import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { authorityLayer, ComputerAuthority } from "./authority";
import { type Computer } from "./contracts";
import { createEnrollmentHandler } from "./enrollment";
import { EnrollmentConnection, EnrollmentIntent, EnrollmentMetadata } from "./enrollment-contracts";

const dataDir = await mkdtemp(join(tmpdir(), "labora-enrollment-e2e-"));

const endpoint = "https://verification.tailnet.test/labora";

const ownerLogin = "owner@example.test";

const runtime = ManagedRuntime.make(authorityLayer(dataDir));

const authority = await runtime.runPromise(ComputerAuthority);

const computer: Computer = {
  id: authority.computerId, name: "Verification computer", platform: "linux",
  capabilities: ["agent-host"], displays: [],
  permissions: { screenCapture: "unsupported", accessibility: "unsupported" },
  controlOwner: "user", diagnostics: ["Isolated enrollment fixture; no computer access"],
};

const handler = await runtime.runPromise(createEnrollmentHandler({
  publicUrl: endpoint, ownerLogin, listenerHost: "127.0.0.1",
}, { authority, metadata: computer, computer: () => Effect.succeed(computer), revoke: authority.revoke }));

const checks: string[] = [];

const trustHeaders = {
  "X-Forwarded-Host": new URL(endpoint).host,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": ownerLogin,
};

const handle = (request: Request, peerAddress: string | undefined) => runtime.runPromise(
  handler.fetch(request, peerAddress).pipe(Effect.match({
    onSuccess: (response) => response ?? new Response(null, { status: 404 }),
    onFailure: (error) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status }),
  })),
);

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (request, server) => handle(request, server.requestIP(request)?.address),
});

const request = (path: string, options: RequestInit = {}) => fetch(new URL(path, server.url), {
  ...options, headers: new Headers({ ...trustHeaders, ...Object.fromEntries(new Headers(options.headers)) }),
});

const jsonRequest = (path: string, body: Schema.Schema.Type<typeof Schema.Json>) => request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const decode = async <A>(schema: Schema.Codec<A>, response: Response) => {
  assert.ok(response.ok, await response.clone().text());

  return Schema.decodeUnknownSync(schema)(await response.json());
};

const start = async (clientName = "Labora verification") => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  const response = await jsonRequest("/v1/enrollment", { clientName, challenge });
  assert.equal(response.status, 201);
  const intent = await decode(EnrollmentIntent, response);
  assert.equal(intent.approvalUrl, `${endpoint}/connect/${intent.id}`);
  assert.ok(intent.expiresAt > Date.now() && intent.expiresAt <= Date.now() + 300_000);

  return { ...intent, verifier };
};

const approval = async (id: string) => {
  const response = await request(`/connect/${id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  const html = await response.text();
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  const setCookie = response.headers.get("set-cookie");
  assert.ok(csrf && setCookie);
  assert.match(setCookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.ok(setCookie.includes(`Path=/labora/connect/${id}`));

  return { html, csrf, cookie: setCookie.split(";")[0] ?? "" };
};

const decide = (id: string, csrf: string, cookie: string, decision = "approve") => request(`/connect/${id}`, {
  method: "POST", headers: {
    "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(endpoint).origin, Cookie: cookie,
  }, body: new URLSearchParams({ csrf, decision }),
});

const claim = (id: string, verifier: string) => jsonRequest(`/v1/enrollment/${id}/claim`, { verifier });

const ack = (id: string, verifier: string) => jsonRequest(`/v1/enrollment/${id}/ack`, { verifier });

const cancel = (id: string, verifier: string) => request(`/v1/enrollment/${id}`, {
  method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verifier }),
});

const authenticationStatus = (token: string) => runtime.runPromise(authority.authenticate(token).pipe(Effect.match({
  onSuccess: () => 200, onFailure: (error) => error.status,
})));

const statePath = join(dataDir, "authority.json");

const clients = async () => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  clients: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, digest: Schema.String })),
})))(await readFile(statePath, "utf8")).clients;

try {
  const metadata = await decode(EnrollmentMetadata, await request("/.well-known/labora"));
  assert.deepEqual(metadata, { id: computer.id, name: computer.name, platform: computer.platform, endpoint });
  assert.deepEqual(await clients(), []);
  checks.push("Enabled metadata exposes only identity, platform, and trusted endpoint");

  for (const headers of [
    new Headers({ "X-Forwarded-Proto": "http" }),
    new Headers({ "X-Forwarded-Host": "other.tailnet.test" }),
    new Headers({ "Tailscale-Funnel-Request": "?1" }),
    new Headers({ Origin: "https://untrusted.example" }),
  ]) assert.equal((await request("/.well-known/labora", { headers })).status, 403);

  for (const address of [undefined, "100.100.10.10", "192.168.0.1"])
    assert.equal((await handle(new Request(`${new URL(endpoint).origin}/.well-known/labora`, { headers: trustHeaders }), address)).status, 403);
  assert.equal((await request("/v1/enrollment", {
    method: "POST", headers: { "Tailscale-User-Login": "other@example.test" },
  })).status, 403);
  checks.push("Wrong proxy address, HTTPS, public host, Funnel, origin, and owner are rejected");

  const manual = await runtime.runPromise(authority.issuePairingCode());
  const intent = await start('<script>alert("untrusted")</script>');
  assert.equal((await claim(intent.id, intent.verifier)).status, 202);
  assert.deepEqual(await clients(), []);
  const form = await approval(intent.id);
  assert.ok(!form.html.includes('<script>alert("untrusted")</script>'));
  assert.ok(form.html.includes("&lt;script&gt;"));
  assert.equal((await decide(intent.id, form.csrf, "")).status, 403);
  assert.equal((await decide(intent.id, "invalid", form.cookie)).status, 403);
  assert.equal((await request(`/connect/${intent.id}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: form.cookie },
    body: new URLSearchParams({ csrf: form.csrf, decision: "approve" }),
  })).status, 403);
  assert.deepEqual(await clients(), []);
  checks.push("Pending consent grants no credential; escaped page requires matching origin and CSRF cookie");

  const approved = await decide(intent.id, form.csrf, form.cookie);
  assert.equal(approved.status, 200);
  assert.ok((await approved.text()).includes("Connection approved"));
  assert.deepEqual(await clients(), []);
  assert.equal((await claim(intent.id, randomBytes(32).toString("base64url"))).status, 403);
  const concurrentClaims = await Promise.all([claim(intent.id, intent.verifier), claim(intent.id, intent.verifier)]);
  assert.deepEqual(concurrentClaims.map(response => response.status).sort(), [200, 410]);
  const accepted = concurrentClaims.find(response => response.status === 200);
  assert.ok(accepted);
  const connection = await decode(EnrollmentConnection, accepted);
  assert.equal(connection.endpoint, endpoint);
  assert.equal(connection.computer.id, authority.computerId);
  assert.equal(await authenticationStatus(connection.token), 401);
  assert.equal((await clients()).length, 1);
  assert.ok(!(await readFile(statePath, "utf8")).includes(connection.token));
  assert.ok(!intent.approvalUrl.includes(connection.token) && !form.html.includes(connection.token));
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  checks.push("Consent plus private verifier issues one inactive credential across concurrent claims; only its digest is persisted");

  const pendingRestart = ManagedRuntime.make(authorityLayer(dataDir));

  try {
    const pendingAuthority = await pendingRestart.runPromise(ComputerAuthority);

    const status = await pendingRestart.runPromise(pendingAuthority.authenticate(connection.token).pipe(Effect.match({
      onSuccess: () => 200, onFailure: (error) => error.status,
    })));

    assert.equal(status, 401);
  } finally { await pendingRestart.dispose(); }

  assert.equal((await ack(intent.id, randomBytes(32).toString("base64url"))).status, 403);
  assert.equal((await ack(intent.id, intent.verifier)).status, 204);
  assert.equal((await ack(intent.id, intent.verifier)).status, 204);
  assert.equal(await runtime.runPromise(authority.authenticate(connection.token)), connection.clientId);
  checks.push("Unacknowledged credentials stay inactive across restart; verifier-bound acknowledgement activates once");

  const manualConnection = await runtime.runPromise(authority.pair({ code: manual.code, clientName: "Manual pairing verification" }));
  assert.equal(await runtime.runPromise(authority.authenticate(manualConnection.token)), manualConnection.clientId);
  assert.equal((await clients()).length, 2);
  checks.push("Browser enrollment preserves an outstanding manual pairing code");

  const lost = await start();
  const lostForm = await approval(lost.id);
  assert.equal((await decide(lost.id, lostForm.csrf, lostForm.cookie)).status, 200);
  const lostResponse = await claim(lost.id, lost.verifier);
  assert.equal(lostResponse.status, 200);
  await lostResponse.body?.cancel();
  assert.equal((await clients()).length, 3);
  assert.equal((await cancel(lost.id, randomBytes(32).toString("base64url"))).status, 403);
  assert.equal((await cancel(lost.id, lost.verifier)).status, 204);
  assert.equal((await cancel(lost.id, lost.verifier)).status, 204);
  assert.equal((await ack(lost.id, lost.verifier)).status, 409);
  assert.equal((await claim(lost.id, lost.verifier)).status, 410);
  assert.equal((await clients()).length, 2);
  checks.push("A discarded claim response is cleaned up with the verifier alone; cancellation is idempotent");

  const revoked = await start();
  const revokedForm = await approval(revoked.id);
  await decide(revoked.id, revokedForm.csrf, revokedForm.cookie);
  const revokedConnection = await decode(EnrollmentConnection, await claim(revoked.id, revoked.verifier));
  assert.equal((await ack(revoked.id, revoked.verifier)).status, 204);
  assert.equal(await authenticationStatus(revokedConnection.token), 200);
  assert.equal((await cancel(revoked.id, revoked.verifier)).status, 204);
  assert.equal(await authenticationStatus(revokedConnection.token), 401);
  checks.push("Cancellation after acknowledgement revokes the active credential");

  const denied = await start();
  const deniedForm = await approval(denied.id);
  assert.equal((await decide(denied.id, deniedForm.csrf, deniedForm.cookie, "deny")).status, 200);
  assert.equal((await claim(denied.id, denied.verifier)).status, 403);
  assert.equal((await claim(crypto.randomUUID(), denied.verifier)).status, 410);
  assert.equal((await jsonRequest("/v1/enrollment", { clientName: "Invalid", challenge: "invalid" })).status, 400);
  assert.equal((await jsonRequest("/v1/enrollment", { clientName: "x".repeat(3000), challenge: "0".repeat(64) })).status, 400);
  checks.push("Denial, unavailable intents, invalid challenges, and oversized requests fail without grants");

  for (let index = 0; index < 6; index += 1) await start();
  assert.equal((await jsonRequest("/v1/enrollment", { clientName: "Over limit", challenge: "0".repeat(64) })).status, 429);
  checks.push("Outstanding enrollment intents are bounded to ten");

  const expired = await runtime.runPromise(authority.grant("Expired lease fixture", Date.now() - 1));
  const restored = ManagedRuntime.make(authorityLayer(dataDir));

  try {
    const restoredAuthority = await restored.runPromise(ComputerAuthority);
    assert.equal(await restored.runPromise(restoredAuthority.authenticate(connection.token)), connection.clientId);

    const expiredStatus = await restored.runPromise(restoredAuthority.confirmGrant(expired.clientId).pipe(Effect.match({
      onSuccess: () => 200, onFailure: (error) => error.status,
    })));

    assert.equal(expiredStatus, 410);
    await restored.runPromise(restoredAuthority.revoke(connection.clientId));

    const status = await restored.runPromise(restoredAuthority.authenticate(connection.token).pipe(Effect.match({
      onSuccess: () => 200, onFailure: (error) => error.status,
    })));

    assert.equal(status, 401);
  } finally { await restored.dispose(); }

  checks.push("Acknowledged credential survives restart; expired pending lease cannot activate; revocation persists");

  const result = {
    verifiedAt: new Date().toISOString(), checks,
    boundary: "Real localhost HTTP consent, concurrent claim, acknowledgement, and cancellation with the production Effect handler and durable authority. Tailscale proxy headers, computer metadata, and a past-deadline lease are explicit fixtures. No Tailscale login/Serve mutation, live provider inference, desktop control, or Cloudflare requests. Five-minute wall-clock expiry was not waited out.",
  };

  await mkdir("artifacts/enrollment-e2e", { recursive: true });
  await writeFile("artifacts/enrollment-e2e/result.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.stop(true);
  await runtime.dispose();
  await rm(dataDir, { recursive: true, force: true });
}
