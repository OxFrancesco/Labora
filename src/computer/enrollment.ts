import { webIcon } from "../web-icon";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Schema, Semaphore } from "effect";
import type { ComputerAuthority } from "./authority";
import { ComputerError, type Computer } from "./contracts";
import {
  EnrollmentClaim, EnrollmentMetadata, EnrollmentStart,
} from "./enrollment-contracts";

export interface EnrollmentOptions {
  readonly publicUrl: string;
  readonly ownerLogin?: string;
  readonly pairingOnly?: boolean;
  readonly listenerHost: "127.0.0.1" | "::1";
}

interface Intent {
  readonly id: string;
  readonly clientName: string;
  readonly challenge: string;
  readonly expiresAt: number;
  status: "pending" | "approved" | "denied" | "claimed" | "connected" | "cancelled";
  clientId?: string;
  csrfDigest: string;
  codeApproved?: boolean;
}

interface Dependencies {
  readonly authority: ReturnType<typeof ComputerAuthority.of>;
  readonly metadata: Pick<EnrollmentMetadata, "id" | "name" | "platform">;
  readonly computer: () => Effect.Effect<Computer, ComputerError>;
  readonly revoke: (clientId: string) => Effect.Effect<void, ComputerError>;
}

export interface EnrollmentHandler {
  readonly fetch: (request: Request, peerAddress: string | undefined) =>
    Effect.Effect<Response | undefined, ComputerError>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(sha256(left), "hex"), Buffer.from(sha256(right), "hex"));

const error = (status: number, code: string, message: string) => new ComputerError({ status, code, message });

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const json = (value: Schema.Schema.Type<typeof Schema.Json>, status = 200) =>
  Response.json(value, { status, headers });

const page = (title: string, content: string, cookie?: string) => {
  const responseHeaders = new Headers({ ...headers, "Content-Type": "text/html; charset=utf-8" });

  if (cookie) responseHeaders.set("Set-Cookie", cookie);

  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Labora</title>${webIcon}<style>
  :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;background:#fafafa}*{box-sizing:border-box}body{margin:0;padding:28px}main{max-width:420px;margin:18vh auto}h1{font-size:27px;line-height:1.2;letter-spacing:-.8px;margin:0 0 20px;font-weight:650}p{font-size:15px;line-height:1.6;margin:0 0 22px;color:#555}strong{color:#222;font-weight:600}form{display:flex;gap:10px;margin-top:30px}button{font:inherit;font-size:15px;font-weight:550;border:1px solid #ddd;border-radius:8px;background:#fff;color:#222;padding:12px 18px;cursor:pointer}button[value=approve]{background:#222;border-color:#222;color:#fff;flex:1}button:focus-visible{outline:3px solid #777;outline-offset:3px}@media(prefers-color-scheme:dark){:root{color:#eee;background:#151515}p{color:#aaa}strong{color:#eee}button{background:#222;color:#eee;border-color:#444}button[value=approve]{background:#eee;color:#151515;border-color:#eee}}@media(max-width:480px){main{margin-top:12vh}}
  </style><main><h1>${escape(title)}</h1>${content}</main></html>`, { headers: responseHeaders });
};

const read = Effect.fn("Enrollment.read")((request: Request, expectedType: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!(request.headers.get("content-type") ?? "").startsWith(expectedType)) throw new Error("Invalid content type");
      const reader = request.body?.getReader();

      if (!reader) throw new Error("Missing request body");
      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        while (true) {
          const part = await reader.read();

          if (part.done) break;
          size += part.value.byteLength;

          if (size > 2048) { await reader.cancel(); throw new Error("Request body too large"); }

          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }

      return Buffer.concat(chunks).toString("utf8");
    },
    catch: () => error(400, "invalid_enrollment", "The connection request is invalid."),
  }),
);

export const createEnrollmentHandler = Effect.fn("Enrollment.create")(function* (
  options: EnrollmentOptions,
  dependencies: Dependencies,
) {
  if (options.listenerHost !== "127.0.0.1" && options.listenerHost !== "::1")
    return yield* Effect.fail(error(400, "enrollment_listener", "Browser connection requires a loopback companion listener."));

  const publicUrl = yield* Effect.try({
    try: () => new URL(options.publicUrl),
    catch: () => error(400, "enrollment_url", "The Tailscale address is invalid."),
  });

  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
    !/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(publicUrl.pathname) || (!options.ownerLogin?.trim() && !options.pairingOnly))
    return yield* Effect.fail(error(400, "enrollment_url", "Use the HTTPS address and signed-in owner reported by Tailscale."));
  const endpoint = publicUrl.href.replace(/\/$/, "");
  const intents = new Map<string, Intent>();
  const mutex = yield* Semaphore.make(1);

  const find = Effect.fn("Enrollment.find")(function* (id: string) {
    const intent = intents.get(id);

    if (!intent || intent.expiresAt <= Date.now()) {
      intents.delete(id);

      return yield* Effect.fail(error(410, "enrollment_expired", "This connection request expired. Start again in Labora."));
    }

    return intent;
  });

  const fetch = Effect.fn("Enrollment.fetch")(function* (request: Request, peerAddress: string | undefined) {
    const url = new URL(request.url);
    const approvalMatch = /^\/connect\/([a-f0-9-]{36})$/.exec(url.pathname);
    const claimMatch = /^\/v1\/enrollment\/([a-f0-9-]{36})\/claim$/.exec(url.pathname);
    const ackMatch = /^\/v1\/enrollment\/([a-f0-9-]{36})\/ack$/.exec(url.pathname);
    const cancelMatch = /^\/v1\/enrollment\/([a-f0-9-]{36})$/.exec(url.pathname);

    if (url.pathname !== "/.well-known/labora" && url.pathname !== "/v1/enrollment" && !approvalMatch && !claimMatch && !ackMatch && !cancelMatch) return undefined;

    if (!peerAddress || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddress))
      return yield* Effect.fail(error(403, "enrollment_proxy", "Connect through this computer's Tailscale address."));

    if (request.headers.get("x-forwarded-proto") !== "https" || request.headers.has("tailscale-funnel-request"))
      return yield* Effect.fail(error(403, "enrollment_proxy", "Use the private HTTPS Tailscale connection."));
    const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;

    if (forwardedHost !== publicUrl.host)
      return yield* Effect.fail(error(403, "enrollment_host", "This request did not arrive through the configured Tailscale address."));
    const origin = request.headers.get("origin");

    if (origin && origin !== publicUrl.origin)
      return yield* Effect.fail(error(403, "origin_rejected", "Cross-origin connection requests are not accepted."));

    if (url.pathname === "/.well-known/labora" && request.method === "GET")
      return json({ ...dependencies.metadata, endpoint, approval: options.pairingOnly ? "code" : "browser" });

    const isOwner = !options.pairingOnly && Boolean(options.ownerLogin) && equal(request.headers.get("Tailscale-User-Login") ?? "", options.ownerLogin ?? "");
    const verifierIntent = intents.get(claimMatch?.[1] ?? ackMatch?.[1] ?? cancelMatch?.[1] ?? "");

    if (!isOwner && url.pathname !== "/v1/enrollment" && !verifierIntent?.codeApproved)
      return yield* Effect.fail(error(403, "enrollment_owner", "Sign in to the Tailscale account that owns this computer."));

    if (url.pathname === "/v1/enrollment" && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EnrollmentStart))(yield* read(request, "application/json")).pipe(
        Effect.mapError(() => error(400, "invalid_enrollment", "The connection request is invalid.")),
      );

      if (!input.clientName.trim()) return yield* Effect.fail(error(400, "invalid_enrollment", "A client name is required."));

      if (!isOwner && !input.code)
        return yield* Effect.fail(error(403, "pairing_required", "Enter a pairing code created in Labora Computer on this computer."));

      return yield* mutex.withPermit(Effect.gen(function* () {
        for (const [id, intent] of intents) if (intent.expiresAt <= Date.now()) intents.delete(id);

        if (intents.size >= 10)
          return yield* Effect.fail(error(429, "enrollment_limit", "Too many connection requests. Wait a few minutes and try again."));

        if (input.code) yield* dependencies.authority.consumePairingCode(input.code);
        const id = crypto.randomUUID();
        const expiresAt = Date.now() + 300_000;
        intents.set(id, { id, expiresAt, clientName: input.clientName.trim(), challenge: input.challenge, status: input.code ? "approved" : "pending", codeApproved: Boolean(input.code), csrfDigest: "" });

        return json({ id, expiresAt, approvalUrl: `${endpoint}/connect/${id}` }, 201);
      }));
    }

    if (approvalMatch?.[1] && request.method === "GET") {
      const intent = yield* find(approvalMatch[1]);

      if (intent.status === "connected")
        return page("Computer connected", "<p>Return to Labora to use this computer.</p>");

      if (intent.status === "approved" || intent.status === "claimed")
        return page("Connection approved", "<p>Return to Labora to finish connecting.</p>");

      if (intent.status === "denied") return page("Connection declined", "<p>This computer was not connected.</p>");

      if (intent.status === "cancelled") return page("Connection cancelled", "<p>This computer was not connected.</p>");
      const csrf = randomBytes(32).toString("base64url");
      intent.csrfDigest = sha256(csrf);
      const cookieName = `__Secure-labora-${intent.id}`;
      const cookiePath = `${publicUrl.pathname.replace(/\/$/, "")}/connect/${intent.id}`;

      return page(`Connect ${dependencies.metadata.name}?`, `<p><strong>${escape(intent.clientName)}</strong> will be able to view and control this computer and run your bots. You can disconnect it in Labora.</p><form method="post" action="${escape(endpoint)}/connect/${intent.id}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="deny">Cancel</button><button name="decision" value="approve">Connect computer</button></form>`, `${cookieName}=${csrf}; Path=${cookiePath}; Max-Age=300; Secure; HttpOnly; SameSite=Strict`);
    }

    if (approvalMatch?.[1] && request.method === "POST") {
      if (origin !== publicUrl.origin)
        return yield* Effect.fail(error(403, "origin_rejected", "Return to the connection page and try again."));
      const form = new URLSearchParams(yield* read(request, "application/x-www-form-urlencoded"));
      const id = approvalMatch[1];

      return yield* mutex.withPermit(Effect.gen(function* () {
        const intent = yield* find(id);
        const csrf = form.get("csrf") ?? "";
        const cookie = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`__Secure-labora-${id}=`));
        const cookieValue = cookie?.slice(cookie.indexOf("=") + 1) ?? "";

        if (!intent.csrfDigest || !csrf || !equal(sha256(csrf), intent.csrfDigest) || !equal(cookieValue, csrf))
          return yield* Effect.fail(error(403, "enrollment_csrf", "Return to the connection page and try again."));

        if (intent.status !== "pending")
          return yield* Effect.fail(error(409, "enrollment_decided", "This connection request has already been decided."));
        const decision = form.get("decision");

        if (decision !== "approve" && decision !== "deny")
          return yield* Effect.fail(error(400, "invalid_enrollment", "Choose whether to connect this computer."));
        intent.status = decision === "approve" ? "approved" : "denied";
        intent.csrfDigest = "";

        return decision === "approve"
          ? page("Connection approved", "<p>Return to Labora to finish connecting.</p>")
          : page("Connection declined", "<p>This computer was not connected.</p>");
      }));
    }

    if (claimMatch?.[1] && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EnrollmentClaim))(yield* read(request, "application/json")).pipe(
        Effect.mapError(() => error(400, "invalid_enrollment", "The connection claim is invalid.")),
      );

      const id = claimMatch[1];

      return yield* mutex.withPermit(Effect.gen(function* () {
        const intent = yield* find(id);

        if (!equal(sha256(input.verifier), intent.challenge))
          return yield* Effect.fail(error(403, "enrollment_verifier", "This connection request belongs to another client."));

        if (intent.status === "pending") return json({ status: "pending" }, 202);

        if (intent.status === "denied") return yield* Effect.fail(error(403, "enrollment_denied", "The connection was declined on this computer."));

        if (intent.status === "claimed" || intent.status === "connected") return yield* Effect.fail(error(410, "enrollment_claimed", "This connection request has already been used."));

        if (intent.status === "cancelled") return yield* Effect.fail(error(410, "enrollment_cancelled", "This connection request was cancelled."));
        const computer = yield* dependencies.computer();
        const credential = yield* dependencies.authority.grant(intent.clientName, intent.expiresAt);
        intent.clientId = credential.clientId;
        intent.status = "claimed";

        return json({ ...credential, computer, endpoint });
      }));
    }

    if ((ackMatch?.[1] && request.method === "POST") || (cancelMatch?.[1] && request.method === "DELETE")) {
      const id = ackMatch?.[1] ?? cancelMatch?.[1];

      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EnrollmentClaim))(yield* read(request, "application/json")).pipe(
        Effect.mapError(() => error(400, "invalid_enrollment", "The connection verifier is invalid.")),
      );

      return yield* mutex.withPermit(Effect.gen(function* () {
        const intent = id ? intents.get(id) : undefined;

        if (!intent && request.method === "DELETE") return new Response(null, { status: 204, headers });

        if (!intent) return yield* Effect.fail(error(410, "enrollment_expired", "This connection request expired. Start again in Labora."));

        if (!equal(sha256(input.verifier), intent.challenge))
          return yield* Effect.fail(error(403, "enrollment_verifier", "This connection request belongs to another client."));

        if (request.method === "DELETE") {
          if (intent.clientId) yield* dependencies.revoke(intent.clientId);
          intent.status = "cancelled";
          intent.csrfDigest = "";

          return new Response(null, { status: 204, headers });
        }

        if (intent.expiresAt <= Date.now())
          return yield* Effect.fail(error(410, "enrollment_expired", "This connection request expired. Start again in Labora."));

        if ((intent.status !== "claimed" && intent.status !== "connected") || !intent.clientId)
          return yield* Effect.fail(error(409, "enrollment_unclaimed", "Claim this connection in Labora before confirming it."));
        yield* dependencies.authority.confirmGrant(intent.clientId);
        intent.status = "connected";

        return new Response(null, { status: 204, headers });
      }));
    }

    return json({ error: { code: "not_found", message: "Unknown connection route." } }, 404);
  });

  return { fetch } satisfies EnrollmentHandler;
});
