import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient } from "../src/desktop/client";
import { Connection, Draft } from "../src/desktop/store";
import { openDesktop } from "./desktop-driver";

const root = resolve(import.meta.dir, "..");

const workspace = await mkdtemp("/private/tmp/labora-e2e-");

const profileDirectory = join(workspace, "desktop");

const source = process.argv.includes("--source");

const evidenceDirectory = join(root, "evidence", `desktop-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const PreferencesSnapshot = Schema.Struct({
  connections: Schema.Array(Connection), selected: Schema.String,
  drafts: Schema.Array(Draft), compact: Schema.Boolean, detailsOpen: Schema.Boolean, detailsWidth: Schema.Number,
  voiceLocale: Schema.optionalKey(Schema.String),
});

async function preferences() {
  const file = Bun.file(join(profileDirectory, "desktop.json"));

  return await file.exists() ? Schema.decodeUnknownSync(PreferencesSnapshot)(await file.json()) : undefined;
}

async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (await check()) return;

    await Bun.sleep(100);
  }

  throw new Error(`Timed out: ${label}`);
}

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });

  if (await child.exited !== 0) throw new Error(`Verification setup failed: ${args[0]}`);
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

await run([process.execPath, "scripts/build-desktop-helper.ts"]);

if (source) await run([process.execPath, "scripts/build-avatar-renderer.ts"]);

const clipboardFixture = join(root, "dist/labora-clipboard-fixture");

await run([
  "/usr/bin/swiftc", "-O", "-module-cache-path", join(root, "dist/clipboard-module-cache"),
  "-target", `${process.arch}-apple-macosx14.0`, join(root, "native/desktop/ClipboardFixture.swift"), "-o", clipboardFixture,
]);

async function withClipboard(kind: "files" | "image", paths: string[], action: () => Promise<void>): Promise<void> {
  const child = Bun.spawn([clipboardFixture, kind, ...paths], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let message = "";

  while (!message.includes("ready\n")) {
    const next = await reader.read();

    if (next.done) throw new Error("The clipboard fixture did not initialize.");

    message += decoder.decode(next.value);
  }

  try {
    await action();
  } finally {
    child.stdin.write("restore\n");
    child.stdin.end();

    const remainder = (async () => {
      let output = "";

      while (true) {
        const next = await reader.read();

        if (next.done) break;

        output += decoder.decode(next.value);
      }

      reader.releaseLock();

      return output;
    })();

    const [output, error, code] = await Promise.all([remainder, new Response(child.stderr).text(), child.exited]);

    assert.equal(code, 0, error || "Clipboard restoration failed");
    assert(output.includes("restored") || output.includes("preserved-newer-clipboard"), "Clipboard state was not preserved");
  }
}

await mkdir(evidenceDirectory, { recursive: true });

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

async function startComputer() {
  if (source) {
    const companion = await createComputerHost({
      dataDir: join(workspace, "computer"), name: "Verification Mac",
      macAppPath: join(workspace, "unavailable/Labora Computer.app"), agentFactory: createAgentHttpHandler,
    });

    let server: ReturnType<typeof Bun.serve>;

    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: companion.fetch });
    } catch (error) {
      await companion.close();

      throw error;
    }

    const pairing = await companion.issuePairingCode();

    return { endpoint: server.url.origin, code: pairing.code, async close() { await server.stop(true); await companion.close(); } };
  }

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = reservation.port;
  await reservation.stop(true);

  const executable = join(root, "dist/Labora.app/Contents/MacOS/Labora");

  const child = Bun.spawn([executable, "--computer", "--pair-code"], {
    cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LABORA_COMPUTER_HOST: "127.0.0.1", LABORA_COMPUTER_PORT: String(port),
      LABORA_COMPUTER_DATA: join(workspace, "computer"), LABORA_COMPUTER_NAME: "Verification Mac",
      LABORA_COMPUTER_APP: join(workspace, "unavailable/Labora Computer.app"),
      LABORA_AGENT_HOST: "true", LABORA_ALLOW_NETWORK: "false", LABORA_MANAGEMENT_TOKEN: undefined,
    },
  });

  const errorOutput = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const startupTimeout = setTimeout(() => child.kill(), 30_000);
  let output = "";
  let code: string | undefined;

  try {
    while (!code) {
      const next = await reader.read();

      if (next.done) throw new Error(`Packaged companion did not start: ${await errorOutput}`);

      output += decoder.decode(next.value);
      code = /Pairing code: (\d{8})\./.exec(output)?.[1];
    }
  } finally {
    clearTimeout(startupTimeout);
  }

  const drain = (async () => {
    while (!(await reader.read()).done) {}

    reader.releaseLock();
  })();

  return {
    endpoint: `http://127.0.0.1:${port}`, code,
    async close() {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);

      try {
        await child.exited;
        await drain;
        await errorOutput;
      } finally { clearTimeout(timeout); }
    },
  };
}

const computer = await startComputer();

let driver = await openDesktop({ profileDirectory, evidenceDirectory, source }).catch(async (error) => {
  await computer.close();

  throw error;
});

let app = driver.app;

let driverClosed = false;

const steps: string[] = [];

let failure: Error | undefined;

async function step(label: string, name: string, action: () => Promise<void>): Promise<void> {
  await action();
  await driver.screenshot(name);
  steps.push(label);
}

try {
  await app.getByTestId("sidebar-new").waitFor({ timeoutMs: 20_000 });
  await driver.screenshot("01-empty");
  await app.getByTestId("sidebar-new").click();
  await app.getByTestId("connection-advanced").click();
  await app.getByTestId("computer-address").fill(computer.endpoint);
  await app.getByTestId("pairing-code").fill(computer.code === "00000000" ? "11111111" : "00000000");

  await step("An invalid pairing code is rejected through the native dialog", "02-pair-rejected", async () => {
    await app.getByTestId("pair-computer").click();
    await waitUntil("invalid pairing message", async () => (await app.call("getPaintedText", {})).text.some((text) => text.includes("Pairing code is invalid")));
    assert.equal((await preferences())?.connections.length ?? 0, 0);
  });

  await step("The native client pairs with a real isolated companion", "03-paired", async () => {
    await app.getByTestId("pairing-code").fill(computer.code);
    await app.getByTestId("pair-computer").click();
    await waitUntil("saved computer connection", async () => (await preferences())?.connections.length === 1);
  });

  const connection = (await preferences())?.connections[0];

  assert(connection, "The paired computer must persist in the desktop profile");

  const client = computerClient(connection);

  async function createBot(name: string) {
    await app.getByTestId("sidebar-new").click();
    await app.getByTestId("new-bot-name").waitFor();
    await app.getByTestId("new-bot-name").fill(name);
    await app.getByTestId("create-bot").click();
    await waitUntil(`persisted bot ${name}`, async () => (await client.bots()).some((bot) => bot.name === name));

    const bot = (await client.bots()).find((candidate) => candidate.name === name);

    assert(bot, `Bot ${name} was not created`);
    assert(await Bun.file(join(workspace, "computer/bots", bot.id, "bot.json")).exists());
    await app.getByTestId(`bot-${bot.id}`).waitFor();
    const snapshot = await client.messages(bot.id);
    const auth = await client.auth(bot.id);

    assert.equal(snapshot.messages.length, 0, "A new Pi session must start without fixture messages");
    assert.equal(auth.openai, "signed-out", "The isolated Pi process must not inherit provider credentials");
    assert.equal(auth.executor, "signed-out", "The isolated Pi process must not inherit Executor credentials");

    return bot;
  }

  const writing = await createBot("Writing");
  const firstDraft = "Keep this draft when I switch bots.";
  await app.getByTestId("composer").fill(firstDraft);
  const research = await createBot("Research");
  steps.push("Both real Pi workers expose empty sessions and signed-out provider and Executor state");
  const secondDraft = "Check the proposal.";
  await app.getByTestId("composer").fill(secondDraft);

  await step("Two real bots retain separate drafts when switching", "04-drafts", async () => {
    await app.getByTestId(`bot-${writing.id}`).click();
    await waitUntil("Writing draft restored", async () => (await app.call("getPaintedText", {})).text.join("\n").includes(firstDraft));
    await app.getByTestId(`bot-${research.id}`).click();
    await waitUntil("Research draft restored", async () => (await app.call("getPaintedText", {})).text.join("\n").includes(secondDraft));
    await waitUntil("both drafts persisted", async () => {
      const saved = await preferences();

      return saved?.drafts.some((draft) => draft.text === firstDraft) === true && saved.drafts.some((draft) => draft.text === secondDraft);
    });
    assert.equal((await client.bots()).length, 2);
  });

  await step("Settings changes persist and the language menu dismisses without closing Settings", "04-settings-general", async () => {
    await app.getByTestId("sidebar-account").click();
    await app.getByTestId("settings-dialog").waitFor();
    const before = await preferences();
    await app.getByTestId("settings-compact").click();
    await waitUntil("settings sidebar preference", async () => (await preferences())?.compact !== before?.compact);
    await app.getByTestId("settings-compact").click();
    await app.getByTestId("settings-voice-language").click();
    await app.getByTestId("settings-language-en-US").click();
    await waitUntil("voice language saved", async () => (await preferences())?.voiceLocale === "en-US");
    await app.getByTestId("settings-voice-language").click();
    await app.getByTestId("settings-language-en-US").press("escape");
    assert.equal(await app.getByTestId("settings-dialog").count(), 1);
    await waitUntil("language menu dismissed", async () => await app.getByTestId("settings-language-en-US").count() === 0);
  });

  await step("Computer settings show the actual paired companion", "04-settings-computer", async () => {
    await app.getByTestId("settings-section-computer").click();
    await app.getByTestId(`disconnect-${connection.id}`).waitFor();
    const painted = (await app.call("getPaintedText", {})).text.join("\n");
    assert(painted.includes(connection.computer.name) && painted.includes(connection.endpoint));
  });
  await app.getByTestId("sheet-close").click();

  let routineId = "";

  await step("A routine created in the native editor is saved paused", "04-routine-editor", async () => {
    await app.getByTestId("routine-new").click();
    await app.getByTestId("routine-name").fill("Review tomorrow");
    await app.getByTestId("routine-prompt").fill("Summarize the notes in the workspace.");
    await app.getByTestId("routine-once").click();
    await app.getByTestId("routine-at").fill(new Date(Date.now() + 86_400_000).toISOString());
    await driver.screenshot("04-routine-filled");
    await app.getByTestId("routine-save").click();
    await waitUntil("routine persisted", async () => (await client.routines()).some((routine) => routine.name === "Review tomorrow"));
    const saved = (await client.routines()).find((routine) => routine.name === "Review tomorrow");
    assert(saved);
    routineId = saved.id;
    assert.equal(saved.enabled, false);
    assert.equal(saved.botId, research.id);
  });

  await step("Routine enable and pause update the real scheduler", "04-routine-paused", async () => {
    await app.getByTestId("routine-toggle").click();
    await waitUntil("routine enabled", async () => (await client.routines()).find((routine) => routine.id === routineId)?.enabled === true);
    await app.getByTestId("routine-toggle").click();
    await waitUntil("routine paused", async () => (await client.routines()).find((routine) => routine.id === routineId)?.enabled === false);
  });

  await step("A signed-out routine attempt shows its real blocked result without polluting direct chat", "04-routine-blocked", async () => {
    await app.getByTestId("routine-run").click();
    await waitUntil("routine blocked", async () => (await client.routineRuns(routineId)).some((run) => run.status === "blocked"));
    await waitUntil("blocked result visible", async () => (await app.call("getPaintedText", {})).text.some((text) => text.includes("Blocked")));
    assert.equal((await client.messages(research.id)).messages.length, 0);
    await app.getByTestId("routine-results").click();
    await waitUntil("empty routine history", async () => (await app.call("getPaintedText", {})).text.includes("No results yet"));
    await app.getByTestId("routine-results-back").click();
  });
  await app.getByTestId("routine-back").click();

  await step("The details divider responds to a continuous drag", "05-resized", async () => {
    const divider = app.getByTestId("details-divider");
    const before = await divider.bounds();
    await divider.dragBy(-96, 0, { steps: 12 });
    await waitUntil("divider moved", async () => (await divider.bounds()).x < before.x - 40);
  });

  await step("Bot name edits persist and labels are absent", "06-profile-edited", async () => {
    await app.getByTestId("edit-bot-name").click();
    await app.getByTestId("edit-bot-value").fill("Research Notes");
    await app.getByTestId("edit-bot-value").press("enter");
    await waitUntil("bot name saved", async () => (await client.bots()).find((bot) => bot.id === research.id)?.name === "Research Notes");
    assert.equal(await app.getByTestId("edit-bot-label").count(), 0);
  });

  await step("The native character picker renders all six Blender models", "06-character-picker", async () => {
    await app.getByTestId("edit-bot-color").click();

    for (const tint of ["#8450e5", "#0788e9", "#f42846", "#dfb845", "#6ba87b", "#ececec"]) await app.getByTestId(`edit-color-${tint}`).waitFor();

    for (const name of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"]) await app.getByTestId(`avatar3d-ready-${name}-36`).waitFor({ timeoutMs: 30_000 });
  });

  await step("Choosing Star updates the real bot profile", "06-star-selected", async () => {
    await app.getByTestId("edit-color-#dfb845").click();
    await waitUntil("Star character saved", async () => (await client.bots()).find((bot) => bot.id === research.id)?.color === "#dfb845");
    await app.getByTestId("avatar3d-ready-star-80").waitFor({ timeoutMs: 30_000 });
  });

  await step("Moving over the Details avatar rotates its rendered 3D geometry", "06-star-turned", async () => {
    const bounds = await app.getByTestId("avatar3d-view-star-80").bounds();
    await app.mouse.move({ x: bounds.x + bounds.width * 0.2, y: bounds.y + bounds.height * 0.7 });
    await Bun.sleep(250);
    const initial = await avatarPixels(await driver.screenshot("06-star-initial-pose"), bounds);
    await app.mouse.move({ x: bounds.x + bounds.width * 0.88, y: bounds.y + bounds.height * 0.25 });
    let changed = 0;
    await waitUntil("visible native model rotation", async () => {
      const next = await avatarPixels(await driver.screenshot("06-star-pose-check"), bounds);
      changed = 0;

      for (let offset = 0; offset < initial.length; offset += 4) {
        if (!initial.subarray(offset, offset + 4).equals(next.subarray(offset, offset + 4))) changed++;
      }

      return changed > 1000;
    });
    await Bun.write(join(evidenceDirectory, "avatar-interaction.json"), JSON.stringify({ bounds, changedPixels: changed, input: "Native GPUix pointer move", output: "Cropped native-window screenshot pixels" }, null, 2));
  });

  const botWorkspace = join(workspace, "computer/bots", research.id, "workspace");
  await mkdir(botWorkspace, { recursive: true });
  const libraryContent = "# Labora verification\nCreated by the native E2E runner.\n";
  await writeFile(join(botWorkspace, "research.md"), libraryContent);

  for (const [tab, screenshot] of [["details", "06-details"], ["library", "07-library"], ["computer", "08-computer"]] as const) {
    await step(`The ${tab} tab opens in the native right panel`, screenshot, async () => {
      await app.getByTestId(`tab-${tab}`).click();

      if (tab === "library") {
        await app.getByTestId("file-research.md").waitFor();
        assert.equal(await new Response(await client.file(research.id, "research.md")).text(), libraryContent);
      }
    });
  }

  const firstFile = join(workspace, "First note.txt");
  const secondFile = join(workspace, "Second note.txt");
  await writeFile(firstFile, "First attachment\n");
  await writeFile(secondFile, "Second attachment\n");

  await step("Native file clipboard paste preserves attachment order", "09-file-paste", async () => {
    await withClipboard("files", [firstFile, secondFile], async () => {
      await app.getByTestId("composer").click();
      await app.getByTestId("composer").press("cmd-v");
      await app.getByTestId("attachment-1").waitFor();
      assert((await app.getByTestId("attachment-0").textContent()).includes("First note.txt"));
      assert((await app.getByTestId("attachment-1").textContent()).includes("Second note.txt"));
    });
  });

  await step("Removing an attachment leaves the remaining file intact", "10-attachment-removed", async () => {
    await app.getByTestId("remove-attachment-0").click();
    await waitUntil("first attachment removed", async () => await app.getByTestId("attachment-1").count() === 0);
    assert((await app.getByTestId("attachment-0").textContent()).includes("Second note.txt"));
  });

  await step("A real clipboard PNG becomes an attachment", "11-image-paste", async () => {
    await withClipboard("image", [join(evidenceDirectory, "01-empty.png")], async () => {
      await app.getByTestId("composer").click();
      await app.getByTestId("composer").press("cmd-v");
      await app.getByTestId("attachment-1").waitFor();
      assert((await app.getByTestId("attachment-1").textContent()).includes("Pasted image.png"));
    });
  });

  await step("The sidebar expands and its preference persists", "09-sidebar", async () => {
    const before = await preferences();
    await app.getByTestId("sidebar-toggle").click();
    await waitUntil("sidebar preference changed", async () => (await preferences())?.compact !== before?.compact);
  });

  await step("Closing and reopening details preserves the selected draft", "10-restored", async () => {
    await app.getByTestId("details-toggle").click();
    await waitUntil("details closed", async () => await app.getByTestId("details-divider").count() === 0);
    await app.getByTestId("details-toggle").click();
    await app.getByTestId("details-divider").waitFor();
    assert((await app.call("getPaintedText", {})).text.join("\n").includes(secondDraft));
  });

  const beforeRestart = await preferences();
  assert(beforeRestart);
  await waitUntil("attachment paths persisted", async () => (await preferences())?.drafts.find((draft) => draft.text === secondDraft)?.paths.length === 2);
  await driver.close();
  driverClosed = true;
  driver = await openDesktop({ profileDirectory, evidenceDirectory: join(evidenceDirectory, "restart"), source });
  driverClosed = false;
  app = driver.app;

  await step("A new native app process restores the selected bot, draft, ordered attachments, metadata, sidebar, and panel width", "12-restarted", async () => {
    await app.getByTestId("attachment-1").waitFor({ timeoutMs: 20_000 });
    const restored = await preferences();
    assert(restored);
    assert.equal(restored.selected, beforeRestart.selected);
    assert.equal(restored.compact, beforeRestart.compact);
    assert.equal(restored.detailsOpen, true, "Closing immediately after reopening Details must preserve that preference");
    assert.equal(restored.detailsWidth, beforeRestart.detailsWidth);
    assert.equal(restored.voiceLocale, "en-US");
    assert((await app.call("getPaintedText", {})).text.join("\n").includes(secondDraft));
    assert((await app.getByTestId("attachment-0").textContent()).includes("Second note.txt"));
    assert((await app.getByTestId("attachment-1").textContent()).includes("Pasted image.png"));
    await app.getByTestId("avatar3d-ready-star-80").waitFor({ timeoutMs: 30_000 });
    const painted = (await app.call("getPaintedText", {})).text.join("\n");
    assert(painted.includes("Research Notes") && painted.includes("Planning"));
    assert.equal((await client.bots()).find((bot) => bot.id === research.id)?.color, "#dfb845");
    await app.getByTestId(`bot-${writing.id}`).click();
    await waitUntil("Writing draft restored after restart", async () => (await app.call("getPaintedText", {})).text.join("\n").includes(firstDraft));
    await app.getByTestId(`bot-${research.id}`).click();
    await app.getByTestId("attachment-1").waitFor();
  });

  await step("Sending while signed out opens an actionable ChatGPT prompt", "13-sign-in-required", async () => {
    await app.getByTestId("send").click();
    await app.getByTestId("connection-openai").waitFor();
    await waitUntil("painted sign-in prompt", async () => (await app.call("getPaintedText", {})).text.join("\n").includes("Continue with ChatGPT"));
    const text = (await app.call("getPaintedText", {})).text.join("\n");
    assert(text.includes("Sign in with ChatGPT") && text.includes("Continue with ChatGPT"));
    assert(!text.includes("Sign in with your ChatGPT subscription before sending"));
    assert.equal((await client.messages(research.id)).messages.length, 0);
  });

  await step("Closing sign-in preserves the draft and attachments; Enter opens it again", "14-sign-in-retry", async () => {
    await app.getByTestId("sheet-close").click();
    assert((await app.call("getPaintedText", {})).text.join("\n").includes(secondDraft));
    assert((await app.getByTestId("attachment-0").textContent()).includes("Second note.txt"));
    assert((await app.getByTestId("attachment-1").textContent()).includes("Pasted image.png"));
    await app.getByTestId("composer").press("enter");
    await app.getByTestId("connection-openai").waitFor();
    assert.equal((await client.messages(research.id)).messages.length, 0);
  });
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  await driver.screenshot("failure").catch(() => undefined);
} finally {
  if (!driverClosed) await driver.close().catch((error) => { failure ??= error instanceof Error ? error : new Error(String(error)); });
  await computer.close();
  await writeFile(join(evidenceDirectory, "verification.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), executable: driver.executable,
    kind: "Native GPUix client with real isolated companion and bot storage",
    passed: !failure, steps, error: failure?.message,
    limits: ["No provider inference or hosted Executor request", "No OS screen capture or input control", "No native Finder drop or microphone recording", "The Library file was written by the E2E runner, not generated by a model"],
  }, null, 2));

  if (!failure) await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(`${evidenceDirectory}\n`);

if (failure) throw failure;
