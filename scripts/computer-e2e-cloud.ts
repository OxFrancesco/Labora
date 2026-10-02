import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Schema } from "effect";
import { Computer, PairResponse, type Action } from "../src/computer/contracts";

const origin = new URL(process.argv[2] ?? "");

if (origin.protocol !== "https:" || !/^labora-desktops\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname)) throw new Error("Pass the deployed Labora workers.dev HTTPS origin");

const secret = Schema.decodeUnknownSync(Schema.Struct({ LABORA_ADMIN_TOKEN: Schema.String }))(await Bun.file(".labora/cloud-admin.json").json());

const adminHeaders = { Authorization: `Bearer ${secret.LABORA_ADMIN_TOKEN}`, "Content-Type": "application/json" };

const directory = resolve("artifacts/computer-cloud-e2e");

await mkdir(directory, { recursive: true });

for (const name of await readdir(directory)) if (/^frame-\d+\.png$/.test(name)) await rm(join(directory, name));

const desktopId = "verification-20261002";

const botId = "cloud-verification";

const checks: string[] = [];

let created = false;

let suspended = false;

let recording = false;

let recordingTask: Promise<void> | undefined;

let frameIndex = 0;

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); checks.push(message); };

const request = (path: string, init?: RequestInit) => fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(120_000) });

const suspend = async () => {
  const response = await request(`/v1/desktops/${desktopId}/suspend`, { method: "POST", headers: adminHeaders });
  const result = Schema.decodeUnknownSync(Schema.Struct({ suspended: Schema.Boolean }))(await response.json());

  if (!response.ok || !result.suspended) throw new Error("Verification desktop could not suspend");
  suspended = true;
};

try {
  check((await request("/v1/desktops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: desktopId, name: "Labora cloud verification" }) })).status === 401, "owner provisioning rejects unauthenticated requests");
  created = true;
  const provision = await request("/v1/desktops", { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: desktopId, name: "Labora cloud verification" }) });

  if (!provision.ok) throw new Error(`Cloud desktop provisioning failed with ${provision.status}: ${(await provision.text()).slice(0, 2000)}`);
  const pairing = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String, code: Schema.String }))(await provision.json());
  const base = pairing.url;
  const pairedResponse = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, clientName: "Labora Cloudflare E2E" }) });

  if (!pairedResponse.ok) throw new Error(`Cloud pairing failed with ${pairedResponse.status}: ${(await pairedResponse.text()).slice(0, 2000)}`);
  const paired = Schema.decodeUnknownSync(PairResponse)(await pairedResponse.json());
  await writeFile(".labora/cloud-verification.json", JSON.stringify({ origin: origin.href, desktopId, base, token: paired.token, computerId: paired.computer.id }), { mode: 0o600 });
  const headers = { Authorization: `Bearer ${paired.token}`, "X-Computer-Id": paired.computer.id, "Content-Type": "application/json" };
  const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(120_000) });
  check(paired.computer.platform === "linux" && paired.computer.capabilities.includes("capture") && paired.computer.capabilities.includes("input"), "Cloudflare container reports real X11 capture and input");
  check((await fetch(`${base}/_labora/pair`, { method: "POST" })).status === 404, "container management pairing path is not publicly routed");
  check((await api("/v1/computer", { headers: { "X-Computer-Id": "wrong-computer" } })).status === 409, "credentials remain bound to the paired computer");

  const frame = async (name?: string) => {
    const response = await api("/v1/displays/x11/frame");

    if (!response.ok) throw new Error(`Cloud capture failed with ${response.status}`);
    const png = new Uint8Array(await response.arrayBuffer());

    if (name) await Bun.write(join(directory, name), png);
    const id = response.headers.get("X-Frame-Id");

    if (!id || png[0] !== 137 || png[1] !== 80) throw new Error("Cloud frame was not an identified PNG");

    return id;
  };

  await frame("cloud-before.png");
  check(true, "live Cloudflare Linux screenshot captured");
  recording = true;
  recordingTask = (async () => {
    while (recording) {
      try { await frame(`frame-${String(frameIndex++).padStart(4, "0")}.png`); } catch { /* The foreground assertions report capture failures. */ }

      await Bun.sleep(500);
    }
  })();

  const actions = async (input: readonly Action[]) => {
    const response = await api("/v1/actions", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), frameId: await frame(), displayId: "x11", actor: "user", actions: input }) });

    if (!response.ok) throw new Error(`Cloud input failed with ${response.status}`);
  };

  const botResponse = await api("/v1/bots", { method: "POST", body: JSON.stringify({ id: botId, name: "Cloud verification", color: "#495970" }) });
  check(botResponse.ok || botResponse.status === 409, "real cloud Pi host provides an isolated bot without model credentials");
  check((await api(`/v1/bots/${botId}/files`)).ok, "cloud bot workspace is available");
  await actions([{ type: "key", key: "Ctrl+Alt+t" }]);
  await Bun.sleep(1200);
  const marker = `Labora Cloudflare verified ${desktopId}`;
  await actions([{ type: "type", text: `printf '%s' '${marker}' > /home/bun/.labora/computer/bots/${botId}/workspace/cloud-proof.txt; printf '\\n${marker}\\n'` }, { type: "key", key: "Enter" }]);
  const proofPath = `/v1/bots/${botId}/files/content?path=cloud-proof.txt`;
  let proof = "";

  for (let attempt = 0; attempt < 15 && proof !== marker; attempt += 1) {
    const response = await api(proofPath);

    if (response.ok) proof = await response.text();

    if (proof !== marker) await Bun.sleep(300);
  }

  check(proof === marker, "keyboard input reached the cloud terminal and wrote a real workspace file");
  await frame("cloud-desktop.png");
  const browser = await api("/v1/browser/markdown", { method: "POST", body: JSON.stringify({ url: "https://example.com/" }) });
  const browserResult = await browser.text();
  await Bun.write(join(directory, "kitesurf-result.json"), browserResult);
  check(browser.ok && browser.headers.get("X-Labora-Browser") === "kitesurf" && browserResult.includes("Example Domain"), "real Kitesurf Worker binding returns public-page Markdown");
  recording = false;
  await recordingTask;
  await suspend();
  check(true, "cloud desktop saved a snapshot and suspended");
  const restored = Schema.decodeUnknownSync(Computer)(await (await api("/v1/computer")).json());
  suspended = false;
  check(restored.id === paired.computer.id, "paired identity and credential survive Cloudflare snapshot restore");
  check(await (await api(proofPath)).text() === marker, "workspace file survives Cloudflare snapshot restore");
  await frame("cloud-restored.png");
  await suspend();
  check(true, "verification container suspended after the final capture");
  const result = { checkedAt: new Date().toISOString(), origin: origin.href, desktopId, checks, suspended, noModelInference: true, screenshots: ["cloud-before.png", "cloud-desktop.png", "cloud-restored.png"] };
  await Bun.write(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: checks.length, desktopId, suspended, artifacts: directory }));
} finally {
  recording = false;
  await recordingTask;

  if (created && !suspended) await suspend();
  await Bun.write(join(directory, "latest-checks.json"), JSON.stringify({ checkedAt: new Date().toISOString(), desktopId, checks, suspended }, null, 2));

  if (frameIndex > 1) {
    const encoder = Bun.spawn(["ffmpeg", "-y", "-framerate", "2", "-i", join(directory, "frame-%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(directory, "cloud-desktop.mp4")], { stdout: "ignore", stderr: "ignore" });
    await encoder.exited;
  }
}
