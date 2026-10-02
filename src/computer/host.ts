import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { authorityLayer, ComputerAuthority, type PairingCode } from "./authority";
import { desktopLayer, Desktop } from "./desktop";
import { platformLayer } from "./platform";
import { ActionsRequest, ComputerError, ControlRequest, PairRequest, type Computer, type Frame } from "./contracts";
import { createEnrollmentHandler, type EnrollmentHandler, type EnrollmentOptions } from "./enrollment";

export interface AgentComputerAdapter {
  info(): Promise<Computer>;
  capture(displayId: string): Promise<{ frame: Frame; png: Uint8Array }>;
  act(request: ActionsRequest): Promise<{ executed: number }>;
  browser?(input: { url: string }): Promise<Schema.Schema.Type<typeof Schema.Json>>;
}

export interface AgentHost {
  fetch(request: Request, context: { computerId: string; clientId: string; controlOwner: "user" | "agent" }): Promise<Response | undefined>;
  close(): Promise<void>;
  isBusy?(): Promise<boolean>;
}

export interface ComputerHostOptions {
  dataDir: string;
  name: string;
  display?: string;
  macAppPath?: string;
  managementToken?: string;
  browserBroker?: string;
  agentFactory?: (options: { dataDir: string; computer: AgentComputerAdapter }) => Promise<AgentHost>;
}

const json = (body: Schema.Schema.Type<typeof Schema.Json>, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

const readJson = Effect.fn("ComputerHttp.readJson")((request: Request) => Effect.tryPromise({
  try: async () => {
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) throw new Error("JSON body required");
    const reader = request.body?.getReader();

    if (!reader) throw new Error("Request body required");
    const chunks: Uint8Array[] = [];
    let length = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) break;
        length += value.byteLength;

        if (length > 131_072) { await reader.cancel(); throw new Error("Request body too large"); }

        chunks.push(value);
      }
    } finally { reader.releaseLock(); }

    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(Buffer.concat(chunks).toString("utf8"));
  },
  catch: () => new ComputerError({ status: 400, code: "invalid_body", message: "A JSON body smaller than 128 KiB is required" }),
}));

export async function createComputerHost(options: ComputerHostOptions) {
  const authority = authorityLayer(options.dataDir);
  const platform = platformLayer(options);
  const desktop = desktopLayer(options.name, options.agentFactory !== undefined).pipe(Layer.provide(platform), Layer.provideMerge(authority));
  const runtime = ManagedRuntime.make(desktop);
  const services = await runtime.runPromise(Effect.gen(function* () { return { authority: yield* ComputerAuthority, desktop: yield* Desktop }; }));

  const adapter: AgentComputerAdapter = {
    info: () => runtime.runPromise(services.desktop.info()),
    capture: (displayId) => runtime.runPromise(services.desktop.capture(displayId)),
    act: request => runtime.runPromise(services.desktop.act({ ...request, actor: "agent" })),
  };

  if (options.browserBroker && options.managementToken) {
    const broker = new URL(options.browserBroker);

    if (broker.protocol !== "https:" || broker.username || broker.password) throw new Error("Browser broker requires an HTTPS URL without credentials");
    adapter.browser = async input => {
      const response = await fetch(broker, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000), headers: { "Content-Type": "application/json", "X-Labora-Management": options.managementToken ?? "" }, body: JSON.stringify(input) });

      if (!response.ok) throw new Error(`Kitesurf read failed with HTTP ${response.status}`);

      return Schema.decodeUnknownSync(Schema.Json)(await response.json());
    };
  }

  const agents = await options.agentFactory?.({ dataDir: options.dataDir, computer: adapter });
  const authenticatedRequests = new Map<string, Set<AbortController>>();
  let enrollment: EnrollmentHandler | undefined;

  const platformName = (): Computer["platform"] => {
    switch (process.platform) {
      case "darwin": return "macos";
      case "linux": return "linux";
      case "win32": return "windows";
      default: return "unsupported";
    }
  };

  const enableEnrollment = async (configuration: EnrollmentOptions) => {
    enrollment = await runtime.runPromise(createEnrollmentHandler(configuration, {
      authority: services.authority,
      metadata: {
        id: services.authority.computerId,
        name: options.name,
        platform: platformName(),
      },
      computer: services.desktop.info,
      revoke: (clientId) => services.authority.revoke(clientId).pipe(Effect.tap(() => Effect.sync(() => {
        for (const controller of authenticatedRequests.get(clientId) ?? []) controller.abort();
        authenticatedRequests.delete(clientId);
      }))),
    }));
  };

  const revoke = async (clientId: string) => {
    await runtime.runPromise(services.authority.revoke(clientId));

    for (const controller of authenticatedRequests.get(clientId) ?? []) controller.abort();
    authenticatedRequests.delete(clientId);
  };

  const handle = Effect.fn("ComputerHttp.handle")(function* (request: Request, peerAddress?: string) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (enrollment) {
      const enrolled = yield* enrollment.fetch(request, peerAddress);

      if (enrolled) return enrolled;
    }

    if (origin && origin !== url.origin) return json({ error: { code: "origin_rejected", message: "Cross-origin browser requests are not accepted" } }, 403);

    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });

    if (options.managementToken && url.pathname === "/_labora/pair" && request.method === "POST") {
      if (request.headers.get("X-Labora-Management") !== options.managementToken) return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);

      return json({ ...yield* services.authority.issuePairingCode() });
    }

    if (options.managementToken && url.pathname === "/_labora/activity" && request.method === "GET") {
      if (request.headers.get("X-Labora-Management") !== options.managementToken) return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);

      return json({ busy: agents ? yield* Effect.promise(() => agents.isBusy ? agents.isBusy() : Promise.resolve(true)) : false });
    }

    if (url.pathname === "/v1/pair" && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(PairRequest)(yield* readJson(request)).pipe(Effect.mapError(() => new ComputerError({ status: 400, code: "invalid_pairing", message: "Enter the eight-digit code and a client name" })));
      const credential = yield* services.authority.pair(input);
      const computer = yield* services.desktop.info();

      return json({ ...credential, computer: { ...computer } });
    }

    const authorization = request.headers.get("authorization") ?? "";
    const clientId = yield* services.authority.authenticate(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");

    if (request.headers.get("X-Computer-Id") !== services.authority.computerId) return json({ error: { code: "wrong_computer", message: "Select the paired computer again" } }, 409);

    if (url.pathname === "/v1/computer" && request.method === "GET") return json({ ...yield* services.desktop.info() });

    if (url.pathname === "/v1/clients/self" && request.method === "DELETE") { yield* Effect.promise(() => revoke(clientId));

 return new Response(null, { status: 204 }); }

    const frameMatch = /^\/v1\/displays\/([^/]+)\/frame$/.exec(url.pathname);

    if (frameMatch?.[1] && request.method === "GET") {
      const { frame, png } = yield* services.desktop.capture(decodeURIComponent(frameMatch[1]));

      return new Response(Buffer.from(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Frame-Id": frame.id, "X-Frame-Width": String(frame.width), "X-Frame-Height": String(frame.height), "X-Captured-At": String(frame.capturedAt), "X-Frame-Origin-X": String(frame.originX), "X-Frame-Origin-Y": String(frame.originY), "X-Frame-Scale-X": String(frame.scaleX), "X-Frame-Scale-Y": String(frame.scaleY) } });
    }

    if (url.pathname === "/v1/control" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(ControlRequest)(yield* readJson(request)).pipe(Effect.mapError(() => new ComputerError({ status: 400, code: "invalid_control", message: "Control owner must be user or agent" })));
      yield* services.desktop.control(body.owner);

      return json({ owner: body.owner });
    }

    if (url.pathname === "/v1/actions" && request.method === "POST") {
      const body = yield* Schema.decodeUnknownEffect(ActionsRequest)(yield* readJson(request)).pipe(Effect.mapError(() => new ComputerError({ status: 400, code: "invalid_actions", message: "Input actions or coordinates are invalid" })));

      return json(yield* services.desktop.act(body));
    }

    if (agents && (url.pathname === "/v1/bots" || url.pathname.startsWith("/v1/bots/") ||
      url.pathname === "/v1/routines" || url.pathname.startsWith("/v1/routines/"))) {
      return yield* Effect.tryPromise({ try: async () => {
        const controller = new AbortController();
        const controllers = authenticatedRequests.get(clientId) ?? new Set<AbortController>();
        controllers.add(controller); authenticatedRequests.set(clientId, controllers);
        const signal = AbortSignal.any([request.signal, controller.signal]);
        signal.addEventListener("abort", () => controllers.delete(controller), { once: true });
        const response = await agents.fetch(new Request(request, { signal }), { clientId, computerId: services.authority.computerId, controlOwner: services.desktop.owner() });

        if (!response?.headers.get("content-type")?.includes("text/event-stream")) controllers.delete(controller);

        return response ?? json({ error: { code: "not_found", message: "Unknown bot operation" } }, 404);
      }, catch: () => new ComputerError({ status: 500, code: "agent_host", message: "The bot host could not complete this request" }) });
    }

    return json({ error: { code: "not_found", message: "Unknown companion operation" } }, 404);
  });

  return {
    id: services.authority.computerId,
    fetch: (request: Request) => runtime.runPromise(handle(request).pipe(Effect.catch(error => Effect.succeed(json({ error: { code: error.code, message: error.message } }, error.status))))),
    fetchFrom: (request: Request, peerAddress: string | undefined) => runtime.runPromise(handle(request, peerAddress).pipe(Effect.catch(error => Effect.succeed(json({ error: { code: error.code, message: error.message } }, error.status))))),
    enableEnrollment,
    disableEnrollment: () => { enrollment = undefined; },
    issuePairingCode: (): Promise<PairingCode> => runtime.runPromise(services.authority.issuePairingCode()),
    revokeClient: revoke,
    computer: adapter,
    async close() { for (const controllers of authenticatedRequests.values()) for (const controller of controllers) controller.abort(); await agents?.close(); await runtime.dispose(); },
  };
}
