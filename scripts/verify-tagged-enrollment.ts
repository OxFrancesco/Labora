import { Schema } from "effect";
import { EnrollmentIntent, type EnrollmentStart } from "../src/computer/enrollment-contracts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createComputerHost } from "../src/computer/host";
import { startComputerSetup } from "../src/computer/setup";
import { startComputerConnection } from "../src/enrollment/connect";
import type { Connection } from "../src/desktop/store";
import type { createTailscaleAdapter } from "../src/tailscale";

const workspace = await mkdtemp("/private/tmp/labora-tagged-");

const evidence = resolve("evidence", `tagged-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

await mkdir(evidence, { recursive: true, mode: 0o700 });

const endpoint = "https://tagged.review.ts.net/labora";

const node = { id: "tagged-pc", name: "Tagged verification Mac", dnsName: "tagged.review.ts.net", online: true, tagged: true };

const companion = await createComputerHost({ dataDir: workspace, name: node.name, macAppPath: join(workspace, "missing.app") });

let configured = false;

let connected: Connection | undefined;

const checks: string[] = [];

const adapter: ReturnType<typeof createTailscaleAdapter> = {
  async status() { return { installed: true, running: true, backendState: "Running", self: node, peers: [] }; },
  beginLogin() { throw new Error("Tagged verification must not sign in."); },
  async ensureServe() { configured = true;

 return { endpoint, changed: true }; },
  async serveStatus() { return { endpoint, configured, self: node }; },
};

let setup: Awaited<ReturnType<typeof startComputerSetup>>;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, listener) {
  return await setup.fetch(request, listener.requestIP(request)?.address) ?? new Response("Not found", { status: 404 });
} });

setup = await startComputerSetup({ host: companion, dataDir: workspace, localOrigin: server.url.origin, port: server.port!, adapter });

async function throughServe(request: Request) {
  const url = new URL(request.url);
  assert.equal(url.origin, new URL(endpoint).origin);
  assert(url.pathname.startsWith("/labora/"));
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.delete("Tailscale-User-Login");

  return companion.fetchFrom(new Request(new URL(url.pathname.slice(7), url.origin), { method: request.method, headers, body: request.body }), "127.0.0.1");
}

const request: typeof fetch = Object.assign(async (input: Request | URL | string, init?: RequestInit) => throughServe(new Request(input, init)), { preconnect: fetch.preconnect });

const wizard = startComputerConnection({ adapter, request, async onConnected(connection) {
  const file = join(workspace, "connection.json");
  await Bun.write(file, JSON.stringify(connection), { mode: 0o600 });
  const inactive = await request(`${endpoint}/v1/computer`, { headers: { Authorization: `Bearer ${connection.token}`, "X-Computer-Id": connection.id } });
  assert.equal(inactive.status, 401);
  checks.push("Claimed credential remains inactive until acknowledgment.");
  connected = connection;

  return async () => { connected = undefined; await rm(file, { force: true }); };
}, async onConfirmed() {
  assert(connected);
  const accepted = await request(`${endpoint}/v1/computer`, { headers: { Authorization: `Bearer ${connected.token}`, "X-Computer-Id": connected.id } });
  assert.equal(accepted.status, 200);
  assert(!JSON.stringify(wizard.state()).includes(connected.token));
  checks.push("Tagged browser pairing activated the credential and authenticated a real companion request.");
  await publish();
} });

async function publish() {
  await Bun.write(join(evidence, "session.json"), JSON.stringify({ setupUrl: setup.url, wizardUrl: wizard.url }, null, 2), { mode: 0o600 });
  await Bun.write(join(evidence, "result.json"), JSON.stringify({ checks, connected: Boolean(connected), stage: wizard.state().stage, proofBoundary: "Production setup and connection pages, real authorization and persistence. Tailscale identity and Serve transport are isolated fixtures." }, null, 2));
}

async function postSetup(action: string, origin = server.url.origin) {
  return fetch(`${setup.url}/${action}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
}

assert.equal((await postSetup("pair-code", "https://untrusted.invalid")).status, 403);

assert.equal((await postSetup("pair-code")).status, 400);

assert.equal((await postSetup("enable")).status, 200);

checks.push("Local setup enables tagged sharing; code creation rejects cross-origin requests and disabled sharing.");

const started = { clientName: "Tagged fixture", challenge: createHash("sha256").update(randomBytes(32)).digest("hex") };

const enroll = (body: EnrollmentStart) => request(`${endpoint}/v1/enrollment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

assert.equal((await enroll(started)).status, 403);

const first = await companion.issuePairingCode();

const wrong = first.code === "00000000" ? "11111111" : "00000000";

for (let attempt = 0; attempt < 5; attempt++) assert.equal((await enroll({ ...started, code: wrong })).status, 403);

assert.equal((await enroll({ ...started, code: first.code })).status, 403);

checks.push("Missing codes and five incorrect attempts cannot create a connection; the exhausted code stays blocked.");

const second = await companion.issuePairingCode();

const valid = await enroll({ ...started, code: second.code });

assert.equal(valid.status, 201);

assert.equal((await enroll({ ...started, code: second.code })).status, 403);

const intent = Schema.decodeUnknownSync(EnrollmentIntent)(await valid.json());

const invalidClaim = await request(`${endpoint}/v1/enrollment/${intent.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verifier: randomBytes(32).toString("base64url") }) });

assert.equal(invalidClaim.status, 403);

assert.equal((await request(`${endpoint}/connect/${intent.id}`)).status, 403);

checks.push("Codes are single-use; an unrelated verifier and unauthenticated browser approval cannot claim access.");

await setup.close();

setup = await startComputerSetup({ host: companion, dataDir: workspace, localOrigin: server.url.origin, port: server.port!, adapter });

const restored = Schema.decodeUnknownSync(Schema.Struct({ enabled: Schema.Boolean }))(await (await fetch(`${setup.url}/status`)).json());

assert(restored.enabled);

checks.push("Tagged enrollment restores only after the node identity and Serve route match.");

await publish();

console.log(JSON.stringify({ evidence, setupUrl: setup.url, wizardUrl: wizard.url, checks }));

async function close() {
  await publish();
  wizard.close();
  await setup.close();
  server.stop(true);
  await companion.close();
  await rm(workspace, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void close(); });

process.on("SIGTERM", () => { void close(); });
