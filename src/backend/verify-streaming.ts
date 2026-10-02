import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { createAgentHttpHandler, type AgentHttpHandler } from "./http";
import { AgentEvent, EventPayload, type Message } from "./contracts";
import { idleActivity, reduceActivity } from "./activity";
import { computerClient } from "../desktop/client";
import { reduceMessages } from "../desktop/conversation-state";
import type { Connection } from "../desktop/store";

interface Generation {
  text: (delta: string) => void;
  finish: () => void;
  tool: (name: string, input: Schema.Schema.Type<typeof Schema.Json>) => void;
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
      const body = Schema.decodeUnknownSync(Schema.Struct({ stream: Schema.Boolean }))(await request.json());
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

try {
  process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";
  host = await createAgentHttpHandler({ dataDir });
  await client.createBot({ id: "one", name: "Streaming verification", color: "#aabbcc" });
  await client.createBot({ id: "two", name: "Isolated bot", color: "#aabbcc" });
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
  await client.cancel("one");
  await waitFor(() => activity.phase === "cancelled");
  assert.equal((await client.messages("one")).busy, false);
  checks.push("Cancellation stops a real active Pi request and preserves partial text");

  const toolCall = await nextGeneration("Request the isolated write tool for verification.");
  const afterTool = awaitingGeneration.promise;
  toolCall.tool("write", { path: "approved-fixture.txt", content: "Controlled fixture only" });
  await waitFor(() => activity.phase === "waiting");
  const approvalEvent = events.slice().reverse().find((event) => EventPayload.isAnyOf(["ApprovalRequested"])(event.payload));
  assert.ok(approvalEvent && EventPayload.isAnyOf(["ApprovalRequested"])(approvalEvent.payload));
  const approval = approvalEvent.payload;
  const waiting = await client.messages("one");
  assert.equal(waiting.activity?.phase, "waiting");
  assert.equal(await Bun.file(join(dataDir, "bots", "one", "workspace", "approved-fixture.txt")).exists(), false);
  await client.approve("one", approval.requestId, "approve");
  const toolReply = await afterTool;
  toolReply.text("The approved fixture is saved.");
  toolReply.finish();
  await waitFor(() => activity.phase === "complete");
  assert.equal(await Bun.file(join(dataDir, "bots", "one", "workspace", "approved-fixture.txt")).text(), "Controlled fixture only");
  assert.ok(trace.some((item) => item.phase === "working"));
  checks.push("Approval pauses a real filesystem tool, restores waiting state, and resumes after explicit consent");

  const deniedTool = await nextGeneration("Request an isolated write that the human will decline.");
  deniedTool.tool("write", { path: "denied-fixture.txt", content: "Must not be written" });
  await waitFor(() => activity.phase === "waiting");
  const deniedEvent = events.slice().reverse().find((event) => EventPayload.isAnyOf(["ApprovalRequested"])(event.payload));
  assert.ok(deniedEvent && EventPayload.isAnyOf(["ApprovalRequested"])(deniedEvent.payload));
  await client.approve("one", deniedEvent.payload.requestId, "deny");
  await waitFor(() => activity.phase === "cancelled");
  assert.equal(await Bun.file(join(dataDir, "bots", "one", "workspace", "denied-fixture.txt")).exists(), false);
  checks.push("Declining a real tool leaves the filesystem untouched and reports cancelled, not complete");

  const other = await client.messages("two");
  assert.equal(other.messages.length, 0);
  assert.equal(other.activity?.phase, "idle");
  checks.push("A second real Pi bot keeps an empty transcript and idle activity");

  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "result.json"), JSON.stringify({ ok: true, checks, trace,
    boundary: "Real Pi worker, Labora host, HTTP/SSE and desktop reducers with an isolated local provider fixture. No ChatGPT account or live inference used.",
  }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, checks, artifact: join(artifactDir, "result.json") }) + "\n");
} finally {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(streamTasks);
  await host?.close();
  await server.stop(true);
  await rm(dataDir, { recursive: true, force: true });
}
