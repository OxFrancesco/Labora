import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import { Computer, PairResponse, type ActionsRequest, type ControlRequest } from "../src/computer/contracts";

const directory = resolve("artifacts/computer-e2e");

await mkdir(directory, { recursive: true });

const privateDirectory = await mkdtemp(join(tmpdir(), "labora-computer-e2e-"));

const secret = randomBytes(32).toString("base64url");

const envFile = join(privateDirectory, "container.env");

await writeFile(envFile, `LABORA_MANAGEMENT_TOKEN=${secret}\nLABORA_COMPUTER_NAME=Labora isolated Linux\n`, { mode: 0o600 });

const command = async (argv: string[], includeStderr = false) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  if (exitCode !== 0) throw new Error(`${argv[0]} failed: ${stderr.slice(-1200)}`);

  return `${stdout}${includeStderr ? stderr : ""}`.trim();
};

const existing = await command(["docker", "ps", "-q", "--filter", "label=org.labora.computer-e2e=true"]);

if (existing) throw new Error("A Labora computer E2E container is already running; inspect its owner before another test");

let containerId = "";

let recording = false;

let recordLoop: Promise<void> | undefined;

let keepContainer = false;

const results: string[] = [];

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); results.push(message); };

try {
  containerId = await command(["docker", "run", "-d", "--platform", "linux/amd64", "--label", "org.labora.computer-e2e=true", "--env-file", envFile,
    "-p", "127.0.0.1::7778", "labora-computer:e2e"]);
  const binding = await command(["docker", "port", containerId, "7778/tcp"]);
  let base = `http://${binding}`;

  const waitReady = async () => {
    const end = Date.now() + 90_000;
    let polls = 0;

    while (Date.now() < end) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* The container is starting. */ }

      if (polls++ % 10 === 0 && await command(["docker", "inspect", "--format", "{{.State.Running}}", containerId]) === "false") {
        const logs = await command(["docker", "logs", containerId], true);
        throw new Error(`Test container stopped: ${logs.replaceAll(secret, "[redacted]").slice(-4000)}`);
      }

      await Bun.sleep(200);
    }

    throw new Error("Companion did not start within 90 seconds");
  };

  await waitReady();
  check((await fetch(`${base}/v1/computer`)).status === 401, "unauthorized computer request rejected");

  const issue = async () => {
    const response = await fetch(`${base}/_labora/pair`, { method: "POST", headers: { "X-Labora-Management": secret } });

    if (!response.ok) throw new Error("Management pairing failed");

    return Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await response.json());
  };

  const first = await issue();
  const wrong = first.code === "00000000" ? "11111111" : "00000000";

  for (let index = 0; index < 5; index += 1) await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: wrong, clientName: "E2E" }) });
  const exhausted = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: first.code, clientName: "E2E" }) });
  check(exhausted.status === 403, "pairing rejects correct code after five failed attempts");
  const next = await issue();
  const pairResponse = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: next.code, clientName: "Labora Linux E2E" }) });
  const paired = Schema.decodeUnknownSync(PairResponse)(await pairResponse.json());
  const headers = { Authorization: `Bearer ${paired.token}`, "X-Computer-Id": paired.computer.id, "Content-Type": "application/json" };
  check(paired.computer.platform === "linux" && paired.computer.capabilities.includes("capture") && paired.computer.capabilities.includes("input"), "real X11 capture and input capabilities available");
  const reuse = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: next.code, clientName: "E2E replay" }) });
  check(reuse.status === 403, "successful pairing code is single-use");

  const frame = async (name?: string) => {
    const response = await fetch(`${base}/v1/displays/x11/frame`, { headers });

    if (!response.ok) throw new Error(`Capture failed ${await response.text()}`);
    const png = new Uint8Array(await response.arrayBuffer());

    if (name) await Bun.write(join(directory, name), png);
    const id = response.headers.get("X-Frame-Id");

    if (!id) throw new Error("Capture ID missing");

    return id;
  };

  const firstFrame = await frame("linux-before.png");
  const post = (path: string, body: ActionsRequest | ControlRequest) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const blocked = await post("/v1/actions", { requestId: crypto.randomUUID(), frameId: firstFrame, displayId: "x11", actor: "agent", actions: [{ type: "move", x: 1, y: 1 }] });
  check(blocked.status === 409, "agent input pauses while user controls computer");
  await command(["docker", "exec", "-d", containerId, "xterm", "-T", "Labora E2E", "-geometry", "100x26+40+60", "-e", "sh", "-c", "printf 'Labora isolated Linux desktop\n\nType below through the authenticated computer API.\n'; cat > /tmp/labora-e2e-input.txt"]);
  const deadline = Date.now() + 10_000;
  let window = "";

  while (Date.now() < deadline && !window) {
    try { window = (await command(["docker", "exec", containerId, "xdotool", "search", "--name", "Labora E2E"])).split("\n")[0] ?? ""; } catch { await Bun.sleep(100); }
  }

  if (!window) throw new Error("Isolated test terminal did not start");
  await command(["docker", "exec", containerId, "xdotool", "windowactivate", "--sync", window]);
  recording = true;
  recordLoop = (async () => {
    let index = 0;

    while (recording && index < 100) {
      await frame(`frame-${String(index).padStart(3, "0")}.png`);
      index += 1; await Bun.sleep(200);
    }
  })();
  await post("/v1/control", { owner: "agent" });
  const marker = `Verified through Labora computer API ${new Date().toISOString()}`;

  const request: ActionsRequest = { requestId: crypto.randomUUID(), frameId: await frame(), displayId: "x11", actor: "agent", actions: [
    { type: "click", x: 240, y: 240, button: "left", count: 1 },
    { type: "type", text: marker }, { type: "key", key: "Enter" },
    { type: "move", x: 360, y: 320 }, { type: "pointer_down", x: 360, y: 320, button: "left" }, { type: "pointer_up", x: 380, y: 340, button: "left" },
    { type: "scroll", x: 380, y: 340, deltaX: 0, deltaY: 40 },
  ] };

  const actions = await post("/v1/actions", request);

  if (!actions.ok) throw new Error(`Desktop action batch failed: ${await actions.text()}`);
  check(actions.ok, `desktop action batch succeeds (${actions.status})`);
  const typed = await command(["docker", "exec", containerId, "cat", "/tmp/labora-e2e-input.txt"]);
  check(typed === marker, "actual X11 typed text and Return reached the test terminal");
  check((await post("/v1/actions", request)).status === 409, "duplicate input request rejected without replay");
  await post("/v1/control", { owner: "user" });
  check((await post("/v1/actions", { ...request, requestId: crypto.randomUUID() })).status === 409, "human takeover blocks further agent input");

  const pointerState = () => command(["docker", "exec", containerId, "python3", "-c", `import ctypes
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
d = x.XOpenDisplay(None)
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
w = x.XDefaultRootWindow(d)
root, child = ctypes.c_ulong(), ctypes.c_ulong()
rx, ry, wx, wy = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
mask = ctypes.c_uint()
x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
x.XQueryPointer(d, w, ctypes.byref(root), ctypes.byref(child), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
print(mask.value & 256)`]);

  const held = await post("/v1/actions", { requestId: crypto.randomUUID(), frameId: await frame(), displayId: "x11", actor: "user", actions: [{ type: "pointer_down", x: 360, y: 320, button: "left" }] });
  check(held.ok && await pointerState() === "256", "real X11 pointer button is held before disconnect simulation");
  await Bun.sleep(6_200);
  check(await pointerState() === "0", "held pointer releases after input inactivity without changing owner");
  await frame("linux-desktop.png");
  await Bun.sleep(1000);
  recording = false; await recordLoop;
  await command(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "5", "-i", join(directory, "frame-%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(directory, "linux-desktop.mp4")]);
  await command(["docker", "restart", containerId]);
  base = `http://${await command(["docker", "port", containerId, "7778/tcp"])}`;
  await waitReady();
  const restored = await fetch(`${base}/v1/computer`, { headers });
  check(restored.ok && Schema.decodeUnknownSync(Computer)(await restored.json()).id === paired.computer.id, "stable computer identity and paired credential survive process restart");
  const revoked = await fetch(`${base}/v1/clients/self`, { method: "DELETE", headers });
  check(revoked.status === 204 && (await fetch(`${base}/v1/computer`, { headers })).status === 401, "revoked credential loses access immediately");
  await Bun.write(join(directory, "result.json"), JSON.stringify({ checkedAt: new Date().toISOString(), isolatedDocker: true, cloudflareDeployed: false, checks: results, screenshots: ["linux-before.png", "linux-desktop.png"], recording: "linux-desktop.mp4" }, null, 2));

  if (process.argv.includes("--keep")) {
    await writeFile(join(privateDirectory, "connection.json"), JSON.stringify({ containerId, url: base, managementToken: secret }), { mode: 0o600 });
    keepContainer = true;
  }

  console.log(JSON.stringify({ passed: results.length, artifacts: directory, privateConnectionFile: keepContainer ? join(privateDirectory, "connection.json") : null }));
} finally {
  recording = false;
  await recordLoop?.catch(() => undefined);

  if (!keepContainer) {
    if (containerId) await command(["docker", "rm", "-f", containerId]).catch(() => undefined);
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
