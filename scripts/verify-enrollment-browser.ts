import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { createComputerHost } from "../src/computer/host";
import { EnrollmentConnection } from "../src/computer/enrollment-contracts";
import { Connection } from "../src/desktop/store";
import { startComputerConnection } from "../src/enrollment/connect";
import { TailscaleStatus, type createTailscaleAdapter } from "../src/tailscale";

const root = resolve(import.meta.dir, "..");

const workspace = await mkdtemp("/private/tmp/labora-enrollment-");

const evidence = join(root, "evidence", `enrollment-browser-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

await mkdir(evidence, { recursive: true, mode: 0o700 });

const endpoint = "https://verification-pc.review.ts.net/labora";

const owner = "review@example.invalid";

const mount = `/review/${randomBytes(24).toString("hex")}`;

const checks: string[] = [];

const companion = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Verification PC", macAppPath: join(workspace, "missing.app") });

await companion.enableEnrollment({ publicUrl: endpoint, ownerLogin: owner, listenerHost: "127.0.0.1" });

let scenario = "ready";

let connected: Connection | undefined;

let issued: EnrollmentConnection | undefined;

let mutationAttempts = 0;

let revokeAttempts = 0;

let revokeFailure = false;

let transportCalls = 0;

let closed = false;

function record(check: string) { if (!checks.includes(check)) checks.push(check); }

const fixtureStatus = TailscaleStatus.make({
  installed: true, running: true, backendState: "Running", ownerLogin: owner,
  self: { id: "review-controller", name: "Verification Controller", dnsName: "controller.review.ts.net", online: true, tagged: false, ownerLogin: owner },
  peers: [
    { id: "review-pc", name: "Verification PC", dnsName: "verification-pc.review.ts.net", online: true, tagged: false, ownerLogin: owner },
    { id: "review-offline", name: "Offline PC", dnsName: "offline.review.ts.net", online: false, tagged: false, ownerLogin: owner },
  ],
});

const adapter: ReturnType<typeof createTailscaleAdapter> = {
  async status() {
    if (scenario === "install") return { installed: false, running: false, backendState: "Unavailable", peers: [] };

    if (scenario === "unavailable") return { installed: true, running: false, backendState: "Unavailable", peers: [], unavailableReason: "Open Tailscale to start its background service." };

    return fixtureStatus;
  },
  beginLogin() { mutationAttempts += 1;

 return { done: Promise.reject(new Error("No sign-in may run in this verification.")), cancel() {} }; },
  async ensureServe() { mutationAttempts += 1; throw new Error("No sharing configuration may change in this verification."); },
  async serveStatus() { throw new Error("The client wizard does not need sharing configuration."); },
};

async function throughServe(input: Request) {
  const url = new URL(input.url);
  assert.equal(url.origin, new URL(endpoint).origin, "Only the isolated companion may receive fixture requests.");
  assert(url.pathname.startsWith("/labora/"));
  const headers = new Headers(input.headers);
  headers.set("Host", url.host);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("Tailscale-User-Login", owner);
  const target = new URL(url.pathname.slice("/labora".length) + url.search, url.origin);

  return companion.fetchFrom(new Request(target, { method: input.method, headers, body: input.body, signal: input.signal }), "127.0.0.1");
}

const request: typeof fetch = Object.assign(async (input: Request | string | URL, init?: RequestInit) => {
  const incoming = new Request(input, init);
  const url = new URL(incoming.url);
  transportCalls += 1;

  if (url.hostname === "controller.review.ts.net") return new Response(null, { status: 404 });

  const revoking = incoming.method === "DELETE" && (url.pathname.endsWith("/v1/clients/self") || url.pathname.includes("/v1/enrollment/"));

  if (revoking) {
    revokeAttempts += 1;

    if (revokeFailure) return Response.json({ error: { message: "Fixture revocation failed." } }, { status: 503 });
  }

  const response = await throughServe(incoming);

  if (url.pathname.endsWith("/claim") && response.status === 200) {
    issued = Schema.decodeUnknownSync(EnrollmentConnection)(await response.clone().json());
    record("The production wizard received a credential from the real companion claim route.");
  }

  if (url.pathname.endsWith("/ack") && response.ok && connected) {
    const accepted = await throughServe(new Request(`${endpoint}/v1/computer`, { headers: { Authorization: `Bearer ${connected.token}`, "X-Computer-Id": connected.id } }));
    assert.equal(accepted.status, 200);
    record("Acknowledgment activated the privately persisted credential, verified against the real companion.");
  }

  if (revoking && response.ok && issued) {
    const denied = await throughServe(new Request(`${endpoint}/v1/computer`, { headers: { Authorization: `Bearer ${issued.token}`, "X-Computer-Id": issued.computer.id } }));
    assert.equal(denied.status, 401);
    record("Failed local persistence revoked the new credential, confirmed by an unauthorized companion response.");
  }

  return response;
}, { preconnect: fetch.preconnect });

function start() {
  connected = undefined;
  issued = undefined;
  revokeFailure = scenario === "revoke-failure";

  return startComputerConnection({ adapter, request, async onConnected(connection) {
    if (scenario === "persistence-failure" || scenario === "revoke-failure") throw new Error("Verification could not save this connection.");
    const path = join(workspace, "connection.json");
    await writeFile(path, JSON.stringify(connection), { mode: 0o600 });
    connected = Schema.decodeUnknownSync(Connection)(await Bun.file(path).json());
    assert.equal(connected.computer.id, companion.id);
    const authenticated = await request(`${endpoint}/v1/computer`, { headers: { Authorization: `Bearer ${connected.token}`, "X-Computer-Id": connected.id } });
    assert.equal(authenticated.status, 401);
    record("The claimed credential was persisted privately and remained inactive before acknowledgment.");

    if (scenario === "cancel-during-save") await Bun.sleep(700);

    return async () => {
      connected = undefined;
      await rm(path, { force: true });
      record("Cancellation removed the privately persisted connection.");
    };
  } });
}

function summary() {
  const state = wizard.state();

  if (connected) {
    assert(!JSON.stringify(state).includes(connected.token));
    record("Browser state contains no computer bearer credential.");
  }

  assert.equal(mutationAttempts, 0);

  return { scenario, state, checks, mutationAttempts, revokeAttempts, transportCalls, connected: Boolean(connected), proofBoundary: "Production wizard HTML, real companion routes and private credential persistence. Tailscale status, HTTPS transport and trusted Serve headers are injected fixtures. No live sign-in, route change, screen capture or computer input." };
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
  async fetch(incoming, listener) {
    const url = new URL(incoming.url);

    if (listener.requestIP(incoming)?.address !== "127.0.0.1" || url.host !== listener.url.host || !url.pathname.startsWith(mount)) return new Response("Not found", { status: 404 });
    const action = url.pathname.slice(mount.length);
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

    if (action === "/status") return Response.json(summary(), { headers });

    if (action === "/approval") {
      const approval = wizard.state().approvalUrl;

      if (!approval) return new Response("Choose Verification PC in the setup tab first.", { status: 409, headers });

      return Response.redirect(`${listener.url.origin}${mount}/consent/${new URL(approval).pathname.split("/").at(-1)}`);
    }

    if (action.startsWith("/consent/")) {
      const id = action.slice("/consent/".length);

      if (!/^[a-f0-9-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
      const forwarded = new Headers(incoming.headers);

      if (incoming.method === "POST") {
        if (incoming.headers.get("origin") !== listener.url.origin) return Response.json({ error: "Cross-origin request", origin: incoming.headers.get("origin"), expectedOrigin: listener.url.origin }, { status: 403 });
        forwarded.set("Origin", new URL(endpoint).origin);
      }

      forwarded.set("Cookie", (incoming.headers.get("cookie") ?? "").replaceAll("labora-review-csrf-", "__Secure-labora-"));
      const response = await throughServe(new Request(`${endpoint}/connect/${id}`, { method: incoming.method, headers: forwarded, body: incoming.body }));
      const responseHeaders = new Headers(response.headers);
      const cookie = responseHeaders.get("Set-Cookie");

      if (cookie) responseHeaders.set("Set-Cookie", cookie.replace("__Secure-labora-", "labora-review-csrf-").replace(`Path=/labora/connect/${id}`, `Path=${mount}/consent/${id}`).replace("; Secure", ""));
      const body = (await response.text()).replaceAll(`${endpoint}/connect/${id}`, `${listener.url.origin}${mount}/consent/${id}`);

      if (incoming.method === "POST" && response.ok) record("Companion consent accepted the actual form with its CSRF cookie and token.");

      return new Response(body, { status: response.status, headers: responseHeaders });
    }

    if (action === "/scenario" && incoming.method === "POST") {
      const origin = incoming.headers.get("origin");

      if (origin && origin !== listener.url.origin) return new Response("Cross-origin request", { status: 403 });
      const next = Schema.decodeUnknownSync(Schema.Struct({ scenario: Schema.Literals(["ready", "install", "unavailable", "persistence-failure", "revoke-failure", "cancel-during-save"]) }))(await incoming.json());
      scenario = next.scenario;
      wizard = start();
      await publish();

      return Response.json({ wizardUrl: wizard.url }, { headers });
    }

    return new Response("Not found", { status: 404, headers });
  },
});

async function publish() {
  await writeFile(join(evidence, "session.json"), JSON.stringify({ wizardUrl: wizard.url, approvalUrl: `${server.url.origin}${mount}/approval`, statusUrl: `${server.url.origin}${mount}/status`, scenarioUrl: `${server.url.origin}${mount}/scenario` }, null, 2), { mode: 0o600 });
  await writeFile(join(evidence, "result.json"), JSON.stringify(summary(), null, 2), { mode: 0o600 });
}

let wizard = start();

await publish();

const timer = setInterval(() => { void publish(); }, 1000);

async function close() {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  await publish();
  wizard.close();
  server.stop(true);
  await companion.close();
  await rm(workspace, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

process.on("SIGINT", () => { void close(); });

process.on("SIGTERM", () => { void close(); });

console.log(JSON.stringify({ evidence, sessionFile: join(evidence, "session.json"), wizardUrl: wizard.url }));

async function waitUntil(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(60);
  }

  throw new Error(`Timed out: ${label}`);
}

async function client() {
  const html = await (await fetch(wizard.url)).text();
  const session = /const session=("[A-Za-z0-9_-]+");/.exec(html)?.[1];
  assert(session, "The production browser page must include its setup session.");
  const secret = Schema.decodeUnknownSync(Schema.String)(JSON.parse(session));

  const api = async (action: string, body?: { id?: string }) => {
    const response = await fetch(`${wizard.url}/api/${action}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Labora-Session": secret, Origin: new URL(wizard.url).origin },
      body: body ? JSON.stringify(body) : undefined,
    });

    assert(response.ok, `Wizard ${action} returned ${response.status}`);

    return response.json();
  };

  await waitUntil(async () => { await api("status");

 return wizard.state().stage === "choose"; }, "computer discovery");

  return api;
}

async function approve() {
  const bridge = `${server.url.origin}${mount}/approval`;
  const response = await fetch(bridge);
  const html = await response.text();
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(csrf && action && cookie, "Companion approval form and cookie must be present.");
  const approved = await fetch(action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: server.url.origin, Cookie: cookie }, body: new URLSearchParams({ csrf, decision: "approve" }) });
  assert.equal(approved.status, 200);
}

async function verifyLifecycle() {
  scenario = "persistence-failure";
  wizard = start();
  let api = await client();
  await api("connect", { id: "review-pc" });
  await approve();
  await waitUntil(() => wizard.state().stage === "choose" && Boolean(wizard.state().error), "save failure cleanup");
  assert(!wizard.state().cleanupPending);
  assert.match(wizard.state().error ?? "", /could not save/);
  record("Local persistence failure returned to selection after confirmed remote revocation.");

  scenario = "revoke-failure";
  wizard = start();
  api = await client();
  await api("connect", { id: "review-pc" });
  await approve();
  await waitUntil(() => Boolean(wizard.state().cleanupPending), "revocation failure diagnostic");
  assert.match(wizard.state().error ?? "", /cancell|revok/i);
  revokeFailure = false;
  await api("cleanup", {});
  assert(!wizard.state().cleanupPending);
  record("A failed cancellation stayed visible and retry completed remote revocation.");

  scenario = "ready";
  wizard = start();
  api = await client();
  await api("connect", { id: "review-pc" });
  await api("cancel", {});
  assert.equal(wizard.state().stage, "choose");
  assert.equal(connected, undefined);
  record("Cancellation before consent returned to computer selection without creating a connection.");

  scenario = "cancel-during-save";
  wizard = start();
  api = await client();
  await api("connect", { id: "review-pc" });
  await approve();
  await waitUntil(() => Boolean(connected), "credential persistence before acknowledgment");
  await api("cancel", {});
  await Bun.sleep(900);
  assert.equal(connected, undefined, "Cancelling during local persistence must remove the saved connection.");
  assert.equal(wizard.state().stage, "choose");
  record("Cancellation during local persistence removed the saved connection and never activated it.");
}

if (process.argv.includes("--lifecycle")) {
  try {
    await verifyLifecycle();
    await writeFile(join(evidence, "lifecycle.json"), JSON.stringify({ passed: true, checks, proofBoundary: summary().proofBoundary }, null, 2));
  } catch (cause) {
    process.exitCode = 1;
    await writeFile(join(evidence, "lifecycle.json"), JSON.stringify({ passed: false, error: cause instanceof Error ? cause.message : String(cause), checks, proofBoundary: summary().proofBoundary }, null, 2));
    console.error(cause instanceof Error ? cause.message : "Lifecycle verification failed.");
  } finally { await close(); }
}
