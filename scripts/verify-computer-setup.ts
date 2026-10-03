import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createComputerHost } from "../src/computer/host";
import { startComputerSetup } from "../src/computer/setup";
import { TailscaleStatus, type createTailscaleAdapter } from "../src/tailscale";

const workspace = await mkdtemp("/private/tmp/labora-setup-");

const evidence = join(resolve(import.meta.dir, ".."), "evidence", `computer-setup-browser-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

await mkdir(evidence, { recursive: true, mode: 0o700 });

const control = `/fixture/${randomBytes(24).toString("hex")}`;

const endpoint = "https://setup-pc.review.ts.net/labora";

const owner = "review@example.invalid";

const companion = await createComputerHost({ dataDir: workspace, name: "Verification PC", macAppPath: join(workspace, "missing.app") });

const node = { id: "setup-pc", name: "Verification PC", dnsName: "setup-pc.review.ts.net", online: true, tagged: false, ownerLogin: owner };

let signedIn = false;

let configured = false;

let loginCalls = 0;

let enableCalls = 0;

let enrollmentCalls = 0;

let disabledCalls = 0;

let completeLogin: (() => void) | undefined;

let setup: Awaited<ReturnType<typeof startComputerSetup>> | undefined;

const checks: string[] = [];

const adapter: ReturnType<typeof createTailscaleAdapter> = {
  async status() {
    if (signedIn) return TailscaleStatus.make({ installed: true, running: true, backendState: "Running", peers: [], self: node, ownerLogin: owner });

    return TailscaleStatus.make({ installed: true, running: false, backendState: "NeedsLogin", peers: [] });
  },
  beginLogin(onAuthUrl) {
    loginCalls += 1;
    let cancel = () => {};

    const done = new Promise<TailscaleStatus>((resolve, reject) => {
      completeLogin = () => { signedIn = true; void adapter.status().then(resolve); };

      cancel = () => reject(new Error("Fixture sign-in cancelled."));
    });

    onAuthUrl("https://login.tailscale.com/a/labora-verification");

    return { done, cancel };
  },
  async ensureServe() {
    assert(signedIn, "Sign-in must finish before sharing is enabled.");
    enableCalls += 1;
    configured = true;

    return { endpoint, changed: true };
  },
  async serveStatus() { return { endpoint, configured, self: node }; },
};

const host = {
  issuePairingCode: () => companion.issuePairingCode(),
  async enableEnrollment(configuration: Parameters<typeof companion.enableEnrollment>[0]) { enrollmentCalls += 1; await companion.enableEnrollment(configuration); },
  disableEnrollment() { disabledCalls += 1; companion.disableEnrollment(); },
};

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, listener) {
  const url = new URL(request.url);
  const peer = listener.requestIP(request)?.address;

  if (peer !== "127.0.0.1" || url.host !== listener.url.host) return new Response("Not found", { status: 404 });

  if (url.pathname === `${control}/status`) return Response.json(summary());

  if (url.pathname.startsWith(`${control}/`) && request.method === "POST") {
    const origin = request.headers.get("origin");

    if (origin && origin !== listener.url.origin) return new Response("Cross-origin", { status: 403 });
    const action = url.pathname.slice(control.length + 1);

    if (action === "complete-login") {
      assert(completeLogin, "Start sign-in in the browser first.");
      completeLogin();
      checks.push("Browser sign-in requested the validated Tailscale link before the fixture completed sign-in.");
    } else if (action === "restore") {
      assert.equal(enableCalls, 1);
      assert.equal((await stat(join(workspace, "enrollment.json"))).mode & 0o777, 0o600);
      await setup?.close();
      setup = await startComputerSetup({ host, dataDir: workspace, port: server.port ?? 0, localOrigin: server.url.origin, adapter });
      assert.equal(enableCalls, 1);
      assert.equal(enrollmentCalls, 2);
      checks.push("Private saved enrollment restored after rechecking the same owner and Serve route without mutating sharing again.");
    } else if (action === "remove-route") {
      configured = false;
      checks.push("The fixture removed its simulated sharing route to exercise recovery.");
    } else return new Response("Not found", { status: 404 });
    await publish();

    return Response.json({ ...summary(), setupUrl: setup?.url });
  }

  return await setup?.fetch(request, peer) ?? companion.fetchFrom(request, peer);
} });

function summary() {
  return { signedIn, configured, loginCalls, enableCalls, enrollmentCalls, disabledCalls, checks, proofBoundary: "Real browser setup page, real companion enrollment configuration and private persisted restore. Tailscale status, sign-in completion and Serve mutation are injected fixtures. No live Tailscale commands, account changes or computer permissions." };
}

async function publish() {
  await writeFile(join(evidence, "session.json"), JSON.stringify({ setupUrl: setup?.url, controlUrl: `${server.url.origin}${control}` }, null, 2), { mode: 0o600 });
  await writeFile(join(evidence, "result.json"), JSON.stringify(summary(), null, 2), { mode: 0o600 });
}

setup = await startComputerSetup({ host, dataDir: workspace, port: server.port ?? 0, localOrigin: server.url.origin, adapter });

assert.equal(enableCalls, 0);

assert.equal(loginCalls, 0);

const missingOrigin = await fetch(`${setup.url}/enable`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

assert.equal(missingOrigin.status, 403);

const hostileOrigin = await fetch(`${setup.url}/enable`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: "{}" });

assert.equal(hostileOrigin.status, 403);

const remote = await setup.fetch(new Request(setup.url, { headers: { Host: server.url.host } }), "100.64.0.1");

assert.equal(remote?.status, 403);

assert.equal(enableCalls, 0);

checks.push("Starting setup performed no sign-in or Serve mutation; missing or foreign Origin and non-loopback peers could not enable access.");

await publish();

const timer = setInterval(() => { void publish(); }, 1000);

let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await publish();
  await setup?.close();
  server.stop(true);
  await companion.close();
  await rm(workspace, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void close(); });

process.on("SIGTERM", () => { void close(); });

console.log(JSON.stringify({ evidence, sessionFile: join(evidence, "session.json"), setupUrl: setup.url }));
