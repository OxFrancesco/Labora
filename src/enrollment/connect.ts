import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { Effect, Option, Schema } from "effect";
import { createTailscaleAdapter } from "../tailscale";
import { EnrollmentConnection, EnrollmentIntent, EnrollmentMetadata } from "../computer/enrollment-contracts";
import type { Connection } from "../desktop/store";
import { connectionPage } from "./page";

interface AvailableComputer {
  id: string;
  name: string;
  online: boolean;
  ready: boolean;
  platform?: string;
  requiresCode?: boolean;
}

export interface ConnectionState {
  stage: "checking" | "install" | "unavailable" | "signin" | "choose" | "code" | "approving" | "connected";
  computers: AvailableComputer[];
  busy: boolean;
  loginPending: boolean;
  authUrl?: string;
  approvalUrl?: string;
  selectedName?: string;
  selectedId?: string;
  connectedName?: string;
  error?: string;
  unavailableReason?: string;
  cleanupPending?: boolean;
}

interface ConnectionOptions {
  onConnected: (connection: Connection) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;
  onConfirmed?: () => void | Promise<void>;
  adapter?: ReturnType<typeof createTailscaleAdapter>;
  request?: typeof fetch;
}

function safeError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The connection could not be completed.";
}

const Selection = Schema.Struct({ id: Schema.String });

const CodeSelection = Schema.Struct({ id: Schema.String, code: Schema.String.check(Schema.isPattern(/^\d{8}$/)) });

const RemoteError = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

async function checked(response: Response) {
  if (response.ok) return response;
  const body = await response.json().catch(() => null);
  const decoded = Schema.decodeUnknownOption(RemoteError)(body);
  throw new Error(Option.isSome(decoded) ? decoded.value.error.message : `The computer did not accept the request (${response.status}).`);
}

export interface ConnectionWizard {
  url: string;
  state: () => ConnectionState;
  isClosed: () => boolean;
  close: () => void;
}

let activeConnection: ConnectionWizard | undefined;

export function startComputerConnection(options: ConnectionOptions): ConnectionWizard {
  activeConnection?.close();
  const adapter = options.adapter ?? createTailscaleAdapter();
  const request = options.request ?? fetch;
  const controller = new AbortController();
  const session = randomBytes(32).toString("base64url");
  const path = `/connect/${randomBytes(24).toString("base64url")}`;
  const endpoints = new Map<string, string>();
  let state: ConnectionState = { stage: "checking", computers: [], busy: false, loginPending: false };
  let lastRefresh = 0;
  let refreshing: Promise<void> | undefined;
  let login: ReturnType<typeof adapter.beginLogin> | undefined;
  let pairing: AbortController | undefined;
  let pendingCleanup: (() => Promise<void>) | undefined;
  let cleaning: Promise<void> | undefined;
  let closed = false;

  async function cleanup() {
    if (cleaning) return cleaning;

    if (!pendingCleanup) return;
    cleaning = pendingCleanup().then(() => {
      pendingCleanup = undefined;
      state = { ...state, cleanupPending: false };
    }).catch(() => {
      state = { ...state, cleanupPending: true, error: "The computer could not confirm cancellation. Retry cancellation when it is reachable." };
      throw new Error(state.error);
    }).finally(() => { cleaning = undefined; });

    return cleaning;
  }

  async function sendEnrollment(endpoint: string, id: string, verifier: string, method: "POST" | "DELETE") {
    let failure = new Error("The computer did not respond.");

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await checked(await request(`${endpoint}/v1/enrollment/${id}${method === "POST" ? "/ack" : ""}`, {
          method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verifier }), redirect: "error",
          signal: AbortSignal.timeout(5000),
        }));

        return;
      } catch (cause) { failure = new Error(safeError(cause)); }

      if (attempt < 2) await Bun.sleep(250 * (attempt + 1));
    }

    throw failure;
  }

  function refresh(force = false) {
    if (refreshing) return refreshing;

    if (closed || pairing || pendingCleanup || state.stage === "connected" || state.stage === "code" || (!force && (state.error || Date.now() - lastRefresh < 5_000))) return Promise.resolve();
    lastRefresh = Date.now();
    state = { ...state, busy: true, error: undefined };
    refreshing = Effect.runPromise(Effect.tryPromise({
      try: async () => {
        const status = await adapter.status(controller.signal);

        if (!status.installed) { state = { ...state, stage: "install", computers: [] };

 return; }

        if (!status.running) { state = { ...state,
          stage: status.backendState === "Unavailable" || status.backendState === "NeedsMachineAuth" ? "unavailable" : "signin",
          computers: [], authUrl: state.authUrl ?? status.authUrl,
          unavailableReason: status.backendState === "NeedsMachineAuth" ? "A Tailscale administrator needs to approve this device. Come back here once it is approved." : status.unavailableReason,
        };

 return; }

        if (!status.self || (!status.ownerLogin && !status.self.tagged)) {
          state = { ...state, stage: "unavailable", computers: [], unavailableReason: "Tailscale has not reported a usable device identity. Open Tailscale and check this device." };

          return;
        }

        const peers = [...(status.self ? [status.self] : []), ...status.peers];
        const computers: AvailableComputer[] = [];
        endpoints.clear();

        for (let offset = 0; offset < peers.length; offset += 4) {
          const chunk = await Promise.all(peers.slice(offset, offset + 4).map(async (peer) => {
            const result: AvailableComputer = { id: peer.id, name: peer.name, online: peer.online, ready: false };

            if (!peer.online || !peer.dnsName) return result;
            const endpoint = `https://${peer.dnsName.replace(/\.$/, "")}/labora`;

            try {
              const response = await request(`${endpoint}/.well-known/labora`, {
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]), redirect: "error",
              });

              if (!response.ok) return result;
              const metadata = Schema.decodeUnknownSync(EnrollmentMetadata)(await response.json());

              if (metadata.endpoint !== endpoint) return result;
              endpoints.set(peer.id, endpoint);

              return { ...result, name: metadata.name, ready: true, platform: metadata.platform,
                requiresCode: metadata.approval === "code" || status.self?.tagged || peer.tagged || !status.ownerLogin || peer.ownerLogin !== status.ownerLogin };
            } catch { return result; }
          }));

          computers.push(...chunk);
        }

        if (closed) return;
        computers.sort((left, right) => Number(right.ready) - Number(left.ready) || left.name.localeCompare(right.name));
        state = { ...state, stage: "choose", computers, authUrl: undefined };
      },
      catch: safeError,
    })).catch((error) => { if (!closed) state = { ...state, error: safeError(error) }; }).finally(() => {
      state = { ...state, busy: false };
      refreshing = undefined;
    });

    return refreshing;
  }

  async function beginPairing(id: string, code?: string) {
    if (pairing) throw new Error("Finish or cancel the current connection first.");

    if (pendingCleanup) throw new Error("Retry cancellation before starting another connection.");
    const endpoint = endpoints.get(id);
    const computer = state.computers.find((item) => item.id === id && item.ready);

    if (!endpoint || !computer) throw new Error("This computer is no longer available. Refresh the list and try again.");

    if (computer.requiresCode && !code) {
      state = { ...state, stage: "code", selectedId: id, selectedName: computer.name, error: undefined };

      return;
    }

    const attempt = new AbortController();
    pairing = attempt;
    const verifier = randomBytes(32).toString("base64url");
    const signal = AbortSignal.any([controller.signal, attempt.signal, AbortSignal.timeout(5 * 60_000)]);

    try {
      const response = await checked(await request(`${endpoint}/v1/enrollment`, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
        body: JSON.stringify({ clientName: `Labora on ${hostname()}`, challenge: createHash("sha256").update(verifier).digest("hex"), code }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }));

      const intent = Schema.decodeUnknownSync(EnrollmentIntent)(await response.json());

      if (intent.approvalUrl !== `${endpoint}/connect/${intent.id}`) throw new Error("The computer returned an unexpected approval address.");
      let rollback: void | (() => Promise<void>);
      let claimedConnection: Connection | undefined;
      pendingCleanup = async () => {
        await sendEnrollment(endpoint, intent.id, verifier, "DELETE");

        if (claimedConnection) {
          let revoked = false;

          for (let retry = 0; retry < 3; retry++) {
            try {
              const response = await request(`${endpoint}/v1/clients/self`, {
                method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5000),
                headers: { Authorization: `Bearer ${claimedConnection.token}`, "X-Computer-Id": claimedConnection.id },
              });

              if (response.ok || response.status === 401) { revoked = true; break; }
            } catch { /* A failed cancellation keeps the saved credential available for retry. */ }

            if (retry < 2) await Bun.sleep(250 * (retry + 1));
          }

          if (!revoked) throw new Error("Could not revoke the saved computer connection.");
        }

        if (rollback) {
          const undo = rollback;
          rollback = undefined;
          await undo();
        }
      };

      state = { ...state, stage: "approving", approvalUrl: code ? undefined : intent.approvalUrl, selectedName: computer.name, error: undefined };
      void claim();

      async function claim() {
        try {
          while (!signal.aborted && Date.now() < intent.expiresAt) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1200);

              function abort() { clearTimeout(timer); reject(new Error("Connection cancelled.")); }

              signal.addEventListener("abort", abort, { once: true });
            });

            const claimed = await checked(await request(`${endpoint}/v1/enrollment/${intent.id}/claim`, {
              method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
              body: JSON.stringify({ verifier }), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            }));

            if (claimed.status === 202) continue;
            const paired = Schema.decodeUnknownSync(EnrollmentConnection)(await claimed.json());

            if (paired.endpoint !== endpoint) throw new Error("The computer address changed during approval. Try connecting again.");
            const connection: Connection = { id: paired.computer.id, endpoint, token: paired.token, clientId: paired.clientId, computer: paired.computer };
            claimedConnection = connection;

            if (signal.aborted) {
              await cleanup();

              return;
            }

            rollback = await options.onConnected(connection);

            if (signal.aborted) {
              await cleanup();

              if (rollback) { await rollback(); rollback = undefined; }

              return;
            }

            await sendEnrollment(endpoint, intent.id, verifier, "POST");

            if (signal.aborted) {
              await cleanup();

              return;
            }

            pendingCleanup = undefined;
            state = { ...state, stage: "connected", connectedName: paired.computer.name, approvalUrl: undefined, error: undefined };

            try { await options.onConfirmed?.(); } catch (cause) { state = { ...state, error: safeError(cause) }; }

            return;
          }

          throw new Error("The connection request expired. Choose the computer to try again.");
        } catch (error) {
          try { await cleanup(); } catch { return; }

          if (!closed && pairing === attempt) state = { ...state, stage: "choose", approvalUrl: undefined, error: safeError(error) };
        } finally { if (pairing === attempt) pairing = undefined; }
      }
    } catch (error) { if (pairing === attempt) pairing = undefined; throw error; }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
    async fetch(request, listener) {
      const url = new URL(request.url);
      const peer = listener.requestIP(request)?.address;

      if (peer !== "127.0.0.1" || url.host !== listener.url.host || !url.pathname.startsWith(path)) return new Response("Not found", { status: 404 });
      const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

      if (url.pathname === path && request.method === "GET") {
        const nonce = randomBytes(18).toString("base64url");

        return new Response(connectionPage(nonce, session), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; img-src data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
      }

      const origin = request.headers.get("Origin");

      if (request.headers.get("X-Labora-Session") !== session || (origin !== null && origin !== listener.url.origin)) return Response.json({ error: "This setup session is not available." }, { status: 403, headers });

      try {
        const action = url.pathname.slice(path.length);

        if (action === "/api/status" && request.method === "GET") { void refresh();

 return Response.json(state, { headers }); }

        if (request.method !== "POST") return new Response("Not found", { status: 404, headers });

        if (action === "/api/refresh") await refresh(true);
        else if (action === "/api/login") {
          if (!login) {
            state = { ...state, loginPending: true, error: undefined };
            login = adapter.beginLogin((authUrl) => { state = { ...state, authUrl }; });
            void login.done.then(() => refresh(true)).catch((error) => { if (!closed) state = { ...state, error: safeError(error) }; }).finally(() => { login = undefined; state = { ...state, loginPending: false }; });
          }
        } else if (action === "/api/connect") await beginPairing(Schema.decodeUnknownSync(Selection)(await request.json()).id);
        else if (action === "/api/pair-code") {
          const selection = Schema.decodeUnknownSync(CodeSelection)(await request.json());
          await beginPairing(selection.id, selection.code);
        }
        else if (action === "/api/cancel" || action === "/api/cleanup") {
          pairing?.abort();
          pairing = undefined;
          await cleanup();
          state = { ...state, stage: "choose", approvalUrl: undefined, error: undefined };
        }
        else return new Response("Not found", { status: 404, headers });

        return Response.json(state, { headers });
      } catch (error) { state = { ...state, error: safeError(error) };

 return Response.json({ error: state.error }, { status: 400, headers }); }
    },
  });

  const expiry = setTimeout(close, 15 * 60_000);
  expiry.unref();

  function close() {
    if (closed) return;
    closed = true;
    controller.abort(); pairing?.abort(); login?.cancel(); clearTimeout(expiry); server.stop(true);
    void cleanup().catch(() => undefined);

    if (activeConnection === result) activeConnection = undefined;
  }

  const result: ConnectionWizard = { url: `${server.url.origin}${path}`, state: () => state, isClosed: () => closed, close };
  activeConnection = result;

  return result;
}
