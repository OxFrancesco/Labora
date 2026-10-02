import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventPayload, type AgentEvent } from "../src/backend/contracts";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";
import { startVerificationComputer } from "./verification-computer";

const root = resolve(import.meta.dir, "..");

const dataDir = join(root, ".labora");

const profileDirectory = join(dataDir, "hydra-native-profile");

const source = process.argv.includes("--source");

const cancellation = process.argv.includes("--cancel");

const botId = "hydra";

const evidenceDirectory = join(root, "evidence", `live-chatgpt-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const checks: string[] = [];

const snapshots: { file: string; deltaCount: number; textLength: number; completed: boolean }[] = [];

const trace: { sequence: number; tag: string; timestamp: string; characters?: number }[] = [];

const events: AgentEvent[] = [];

let deltaCount = 0;

let textLength = 0;

let completed = false;

let failure: Error | undefined;

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

let screenshotWork = Promise.resolve();

let captureCount = 0;

const abort = new AbortController();

let streaming: Promise<void> | undefined;

let observerError: Error | undefined;

async function waitUntil(label: string, check: () => Promise<boolean>, timeout = 90_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (observerError) throw observerError;

    if (await check()) return;
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

await mkdir(profileDirectory, { recursive: true, mode: 0o700 });

await mkdir(evidenceDirectory, { recursive: true });

assert.ok(await Bun.file(join(dataDir, "bots", botId, "agent", "auth.json")).exists(), "Complete Hydra ChatGPT sign-in before running live verification.");


const computer = await startVerificationComputer(root, dataDir, source);

let client: ReturnType<typeof computerClient> | undefined;

try {
  const connection = await pairComputer(computer.endpoint, computer.code);
  client = computerClient(connection);
  const liveClient = client;

  if (!(await liveClient.bots()).some((bot) => bot.id === botId))
    await liveClient.createBot({ id: botId, name: "Hydra", color: "#e9b44c" });
  assert.equal((await liveClient.auth(botId)).openai, "ready", "Hydra must already have an authorized subscription.");
  const initial = await liveClient.messages(botId);
  assert.equal(initial.busy, false, "An existing Hydra run must finish before verification.");
  await writeFile(join(profileDirectory, "desktop.json"), JSON.stringify({
    connections: [connection], selected: `${connection.id}/${botId}`, compact: true,
    detailsOpen: true, detailsWidth: 336, drafts: [],
  }), { mode: 0o600 });
  driver = await openDesktop({ profileDirectory, evidenceDirectory, source, foreground: true });
  const app = driver.app;
  await app.getByTestId("composer").waitFor({ timeoutMs: 20_000 });
  await driver.screenshot("01-ready");
  streaming = liveClient.events(botId, initial.cursor, abort.signal, (event) => {
    events.push(event);
    const payload = event.payload;
    const item = { sequence: event.sequence, tag: payload._tag, timestamp: event.timestamp };

    if (EventPayload.isAnyOf(["TextDelta"])(payload)) {
      deltaCount += 1;
      textLength += payload.text.length;
      trace.push({ ...item, characters: payload.text.length });

      if (captureCount < 2 && textLength > (captureCount + 1) * 140) {
        const number = ++captureCount;
        screenshotWork = screenshotWork.then(async () => {
          if (!driver) return;
          const file = await driver.screenshot(`0${number + 1}-streaming`);
          snapshots.push({ file, deltaCount, textLength, completed });
        });
      }
    } else trace.push(item);

    if (EventPayload.isAnyOf(["RunCompleted"])(payload)) completed = true;
  }).catch((error: Error) => { if (!abort.signal.aborted) observerError = error; });

  await app.getByTestId("composer").fill("This is a harmless streaming check. Do not call tools or access files, computers, integrations, or websites. Write 45 numbered tips for caring for an imaginary desk plant, with one short sentence per tip. Finish with LABORA_STREAM_DONE on its own line.");
  await app.getByTestId("send").click();
  await waitUntil("a completed real model response", async () => completed || events.some((event) => EventPayload.isAnyOf(["RunFailed", "RunCancelled"])(event.payload)), 150_000);
  const failed = events.find((event) => EventPayload.isAnyOf(["RunFailed", "RunCancelled"])(event.payload));
  assert.equal(failed, undefined, "The real provider run must finish successfully.");
  assert.ok(deltaCount >= 2, `Expected at least two incremental text updates, received ${deltaCount}.`);
  const completedIndex = events.findIndex((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload));
  assert.ok(events.slice(0, completedIndex).filter((event) => EventPayload.isAnyOf(["TextDelta"])(event.payload)).length >= 2);
  await screenshotWork;
  const final = await liveClient.messages(botId);
  const finalMessage = final.messages.at(-1);
  assert.ok(finalMessage?.role === "assistant" && finalMessage.text.includes("LABORA_STREAM_DONE"));
  assert.equal(final.busy, false);
  assert.equal(final.activity?.phase, "complete");
  const deltas = events.flatMap((event) => EventPayload.isAnyOf(["TextDelta"])(event.payload) ? [event.payload.text] : []).join("");
  assert.equal(deltas, finalMessage.text, "Live deltas must reconstruct the persisted final reply exactly.");
  await waitUntil("the final reply painted in the native app", async () => (await app.call("getPaintedText", {})).text.join("\n").includes("LABORA_STREAM_DONE"));
  await driver.screenshot("04-complete");
  assert.ok(snapshots.some((snapshot) => !snapshot.completed), "At least one native screenshot must be captured while the response is still streaming.");
  checks.push("Real ChatGPT request sent through the native composer", "Multiple real provider deltas arrived before completion", "Deltas match the persisted final reply exactly", "Native transcript painted the final response", "Native streaming screenshot captured before completion");

  if (cancellation) {
    const before = events.length;
    await app.getByTestId("composer").fill("Another harmless streaming check. Do not call tools. Write 200 short numbered sentences describing imaginary clouds.");
    await app.getByTestId("send").click();
    await waitUntil("the cancellation run to start streaming", async () => events.slice(before).some((event) => EventPayload.isAnyOf(["TextDelta"])(event.payload)));
    await app.getByTestId("cancel").click();
    await waitUntil("native cancellation", async () => events.slice(before).some((event) => EventPayload.isAnyOf(["RunCancelled"])(event.payload)));
    await driver.screenshot("05-cancelled");
    assert.equal((await liveClient.messages(botId)).busy, false);
    checks.push("Native Stop cancels a real streaming model response");
  }

  await driver.close();
  driver = undefined;
  const persisted = await liveClient.messages(botId);
  const restartDirectory = join(evidenceDirectory, "restart");
  driver = await openDesktop({ profileDirectory, evidenceDirectory: restartDirectory, source, foreground: true });
  await driver.app.getByTestId("composer").waitFor({ timeoutMs: 20_000 });
  const restoredText = persisted.messages.slice().reverse().find((message) => message.role === "assistant" && message.text.trim())?.text;
  assert.ok(restoredText, "A saved assistant reply must exist before restart.");
  const restoredEnding = restoredText.trim().split(/\s+/).slice(-8).join(" ");
  const restartedApp = driver.app;
  await waitUntil("saved response painted after native restart", async () =>
    (await restartedApp.call("getPaintedText", {})).text.join(" ").replace(/\s+/g, " ").includes(restoredEnding));
  assert.equal((await liveClient.messages(botId)).messages.length, persisted.messages.length);
  await driver.screenshot("01-restored");
  checks.push("Native app restart preserves the real transcript and connection");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));

  if (driver) await driver.screenshot("failure").catch(() => undefined);
} finally {
  abort.abort();
  await streaming;
  await screenshotWork.catch(() => undefined);

  if (driver) await driver.close().catch((error: Error) => { failure ??= error; });

  if (client) {
    const state = await client.messages(botId).catch(() => undefined);

    if (state?.busy) await client.cancel(botId).catch(() => undefined);
  }

  await computer.close();
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({
    ok: !failure, source, checks, deltaCount, textLength, snapshots, trace,
    error: failure ? "Live verification did not pass. Review the private verification session." : null,
    boundary: `Real ChatGPT subscription, ${source ? "source" : "packaged"} native app, ${source ? "source" : "packaged"} Pi worker and companion HTTP/SSE. Desktop capture/control disabled. Credentials and connection profile remain in .labora.`,
  }, null, 2));
}

if (failure) throw failure;

process.stdout.write(JSON.stringify({ ok: true, evidenceDirectory, deltaCount, checks }) + "\n");
