import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventPayload, type AgentEvent } from "../src/backend/contracts";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";
import { startVerificationComputer } from "./verification-computer";

const root = resolve(import.meta.dir, "..");

const dataDir = join(root, ".labora");

const profileDirectory = join(dataDir, "hydra-controls-profile");

const source = process.argv.includes("--source");

const botId = "hydra";

const evidenceDirectory = join(root, "evidence", `live-controls-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const checks: string[] = [];

const events: AgentEvent[] = [];

const abort = new AbortController();

let failure: Error | undefined;

let observerError: Error | undefined;

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

let streaming: Promise<void> | undefined;

let client: ReturnType<typeof computerClient> | undefined;

async function waitUntil(label: string, check: () => Promise<boolean>, start = 0) {
  const deadline = Date.now() + 150_000;

  while (Date.now() < deadline) {
    if (observerError) throw observerError;
    assert.equal(events.slice(start).some((event) => EventPayload.isAnyOf(["RunFailed", "RunCancelled"])(event.payload)), false, `The real provider run failed while waiting for ${label}.`);

    if (await check()) return;
    await Bun.sleep(75);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

await mkdir(profileDirectory, { recursive: true, mode: 0o700 });

await mkdir(evidenceDirectory, { recursive: true });

assert.ok(await Bun.file(join(dataDir, "bots", botId, "agent/auth.json")).exists(), "Complete Hydra sign-in before live controls verification.");

const computer = await startVerificationComputer(root, dataDir, source);

try {
  const connection = await pairComputer(computer.endpoint, computer.code);
  client = computerClient(connection);
  const liveClient = client;
  assert.equal((await liveClient.auth(botId)).openai, "ready");
  const initial = await liveClient.messages(botId);
  assert.equal(initial.busy, false, "Finish any existing Hydra task before this verification.");
  await writeFile(join(profileDirectory, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/${botId}`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: [] }), { mode: 0o600 });
  streaming = liveClient.events(botId, initial.cursor, abort.signal, (event) => { events.push(event); }).catch((error: Error) => { if (!abort.signal.aborted) observerError = error; });
  driver = await openDesktop({ profileDirectory, evidenceDirectory, source, foreground: true });
  const app = driver.app;
  await app.getByTestId("composer").waitFor({ timeoutMs: 20_000 });
  await app.getByTestId("avatar3d-ready-pebble-26").waitFor({ timeoutMs: 30_000 });

  for (const name of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"])
    for (const size of [26, 42, 80]) {
      const expected = await app.getByTestId(`avatar3d-view-${name}-${size}`).count();

      if (expected) await waitUntil("all visible avatars to load", async () => await app.getByTestId(`avatar3d-ready-${name}-${size}`).count() === expected);
    }

  await driver.screenshot("01-ready");
  await app.getByTestId("composer").fill("This is a harmless native interaction test about an imaginary desk plant. First use update_plan to record two steps: ask for a color, then acknowledge the answer. Then call ask_user with exactly one question: id color, question Which color should the imaginary plant pot use?, options Blue and Green. Wait for my answer. After receiving it, mark the plan complete and reply exactly LABORA_QUESTION_DONE followed by the chosen color. Use only update_plan and ask_user, either directly or through codemode; do not access files, computers, integrations, or the web.");
  await app.getByTestId("send").click();
  await waitUntil("the model asking a real question", async () => events.some((event) => EventPayload.isAnyOf(["QuestionRequested"])(event.payload)));
  await app.getByTestId("question-answer-0").waitFor({ timeoutMs: 20_000 });
  await driver.screenshot("02-model-question");
  await app.getByTestId("question-answer-0").fill("Blue");
  await app.getByTestId("submit-question").click();
  await waitUntil("the answered model request to complete", async () => events.some((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload)));
  const answered = await liveClient.messages(botId);
  assert.match(answered.messages.at(-1)?.text ?? "", /LABORA_QUESTION_DONE\s+Blue/i);
  assert.ok(events.some((event) => EventPayload.isAnyOf(["QuestionResolved"])(event.payload) && event.payload.outcome === "answered"));
  assert.ok(answered.plan?.steps.length && answered.plan.steps.every((step) => step.status === "completed"));
  const planUpdates = events.flatMap(({ payload }) => EventPayload.isAnyOf(["PlanUpdated"])(payload) ? [payload] : []);
  assert.ok(planUpdates.length >= 2 && planUpdates[0]?.plan.steps.some((step) => step.status !== "completed"), "The model must create and complete a new plan in this request.");
  await waitUntil("the answer painted", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("LABORA_QUESTION_DONE"));
  await driver.screenshot("03-answer-complete");
  checks.push("Real ChatGPT selected ask_user and waited for native input", "Native free-text answer reached the model and changed its final response", "Real ChatGPT updated its persistent plan before and after the question");

  const beforeSteering = events.length;
  await app.getByTestId("composer").fill("Write 120 short numbered sentences about an imaginary desk plant. Do not use tools. This is a harmless streaming and steering test.");
  await app.getByTestId("send").click();
  await waitUntil("the model to stream before steering", async () => events.slice(beforeSteering).some((event) => EventPayload.isAnyOf(["TextDelta"])(event.payload)), beforeSteering);
  const steeringRun = events.slice(beforeSteering).map((event) => event.payload).find(EventPayload.isAnyOf(["RunStarted"]));
  assert.ok(steeringRun, "The streamed response must belong to a started run.");
  await app.getByTestId("composer").fill("Change direction now: stop discussing plants and reply exactly LABORA_STEERING_DONE. Do not use tools.");
  await app.getByTestId("input-mode-steer").click();
  const beforeQueue = await liveClient.messages(botId);
  assert.equal(beforeQueue.busy, true, "Steering must be submitted before the run finishes.");
  assert.equal(beforeQueue.activity?.runId, steeringRun.runId);
  await app.getByTestId("send").click();
  await waitUntil("steering acknowledgement", async () => events.slice(beforeSteering).some((event) => EventPayload.isAnyOf(["InputQueueChanged"])(event.payload) && event.payload.runId === steeringRun.runId && event.payload.items.some((item) => item.mode === "steer")), beforeSteering);
  await driver.screenshot("04-steering-queued");
  await waitUntil("the steered request to complete", async () => events.slice(beforeSteering).some((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload)), beforeSteering);
  const steered = await liveClient.messages(botId);
  assert.match(steered.messages.at(-1)?.text ?? "", /LABORA_STEERING_DONE/);
  assert.ok(steered.messages.some((message) => message.role === "user" && message.text.startsWith("Change direction now:")));
  await waitUntil("the redirected response painted", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("LABORA_STEERING_DONE"), beforeSteering);
  await driver.screenshot("05-steering-complete");
  checks.push("Native composer queued steering during real ChatGPT streaming", "Pi consumed the steering and the model changed its final response");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));

  if (driver) await driver.screenshot("failure").catch(() => undefined);
} finally {
  abort.abort();
  await streaming;

  if (client) {
    const active = await client.messages(botId).catch(() => undefined);
    const runId = active?.activity?.runId;

    if (active?.busy && runId && events.some((event) => EventPayload.isAnyOf(["RunStarted"])(event.payload) && event.payload.runId === runId))
      await client.cancel(botId, "direct", runId).catch((error: Error) => { failure ??= error; });
  }

  if (driver) await driver.close().catch((error: Error) => { failure ??= error; });
  await computer.close().catch((error: Error) => { failure ??= error; });
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({ ok: !failure, source, checks, trace: events.map((event) => ({ sequence: event.sequence, tag: event.payload._tag, timestamp: event.timestamp })), error: failure?.message ?? null, boundary: `Real Hydra ChatGPT subscription and ${source ? "source" : "packaged"} native UI, companion and Pi worker. Computer input/capture disabled. Private credentials stay in .labora.` }, null, 2));
}

if (failure) throw failure;

console.log(JSON.stringify({ ok: true, evidenceDirectory, checks }));
