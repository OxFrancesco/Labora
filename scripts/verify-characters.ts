import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { characters } from "../src/desktop/avatars";
import { openDesktop } from "./desktop-driver";

const source = process.argv.includes("--source");

const baseline = process.argv.includes("--baseline");

const workspace = await mkdtemp("/private/tmp/labora-characters-");

const profileDirectory = join(workspace, "profile");

const evidenceDirectory = resolve("evidence", baseline ? "characters-before" : "characters-after");

await mkdir(profileDirectory, { recursive: true });

await mkdir(evidenceDirectory, { recursive: true });

const companion = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Character verification", agentFactory: createAgentHttpHandler });

let rejectNext = false;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  if (request.method === "PATCH" && new URL(request.url).pathname.endsWith("/character")) {
    await Bun.sleep(400);

    if (rejectNext) { rejectNext = false;

 return Response.json({ error: { message: "Controlled save failure" } }, { status: 503 }); }
  }

  return companion.fetch(request);
} });

const connection = await pairComputer(server.url.origin, (await companion.issuePairingCode()).code);

const client = computerClient(connection);

await client.createBot({ id: "character", name: "Character test", color: "#ececec" });

await Bun.write(join(profileDirectory, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/character`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: [] }));

const executable = process.argv.find((argument) => argument.startsWith("--executable="))?.slice(13);

const driver = await openDesktop({ source, executable, profileDirectory, evidenceDirectory, foreground: true });

const app = driver.app;

const times: { character: string; milliseconds: number }[] = [];

const checks: string[] = [];

let pickerMs = 0;

let failure: Error | undefined;

async function waitFor(check: () => Promise<boolean>) {
  const deadline = performance.now() + 15000;

  while (!await check()) {
    assert(performance.now() < deadline, "Character state did not settle");
    await Bun.sleep(10);
  }
}

async function avatarPixels(path: string, bounds: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const ffmpeg = Bun.which("ffmpeg");

  if (!ffmpeg) throw new Error("ffmpeg is required to verify native 3D interaction.");

  const screenshot = Buffer.from(await Bun.file(path).arrayBuffer());
  const scale = screenshot.readUInt32BE(16) / 1224;
  const crop = [bounds.width, bounds.height, bounds.x, bounds.y].map((value) => Math.round(value * scale)).join(":");
  const child = Bun.spawn([ffmpeg, "-loglevel", "error", "-i", path, "-vf", `crop=${crop}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const [pixels, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);

  return Buffer.from(pixels);
}

try {
  await app.getByTestId("composer").waitFor();
  await app.getByTestId("avatar3d-ready-pebble-80").waitFor({ timeoutMs: 30000 });
  let started = performance.now();
  await app.getByTestId("edit-bot-color").click();

  for (const character of characters) await app.getByTestId(`avatar3d-ready-${character.name.toLowerCase()}-36`).waitFor({ timeoutMs: 30000 });
  await app.call("getPaintedText", {});
  pickerMs = performance.now() - started;
  await driver.screenshot("02-picker-ready");

  for (const character of characters) {
    if (!await app.getByTestId(`edit-color-${character.color}`).count()) await app.getByTestId("edit-bot-color").click();
    started = performance.now();
    await app.getByTestId(`edit-color-${character.color}`).click();
    await waitFor(async () => await app.getByTestId(`avatar3d-ready-${character.name.toLowerCase()}-80`).count() > 0);
    await app.call("getPaintedText", {});
    times.push({ character: character.name, milliseconds: performance.now() - started });
    await waitFor(async () => (await client.bots())[0]?.color === character.color);
  }

  await driver.screenshot("03-character-changed");

  if (!baseline) {
    assert.equal(await app.getByTestId("edit-bot-label").count(), 0);
    assert.ok(!(await app.getByTestId("app-layout").textContent()).includes("Add a label"));
    checks.push("Agent label UI removed");
    rejectNext = true;
    await app.getByTestId("edit-bot-color").click();
    await app.getByTestId("edit-color-#8450e5").click();
    await app.getByTestId("avatar3d-ready-spark-80").waitFor();
    await waitFor(async () => await app.getByTestId("avatar3d-ready-pebble-80").count() > 0);
    assert.equal((await client.bots())[0]?.color, "#ececec");
    checks.push("A failed character save rolls back to the confirmed selection");
    await app.getByTestId("edit-bot-color").click();
    await app.getByTestId("edit-color-#8450e5").click();
    await app.getByTestId("edit-bot-color").click();
    await app.getByTestId("edit-color-#0788e9").click();
    await app.getByTestId("edit-bot-color").click();
    await app.getByTestId("edit-color-#f42846").click();
    await waitFor(async () => (await client.bots())[0]?.color === "#f42846");
    await app.getByTestId("avatar3d-ready-pyramid-80").waitFor();
    checks.push("Rapid changes persist the latest selection, despite delayed acknowledgements");
    await driver.screenshot("04-latest-selection");
    const bounds = await app.getByTestId("avatar3d-view-pyramid-80").bounds();
    await app.mouse.move({ x: bounds.x + bounds.width * 0.2, y: bounds.y + bounds.height * 0.7 });
    const initial = await avatarPixels(await driver.screenshot("05-initial-pose"), bounds);
    await app.mouse.move({ x: bounds.x + bounds.width * 0.88, y: bounds.y + bounds.height * 0.25 });
    let changed = 0;
    await waitFor(async () => {
      const next = await avatarPixels(await driver.screenshot("06-turned-pose"), bounds);
      changed = 0;

      for (let offset = 0; offset < initial.length; offset += 4) {
        if (!initial.subarray(offset, offset + 4).equals(next.subarray(offset, offset + 4))) changed++;
      }

      return changed > 1000;
    });
    checks.push(`The 3D character still responds to pointer movement (${changed} changed avatar pixels)`);
  }

  assert.ok(pickerMs < 150, `Opening character images took ${pickerMs.toFixed(1)} ms`);
  assert.ok(times.every((sample) => sample.milliseconds < 100), `Character changes must paint before the 400 ms save acknowledgement: ${JSON.stringify(times)}`);
  checks.push("Picker appears within 150 ms and every character change paints within 100 ms while saves take 400 ms");
} catch (error) { failure = error instanceof Error ? error : new Error(String(error)); await driver.screenshot("failure"); }
finally {
  await driver.close();
  await server.stop(true);
  await companion.close();
  await Bun.write(join(evidenceDirectory, "result.json"), JSON.stringify({ ok: !failure, pickerMs, times, checks, error: failure?.message, boundary: "Native UI with real local companion and delayed/failed PATCH responses; no personal bot edits." }, null, 2));

  if (!failure) await rm(workspace, { recursive: true, force: true });
}

console.log(JSON.stringify({ pickerMs, times, checks, error: failure?.message }));

if (failure) throw failure;
