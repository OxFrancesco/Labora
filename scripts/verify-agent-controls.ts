import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { EventPayload } from "../src/backend/contracts";
import { computerClient, pairComputer } from "../src/desktop/client";
import { RoutineSchedule } from "../src/backend/routine-contracts";
import { openDesktop } from "./desktop-driver";

interface Generation {
  input: string;
  text(delta: string): void;
  finish(): void;
  tool(name: string, input: Schema.Schema.Type<typeof Schema.Json>): void;
  fail(): void;
}

const root = resolve(import.meta.dir, "..");

const workspace = await mkdtemp("/private/tmp/labora-controls-e2e-");

const dataDir = join(workspace, "computer");

const profileDirectory = join(workspace, "desktop");

const source = process.argv.includes("--source");

const layoutOnly = process.argv.includes("--layout-only");

const draftOnly = process.argv.includes("--draft-only");

const routinesOnly = process.argv.includes("--routines-and-draft");

const questionOnly = process.argv.includes("--routine-question-only");

const evidenceDirectory = join(root, "evidence", `controls-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const checks: string[] = [];

const requests: string[] = [];

const inputIds: string[] = [];

let loseInputAcknowledgement = false;

let pending = Promise.withResolvers<Generation>();

let failure: Error | undefined;

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

const companion = await createComputerHost({ dataDir, name: "Agent controls verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "unavailable/Labora Computer.app") });

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path !== "/v1/responses") {
      if (path.endsWith("/inputs") && request.method === "POST") {
        const input = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await request.clone().json());
        inputIds.push(input.id);
        const response = await companion.fetch(request);

        if (response.ok && loseInputAcknowledgement) {
          loseInputAcknowledgement = false;

          return Response.json({ error: { message: "Simulated lost acknowledgement. Your input is preserved." } }, { status: 502 });
        }

        return response;
      }

      return companion.fetch(request);
    }

    const body = Schema.decodeUnknownSync(Schema.Struct({ stream: Schema.Boolean, input: Schema.Json }))(await request.json());
    assert.equal(body.stream, true);
    const input = JSON.stringify(body.input);
    requests.push(input);
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
          input,
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

async function generation(request: Promise<Generation>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The real Pi worker did not issue the expected provider request.")), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(evidenceDirectory, { recursive: true });
  await client.createBot({ id: "controls", name: "Questions and updates", color: "#dfb845" });
  await client.createBot({ id: "other", name: "Other bot", color: "#6ba87b" });
  const agentDir = join(dataDir, "bots/controls/agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: "local-fixture-access", refresh: "local-fixture-refresh", expires: Date.now() + 3_600_000,
    clientId: "local-fixture", subject: "local-fixture", idToken: "local-fixture", scopes: ["chatgpt.tokens.use.direct"],
  } }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1` } } }), { mode: 0o600 });
  const layoutAttachments = layoutOnly ? Array.from({ length: 4 }, (_, index) => join(workspace, `${index}-quarterly-product-review-with-supporting-documents-and-a-very-long-file-name-${"details-".repeat(10)}.txt`)) : [];

  for (const path of layoutAttachments) await writeFile(path, "Layout verification attachment.");
  await writeFile(join(profileDirectory, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/controls`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: layoutOnly ? [{ key: `${connection.id}/controls`, text: "", paths: layoutAttachments }] : [] }), { mode: 0o600 });
  driver = await openDesktop({ profileDirectory, evidenceDirectory, source, foreground: true });
  let app = driver.app;
  let native = driver;
  await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });

  const readyAvatars = async () => {
    await app.getByTestId("avatar3d-view-star-26").waitFor();

    for (const id of ["pebble-42", "star-42", "hexagon-42", "star-26", "star-80"]) {
      if (await app.getByTestId(`avatar3d-view-${id}`).count())
        await app.getByTestId(`avatar3d-ready-${id}`).waitFor({ timeoutMs: 30_000 });
    }
  };

  await readyAvatars();

  const snapshot = () => client.messages("controls");
  const queue = async () => (await snapshot()).pending.find(EventPayload.isAnyOf(["InputQueueChanged"]))?.items ?? [];
  const question = async () => (await snapshot()).pending.find(EventPayload.isAnyOf(["QuestionRequested"]));

  const capture = async (name: string) => {
    await readyAvatars();
    await native.screenshot(name);
  };

  const send = async (text: string) => {
    const next = pending.promise;
    await app.getByTestId("composer").fill(text);
    await app.getByTestId("send").click();

    return generation(next);
  };

  const complete = async (next: Generation, text: string) => {
    next.text(text);
    next.finish();
    await waitUntil("task completion", async () => !(await snapshot()).busy);
    await waitUntil("native completion", async () => await app.getByTestId("cancel").count() === 0);
  };

  const restart = async (name: string) => {
    await native.close();
    driver = undefined;
    driver = await openDesktop({ profileDirectory, evidenceDirectory: join(evidenceDirectory, name), source, foreground: true });
    native = driver;
    app = driver.app;
    await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });
    await readyAvatars();
  };

  if (layoutOnly) {
    const { verifyLayout } = await import("./verify-layout");
    await verifyLayout({ app, client, send, capture, evidenceDirectory, checks, pending: () => pending.promise, generation, complete });
  }

  const runProgress = async (model: Generation) => {
    const gate = join(dataDir, "bots/controls/workspace/continue-progress");
    const next = pending.promise;
    model.tool("bash", { command: `printf 'FIRST_PROGRESS_MARKER\\n'; while [ ! -f '${gate}' ]; do sleep 0.1; done; printf 'LAST_PROGRESS_MARKER\\n'` });

    await waitUntil("bounded native tool output", async () => (await app.getByTestId("transcript").textContent()).includes("FIRST_PROGRESS_MARKER"));
    assert.equal((await snapshot()).busy, true);
    await capture("11-tool-progress");
    await writeFile(gate, "continue\n");

    return generation(next);
  };

  if (!layoutOnly && !draftOnly && !routinesOnly && !questionOnly) {
    const first = await send("Ask me how to format the response.");
    first.tool("ask_user", { questions: [
      { id: "format", question: "How much detail should I include?", options: ["Brief", "Detailed"] },
      { id: "name", question: "What name should I use?" },
    ] });
    await app.getByTestId("agent-question").waitFor();
    assert.equal(await app.getByTestId("approve-tool").count(), 0, "Asking a question must not require tool approval");
    assert.equal((await snapshot()).activity?.phase, "asking");
    await capture("01-question");
    const originalQuestion = await question();
    assert.ok(originalQuestion);
    await restart("question-reconnect");
    await app.getByTestId("agent-question").waitFor();
    assert.equal((await question())?.requestId, originalQuestion.requestId);
    await app.getByTestId("question-option-0-1").click();
    await app.getByTestId("question-answer-0").fill("Detailed, with two examples");
    await app.getByTestId("question-answer-1").fill("Basil the imaginary plant");
    const answered = pending.promise;
    await app.getByTestId("submit-question").click();
    const afterAnswer = await generation(answered);
    assert.ok(afterAnswer.input.includes("Detailed, with two examples") && afterAnswer.input.includes("Basil the imaginary plant"));
    await complete(afterAnswer, "The requested format and name were received.");
    await capture("02-answered");
    checks.push("Real ask_user reaches native choices and editable free text without approval", "Pending question survives a native restart with the same request identity", "Native answers reach the next real Pi provider request exactly");

    const running = await send("Start a task so I can change its direction.");
    running.text("I am working on the original request.");
    loseInputAcknowledgement = true;
    await app.getByTestId("composer").fill("STEER_TO_A_SHORT_LIST");
    await app.getByTestId("send").click();
    await waitUntil("accepted steering queue", async () => (await queue()).length === 1);
    await waitUntil("lost acknowledgement reported", async () => (await app.call("getPaintedText", {})).text.join(" ").includes("Simulated lost acknowledgement"));
    await capture("02-lost-acknowledgement-draft");
    await app.getByTestId("send").click();
    await waitUntil("successful input retry", async () => inputIds.length === 2 && await app.getByTestId("send").count() === 0);
    assert.equal(inputIds[0], inputIds[1], "Retrying unchanged input must reuse its original acknowledgement identity");
    assert.equal((await queue()).length, 1);
    checks.push("A lost HTTP acknowledgement preserves the draft and its retry identity without queueing duplicate work");
    await app.getByTestId("input-mode-follow-up").click();
    await app.getByTestId("composer").fill("FOLLOW_UP_WITH_A_SUMMARY");
    await app.getByTestId("send").click();
    await waitUntil("both accepted inputs", async () => (await queue()).length === 2);
    assert.equal(await app.getByTestId("cancel").count(), 1, "Stop stays available while composing and queueing");
    await capture("03-queued-inputs");
    await restart("queue-reconnect");
    await app.getByTestId("queued-inputs").waitFor();
    assert.equal((await queue()).length, 2);
    const steering = pending.promise;
    running.finish();
    const steered = await generation(steering);
    assert.ok(steered.input.includes("STEER_TO_A_SHORT_LIST"));
    assert.ok(!steered.input.includes("FOLLOW_UP_WITH_A_SUMMARY"), "A follow-up must wait until the current task finishes");
    await waitUntil("consumed steering removed", async () => (await queue()).length === 1);
    assert.equal((await snapshot()).busy, true);
    await capture("04-steering-delivered");
    const followUp = pending.promise;
    steered.text("The updated task is complete.");
    steered.finish();
    const followed = await generation(followUp);
    assert.ok(followed.input.includes("FOLLOW_UP_WITH_A_SUMMARY"));
    await waitUntil("consumed follow-up removed", async () => (await queue()).length === 0);
    await complete(followed, "The separate follow-up summary is complete.");
    await capture("05-follow-up-delivered");
    checks.push("Busy composer accepts a steering update and a separate follow-up while retaining Stop", "Acknowledged input queue survives native restart", "Steering reaches the next Pi turn before the follow-up", "Follow-up reaches Pi only after the original task finishes, and consumed queue items disappear");

    const toRedirect = await send("Ask me a question before continuing.");
    toRedirect.tool("ask_user", { questions: [{ id: "destination", question: "Which direction should I take?", options: ["North", "South"] }] });
    await app.getByTestId("agent-question").waitFor();
    const redirected = pending.promise;
    await app.getByTestId("composer").fill("REDIRECT_THE_TASK_TO_WEST");
    await app.getByTestId("send").click();
    const afterRedirect = await generation(redirected);
    assert.ok(afterRedirect.input.includes("redirected") && afterRedirect.input.includes("REDIRECT_THE_TASK_TO_WEST"));
    await complete(afterRedirect, "I received the changed direction without an invented answer.");
    await waitUntil("redirected question removed", async () => await app.getByTestId("agent-question").count() === 0);
    await capture("06-question-redirected");
    checks.push("Steering releases a pending question as redirected and reaches the actual next provider request");

    const toSkip = await send("Ask a question I can skip.");
    toSkip.tool("ask_user", { questions: [{ id: "optional", question: "Would you like to add a detail?" }] });
    await app.getByTestId("agent-question").waitFor();
    const skipped = pending.promise;
    await app.getByTestId("skip-question").click();
    const afterSkip = await generation(skipped);
    assert.ok(afterSkip.input.includes("dismissed"));
    await complete(afterSkip, "The optional question was skipped.");
    await capture("07-question-skipped");
    checks.push("Native Skip sends a dismissed tool result instead of fabricating an answer");

    const toCancel = await send("Wait while I queue a message, then stop.");
    toCancel.text("This task can be stopped.");
    await app.getByTestId("composer").fill("CANCELLED_INPUT_MUST_NOT_REACH_THE_MODEL");
    await app.getByTestId("send").click();
    await waitUntil("queued update before Stop", async () => (await queue()).length === 1);
    await app.getByTestId("cancel").click();
    await waitUntil("cancelled run", async () => (await snapshot()).activity?.phase === "cancelled");
    assert.equal((await queue()).length, 0);
    await waitUntil("native queue removed after Stop", async () => await app.getByTestId("queued-inputs").count() === 0);
    await capture("08-stopped-with-empty-queue");
    const fresh = await send("Start an unrelated task after stopping.");
    assert.ok(!fresh.input.includes("CANCELLED_INPUT_MUST_NOT_REACH_THE_MODEL"));
    await complete(fresh, "The cancelled update was not replayed.");
    checks.push("Stop clears queued input and a later task never receives the cancelled instruction");

    const planning = await send("Make a short plan, then run a harmless command.");
    const afterPlan = pending.promise;
    planning.tool("update_plan", { steps: [
      { text: "Read the request", status: "completed" },
      { text: "Run the local progress fixture", status: "in_progress" },
      { text: "Report the result", status: "pending" },
    ] });
    await app.getByTestId("agent-plan").waitFor();
    assert.equal(await app.getByTestId("approve-tool").count(), 0);
    const planContinuation = await generation(afterPlan);
    await capture("09-plan-created");
    await restart("plan-reconnect");
    await app.getByTestId("agent-plan").waitFor();
    assert.equal((await snapshot()).plan?.steps[1]?.text, "Run the local progress fixture");
    assert.ok((await app.getByTestId("agent-plan").textContent()).includes("Run the local progress fixture"));
    await capture("10-plan-restored");
    const toolFinished = await runProgress(planContinuation);
    const finalPlan = pending.promise;
    toolFinished.tool("update_plan", { steps: [
      { text: "Read the request", status: "completed" },
      { text: "Run the local progress fixture", status: "completed" },
      { text: "Report the result", status: "completed" },
    ] });
    await complete(await generation(finalPlan), "The plan is complete and the command output was visible while it ran.");
    assert.ok((await snapshot()).plan?.steps.every((step) => step.status === "completed"));
    await waitUntil("finished progress removed", async () => await app.getByTestId("tool-progress").count() === 0);
    await capture("12-plan-complete");
    checks.push("A real update_plan call paints a checklist and its state survives native restart", "Real bash output paints before the tool completes and remains in the transcript", "A completed plan preserves all completed step statuses");

  }

  const verifyRoutines = async () => {
    if (routinesOnly) {
      const baseline = await send("Keep my main chat and its plan separate from any routine.");
      const planned = pending.promise;
      baseline.tool("update_plan", { steps: [
        { text: "Keep the main chat", status: "completed" },
        { text: "Keep its plan", status: "completed" },
        { text: "Keep its answer", status: "completed" },
      ] });
      await complete(await runProgress(await generation(planned)), "Basil the imaginary plant belongs only to the main chat.");
      checks.push("Real bash output is visible in the native screenshot before the command is released to finish");
    }

    const routine = await client.createRoutine({ botId: "controls", name: "Question routine", prompt: "Ask about the routine result.", schedule: RoutineSchedule.cases.Once.make({ at: new Date(Date.now() + 86_400_000).toISOString() }) });
    const conversationId = `routine-${routine.id}`;
    await app.getByTestId(`routine-${routine.id}`).waitFor({ timeoutMs: 15_000 });
    await app.getByTestId(`routine-${routine.id}`).click();
    await app.getByTestId("routine-run").waitFor();
    await waitUntil("routine view layout", async () => await app.getByTestId("edit-bot-name").count() === 0);
    await capture("13-routine-ready");
    const routineStarted = pending.promise;
    await app.getByTestId("routine-run").click();
    const routineModel = await generation(routineStarted);
    routineModel.tool("ask_user", { questions: [{ id: "routine-answer", question: "Which routine result should I keep?", options: ["First", "Second"] }] });
    await app.getByTestId("routine-results").waitFor();
    await app.getByTestId("routine-results").click();
    const routineView = app.getByTestId("routine-conversation");
    await routineView.getByTestId("agent-question").waitFor();
    assert.equal((await snapshot()).pending.some(EventPayload.isAnyOf(["QuestionRequested"])), false);
    await capture("13-routine-question");

    if (questionOnly) {
      await app.getByTestId("routine-stop").click();
      await waitUntil("question preview stopped", async () => (await client.messages("controls", conversationId)).activity?.phase === "cancelled");
      checks.push("The rebuilt packaged app renders the actual routine question with compact metadata and no empty assistant entry");

      return;
    }

    await routineView.getByTestId("question-answer-0").fill("ROUTINE_ANSWER_ONLY");
    const routineAnswered = pending.promise;
    await routineView.getByTestId("submit-question").click();
    const routineAnswer = await generation(routineAnswered);
    assert.ok(routineAnswer.input.includes("ROUTINE_ANSWER_ONLY"));
    assert.ok(!routineAnswer.input.includes("Basil the imaginary plant"), "Routine context must not contain direct chat answers");
    const routinePlanned = pending.promise;
    routineAnswer.tool("update_plan", { steps: [{ text: "Save the routine result", status: "completed" }] });
    const routinePlan = await generation(routinePlanned);
    await routineView.getByTestId("agent-plan").waitFor();
    assert.equal((await snapshot()).plan?.steps.length, 3, "The direct chat plan remains separate");
    routinePlan.tool("ask_user", { questions: [{ id: "routine-extra", question: "Anything else for this routine?" }] });
    await waitUntil("next routine question", async () => await routineView.getByTestId("agent-question").count() > 0 && (await routineView.getByTestId("agent-question").textContent()).includes("Anything else for this routine?"));
    const routineSkipped = pending.promise;
    await routineView.getByTestId("skip-question").click();
    const skippedRoutine = await generation(routineSkipped);
    assert.ok(skippedRoutine.input.includes("dismissed"));
    skippedRoutine.text("The routine answer and skipped extra question were received.");
    skippedRoutine.finish();
    await waitUntil("routine completion", async () => !(await client.messages("controls", conversationId)).busy);
    await capture("14-routine-complete");
    checks.push("Routine results expose model questions and exact conversation-scoped answers", "Routine plan and answers stay separate from the main chat", "Native Skip also resolves a routine question without an invented answer");

    await app.getByTestId("routine-results-back").click();
    await capture("15-routine-ready-again");
    const routineRestarted = pending.promise;
    await app.getByTestId("routine-run").click();
    const waitingRoutine = await generation(routineRestarted);
    waitingRoutine.tool("ask_user", { questions: [{ id: "routine-stop", question: "Should this routine continue?" }] });
    await app.getByTestId("routine-results").click();
    await waitUntil("routine question before Stop", async () => await routineView.getByTestId("agent-question").count() > 0 && (await routineView.getByTestId("agent-question").textContent()).includes("Should this routine continue?"));
    await app.getByTestId("routine-stop").click();
    await waitUntil("routine cancellation", async () => (await client.messages("controls", conversationId)).activity?.phase === "cancelled");
    await waitUntil("routine question removed", async () => await app.getByTestId("routine-conversation").getByTestId("agent-question").count() === 0);
    await capture("15-routine-stopped");
    checks.push("Routine Stop cancels a pending question in its own conversation");

    assert.equal((await client.messages("other")).messages.length, 0);
    assert.equal((await client.messages("other")).pending.length, 0);
    checks.push("The other bot receives no questions, answers, or queued inputs");

    await app.getByTestId("routine-results-back").click();
    await app.getByTestId("routine-back").click();
  };

  if (!layoutOnly && !draftOnly) await verifyRoutines();

  if (!layoutOnly && !questionOnly) {
    const savedAttachment = join(workspace, "Keep this note.txt");
    await writeFile(savedAttachment, "This attachment belongs to an unsent draft.\n");
    const clipboardFixture = join(workspace, "clipboard-fixture");

    const compile = Bun.spawn([
      "/usr/bin/swiftc", "-O", "-module-cache-path", join(workspace, "swift-cache"),
      "-target", `${process.arch}-apple-macosx14.0`, join(root, "native/desktop/ClipboardFixture.swift"), "-o", clipboardFixture,
    ], { stdout: "pipe", stderr: "pipe" });

    const [, compileError, compileCode] = await Promise.all([new Response(compile.stdout).text(), new Response(compile.stderr).text(), compile.exited]);
    assert.equal(compileCode, 0, compileError);
    const clipboard = Bun.spawn([clipboardFixture, "files", savedAttachment], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = clipboard.stdout.getReader();
    const decoder = new TextDecoder();
    let ready = "";

    try {
      while (!ready.includes("ready\n")) {
        const next = await reader.read();
        assert.equal(next.done, false, "Clipboard fixture must initialize");
        ready += decoder.decode(next.value);
      }

      await app.getByTestId("composer").press("cmd-v");
      await app.getByTestId("attachment-0").waitFor();
      assert.ok((await app.getByTestId("attachment-0").textContent()).includes("Keep this note.txt"));
    } finally {
      clipboard.stdin.write("restore\n");
      clipboard.stdin.end();
      let restored = "";

      while (true) {
        const next = await reader.read();

        if (next.done) break;
        restored += decoder.decode(next.value);
      }

      reader.releaseLock();
      const [clipboardError, clipboardCode] = await Promise.all([new Response(clipboard.stderr).text(), clipboard.exited]);
      assert.equal(clipboardCode, 0, clipboardError);
      assert.ok(restored.includes("restored") || restored.includes("preserved-newer-clipboard"), "The original clipboard must be preserved");
    }

    const unsentDraft = "Keep this unsent draft exactly, including its final words. The attached note must stay with it when I immediately close and reopen Labora. FINAL_DRAFT_MARKER";
    await app.getByTestId("composer").fill(unsentDraft);
    await restart("draft-reconnect");
    await app.getByTestId("attachment-0").waitFor();
    assert.ok((await app.getByTestId("attachment-0").textContent()).includes("Keep this note.txt"));
    await capture("16-unsent-draft-restored");
    const restoredInput = pending.promise;
    await app.getByTestId("send").click();
    const restoredDraft = await generation(restoredInput);
    assert.ok(restoredDraft.input.includes(unsentDraft), "The exact restored draft must reach the provider without refilling the composer");
    const uploadedPath = restoredDraft.input.match(/Attached file: ([^"\\]+Keep_this_note\.txt)/)?.[1];
    assert.ok(uploadedPath, "The restored attachment path must reach the provider");
    assert.equal(await Bun.file(uploadedPath).text(), "This attachment belongs to an unsent draft.\n");
    await complete(restoredDraft, "The complete restored draft and its attachment were received.");
    await capture("17-restored-draft-delivered");
    checks.push("Immediately closing and reopening preserves the exact unsent draft and its native-pasted attachment, proven by the next actual provider request");
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));

  if (driver) await driver.screenshot("failure").catch(() => undefined);
} finally {
  if (driver) await driver.close().catch((error: Error) => { failure ??= error; });
  const active = await client.messages("controls").catch(() => undefined);

  if (active?.busy) await client.cancel("controls").catch(() => undefined);
  await server.stop(true);
  await companion.close();
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({
    ok: !failure, source, draftOnly, routinesOnly, questionOnly, checks, providerRequests: requests.length, error: failure?.message,
    boundary: "Native GPUix app and real source companion/Pi worker, with an isolated local Responses provider fixture. Assertions inspect actual outgoing Pi request input for human answers, steering, follow-up, and cancellation. No live ChatGPT request or personal credentials.",
  }, null, 2));

  if (!failure) await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(`${evidenceDirectory}\n`);

if (failure) throw failure;
