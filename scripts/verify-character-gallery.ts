import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { launch, connectStdio } from "@gpuix/react/automation";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { collectionCharacters } from "../src/desktop/avatars";

const workspace = await mkdtemp("/private/tmp/labora-gallery-");

const evidence = resolve(process.env.LABORA_GALLERY_EVIDENCE ?? "evidence/character-gallery");

const profile = join(workspace, "profile");

await mkdir(profile, { recursive: true });

await mkdir(evidence, { recursive: true });

const host = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Gallery verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "none") });

let rejectNext = false;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  if (request.method === "PATCH" && new URL(request.url).pathname.endsWith("/gallery")) {
    await Bun.sleep(200);

    if (rejectNext) { rejectNext = false;

 return Response.json({ error: { message: "Character could not be saved" } }, { status: 503 }); }
  }

  return host.fetch(request);
} });

const connection = await pairComputer(server.url.origin, (await host.issuePairingCode()).code);

const client = computerClient(connection);

await client.createBot({ id: "gallery", name: "Labo", color: "#dfb845" });

await Bun.write(join(profile, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/gallery`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: [] }));

const socketPath = join(workspace, "gallery.sock");

const app = await launch({ command: process.execPath, args: ["scripts/character-gallery-fixture.tsx"], cwd: process.cwd(), env: { ...process.env, LABORA_SHORTCUT_DISABLED: "1", LABORA_DESKTOP_DATA_DIR: profile, LABORA_GALLERY_SOCKET: socketPath, GPUIX_BACKGROUND: "0" } });

let gallery: Awaited<ReturnType<typeof connectStdio>> | undefined;

const frames: string[] = [];

const checks: string[] = [];

async function capture(target: typeof app, name: string) { const path = join(evidence, `${name}.png`); await target.screenshot({ path }); frames.push(path); }

async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 30000;

 while (!await check()) { assert(Date.now() < deadline, "State did not settle"); await Bun.sleep(100); } }

async function attach() { await until(async () => existsSync(socketPath)); const socket = connect(socketPath); await new Promise<void>((done) => socket.once("connect", done));

 return connectStdio({ write: (chunk) => { socket.write(chunk); }, feed: (listener) => { socket.on("data", (chunk) => listener(chunk.toString())); }, close: async () => { socket.end(); } }); }

try {
  await app.getByTestId("edit-bot-color").waitFor({ timeoutMs: 30000 });
  await app.getByTestId("edit-bot-color").click();
  await capture(app, "plus-button");
  const plus = await app.getByTestId("edit-color-more").bounds();
  const pebble = await app.getByTestId("edit-color-#ececec").bounds();
  assert(Math.abs(plus.y - pebble.y) <= 5, "Plus stays beside the six pets");
  await app.getByTestId("edit-color-more").click();
  gallery = await attach();
  await gallery.getByTestId("character-window").waitFor();
  await gallery.getByTestId("character-scout").click();
  await Bun.sleep(1200);
  await capture(gallery, "gallery");
  console.log("Gallery screenshot ready", evidence);
  const initial = await gallery.call("initialize", { protocolVersion: 1, client: "gallery-verification" });
  await app.getByTestId("edit-color-more").click();
  assert.equal((await gallery.call("initialize", { protocolVersion: 1, client: "gallery-verification" })).pid, initial.pid);
  checks.push("Plus opens a separate native window and reuses it");

  for (const [index, character] of collectionCharacters.entries()) {
    if (index === 20) { await gallery.call("scrollTo", { elementId: (await gallery.getByTestId("character-grid").element()).id, x: 0, y: -450 }); await Bun.sleep(200); }

    await gallery.getByTestId(`character-${character.name.toLowerCase()}`).click();
    await gallery.getByTestId("character-use").click();
    await until(async () => (await client.bots())[0]?.color === character.color);
    await app.getByTestId(`avatar3d-ready-${character.name.toLowerCase()}-80`).waitFor();
    await gallery.getByText("Selected").waitFor();
    await capture(gallery, `selected-${character.name.toLowerCase()}`);
  }

  checks.push("All 24 pets render, save through the companion, and update the main profile");
  await gallery.call("scrollTo", { elementId: (await gallery.getByTestId("character-grid").element()).id, x: 0, y: 0 });
  await Bun.sleep(200);
  rejectNext = true;
  await gallery.getByTestId("character-scout").click();
  await gallery.getByTestId("character-use").click();
  await gallery.getByText("Character could not be saved").waitFor();
  assert.equal((await client.bots())[0]?.color, collectionCharacters[23]!.color);
  await capture(gallery, "save-error");
  await gallery.getByTestId("character-use").click();
  await until(async () => (await client.bots())[0]?.color === collectionCharacters[0]!.color);
  checks.push("Failed save preserves the prior character and supports retry");
  const resize = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${initial.pid}) to set size of window 1 to {760, 540}`]);
  assert.equal(await resize.exited, 0);
  await Bun.sleep(500);
  const use = await gallery.getByTestId("character-use").bounds();
  const grid = await gallery.getByTestId("character-grid").bounds();
  assert(use.x >= grid.x + grid.width && use.x + use.width <= 760, "Preview and grid do not overlap at minimum width");
  await capture(gallery, "minimum-window");
  await gallery.getByTestId("character-use").press("escape");
  gallery = undefined;
  await Bun.sleep(600);
  await app.getByTestId("edit-color-more").click();
  gallery = await attach();
  await gallery.getByText("Selected").waitFor();
  await capture(gallery, "reopened-selection");
  checks.push("Minimum window fits; Escape closes; reopening restores saved selection");
  await capture(app, "selected-main-profile");
  await Bun.write(join(evidence, "results.json"), JSON.stringify({ checks, workspace }, null, 2));
  console.log(JSON.stringify({ checks, evidence }));
} finally {
  await gallery?.close().catch(() => undefined);
  await app.close();
  await host.close();
  server.stop(true);

  if (frames.length) {
    const timeline = join(evidence, "frames.txt");
    await Bun.write(timeline, frames.map((path) => `file '${path}'\nduration 0.8`).join("\n") + `\nfile '${frames.at(-1)}'\n`);
    const encoder = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", timeline, "-vf", "scale=1200:900:force_original_aspect_ratio=decrease,pad=1200:900:(ow-iw)/2:(oh-ih)/2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, "walkthrough.mp4")]);
    await encoder.exited;
  }
}
