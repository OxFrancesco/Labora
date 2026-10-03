import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createDesktopStore } from "../src/desktop/store";
import { computerClient } from "../src/desktop/client";
import { EventPayload, type AgentEvent } from "../src/backend/contracts";
import { openDesktop } from "./desktop-driver";

const store = await createDesktopStore();

const profile = store.preferences;

const connection = profile.connections.find((item) => profile.selected.startsWith(`${item.id}/`));

assert.ok(connection, "Select the real chat before running this verification.");

const botId = profile.selected.slice(connection.id.length + 1);

const client = computerClient(connection);

const before = await client.messages(botId);

assert.equal(before.busy, false, "An existing task must finish before this verification.");

assert.equal(profile.drafts.some((draft) => draft.key === profile.selected && (draft.text || draft.paths.length)), false, "Preserve the user's existing draft.");

assert.equal((await client.auth(botId)).openai, "ready");

const executable = join(homedir(), "Applications/Labora.app/Contents/MacOS/Labora");

const processes = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });

const owned = (await new Response(processes.stdout).text()).split("\n").flatMap((line) => {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);

  return match?.[2] === executable ? [Number(match[1])] : [];
});

assert.ok(owned.length <= 1);

for (const pid of owned) process.kill(pid, "SIGTERM");

await Bun.sleep(400);

const directory = resolve("evidence", `t3-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

await mkdir(directory, { recursive: true });

const events: AgentEvent[] = [];

const abort = new AbortController();

let observerError: Error | undefined;

const stream = client.events(botId, before.cursor, abort.signal, (event) => { events.push(event); }).catch((error: Error) => { if (!abort.signal.aborted) observerError = error; });

const driver = await openDesktop({ profileDirectory: store.directory, evidenceDirectory: directory, executable, foreground: true });

const app = driver.app;

const checks: string[] = [];

let failure: Error | undefined;

async function waitFor(label: string, check: () => Promise<boolean>, timeout = 180_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (observerError) throw observerError;
    const failed = events.find((event) => EventPayload.isAnyOf(["RunFailed"])(event.payload));
    assert.equal(failed, undefined, `The live run failed while waiting for ${label}`);

    if (await check()) return;
    await Bun.sleep(100);
  }

  throw Error(`Timed out waiting for ${label}`);
}

try {
  await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });
  await driver.screenshot("01-real-chat");
  await app.getByTestId("composer").fill("Please run this harmless UI verification in this existing chat. Use update_plan with two steps: check workspace tools, then ask and acknowledge a color. First write labora-ui-check-20261003.txt containing Native activity check, then read that file, then run bash with command sleep 8; printf 'LABORA_NATIVE_TOOL_OK\\n'. Use the tools directly when available so I can inspect individual tool rows. Next use ask_user with one question, id color, question Which color should the imaginary test card use?, options Blue and Green. Wait for the answer. Then mark the plan completed and reply LABORA_NATIVE_UI_DONE followed by the chosen color. Only these workspace actions and update_plan/ask_user are authorized for this test. Do not call connected apps, browser, or computer controls.");
  await app.getByTestId("send").click();
  await waitFor("a real thinking summary", async () => events.some((event) => EventPayload.isAnyOf(["Message"])(event.payload) && event.payload.message.role === "thinking" && !!event.payload.message.text.trim()));
  await driver.screenshot("02-real-thinking");
  await waitFor("the model asking a question", async () => events.some((event) => EventPayload.isAnyOf(["QuestionRequested"])(event.payload)));
  await app.getByTestId("question-answer-0").waitFor({ timeoutMs: 20_000 });
  await app.getByTestId("task-plan-toggle").click();
  await driver.screenshot("03-real-question-and-plan");
  await app.getByTestId("question-toggle").click();
  assert.equal(await app.getByTestId("question-answer-0").count(), 0);
  await app.getByTestId("question-toggle").click();
  await app.getByTestId("question-answer-0").fill("Blue");
  await app.getByTestId("submit-question").click();
  await waitFor("the real agent's completed reply", async () => events.some((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload)));
  const result = await client.messages(botId);
  const fresh = result.messages.filter((message) => !before.messages.some((old) => old.id === message.id));
  assert.match(fresh.at(-1)?.text ?? "", /LABORA_NATIVE_UI_DONE.*Blue/is);
  assert.ok(fresh.some((message) => message.role === "thinking" && message.text.trim()));
  assert.ok(fresh.some((message) => message.role === "tool" && message.text.includes("LABORA_NATIVE_TOOL_OK")));
  assert.ok(result.plan?.steps.every((step) => step.status === "completed"));
  checks.push("Actual signed-in Lele chat produced streamed and persisted Astra thinking summaries", "Real sandboxed write, read and bash calls completed without approval", "Native question collapse, free-text answer and plan disclosures worked", "The real model received Blue and completed its plan and final reply");
  await waitFor("the final reply painted", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("LABORA_NATIVE_UI_DONE"));
  await app.getByTestId("task-plan-toggle").click();
  await driver.screenshot("04-real-completed");
  const work = fresh.filter((message) => message.role === "tool" || message.role === "thinking");

  for (const message of work) {
    const toggle = app.getByTestId(`activity-toggle-${message.id}`);

    if (await toggle.count()) await toggle.click();
  }

  const command = work.find((message) => message.toolName === "bash");
  assert.ok(command, "A direct real bash call is required for the disclosure check.");
  await app.getByTestId(`tool-${command.id}`).click();
  await app.getByTestId(`detail-${command.id}`).waitFor();
  await Bun.sleep(250);
  await driver.screenshot("05-real-command");
  const thought = work.find((message) => message.role === "thinking");
  assert.ok(thought);
  await app.getByTestId(`tool-${command.id}`).click();
  await app.getByTestId(`tool-${thought.id}`).click();
  await Bun.sleep(250);
  await driver.screenshot("06-real-thought");
  await app.getByTestId(`tool-${thought.id}`).click();
  const timings: number[] = [];

  for (let n = 0; n < 6; n++) {
    const start = performance.now();
    await app.getByTestId("details-toggle").click();
    await app.call("getPaintedText", {});
    timings.push(performance.now() - start);
  }

  assert.ok(Math.max(...timings) < 200, `Native clicks exceeded 200ms: ${timings}`);
  checks.push(`Native clicks with real history: max ${Math.max(...timings).toFixed(1)}ms`);
  await driver.screenshot("07-final-chat");
  await writeFile(join(directory, "events.json"), JSON.stringify(events.map((event) => ({ sequence: event.sequence, timestamp: event.timestamp, tag: event.payload._tag })), null, 2));
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  await driver.screenshot("failure").catch(() => undefined);
} finally {
  abort.abort();
  await stream;
  const active = await client.messages(botId);
  const runId = active.activity?.runId;

  if (active.busy && runId && events.some((event) => EventPayload.isAnyOf(["RunStarted"])(event.payload) && event.payload.runId === runId)) await client.cancel(botId, "direct", runId);
  await driver.close();
  Bun.spawn(["/usr/bin/open", join(homedir(), "Applications/Labora.app")], { stdout: "ignore", stderr: "ignore" });
  await writeFile(join(directory, "result.json"), JSON.stringify({ ok: !failure, botId, checks, error: failure?.message ?? null, boundary: "Installed native app, existing user chat, actual ChatGPT subscription, real Pi tools and workspace sandbox. No external app actions." }, null, 2));
}

console.log(JSON.stringify({ directory, checks, ok: !failure }));

if (failure) throw failure;
