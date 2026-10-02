import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { computerClient, normalizeEndpoint } from "../src/desktop/client";
import { Connection } from "../src/desktop/store";
import { openDesktop } from "./desktop-driver";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { endpoint: { type: "string" }, connection: { type: "string" }, source: { type: "boolean" } },
});

if (!values.endpoint || !values.connection) throw new Error("Use --endpoint HTTPS_URL --connection PRIVATE_CONNECTION_FILE [--source].");

const endpoint = normalizeEndpoint(values.endpoint);

const settings = Schema.decodeUnknownSync(Schema.Struct({ containerId: Schema.String, url: Schema.String, managementToken: Schema.String }))(
  await Bun.file(values.connection).json(),
);

const root = resolve(import.meta.dir, "..");

const directory = join(root, "evidence", `desktop-computer-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const profileDirectory = await mkdtemp("/private/tmp/labora-remote-ui-");

const marker = `Typed through Labora native Computer tab ${crypto.randomUUID()}`;

const resultFile = `/tmp/labora-native-${crypto.randomUUID()}.txt`;

const title = `Labora Native ${crypto.randomUUID()}`;

const pointerTitle = `Labora Pointer ${crypto.randomUUID()}`;

const pointerLog = `/tmp/labora-pointer-${crypto.randomUUID()}.txt`;

const checks: string[] = [];

await mkdir(directory, { recursive: true });

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.slice(-1200)}`);

  return stdout.trim();
}

async function waitUntil(label: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (await check()) return;

    await Bun.sleep(150);
  }

  throw new Error(`Timed out: ${label}`);
}

async function connection() {
  const file = Bun.file(join(profileDirectory, "desktop.json"));

  if (!await file.exists()) return undefined;

  return Schema.decodeUnknownSync(Schema.Struct({ connections: Schema.Array(Connection) }))(await file.json()).connections[0];
}

const expectedLabel = await command(["docker", "inspect", "--format", "{{index .Config.Labels \"org.labora.computer-e2e\"}}", settings.containerId]);

assert.equal(expectedLabel, "true", "Only the explicitly isolated Labora E2E container can receive fixture setup");

assert((await fetch(`${endpoint}/health`)).ok, "The remote companion must be available through HTTPS");

await command([
  "docker", "exec", "-d", "--user", "bun", "--env", "DISPLAY=:99", settings.containerId,
  "xterm", "-T", title, "-geometry", "100x26+40+60", "-e", "sh", "-c",
  `printf 'Labora native desktop verification\n\nInput below arrives through the Computer tab.\n\n'; cat > '${resultFile}'`,
]);

let window = "";

await waitUntil("isolated terminal window", async () => {
  window = await command(["docker", "exec", settings.containerId, "xdotool", "search", "--name", title]).catch(() => "");

  return Boolean(window);
});

assert(/^\d+$/.test(window), "The fixture must have exactly one X11 window");

await command(["docker", "exec", settings.containerId, "xdotool", "windowactivate", "--sync", window]);

await command(["docker", "exec", settings.containerId, "xdotool", "mousemove", "20", "20"]);

await command([
  "docker", "exec", "-d", "--user", "bun", "--env", "DISPLAY=:99", settings.containerId, "sh", "-c",
  `exec stdbuf -oL xev -1 -event button -geometry 360x220+720+80 -name '${pointerTitle}' > '${pointerLog}'`,
]);

let pointerWindow = "";

await waitUntil("independent X11 pointer receiver", async () => {
  pointerWindow = await command(["docker", "exec", settings.containerId, "xdotool", "search", "--name", pointerTitle]).catch(() => "");

  return Boolean(pointerWindow);
});

assert(/^\d+$/.test(pointerWindow), "The pointer fixture must have exactly one X11 window");

await command(["docker", "exec", settings.containerId, "xdotool", "windowactivate", "--sync", window]);

const pairingResponse = await fetch(`${settings.url}/_labora/pair`, {
  method: "POST", headers: { "X-Labora-Management": settings.managementToken },
});

assert(pairingResponse.ok, "The isolated companion must issue a fresh pairing code");

const pairing = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await pairingResponse.json());

const driver = await openDesktop({ profileDirectory, evidenceDirectory: directory, source: values.source });

const app = driver.app;

let linked: Connection | undefined;

let failure: Error | undefined;

try {
  await app.getByTestId("sidebar-new").waitFor({ timeoutMs: 20_000 });
  await app.getByTestId("sidebar-new").click();
  await app.getByTestId("computer-address").fill(endpoint);
  await app.getByTestId("pairing-code").fill(pairing.code);
  await app.getByTestId("pair-computer").click();
  await waitUntil("computer paired through native UI", async () => Boolean(await connection()));
  linked = await connection();
  assert(linked);
  const client = computerClient(linked);
  const computer = await client.computer();
  assert.equal(computer.platform, "linux");
  assert.equal(computer.permissions.screenCapture, "granted");
  assert.equal(computer.permissions.accessibility, "granted");
  checks.push("Native client pairs with the real isolated Linux computer over Tailscale HTTPS");

  const existingBots = new Set((await client.bots()).map((bot) => bot.id));
  await app.getByTestId("sidebar-new").click();
  await app.getByTestId("new-bot-name").fill("Computer verification");
  await app.getByTestId("create-bot").click();
  await waitUntil("new bot selection is persisted", async () => {
    const created = (await client.bots()).find((bot) => !existingBots.has(bot.id));

    if (!created) return false;

    const saved = Schema.decodeUnknownSync(Schema.Struct({ selected: Schema.String }))(await Bun.file(join(profileDirectory, "desktop.json")).json());

    return saved.selected.endsWith(`/${created.id}`);
  });
  await app.getByTestId("tab-computer").waitFor({ timeoutMs: 20_000 });
  await app.getByTestId("tab-computer").click();
  await app.getByTestId("computer-frame").waitFor({ timeoutMs: 20_000 });
  await driver.screenshot("01-linux-preview");
  checks.push("The Computer tab renders an actual captured Linux desktop");

  await client.control("agent");
  await app.getByTestId("computer-open").click();
  await waitUntil("take control button", async () => (await app.call("getPaintedText", {})).text.includes("Take control"));
  await app.getByTestId("computer-control").click();
  await app.getByTestId("computer-type").waitFor();
  await waitUntil("user owns control", async () => (await client.computer()).controlOwner === "user");
  await driver.screenshot("02-user-control");
  checks.push("The native Take control button transfers input ownership to the user");

  const display = computer.displays[0];
  assert(display);
  const frame = await client.frame(display.id);
  const bounds = await app.getByTestId("computer-frame").bounds();
  const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);

  const point = {
    x: bounds.x + (bounds.width - frame.width * scale) / 2 + 180 * scale,
    y: bounds.y + (bounds.height - frame.height * scale) / 2 + 190 * scale,
  };

  await app.mouse.click(point);
  await waitUntil("native pointer coordinate reaches Linux", async () => {
    const position = await command(["docker", "exec", settings.containerId, "xdotool", "getmouselocation", "--shell"]);
    const x = Number(/^X=(\d+)$/m.exec(position)?.[1]);
    const y = Number(/^Y=(\d+)$/m.exec(position)?.[1]);

    return Math.abs(x - 180) <= 3 && Math.abs(y - 190) <= 3;
  });
  await app.getByTestId("computer-type").fill(marker);
  await app.getByTestId("computer-type-send").click();
  await waitUntil("text input submitted", async () => !(await app.call("getPaintedText", {})).text.includes(marker));
  await app.getByTestId("computer-frame").press("enter");
  await waitUntil("remote terminal input readback", async () => await command(["docker", "exec", settings.containerId, "cat", resultFile]) === marker);
  await writeFile(join(directory, "terminal-readback.txt"), await command(["docker", "exec", settings.containerId, "cat", resultFile]));
  await Bun.sleep(800);
  await driver.screenshot("03-typed-linux-terminal");
  checks.push("Native pointer click, text input, and Return reach the actual X11 terminal and match independent file readback");

  await command(["docker", "exec", settings.containerId, "xdotool", "windowactivate", "--sync", pointerWindow]);
  const geometry = await command(["docker", "exec", settings.containerId, "xdotool", "getwindowgeometry", "--shell", pointerWindow]);
  const pointerX = Number(/^X=(\d+)$/m.exec(geometry)?.[1]) + 100;
  const pointerY = Number(/^Y=(\d+)$/m.exec(geometry)?.[1]) + 100;
  assert(Number.isFinite(pointerX) && Number.isFinite(pointerY));

  const receiverPoint = {
    x: bounds.x + (bounds.width - frame.width * scale) / 2 + pointerX * scale,
    y: bounds.y + (bounds.height - frame.height * scale) / 2 + pointerY * scale,
  };

  for (const [button, gpuixButton, x11Button] of [["right", 2, 3], ["middle", 1, 2]] as const) {
    const previous = await command(["docker", "exec", settings.containerId, "cat", pointerLog]);
    await app.mouse.click(receiverPoint, { button: gpuixButton });
    await waitUntil(`independent X11 ${button} click`, async () => {
      const next = (await command(["docker", "exec", settings.containerId, "cat", pointerLog])).slice(previous.length);

      return new RegExp(`ButtonPress[^\\n]*button ${x11Button}`).test(next) && new RegExp(`ButtonRelease[^\\n]*button ${x11Button}`).test(next);
    });
    checks.push(`The native computer viewport delivers real ${button} press and release to an independent X11 receiver`);
  }

  await writeFile(join(directory, "x11-pointer-events.txt"), await command(["docker", "exec", settings.containerId, "cat", pointerLog]));
  await driver.screenshot("04-mouse-buttons");
  await app.getByTestId("computer-control").click();
  await waitUntil("control returned to agent", async () => (await client.computer()).controlOwner === "agent");
  await driver.screenshot("05-control-returned");
  checks.push("The native Return control button restores agent ownership");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  await driver.screenshot("failure");
} finally {
  await driver.close();

  if (linked) {
    const response = await fetch(`${linked.endpoint}/v1/clients/self`, {
      method: "DELETE", headers: { Authorization: `Bearer ${linked.token}`, "X-Computer-Id": linked.id },
    });

    assert.equal(response.status, 204, "The E2E client credential must be revoked after the run");
  }

  await command(["docker", "exec", settings.containerId, "xdotool", "windowclose", window]);
  await command(["docker", "exec", settings.containerId, "xdotool", "windowclose", pointerWindow]);
  await command(["docker", "exec", settings.containerId, "rm", "-f", resultFile, pointerLog]);
  await writeFile(join(directory, "verification.json"), JSON.stringify({
    checkedAt: new Date().toISOString(), passed: !failure, executable: driver.executable,
    transport: "Tailscale HTTPS", isolatedDocker: true, cloudflareDeployed: false,
    checks, failure: failure?.message, recording: "walkthrough.mp4",
    limitations: ["No model inference or Executor call", "No macOS Screen Recording or Accessibility proof"],
  }, null, 2));

  if (!failure) await rm(profileDirectory, { recursive: true });
}

console.log(JSON.stringify({ passed: !failure, checks: checks.length, evidence: directory }));

if (failure) throw failure;
