import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";

interface Generation {
  text(delta: string): void;
  finish(): void;
  tool(name: string, input: Schema.Schema.Type<typeof Schema.Json>): void;
  fail(): void;
}

const root = resolve(import.meta.dir, "..");

const workspace = await mkdtemp("/private/tmp/labora-activity-e2e-");

const dataDir = join(workspace, "computer");

const profileDirectory = join(workspace, "desktop");

const source = process.argv.includes("--source");

const evidenceDirectory = join(root, "evidence", `activity-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const checks: string[] = [];

const motion: { phase: string; changedPixels: number; first: string; second: string }[] = [];

let pending = Promise.withResolvers<Generation>();

let failure: Error | undefined;

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

const companion = await createComputerHost({ dataDir, name: "Activity verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "unavailable/Labora Computer.app") });

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses") return companion.fetch(request);
    const body = Schema.decodeUnknownSync(Schema.Struct({ stream: Schema.Boolean }))(await request.json());
    assert.equal(body.stream, true);
    const id = `activity-${crypto.randomUUID()}`;
    let text = "";
    let started = false;

    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: Schema.Schema.Type<typeof Schema.Json>) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        const item = () => ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

        const complete = (output: Schema.Schema.Type<typeof Schema.Json>[]) => {
          send({ type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
          controller.close();
        };

        const generation: Generation = {
          text(delta) {
            if (!started) {
              started = true;
              send({ type: "response.created", response: { id } });
              send({ type: "response.output_item.added", output_index: 0, item: { ...item(), content: [] } });
            }

            text += delta;
            send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta });
          },
          finish() {
            send({ type: "response.output_item.done", output_index: 0, item: item() });
            complete([item()]);
          },
          tool(name, input) {
            const call = { id, type: "function_call", call_id: id, name, arguments: JSON.stringify(input), status: "completed" };
            send({ type: "response.created", response: { id } });
            send({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } });
            send({ type: "response.output_item.done", output_index: 0, item: call });
            complete([call]);
          },
          fail() {
            send({ type: "response.failed", response: { id, status: "failed", error: { code: "invalid_request_error", message: "Controlled animation verification failure" } } });
            controller.close();
          },
        };

        const current = pending;
        pending = Promise.withResolvers<Generation>();
        current.resolve(generation);
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  },
});

const pairing = await companion.issuePairingCode();

const connection = await pairComputer(server.url.origin, pairing.code);

const client = computerClient(connection);

async function waitUntil(label: string, check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function pixels(path: string, bounds: { x: number; y: number; width: number; height: number }) {
  const ffmpeg = Bun.which("ffmpeg");
  assert.ok(ffmpeg, "ffmpeg is required for native pixel verification");
  const png = Buffer.from(await Bun.file(path).arrayBuffer());
  const scale = png.readUInt32BE(16) / 1224;
  const crop = [bounds.width, bounds.height, bounds.x, bounds.y].map((value) => Math.round(value * scale)).join(":");
  const child = Bun.spawn([ffmpeg, "-loglevel", "error", "-i", path, "-vf", `crop=${crop}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const [data, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);

  return Buffer.from(data);
}

try {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(evidenceDirectory, { recursive: true });
  await client.createBot({ id: "motion", name: "Motion", color: "#dfb845" });
  const agentDir = join(dataDir, "bots/motion/agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: "local-fixture-access", refresh: "local-fixture-refresh", expires: Date.now() + 3_600_000,
    clientId: "local-fixture", subject: "local-fixture", idToken: "local-fixture", scopes: ["chatgpt.tokens.use.direct"],
  } }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1` } } }), { mode: 0o600 });
  await writeFile(join(profileDirectory, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/motion`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: [] }), { mode: 0o600 });
  driver = await openDesktop({ profileDirectory, evidenceDirectory, source, foreground: true });
  const app = driver.app;
  const native = driver;
  await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });
  await app.getByTestId("avatar3d-ready-star-80").waitFor({ timeoutMs: 30_000 });
  await app.mouse.move({ x: 620, y: 35 });

  const state = async (label: string, name: string) => {
    await waitUntil(label, async () => label === "Complete" ? await app.getByTestId("cancel").count() === 0 : (await app.getByTestId("bot-activity").textContent()).includes(label));
    await native.screenshot(name);
    checks.push(`Native activity shows ${label}`);
  };

  const movement = async (phase: string) => {
    const bounds = await app.getByTestId("avatar3d-view-star-80").bounds();
    const first = await native.screenshot(`${phase}-pose-a`);
    const before = await pixels(first, bounds);
    let changedPixels = 0;
    let second = first;

    await waitUntil(`${phase} avatar pixels to change`, async () => {
      await Bun.sleep(160);
      second = await native.screenshot(`${phase}-pose-b`);
      const after = await pixels(second, bounds);
      assert.equal(after.length, before.length);
      changedPixels = 0;

      for (let index = 0; index < before.length; index += 4) {
        if (Math.abs(before[index]! - after[index]!) + Math.abs(before[index + 1]! - after[index + 1]!) + Math.abs(before[index + 2]! - after[index + 2]!) > 18) changedPixels += 1;
      }

      return changedPixels > 40;
    }, 8_000);
    motion.push({ phase, changedPixels, first, second });
    checks.push(`The ${phase} Details avatar changes native pixels without pointer input`);
  };

  const send = async (text: string) => {
    const next = pending.promise;
    await app.getByTestId("composer").fill(text);
    await app.getByTestId("send").click();

    return next;
  };

  assert.equal((await client.messages("motion")).activity?.phase, "idle");
  await native.screenshot("01-idle");
  await movement("idle");

  const streaming = await send("Show the controlled streaming response.");
  await state("Thinking", "02-thinking");
  await movement("thinking");
  streaming.text("First part 🟡");
  await state("Writing", "03-writing");
  await waitUntil("first partial reply", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("First part 🟡"));
  await movement("streaming");
  streaming.text(" then the second part.");
  await waitUntil("second partial reply", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("First part 🟡 then the second part."));
  assert.equal((await client.messages("motion")).busy, true);
  await native.screenshot("04-partial-reply");
  streaming.finish();
  await state("Complete", "05-complete");
  assert.equal((await client.messages("motion")).messages.filter((message) => message.role === "assistant").length, 1);
  checks.push("Two exact Unicode deltas paint before completion and persist as one reply");

  const failing = await send("Show the controlled failure response.");
  failing.fail();
  await state("Needs attention", "06-failed");
  assert.equal((await client.messages("motion")).activity?.phase, "failed");

  const cancelling = await send("Show a response I can stop.");
  cancelling.text("Partial text remains after stopping.");
  await state("Writing", "07-before-stop");
  await app.getByTestId("cancel").click();
  await state("Stopped", "08-cancelled");
  assert.equal((await client.messages("motion")).busy, false);

  const tool = await send("Request the harmless local tool fixture.");
  const afterTool = pending.promise;
  tool.tool("bash", { command: "sleep 5; printf 'Activity fixture completed\\n'" });
  assert.equal(await app.getByTestId("approve-tool").count(), 0);
  await state("Using tools", "10-working");
  await movement("working");
  const final = await afterTool;
  final.text("The controlled tool finished.");
  final.finish();
  await state("Complete", "11-tool-complete");

  const declined = await send("Request the tool fixture to decline.");
  const blockedReply = pending.promise;
  const forbidden = join(dataDir, "must-not-exist.txt");
  declined.tool("write", { path: forbidden, content: "This must be denied." });
  const blocked = await blockedReply;
  blocked.text("The sandbox blocked writing outside the workspace."); blocked.finish();
  await state("Complete", "13-sandbox-blocked");
  assert.equal(await Bun.file(forbidden).exists(), false);
  checks.push("Workspace commands run automatically; the sandbox prevents an outside-workspace write");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));

  if (driver) await driver.screenshot("failure").catch(() => undefined);
} finally {
  if (driver) await driver.close().catch((error: Error) => { failure ??= error; });
  const active = await client.messages("motion").catch(() => undefined);

  if (active?.busy) await client.cancel("motion").catch(() => undefined);
  await server.stop(true);
  await companion.close();
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({
    ok: !failure, source, checks, motion, error: failure?.message,
    boundary: "Production native GPUix client, companion, real Pi worker, native Metal character renderer, and isolated local Responses provider fixture. No live ChatGPT request or personal credentials. No screen or input control permission.",
    limits: ["Reduced-motion and focus-pause settings were not changed or tested", "Transient completion and failure animations are recorded; exact timing is not asserted"],
  }, null, 2));

  if (!failure) await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(`${evidenceDirectory}\n`);

if (failure) throw failure;
