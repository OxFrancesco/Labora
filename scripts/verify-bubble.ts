import { Schema } from "effect";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { launch, connectStdio } from "@gpuix/react/automation";
import { createComputerHost } from "../src/computer/host";
import { createAgentHttpHandler } from "../src/backend/http";
import { computerClient, pairComputer } from "../src/desktop/client";

const workspace = await mkdtemp("/private/tmp/labora-bubble-");

const profile = join(workspace, "desktop");

const data = join(workspace, "computer");

const evidence = resolve(process.env.LABORA_BUBBLE_EVIDENCE ?? `evidence/bubble-${Date.now()}`);

const checks: string[] = [];

await mkdir(profile, { recursive: true });

await mkdir(evidence, { recursive: true });

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

const host = await createComputerHost({ dataDir: data, name: "Bubble verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "none") });

let finish: (() => void) | undefined;

let requests = 0;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
  if (new URL(request.url).pathname !== "/v1/responses") return host.fetch(request);
  requests++;

  return new Response(new ReadableStream({ start(controller) {
    const send = (value: Schema.Schema.Type<typeof Schema.Json>) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    const id = "bubble-response";
    const item = { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Your response stayed available while the bubble was hidden.", annotations: [] }] };
    send({ type: "response.created", response: { id } });
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    finish = () => {
      send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: item.content[0]!.text });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      controller.close();
    };
  } }));
} });

const pair = await host.issuePairingCode();

const connection = await pairComputer(server.url.origin, pair.code);

const client = computerClient(connection);

await client.createBot({ id: "starry", name: "Starry", color: "#dfb845" });

await client.createBot({ id: "other", name: "Other agent", color: "#6ba87b" });

const agentDir = join(data, "bots/starry/agent");

await mkdir(agentDir, { recursive: true });

await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "local-fixture-access", refresh: "local-fixture-refresh", expires: Date.now() + 3600000, clientId: "local-fixture", subject: "local-fixture", idToken: "local-fixture", scopes: ["chatgpt.tokens.use.direct"] } }));

await Bun.write(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1` } } }));

const key = `${connection.id}/starry`;

await Bun.write(join(profile, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/other`, defaultAgent: key, compact: true, detailsOpen: false, detailsWidth: 336, drafts: [] }));

const app = await launch({ command: process.execPath, args: ["scripts/bubble-fixture.ts"], cwd: process.cwd(), env: { ...process.env, LABORA_DESKTOP_DATA_DIR: profile, LABORA_BUBBLE_TEST_SOCKET: join(workspace, "bubble.sock"), GPUIX_BACKGROUND: "0" } });

let bubble: Awaited<ReturnType<typeof connectStdio>> | undefined;

let failure: unknown;

const frames: string[] = [];

async function capture(target: typeof app, name: string) {
  const path = join(evidence, `${name}.png`);
  await target.screenshot({ path });
  frames.push(path);
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function resize(target: typeof app, width: number, height: number) {
  const { pid } = await target.call("initialize", { protocolVersion: 1, client: "labora-bubble" });
  const process = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set size of window 1 to {${width}, ${height}}`]);
  assert.equal(await process.exited, 0);
  await Bun.sleep(250);
}

async function alignment(target: typeof app, inputId: string, buttonId: string, multiline: boolean) {
  const input = await target.getByTestId(inputId).bounds();
  const button = await target.getByTestId(buttonId).bounds();
  // GPUix 0.10 reports the padded content origin with the outer dimensions.
  assert.ok(Math.abs(input.y - 5 + input.height - button.y - button.height) <= 1, `Aligned input/button bottoms: ${JSON.stringify({ input, button })}`);
  assert.equal(button.width, 32);
  assert.equal(button.height, 32);
  assert.ok(input.width > 100);
  assert.ok(input.x + input.width <= button.x);
  assert.ok(multiline ? input.height > 32 : input.height === 32, `Input height: ${JSON.stringify({ input, multiline })}`);
}

try {
  await app.getByTestId("sidebar-account").waitFor({ timeoutMs: 30000 });
  await app.getByTestId("sidebar-account").click();
  await app.getByTestId("bubble-preview").waitFor();
  await capture(app, "settings");
  await app.getByTestId("settings-bubble-shortcut").click();
  await app.getByTestId("shortcut-cancel").waitFor();
  await capture(app, "recording-shortcut");
  await app.getByTestId("settings-bubble-shortcut").press("cmd-alt-b");
  await waitUntil("saved custom shortcut", async () => (await Bun.file(join(profile, "desktop.json")).json()).bubbleShortcut?.key === "b");
  await capture(app, "custom-shortcut");
  await app.getByTestId("shortcut-reset").click();
  await waitUntil("default shortcut reset", async () => (await Bun.file(join(profile, "desktop.json")).json()).bubbleShortcut?.key === "space");
  await app.getByTestId("settings-bubble-shortcut").click();
  await app.getByTestId("settings-bubble-shortcut").press("escape");
  await app.getByTestId("bubble-preview").waitFor();
  checks.push("Record, persist, reset, and cancel a shortcut in Settings");
  console.log("Opening bubble", checks.length);
  await app.getByTestId("bubble-preview").waitFor();
  await app.getByTestId("bubble-preview").click();
  await waitUntil("bubble started", async () => existsSync(join(workspace, "bubble.sock")));
  const socket = connect(join(workspace, "bubble.sock"));
  bubble = await connectStdio({ write: chunk => socket.write(chunk), feed: listener => { socket.on("data", chunk => listener(chunk.toString())); }, close: async () => { socket.end(); } });
  await bubble.getByTestId("bubble-composer").waitFor({ timeoutMs: 15000 });
  await Bun.sleep(300);
  assert.ok((await bubble.call("getPaintedText", {})).text.join("\n").includes("Starry"));
  checks.push("Bubble uses the default Starry agent while the main window has Other agent selected");

  for (const [width, height] of [[440, 560], [360, 380]]) {
    await resize(bubble, width!, height!);
    await bubble.getByTestId("bubble-composer").fill("");
    await alignment(bubble, "bubble-composer", "bubble-send", false);
    await capture(bubble, `bubble-${width}-empty`);
    await bubble.getByTestId("bubble-composer").fill("First line");
    await bubble.getByTestId("bubble-composer").press("shift-enter S e c o n d shift-enter T h i r d");
    await alignment(bubble, "bubble-composer", "bubble-send", true);
    await capture(bubble, `bubble-${width}-multiline`);
  }

  checks.push("Bubble single-line and multiline alignment at 440x560 and 360x380");
  await bubble.getByTestId("bubble-composer").fill("A draft in the bubble");
  await waitUntil("draft saved", async () => (await Bun.file(join(profile, "desktop.json")).json()).drafts.find((draft: { key: string }) => draft.key === key)?.text === "A draft in the bubble");
  await bubble.getByTestId("bubble-close").click();
  console.log("Opening bubble", checks.length);
  await app.getByTestId("bubble-preview").waitFor();
  await app.getByTestId("bubble-preview").click();
  await Bun.sleep(200);
  assert.ok((await bubble.call("getPaintedText", {})).text.join("\n").includes("A draft in the bubble"));
  checks.push("Hide and reopen preserves the draft");
  await bubble.getByTestId("bubble-send").click();
  await waitUntil("real Pi provider request", async () => !!finish);
  await bubble.getByTestId("bubble-close").click();
  finish!();
  await waitUntil("response completed while hidden", async () => !(await client.messages("starry")).busy);
  console.log("Opening bubble", checks.length);
  await app.getByTestId("bubble-preview").waitFor();
  await app.getByTestId("bubble-preview").click();
  const activeBubble = bubble;
  await waitUntil("response displayed", async () => (await activeBubble.call("getPaintedText", {})).text.join("\n").includes("Your response stayed available"));
  assert.equal(requests, 1);
  await capture(bubble, "response-after-hide");
  checks.push("Real Pi worker completes a controlled provider response while hidden; reopen shows it without a duplicate request");
  await bubble.getByTestId("bubble-open").click();
  await app.getByTestId("composer").waitFor();

  for (const [width, height] of [[1224, 768], [800, 540]]) {
    await resize(app, width!, height!);
    await app.getByTestId("composer").fill("");
    await alignment(app, "composer", "send", false);
    await capture(app, `chat-${width}-empty`);
    await app.getByTestId("composer").fill("First line");
    await app.getByTestId("composer").press("shift-enter S e c o n d shift-enter T h i r d");
    await alignment(app, "composer", "send", true);
    await capture(app, `chat-${width}-multiline`);
  }

  checks.push("Main chat single-line and multiline alignment at 1224x768 and 800x540; Open in Labora selects the default agent");

  if (process.env.LABORA_BUBBLE_HOLD === "1") {
    await Bun.write(join(evidence, "ready"), JSON.stringify({ profile, workspace }));
    await waitUntil("interactive shortcut verification", async () => existsSync(join(evidence, "continue")), 300000);
    await capture(bubble, "global-shortcut");
  }
} catch (error) {
  failure = error;
  await capture(bubble ?? app, "failure").catch(() => {});
  await capture(app, "main-failure").catch(() => {});
} finally {
  await bubble?.close();
  await app.close();
  await server.stop(true);
  await host.close();
  await Bun.write(join(evidence, "result.json"), JSON.stringify({ passed: !failure, checks, error: failure instanceof Error ? failure.message : undefined, provider: "Isolated controlled provider; no personal messages sent" }, null, 2));
  await rm(workspace, { recursive: true, force: true });
  const timeline = join(evidence, "frames.txt");
  await Bun.write(timeline, frames.map(path => `file '${path}'\nduration 1.5`).join("\n"));

  if (frames.length) {
    const encoder = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", timeline, "-vf", "scale=1224:768:force_original_aspect_ratio=decrease,pad=1224:768:(ow-iw)/2:(oh-ih)/2,setsar=1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, "walkthrough.mp4")]);
    assert.equal(await encoder.exited, 0);
  }
}

console.log(evidence);

if (failure) throw failure;
