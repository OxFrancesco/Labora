import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { createAgentHttpHandler, type AgentHttpHandler } from "./http";
import { AgentEvent, EventPayload, type Message } from "./contracts";
import { idleActivity, reduceActivity } from "./activity";
import { computerClient } from "../desktop/client";
import { reduceMessages } from "../desktop/conversation-state";
import type { Connection } from "../desktop/store";
import { RoutineSchedule } from "./routine-contracts";

interface Generation {
  input: string;
  tools: string;
  text: (delta: string) => void;
  finish: () => void;
  tool: (name: string, input: Schema.Schema.Type<typeof Schema.Json>) => string;
  fail: () => void;
}

const dataDir = await mkdtemp(join(tmpdir(), "labora-streaming-e2e-"));

const artifactDir = join(process.cwd(), "artifacts", "streaming-e2e");

const checks: string[] = [];

const trace: { phase: string; event: string; textLength: number; sequence: number }[] = [];

let host: AgentHttpHandler | undefined;

let awaitingGeneration = Promise.withResolvers<Generation>();

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/v1/responses") {
      const body = Schema.decodeUnknownSync(Schema.Struct({ stream: Schema.Boolean, input: Schema.Json, tools: Schema.optionalKey(Schema.Json) }))(await request.json());
      assert.equal(body.stream, true);
      const id = `fixture-${crypto.randomUUID()}`;
      let text = "";
      let started = false;

      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (value: Schema.Schema.Type<typeof Schema.Json>) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
          const item = () => ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

          const completed = (output: Schema.Schema.Type<typeof Schema.Json>[]) => {
            send({ type: "response.completed", response: {
              id, status: "completed", output,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            } });
            controller.close();
          };

          const generation: Generation = {
            input: JSON.stringify(body.input),
            tools: JSON.stringify(body.tools ?? []),
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
              completed([item()]);
            },
            tool(name, input) {
              const call = { id, type: "function_call", call_id: id, name, arguments: JSON.stringify(input), status: "completed" };
              send({ type: "response.created", response: { id } });
              send({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } });
              send({ type: "response.output_item.done", output_index: 0, item: call });
              completed([call]);

              return id;
            },
            fail() {
              send({ type: "response.failed", response: {
                id, status: "failed", error: { code: "invalid_request_error", message: "Controlled verification failure" },
              } });
              controller.close();
            },
          };

          const pending = awaitingGeneration;
          awaitingGeneration = Promise.withResolvers<Generation>();
          pending.resolve(generation);
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }

    return await host?.fetch(request, { computerId: "verification", clientId: "verification", controlOwner: "user" }) ?? new Response("Not found", { status: 404 });
  },
});

const endpoint = `http://127.0.0.1:${server.port}`;

const connection: Connection = {
  id: "verification", endpoint, token: "local-verification-only", clientId: "verification",
  computer: {
    id: "verification", name: "Streaming verification", platform: "macos", capabilities: ["agent-host"],
    displays: [], permissions: { screenCapture: "unsupported", accessibility: "unsupported" }, controlOwner: "user", diagnostics: [],
  },
};

const client = computerClient(connection);

const workerPids = async () => {
  const processList = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid=,args="], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(processList.stdout).text();
  assert.equal(await processList.exited, 0);

  return output.split("\n").flatMap((line) => {
    const entry = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    return entry?.[1] && entry[2] && entry[3]?.includes("backend/worker.ts") && Number(entry[2]) === process.pid
      ? [Number(entry[1])] : [];
  });
};

const controllers: AbortController[] = [];

const streamTasks: Promise<void>[] = [];

const events: AgentEvent[] = [];

let messages: readonly Message[] = [];

let activity = idleActivity();

let eventNotice = Promise.withResolvers<void>();

const waitFor = async (condition: () => boolean) => {
  const timeout = AbortSignal.timeout(15_000);

  while (!condition()) {
    const notice = eventNotice.promise;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error(`Timed out waiting for streaming event; last phase=${activity.phase}`));
      timeout.addEventListener("abort", abort, { once: true });
      void notice.then(() => { timeout.removeEventListener("abort", abort); resolve(); });
    });
  }
};

const observe = (cursor: number) => {
  const controller = new AbortController();
  controllers.push(controller);

  const task = client.events("one", cursor, controller.signal, (event) => {
    events.push(event);
    activity = reduceActivity(activity, event.payload);
    messages = reduceMessages(messages, event.payload, event.timestamp);
    trace.push({ phase: activity.phase, event: event.payload._tag, textLength: messages.at(-1)?.text.length ?? 0, sequence: event.sequence });
    const notice = eventNotice;
    eventNotice = Promise.withResolvers<void>();
    notice.resolve();
  }, "bot").catch((error: Error) => { if (!controller.signal.aborted) throw error; });

  streamTasks.push(task);

  return { controller, task };
};

const nextGeneration = async (prompt: string) => {
  const generation = awaitingGeneration.promise;
  await client.send("one", { text: prompt });

  return generation;
};

const post = (path: string, body: Schema.Schema.Type<typeof Schema.Json>) => fetch(`${endpoint}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const originalPath = process.env.PATH;

const toolOutput = (generation: Generation, callId: string) => {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Struct({
    type: Schema.optionalKey(Schema.String), call_id: Schema.optionalKey(Schema.String), output: Schema.optionalKey(Schema.Json),
  }))))(generation.input);

  const result = input.find((item) => item.type === "function_call_output" && item.call_id === callId);
  assert.ok(result, `Missing provider tool result for ${callId}`);

  return JSON.stringify(result.output);
};

try {
  process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  assert.equal(Bun.which("rg", { PATH: process.env.PATH }), null);
  assert.equal(Bun.which("fd", { PATH: process.env.PATH }), null);
  host = await createAgentHttpHandler({ dataDir });
  await client.createBot({ id: "one", name: "Streaming verification", color: "#aabbcc" });
  await client.createBot({ id: "two", name: "Isolated bot", color: "#aabbcc" });
  assert.deepEqual(await workerPids(), []);
  assert.equal((await fetch(`${endpoint}/v1/bots/two/cancel?runId=stale-run`, { method: "POST" })).status, 409);
  assert.deepEqual(await workerPids(), []);

  for (const id of ["one", "two", "two"])
    assert.deepEqual(await client.activity(id, AbortSignal.timeout(5_000)), idleActivity());
  assert.deepEqual(await workerPids(), []);
  checks.push("Repeated background activity requests leave both dormant bots without Pi subprocesses");
  const agentDir = join(dataDir, "bots", "one", "agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: "local-fixture-access", refresh: "local-fixture-refresh", expires: Date.now() + 3_600_000,
    clientId: "local-fixture", subject: "local-fixture", idToken: "local-fixture", scopes: ["chatgpt.tokens.use.direct"],
  } }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${endpoint}/v1` } } }), { mode: 0o600 });
  const initial = await client.messages("one");
  assert.equal(initial.activity?.phase, "idle");
  const activeWorkerPids = await workerPids();
  assert.equal(activeWorkerPids.length, 1);
  let observer = observe(initial.cursor);

  const generation = await nextGeneration("Return the controlled streaming fixture.");

  for (const name of ["read", "bash", "edit", "write", "codemode", "ask_user", "update_plan"])
    assert.ok(generation.tools.includes(`"name":"${name}"`), `Missing declared tool: ${name}; declarations: ${generation.tools.match(/"name":"[^"]+"/g)?.join(", ")}`);
  checks.push("The actual provider request declares file, terminal, search, code mode, ask_user and update_plan tools");
  generation.text("First 🟡");
  await waitFor(() => messages.at(-1)?.text === "First 🟡");
  assert.equal(activity.phase, "streaming");
  assert.equal((await client.activity("one", AbortSignal.timeout(5_000))).phase, "streaming");
  assert.equal((await client.activity("two", AbortSignal.timeout(5_000))).phase, "idle");
  assert.deepEqual(await workerPids(), activeWorkerPids);
  checks.push("Background activity reflects a running Pi stream while its dormant sibling stays unstarted");
  assert.ok(!events.some((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload)));
  const partial = await client.messages("one");
  assert.equal(partial.messages.at(-1)?.text, "First 🟡");
  assert.equal(partial.activity?.phase, "streaming");
  assert.equal(partial.busy, true);
  checks.push("Real Pi deltas reach the desktop before the provider is allowed to finish");

  observer.controller.abort();
  await observer.task;
  generation.text(" second");
  messages = partial.messages;
  activity = partial.activity ?? idleActivity();
  observer = observe(partial.cursor);
  await waitFor(() => messages.at(-1)?.text === "First 🟡 second");
  generation.text(" final");
  await waitFor(() => messages.at(-1)?.text === "First 🟡 second final");
  generation.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal((await client.activity("one", AbortSignal.timeout(5_000))).phase, "complete");
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(messages.at(-1)?.text, "First 🟡 second final");
  const completed = await client.messages("one");
  assert.equal(completed.busy, false);
  assert.equal(completed.activity?.phase, "complete");
  assert.equal(completed.messages.at(-1)?.text, "First 🟡 second final");
  checks.push("Disconnect, snapshot, replay, final upsert, and completion preserve one exact reply");

  const failing = await nextGeneration("Return the controlled provider failure.");
  failing.fail();
  await waitFor(() => activity.phase === "failed");
  assert.match(activity.message ?? "", /Controlled verification failure/);
  assert.equal((await client.messages("one")).activity?.phase, "failed");
  checks.push("Provider failure produces failed activity rather than completion and survives snapshots");

  const cancelling = await nextGeneration("Wait for cancellation.");
  cancelling.text("Partial before cancel");
  await waitFor(() => messages.at(-1)?.text === "Partial before cancel");
  const cancellationRun = (await client.messages("one")).activity?.runId;
  assert.ok(cancellationRun && completed.activity?.runId);
  await assert.rejects(client.cancel("one", "direct", completed.activity.runId), /no longer accepting input/);
  assert.equal((await client.messages("one")).busy, true);
  cancelling.text(" still running");
  await waitFor(() => messages.at(-1)?.text === "Partial before cancel still running");
  await client.cancel("one", "direct", cancellationRun);
  await waitFor(() => activity.phase === "cancelled");
  assert.equal((await client.messages("one")).busy, false);
  checks.push("Cancellation stops a real active Pi request and preserves partial text");
  checks.push("A stale Stop cannot spawn a dormant bot or cancel the next run in the same conversation");

  const toolCall = await nextGeneration("Request the isolated write tool for verification.");
  const afterTool = awaitingGeneration.promise;
  toolCall.tool("write", { path: "approved-fixture.txt", content: "Controlled fixture only" });
  assert.ok(!(await client.messages("one")).pending.some(EventPayload.isAnyOf(["ApprovalRequested"])));
  const toolReply = await afterTool;
  toolReply.text("The approved fixture is saved.");
  toolReply.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal(await Bun.file(join(dataDir, "bots", "one", "workspace", "approved-fixture.txt")).text(), "Controlled fixture only");
  assert.ok(trace.some((item) => item.phase === "working"));
  checks.push("Workspace write runs automatically inside the sandbox");

  const deniedTool = await nextGeneration("Request a write outside the workspace.");
  const deniedReply = awaitingGeneration.promise;
  deniedTool.tool("write", { path: join(dataDir, "denied-fixture.txt"), content: "Must not be written" });
  const deniedResult = await deniedReply;
  assert.ok(deniedResult.input.includes("outside the agent workspace"));
  deniedResult.text("The sandbox blocked the write."); deniedResult.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal(await Bun.file(join(dataDir, "denied-fixture.txt")).exists(), false);
  checks.push("The real write tool cannot write outside the workspace");

  const isolatedRoutine = await client.createRoutine({
    botId: "one", name: "Question isolation", prompt: "Ask for the routine value.",
    schedule: RoutineSchedule.cases.Once.make({ at: new Date(Date.now() + 86_400_000).toISOString() }),
  });

  const routineConversation = `routine-${isolatedRoutine.id}`;
  const askGeneration = await nextGeneration("Ask for an exact value.");
  askGeneration.tool("ask_user", { questions: [{ id: "value", question: "What value should I use?", options: ["One", "Two"] }] });
  await waitFor(() => activity.phase === "asking");
  const asking = await client.messages("one");
  const question = asking.pending.find(EventPayload.isAnyOf(["QuestionRequested"]));
  assert.ok(question);
  assert.ok(!asking.pending.some(EventPayload.isAnyOf(["ApprovalRequested"])));
  const questionBody = { runId: question.runId, answers: [{ id: "value", answer: "EXACT_FREE_TEXT_VALUE" }] };
  assert.equal((await post(`/v1/bots/two/questions/${question.requestId}`, questionBody)).status, 409);
  assert.equal((await post(`/v1/bots/one/questions/${question.requestId}?conversationId=${routineConversation}`, questionBody)).status, 409);
  assert.equal((await post(`/v1/bots/one/questions/${question.requestId}`, { ...questionBody, runId: "stale-run" })).status, 409);
  assert.equal((await post(`/v1/bots/one/questions/${question.requestId}`, { runId: question.runId, answers: [{ id: "wrong", answer: "Wrong field" }] })).status, 409);
  const answerGeneration = awaitingGeneration.promise;
  assert.equal((await post(`/v1/bots/one/questions/${question.requestId}`, questionBody)).status, 200);
  const answered = await answerGeneration;
  assert.ok(answered.input.includes("EXACT_FREE_TEXT_VALUE"));
  assert.ok(answered.input.includes("answered"));
  answered.text("The answer arrived."); answered.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal((await post(`/v1/bots/one/questions/${question.requestId}`, questionBody)).status, 409);
  checks.push("Questions accept exact free text without approval and reject wrong bot, conversation, run, fields and resolved IDs");

  const attachmentGeneration = await nextGeneration("Wait for an attachment update.");
  attachmentGeneration.text("Waiting for the update.");
  await waitFor(() => activity.phase === "streaming");
  const inputRun = (await client.messages("one")).activity?.runId;
  assert.ok(inputRun);

  const queuedInput = {
    id: crypto.randomUUID(), runId: inputRun, mode: "steer", text: "ATTACHMENT_STEERING_MARKER",
    attachments: [{ name: "steering.txt", mimeType: "text/plain", data: Buffer.from("STEERING_FILE_CONTENT").toString("base64") }],
  };

  const workspace = join(dataDir, "bots/one/workspace");
  const beforeFiles = (await readdir(workspace)).sort();
  assert.equal((await post("/v1/bots/one/inputs", { ...queuedInput, runId: "stale-run" })).status, 409);
  assert.equal((await post(`/v1/bots/one/inputs?conversationId=${routineConversation}`, queuedInput)).status, 409);
  assert.deepEqual((await readdir(workspace)).sort(), beforeFiles);
  assert.equal((await post("/v1/bots/one/inputs", queuedInput)).status, 202);
  const afterFiles = (await readdir(workspace)).sort();
  assert.equal(afterFiles.length, beforeFiles.length + 1);
  assert.equal((await post("/v1/bots/one/inputs", queuedInput)).status, 202);
  assert.deepEqual((await readdir(workspace)).sort(), afterFiles);
  assert.equal((await post("/v1/bots/one/inputs", { ...queuedInput, text: "Different duplicate" })).status, 409);
  const queuedSnapshot = await client.messages("one");
  const pendingQueue = queuedSnapshot.pending.find(EventPayload.isAnyOf(["InputQueueChanged"]));
  assert.equal(pendingQueue?.items.length, 1);
  assert.deepEqual(pendingQueue?.items[0]?.attachments, [{ name: "steering.txt", mimeType: "text/plain" }]);
  const attachmentReply = awaitingGeneration.promise;
  attachmentGeneration.finish();
  const withAttachment = await attachmentReply;
  assert.ok(withAttachment.input.includes("ATTACHMENT_STEERING_MARKER") && withAttachment.input.includes("steering.txt"));
  assert.ok(!(await client.messages("one")).pending.some(EventPayload.isAnyOf(["InputQueueChanged"])));
  withAttachment.text("Attachment steering received."); withAttachment.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal((await post("/v1/bots/one/inputs", queuedInput)).status, 409);
  checks.push("Steering attachments reach Pi, duplicate acknowledgements do not rewrite files, and stale targets cannot write or enqueue");

  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1QAAAAASUVORK5CYII=";

  for (const mode of ["steer", "followUp"] as const) {
    const duplicateStart = await nextGeneration("Wait for two distinct updates with identical text.");
    duplicateStart.text("Waiting for updates.");
    await waitFor(() => activity.phase === "streaming");
    const runId = (await client.messages("one")).activity?.runId;
    assert.ok(runId);
    const duplicateIds = [crypto.randomUUID(), crypto.randomUUID()];

    for (const [index, id] of duplicateIds.entries())
      await client.queueInput("one", {
        id, runId, mode, text: `DUPLICATE_QUEUE_${mode}`,
        attachments: [{ name: `image-${index}.png`, mimeType: "image/png", data: pixel }],
      });

    const both = (await client.messages("one")).pending.find(EventPayload.isAnyOf(["InputQueueChanged"]));
    assert.deepEqual(both?.items.map((item) => item.id), duplicateIds);
    const firstInput = awaitingGeneration.promise;
    duplicateStart.finish();
    const firstDuplicate = await firstInput;
    const remaining = (await client.messages("one")).pending.find(EventPayload.isAnyOf(["InputQueueChanged"]));
    assert.deepEqual(remaining?.items.map((item) => item.id), [duplicateIds[1]]);
    assert.deepEqual(remaining?.items[0]?.attachments, [{ name: "image-1.png", mimeType: "image/png" }]);
    assert.equal(firstDuplicate.input.split(`DUPLICATE_QUEUE_${mode}`).length - 1, 1);
    const secondInput = awaitingGeneration.promise;
    firstDuplicate.text("First update received."); firstDuplicate.finish();
    const secondDuplicate = await secondInput;
    assert.ok(!(await client.messages("one")).pending.some(EventPayload.isAnyOf(["InputQueueChanged"])));
    assert.equal(secondDuplicate.input.split(`DUPLICATE_QUEUE_${mode}`).length - 1, 2);
    secondDuplicate.text("Second update received."); secondDuplicate.finish();
    await waitFor(() => activity.phase === "complete");
  }

  checks.push("Identical-text steering and follow-ups consume FIFO while snapshots retain the remaining input ID and image metadata");

  const planning = await nextGeneration("Make a small plan.");
  const planFollowup = awaitingGeneration.promise;
  planning.tool("update_plan", { steps: [{ text: "Inspect the input", status: "completed" }, { text: "Prepare the result", status: "in_progress" }] });
  const planned = await planFollowup;
  assert.equal((await client.messages("one")).plan?.steps[1]?.text, "Prepare the result");
  assert.equal((await client.messages("one", routineConversation)).plan, null);
  planned.text("Plan saved."); planned.finish();
  await waitFor(() => activity.phase === "complete");
  checks.push("The real update_plan tool persists its checklist and keeps direct and routine plans separate");

  const progress = await nextGeneration("Run a command that reports progress.");
  const progressReply = awaitingGeneration.promise;
  progress.tool("bash", { command: "printf 'LABORA_PROGRESS_MARKER'" });
  const progressResult = await progressReply;
  await waitFor(() => events.some((event) => EventPayload.isAnyOf(["ToolProgress"])(event.payload) && event.payload.text.includes("LABORA_PROGRESS_MARKER")));
  assert.ok(progressResult.input.includes("LABORA_PROGRESS_MARKER"));
  progressResult.text("Command output received."); progressResult.finish();
  await waitFor(() => activity.phase === "complete");
  checks.push("Automatic sandboxed terminal output emits bounded progress and reaches the next Pi request");

  const searchDirectory = join(workspace, "search-fixture");
  await mkdir(searchDirectory);
  await writeFile(join(searchDirectory, "needle.txt"), "LABORA_SEARCH_CONTENT_MARKER\n");
  assert.equal(await Bun.file(join(agentDir, "bin", "rg")).exists(), false);
  assert.equal(await Bun.file(join(agentDir, "bin", "fd")).exists(), false);
  let search = await nextGeneration("Inspect the isolated search fixture with the read-only tools.");

  const searches: { name: string; input: Schema.Schema.Type<typeof Schema.Json>; expected: string }[] = [
    { name: "bash", input: { command: "grep -Hn LABORA_SEARCH_CONTENT_MARKER search-fixture/*" }, expected: "needle.txt:1:LABORA_SEARCH_CONTENT_MARKER" },
    { name: "bash", input: { command: "find search-fixture -name '*.txt'" }, expected: "needle.txt" },
    { name: "bash", input: { command: "ls search-fixture" }, expected: "needle.txt" },
  ];

  for (const check of searches) {
    const response = awaitingGeneration.promise;
    const callId = search.tool(check.name, check.input);
    search = await response;
    assert.ok(toolOutput(search, callId).includes(check.expected), `${check.name} failed: ${toolOutput(search, callId)}`);
    assert.ok(!(await client.messages("one")).pending.some(EventPayload.isAnyOf(["ApprovalRequested"])));
  }

  assert.equal(await Bun.file(join(agentDir, "bin", "rg")).exists(), false);
  assert.equal(await Bun.file(join(agentDir, "bin", "fd")).exists(), false);
  search.text("File listing and content search succeeded."); search.finish();
  await waitFor(() => activity.phase === "complete");
  checks.push("Sandboxed shell search and listing return fixture files without unsandboxed built-ins");

  const routineStart = awaitingGeneration.promise;
  const routineRun = await client.runRoutine(isolatedRoutine.id);
  const routineGeneration = await routineStart;
  routineGeneration.tool("ask_user", { questions: [{ id: "routine", question: "What routine value should I use?" }] });
  await waitFor(() => activity.phase === "asking");
  const routineQuestion = (await client.messages("one", routineConversation)).pending.find(EventPayload.isAnyOf(["QuestionRequested"]));
  assert.ok(routineQuestion);
  assert.ok(!(await client.messages("one")).pending.some(EventPayload.isAnyOf(["QuestionRequested"])));
  const routineAnswer = { runId: routineRun.id, answers: [{ id: "routine", answer: "ROUTINE_ONLY_ANSWER" }] };
  assert.equal((await post(`/v1/bots/one/questions/${routineQuestion.requestId}`, routineAnswer)).status, 409);
  const routineReply = awaitingGeneration.promise;
  assert.equal((await post(`/v1/bots/one/questions/${routineQuestion.requestId}?conversationId=${routineConversation}`, routineAnswer)).status, 200);
  const routineAnswered = await routineReply;
  assert.ok(routineAnswered.input.includes("ROUTINE_ONLY_ANSWER") && !routineAnswered.input.includes("EXACT_FREE_TEXT_VALUE"));
  routineAnswered.text("Routine answer received."); routineAnswered.finish();
  await waitFor(() => events.some((event) => EventPayload.isAnyOf(["RunCompleted"])(event.payload) && event.payload.runId === routineRun.id));
  assert.ok(!(await client.messages("one")).messages.some((message) => message.text.includes("Routine answer received.")));
  checks.push("Routine questions restore only in their own conversation and cannot be answered from direct chat");

  const other = await client.messages("two");
  assert.equal(other.messages.length, 0);
  assert.equal(other.activity?.phase, "idle");
  checks.push("A second real Pi bot keeps an empty transcript and idle activity");

  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "result.json"), JSON.stringify({ ok: true, checks, trace,
    boundary: "Real Pi worker, Labora host, HTTP/SSE and desktop reducers with an isolated local provider fixture. No ChatGPT account or live inference used.",
  }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, checks, artifact: join(artifactDir, "result.json") }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ completedChecks: checks }) + "\n");
  throw error;
} finally {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(streamTasks);
  await host?.close();
  await server.stop(true);
  await rm(dataDir, { recursive: true, force: true });

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
}
