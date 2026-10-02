import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema, Stream } from "effect";
import { AgentEvent, AuthStatus, EventPayload, MessageSnapshot } from "./contracts";
import { Routine, RoutineRun, RoutineSchedule } from "./routine-contracts";
import { createAgentHttpHandler, type AgentHttpHandler } from "./http";

const context = { computerId: "routine-verification", clientId: "routine-verification", controlOwner: "user" } satisfies
  Schema.Schema.Type<typeof import("./contracts").AgentRequestContext>;

const dataDir = await mkdtemp(join(tmpdir(), "labora-routines-e2e-"));

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

let host = await createAgentHttpHandler({ dataDir });

const checks: string[] = [];

const pids = new Set<number>();

const request = async (path: string, method = "GET", body?: Schema.Schema.Type<typeof Schema.Json>, target: AgentHttpHandler = host) => {
  const options: RequestInit = { method };

  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const response = await target.fetch(new Request(`http://companion.test${path}`, options), context);
  assert.ok(response);

  return response;
};

const decode = async <A>(schema: Schema.Codec<A>, response: Response) => {
  assert.ok(response.ok, await response.clone().text());

  return Schema.decodeUnknownSync(schema)(await response.json());
};

const create = async (name: string, schedule: RoutineSchedule) =>
  (await decode(Schema.Struct({ routine: Routine }), await request("/v1/routines", "POST", {
    botId: "one", name, prompt: "This isolated verification must stop before inference because it is signed out.", schedule,
  }))).routine;

const runs = async (id: string) =>
  (await decode(Schema.Struct({ runs: Schema.Array(RoutineRun) }), await request(`/v1/routines/${id}/runs`))).runs;

const waitFor = async <A>(read: () => Promise<A>, done: (value: A) => boolean) => {
  const value = await Effect.runPromise(Stream.tick("30 millis").pipe(
    Stream.mapEffect(() => Effect.promise(read)), Stream.filter(done), Stream.runHead, Effect.timeout("8 seconds"),
  ));

  assert.ok(Option.isSome(value));

  return value.value;
};

const seedTranscript = async (directory: string, marker: string) => {
  const workspace = join(dataDir, "bots", "one", "workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(workspace, directory);
  manager.appendMessage({ role: "user", content: marker, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: `Synthetic saved transcript: ${marker}` }],
    api: "openai-responses", provider: "openai", model: "gpt-5.5", stopReason: "stop", timestamp: Date.now() + 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
};

const replay = async (conversationId?: string) => {
  const suffix = conversationId ? `?conversationId=${conversationId}` : "";
  const response = await request(`/v1/bots/one/events${suffix}`);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (!events.some((event) => EventPayload.isAnyOf(["Ready"])(event.payload))) {
      const item: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      assert.equal(item.done, false);
      pending += decoder.decode(item.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))(line.slice(6));
        events.push(event);

        if (EventPayload.isAnyOf(["Ready"])(event.payload)) pids.add(event.payload.pid);
      }
    }
  } finally {
    await reader.cancel();
  }

  return events;
};

try {
  assert.equal((await request("/v1/bots", "POST", { id: "one", name: "One", color: "#dfb845" })).status, 201);

  for (const schedule of [
    RoutineSchedule.cases.Cron.make({ expression: "* * * * * *", timeZone: "UTC" }),
    RoutineSchedule.cases.Cron.make({ expression: "0 9 * * *", timeZone: "Invalid/Zone" }),
    RoutineSchedule.cases.Once.make({ at: "2026-02-30T09:00:00.000Z" }),
  ]) {
    assert.equal((await request("/v1/routines", "POST", { botId: "one", name: "Invalid", prompt: "No execution", schedule })).status, 400);
  }

  checks.push("Invalid dates, time zones, and sub-minute schedules rejected");

  const first = await create("Morning", RoutineSchedule.cases.Cron.make({ expression: "0 9 * * *", timeZone: "Europe/Rome" }));
  const second = await create("Other", RoutineSchedule.cases.Cron.make({ expression: "0 12 * * 1", timeZone: "Europe/Rome" }));
  assert.equal(first.enabled, false);
  assert.equal(first.nextRunAt, null);
  assert.deepEqual(await runs(first.id), []);
  checks.push("New routines remain disabled without starting a worker or model");

  const edited = await decode(Schema.Struct({ routine: Routine }), await request(`/v1/routines/${first.id}`, "PATCH", { name: "Morning review", prompt: "Signed-out admission check." }));
  assert.equal(edited.routine.name, "Morning review");
  const enabled = await decode(Schema.Struct({ routine: Routine }), await request(`/v1/routines/${first.id}/enabled`, "POST", { enabled: true }));
  assert.ok(enabled.routine.nextRunAt);
  assert.ok(Date.parse(enabled.routine.nextRunAt) > Date.now());
  const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).format(new Date(enabled.routine.nextRunAt));
  assert.equal(localHour, "09");
  const disabled = await decode(Schema.Struct({ routine: Routine }), await request(`/v1/routines/${first.id}/enabled`, "POST", { enabled: false }));
  assert.equal(disabled.routine.nextRunAt, null);
  checks.push("Editing, explicit enable/disable, and local-time next occurrence");

  await seedTranscript(join(dataDir, "bots", "one", "sessions"), "DIRECT_PRIVATE_FIXTURE");
  await seedTranscript(join(dataDir, "bots", "one", "conversations", `routine-${first.id}`), "FIRST_ROUTINE_FIXTURE");
  await seedTranscript(join(dataDir, "bots", "one", "conversations", `routine-${second.id}`), "SECOND_ROUTINE_FIXTURE");
  const timestamp = new Date().toISOString();

  const payload = (text: string) => EventPayload.cases.Message.make({ message: {
    id: text, role: "user", text, createdAt: timestamp,
  } });

  const recorded = [
    AgentEvent.make({ botId: "one", sequence: 1, timestamp, payload: payload("LEGACY_DIRECT_EVENT") }),
    AgentEvent.make({ botId: "one", sequence: 2, timestamp, payload: payload("FIRST_ROUTINE_EVENT"), conversationId: `routine-${first.id}` }),
    AgentEvent.make({ botId: "one", sequence: 3, timestamp, payload: payload("SECOND_ROUTINE_EVENT"), conversationId: `routine-${second.id}` }),
  ];

  await writeFile(join(dataDir, "bots", "one", "events.jsonl"), recorded.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  const direct = await decode(MessageSnapshot, await request("/v1/bots/one/messages"));
  assert.ok(direct.messages.every((message) => message.text.includes("DIRECT_PRIVATE_FIXTURE")));
  assert.equal(direct.messages.length, 2);
  const routine = await decode(MessageSnapshot, await request(`/v1/bots/one/messages?conversationId=routine-${first.id}`));
  assert.ok(routine.messages.every((message) => message.text.includes("FIRST_ROUTINE_FIXTURE")));
  assert.equal(routine.messages.length, 2);
  const restoredDirect = await decode(MessageSnapshot, await request("/v1/bots/one/messages"));
  assert.deepEqual(restoredDirect.messages, direct.messages);
  assert.equal((await request("/v1/bots/one/messages?conversationId=..%2Fescape")).status, 400);
  checks.push("Real Pi worker reads separate saved direct and routine histories without switching active conversation");

  const directEvents = await replay();
  assert.deepEqual(directEvents.flatMap((event) => EventPayload.isAnyOf(["Message"])(event.payload) ? [event.payload.message.text] : []), ["LEGACY_DIRECT_EVENT"]);
  const routineEvents = await replay(`routine-${first.id}`);
  assert.deepEqual(routineEvents.flatMap((event) => EventPayload.isAnyOf(["Message"])(event.payload) ? [event.payload.message.text] : []), ["FIRST_ROUTINE_EVENT"]);
  checks.push("SSE isolates routine events and preserves legacy direct history plus global readiness");

  const manual = await decode(Schema.Struct({ run: RoutineRun }), await request(`/v1/routines/${first.id}/run`, "POST"));
  assert.equal(manual.run.status, "blocked");
  assert.match(manual.run.message, /ChatGPT subscription/);
  assert.equal(manual.run.conversationId, `routine-${first.id}`);
  const auth = await decode(AuthStatus, await request("/v1/bots/one/auth"));
  assert.deepEqual(auth, { openai: "signed-out", executor: "signed-out", active: null });
  assert.equal(await host.isBusy(), false);
  assert.equal((await runs(first.id)).length, 1);
  checks.push("Explicit manual execution records signed-out admission as blocked, without OAuth or inference");

  const pausedPid = [...pids][0];
  assert.ok(pausedPid);
  process.kill(pausedPid, "SIGSTOP");

  try {
    const uncertain = await decode(Schema.Struct({ run: RoutineRun }), await request(`/v1/routines/${first.id}/run`, "POST"));
    assert.equal(uncertain.run.status, "starting");
    assert.match(uncertain.run.message, /outcome is unknown/);
    assert.equal((await request(`/v1/routines/${first.id}`, "PATCH", { name: "Must stay locked" })).status, 409);
    assert.equal((await request(`/v1/routines/${first.id}`, "DELETE")).status, 409);
    assert.equal((await request("/v1/bots/one/cancel", "POST")).status, 409);
    process.kill(pausedPid, "SIGCONT");
    assert.equal((await request(`/v1/bots/one/cancel?conversationId=routine-${first.id}`, "POST")).status, 200);
    await waitFor(() => runs(first.id), (items) => items.some((item) => item.id === uncertain.run.id && item.status === "cancelled"));
    assert.equal(await host.isBusy(), false);
  } finally {
    process.kill(pausedPid, "SIGCONT");
  }

  checks.push("A real stopped worker produces uncertain admission, rejects edit/delete/wrong-conversation cancel, and resolves safely after scoped cancellation");

  const scheduled = await create("Scheduled", RoutineSchedule.cases.Once.make({ at: new Date(Date.now() + 2500).toISOString() }));
  await decode(Schema.Struct({ routine: Routine }), await request(`/v1/routines/${scheduled.id}/enabled`, "POST", { enabled: true }));
  const scheduledRuns = await waitFor(() => runs(scheduled.id), (items) => items.some((item) => item.status === "blocked"));
  assert.equal(scheduledRuns.length, 1);
  assert.equal(scheduledRuns[0]?.trigger, "scheduled");
  const all = await decode(Schema.Struct({ routines: Schema.Array(Routine) }), await request("/v1/routines"));
  assert.equal(all.routines.find((item) => item.id === scheduled.id)?.enabled, false);
  assert.equal((await stat(join(dataDir, "routines", "state.json"))).mode & 0o777, 0o600);
  checks.push("Effect scheduler dispatches one enabled occurrence, records its blocked outcome, and disables completed one-time schedule");

  const missed = await create("Offline", RoutineSchedule.cases.Once.make({ at: new Date(Date.now() + 1200).toISOString() }));
  await decode(Schema.Struct({ routine: Routine }), await request(`/v1/routines/${missed.id}/enabled`, "POST", { enabled: true }));
  await host.close();

  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  await waitFor(async () => Date.now(), (now) => RoutineSchedule.isAnyOf(["Once"])(missed.schedule) && now > Date.parse(missed.schedule.at));
  host = await createAgentHttpHandler({ dataDir });
  assert.ok((await runs(first.id)).some((item) => item.id === manual.run.id));
  assert.equal((await runs(missed.id))[0]?.status, "missed");
  const stillIsolated = await decode(MessageSnapshot, await request(`/v1/bots/one/messages?conversationId=routine-${second.id}`));
  assert.ok(stillIsolated.messages.every((message) => message.text.includes("SECOND_ROUTINE_FIXTURE")));
  checks.push("Host restart preserves history and run IDs, skips offline occurrences, and terminates old Pi process");

  await host.close();

  const saved = Schema.decodeUnknownSync(Schema.Struct({ routines: Schema.Array(Routine), runs: Schema.Array(RoutineRun) }))(
    JSON.parse(await readFile(join(dataDir, "routines", "state.json"), "utf8")),
  );

  const interrupted: RoutineRun = { ...manual.run, id: crypto.randomUUID(), status: "starting", finishedAt: null, message: "Synthetic persisted interrupted admission checkpoint" };
  const completed: RoutineRun = { ...interrupted, id: crypto.randomUUID(), message: "Synthetic terminal-journal checkpoint" };
  await writeFile(join(dataDir, "routines", "state.json"), JSON.stringify({ ...saved, runs: [...saved.runs, interrupted, completed] }), { mode: 0o600 });
  const eventPath = join(dataDir, "bots", "one", "events.jsonl");

  const events = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))(line));

  events.push(AgentEvent.make({ botId: "one", sequence: (events.at(-1)?.sequence ?? 0) + 1,
    timestamp: new Date().toISOString(), conversationId: completed.conversationId,
    payload: EventPayload.cases.RunCompleted.make({ runId: completed.id }) }));
  await writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  host = await createAgentHttpHandler({ dataDir });
  const recovered = (await runs(first.id)).find((item) => item.id === interrupted.id);
  assert.equal(recovered?.status, "interrupted");
  assert.match(recovered?.message ?? "", /not retried/);
  assert.equal((await runs(first.id)).find((item) => item.id === completed.id)?.status, "completed");
  checks.push("Persisted interrupted admission is marked interrupted and never automatically replayed");
  checks.push("A terminal outcome already in the durable agent journal repairs an unfinished routine row on restart");

  assert.equal((await request(`/v1/routines/${second.id}`, "DELETE")).status, 200);
  assert.equal((await request(`/v1/routines/${second.id}/runs`)).status, 404);
  assert.equal((await request(`/v1/bots/one/messages?conversationId=routine-${second.id}`)).status, 404);
  await assert.rejects(stat(join(dataDir, "bots", "one", "conversations", `routine-${second.id}`)));
  assert.equal((await readFile(eventPath, "utf8")).includes("SECOND_ROUTINE_EVENT"), false);
  checks.push("Routine deletion removes configuration, journal, Pi transcript, and scoped events; deleted conversation IDs are rejected");

  const result = {
    ok: true, timestamp: new Date().toISOString(), checks,
    evidence: { realPiProcesses: true, localApi: true, syntheticSavedHistoryFixtures: true, noProviderAuth: true, noInference: true, noCloudResourcesTouched: true },
  };

  await mkdir("artifacts/routines-backend-e2e", { recursive: true });
  await writeFile("artifacts/routines-backend-e2e/result.json", JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
}
