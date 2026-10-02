import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  Context, Cron, Effect, Layer, Option, Result, Schedule, Schema, Scope, Semaphore, Stream,
} from "effect";
import { AgentHost } from "./host";
import { AgentEvent, BackendError, ChildCommand, EventPayload } from "./contracts";
import {
  CreateRoutine, Routine, RoutineId, RoutineRun, RoutineSchedule, UpdateRoutine,
} from "./routine-contracts";

export interface Interface {
  readonly list: () => Effect.Effect<readonly Routine[], BackendError>;
  readonly create: (input: CreateRoutine) => Effect.Effect<Routine, BackendError>;
  readonly update: (id: string, input: UpdateRoutine) => Effect.Effect<Routine, BackendError>;
  readonly remove: (id: string) => Effect.Effect<void, BackendError>;
  readonly enabled: (id: string, enabled: boolean) => Effect.Effect<Routine, BackendError>;
  readonly runs: (id: string) => Effect.Effect<readonly RoutineRun[], BackendError>;
  readonly run: (id: string) => Effect.Effect<RoutineRun, BackendError>;
  readonly conversation: (botId: string, conversationId: string) => Effect.Effect<void, BackendError>;
}

export class Service extends Context.Service<Service, Interface>()("Labora/Routines") {}

const State = Schema.Struct({
  routines: Schema.Array(Routine),
  runs: Schema.Array(RoutineRun),
});

type State = Schema.Schema.Type<typeof State>;

const failure = (code: string, message: string, status = 400) =>
  new BackendError({ code, message, status });

const storage = Effect.fn("Routines.storage")(<A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: () => failure("routine_storage", "Routine storage could not be read or saved.", 500),
  }),
);

const validateSchedule = Effect.fn("Routines.validateSchedule")((schedule: RoutineSchedule) =>
  RoutineSchedule.match<Effect.Effect<void, BackendError>>(schedule, {
    Once: ({ at }) => Effect.gen(function* () {
      const value = Date.parse(at);

      if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== at.slice(0, 19))
        return yield* Effect.fail(failure("invalid_schedule", "Choose a valid date and time."));

      if (value <= Date.now())
        return yield* Effect.fail(failure("invalid_schedule", "Choose a future date and time."));
    }),
    Cron: ({ expression, timeZone }) => Effect.gen(function* () {
      if (expression.trim().split(/\s+/).length !== 5 || Result.isFailure(Cron.parse(expression, timeZone)))
        return yield* Effect.fail(failure("invalid_schedule", "Use a five-field schedule and a valid time zone."));

      yield* nextOccurrence(schedule, Date.now());
    }),
  }),
);

const nextOccurrence = Effect.fn("Routines.nextOccurrence")((schedule: RoutineSchedule, after: number) =>
  RoutineSchedule.match<Effect.Effect<string | null, BackendError>>(schedule, {
    Once: ({ at }) => Effect.succeed(Date.parse(at) > after ? new Date(at).toISOString() : null),
    Cron: ({ expression, timeZone }) => Effect.gen(function* () {
      const parsed = Cron.parse(expression, timeZone);

      if (Result.isFailure(parsed))
        return yield* Effect.fail(failure("invalid_schedule", "The saved schedule or time zone is invalid."));

      return yield* Effect.try({
        try: () => Cron.next(parsed.success, new Date(after)).toISOString(),
        catch: () => failure("invalid_schedule", "This schedule has no upcoming occurrence."),
      });
    }),
  }),
);

const active = (run: RoutineRun) => run.status === "starting" || run.status === "running";

type FinishedStatus = Exclude<RoutineRun["status"], "starting" | "running">;

export const layer = (options: Pick<AgentHost.HostOptions, "dataDir">) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const host = yield* AgentHost.Service;
    const scope = yield* Scope.Scope;
    const mutex = yield* Semaphore.make(1);
    const directory = join(resolve(options.dataDir), "routines");
    const path = join(directory, "state.json");
    yield* storage(() => mkdir(directory, { recursive: true, mode: 0o700 }));

    let state: State = { routines: [], runs: [] };
    const pendingFinishes = new Map<string, { status: FinishedStatus; message: string }>();

    if (yield* storage(() => Bun.file(path).exists())) {
      const content = yield* storage(() => readFile(path, "utf8"));
      state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(State))(content).pipe(
        Effect.mapError(() => failure("routine_storage", "Saved routines contain invalid data.", 500)),
      );
    }

    const save = Effect.fn("Routines.save")(function* (next: State) {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      yield* storage(async () => {
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      state = next;
    });

    const find = Effect.fn("Routines.find")(function* (id: string) {
      yield* Schema.decodeUnknownEffect(RoutineId)(id).pipe(
        Effect.mapError(() => failure("invalid_routine", "Invalid routine ID.")),
      );
      const routine = state.routines.find((item) => item.id === id);

      if (!routine) return yield* Effect.fail(failure("not_found", "Routine not found.", 404));

      return routine;
    });

    const replace = Effect.fn("Routines.replace")((routine: Routine) => save({
      ...state,
      routines: state.routines.map((item) => item.id === routine.id ? routine : item),
    }));

    const finish = Effect.fn("Routines.finish")(function* (runId: string, status: FinishedStatus, message: string) {
      pendingFinishes.set(runId, { status, message });
      yield* mutex.withPermit(Effect.gen(function* () {
        const previous = state.runs.find((item) => item.id === runId);

        if (!previous || !active(previous)) {
          pendingFinishes.delete(runId);

          return;
        }

        const run: RoutineRun = {
          ...previous, status, message, finishedAt: new Date().toISOString(),
        };

        yield* save({ ...state, runs: state.runs.map((item) => item.id === runId ? run : item) });
        pendingFinishes.delete(runId);
      })).pipe(Effect.retry(Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 5 }))));
    });

    const watch = Effect.fn("Routines.watch")(function* (run: RoutineRun, events: Stream.Stream<AgentEvent>) {
      const terminal = yield* events.pipe(
        Stream.map((event) => event.payload),
        Stream.filter((payload) => EventPayload.isAnyOf(["ProcessExited"])(payload) ||
          (EventPayload.isAnyOf(["RunCompleted", "RunCancelled", "RunFailed"])(payload) && payload.runId === run.id)),
        Stream.runHead,
      );

      if (Option.isNone(terminal)) {
        yield* finish(run.id, "interrupted", "The agent event stream ended before completion.");

        return;
      }

      const payload = terminal.value;

      if (EventPayload.isAnyOf(["RunCompleted"])(payload))
        yield* finish(run.id, "completed", "Completed.");
      else if (EventPayload.isAnyOf(["RunCancelled"])(payload))
        yield* finish(run.id, "cancelled", "Cancelled.");
      else if (EventPayload.isAnyOf(["RunFailed"])(payload))
        yield* finish(run.id, "failed", payload.message);
      else if (EventPayload.isAnyOf(["ProcessExited"])(payload))
        yield* finish(run.id, "interrupted", payload.message);
    });

    const dispatch = Effect.fn("Routines.dispatch")(function* (run: RoutineRun, prompt: string) {
      const observed = yield* host.startRun(run.botId, ChildCommand.cases.Prompt.make({
        runId: run.id,
        conversationId: run.conversationId,
        message: { text: prompt },
      }));

      const admission = observed.admission;

      if (Result.isFailure(admission)) {
        const error = admission.failure;

        if (error.code === "agent_error" || error.code === "bot_busy") {
          yield* finish(run.id, "blocked", error.message);

          return;
        }

        if (error.code === "worker_exited") {
          yield* finish(run.id, "interrupted", error.message);

          return;
        }
      }

      yield* watch(run, observed.events).pipe(
        Effect.tapError((error) => Effect.logError(error.message)), Effect.ignore,
        Effect.forkIn(scope),
      );

      yield* mutex.withPermit(Effect.gen(function* () {
        const current = state.runs.find((item) => item.id === run.id);

        if (!current || !active(current)) return;

        const running: RoutineRun = Result.isSuccess(admission)
          ? { ...current, status: "running", finishedAt: null, message: "Running." }
          : { ...current, status: "starting", finishedAt: null, message: admission.failure.message };

        yield* save({ ...state, runs: state.runs.map((item) => item.id === run.id ? running : item) });
      })).pipe(Effect.tapError((error) => Effect.logError(error.message)), Effect.ignore);
    });

    const start = Effect.fn("Routines.start")(function* (
      id: string,
      trigger: RoutineRun["trigger"],
      scheduledAt: string,
    ) {
      const claimed = yield* mutex.withPermit(Effect.gen(function* () {
        const routine = yield* find(id);

        if (trigger === "scheduled" && (!routine.enabled || routine.nextRunAt !== scheduledAt)) return null;

        const alreadyRunning = state.runs.some((item) => item.routineId === id && active(item));

        if (trigger === "manual" && alreadyRunning)
          return yield* Effect.fail(failure("routine_busy", "This routine is already running.", 409));
        const timestamp = new Date().toISOString();
        const missed = trigger === "scheduled" && Date.now() - Date.parse(scheduledAt) > 60_000;

        const common = {
          id: crypto.randomUUID(), routineId: id, botId: routine.botId,
          conversationId: `routine-${id}`, trigger, scheduledAt,
          startedAt: timestamp,
        };

        const run: RoutineRun = missed
          ? { ...common, finishedAt: timestamp, status: "missed", message: "The computer was unavailable at the scheduled time. This occurrence was skipped." }
          : alreadyRunning
            ? { ...common, finishedAt: timestamp, status: "blocked", message: "The previous run was still active. This occurrence was skipped." }
            : { ...common, finishedAt: null, status: "starting", message: "Starting." };

        let next = routine;

        if (trigger === "scheduled") {
          const nextRunAt = yield* nextOccurrence(routine.schedule, Date.now());
          next = { ...routine, nextRunAt, enabled: nextRunAt !== null, updatedAt: timestamp };
        }

        const retained = state.runs.filter((item) => item.routineId === id).slice(-99);
        const others = state.runs.filter((item) => item.routineId !== id);
        yield* save({
          routines: state.routines.map((item) => item.id === id ? next : item),
          runs: [...others, ...retained, run],
        });

        return { run, prompt: routine.prompt };
      }));

      if (!claimed) return null;
      const { run, prompt } = claimed;

      if (!active(run)) return run;
      yield* dispatch(run, prompt).pipe(Effect.catch((error) => finish(
        run.id,
        error.code === "agent_error" || error.code === "bot_busy" ? "blocked" : "interrupted",
        error.message,
      )));

      return state.runs.find((item) => item.id === run.id) ?? run;
    });

    const ensureEditable = Effect.fn("Routines.ensureEditable")(function* (id: string) {
      if (state.runs.some((item) => item.routineId === id && active(item)))
        return yield* Effect.fail(failure("routine_busy", "Wait for this routine to finish before editing or deleting it.", 409));
    });

    const list = Effect.fn("Routines.list")(() => Effect.succeed(state.routines));

    const create = Effect.fn("Routines.create")((input: CreateRoutine) => mutex.withPermit(
      Effect.gen(function* () {
        if (!input.name.trim() || !input.prompt.trim())
          return yield* Effect.fail(failure("invalid_routine", "Enter a name and instructions."));

        if (state.routines.length >= 200)
          return yield* Effect.fail(failure("routine_limit", "This computer already has 200 routines.", 409));

        if (!(yield* host.list()).some((bot) => bot.id === input.botId))
          return yield* Effect.fail(failure("not_found", "Choose a bot on this computer.", 404));
        yield* validateSchedule(input.schedule);
        const timestamp = new Date().toISOString();

        const routine: Routine = {
          ...input, name: input.name.trim(), id: crypto.randomUUID(), enabled: false,
          createdAt: timestamp, updatedAt: timestamp, nextRunAt: null,
        };

        yield* save({ ...state, routines: [...state.routines, routine] });

        return routine;
      }),
    ));

    const update = Effect.fn("Routines.update")((id: string, input: UpdateRoutine) => mutex.withPermit(
      Effect.gen(function* () {
        const previous = yield* find(id);
        yield* ensureEditable(id);

        if ((input.name !== undefined && !input.name.trim()) || (input.prompt !== undefined && !input.prompt.trim()))
          return yield* Effect.fail(failure("invalid_routine", "Enter a name and instructions."));

        if (input.schedule) yield* validateSchedule(input.schedule);

        const nextRunAt = input.schedule && previous.enabled
          ? yield* nextOccurrence(input.schedule, Date.now())
          : previous.nextRunAt;

        const routine: Routine = { ...previous, ...input, nextRunAt, updatedAt: new Date().toISOString() };
        yield* replace(routine);

        return routine;
      }),
    ));

    const enabled = Effect.fn("Routines.enabled")((id: string, enable: boolean) => mutex.withPermit(
      Effect.gen(function* () {
        const previous = yield* find(id);

        if (previous.enabled === enable) return previous;
        const nextRunAt = enable ? yield* nextOccurrence(previous.schedule, Date.now()) : null;

        if (enable && nextRunAt === null)
          return yield* Effect.fail(failure("invalid_schedule", "Choose a new future time before enabling this routine."));

        const routine: Routine = {
          ...previous, enabled: enable, nextRunAt, updatedAt: new Date().toISOString(),
        };

        yield* replace(routine);

        return routine;
      }),
    ));

    const remove = Effect.fn("Routines.remove")((id: string) => mutex.withPermit(
      Effect.gen(function* () {
        const routine = yield* find(id);
        yield* ensureEditable(id);
        yield* host.forgetConversation(routine.botId, `routine-${routine.id}`);
        yield* save({
          routines: state.routines.filter((item) => item.id !== id),
          runs: state.runs.filter((item) => item.routineId !== id),
        });
      }),
    ));

    const runs = Effect.fn("Routines.runs")(function* (id: string) {
      yield* find(id);

      return state.runs.filter((item) => item.routineId === id).reverse();
    });

    const run = Effect.fn("Routines.run")(function* (id: string) {
      const result = yield* start(id, "manual", new Date().toISOString());

      if (!result) return yield* Effect.fail(failure("routine_unavailable", "Routine is unavailable.", 409));

      return result;
    });

    const conversation = Effect.fn("Routines.conversation")(function* (botId: string, conversationId: string) {
      if (conversationId === "direct") return;

      if (!conversationId.startsWith("routine-"))
        return yield* Effect.fail(failure("not_found", "Conversation not found.", 404));
      const routine = yield* find(conversationId.slice("routine-".length));

      if (routine.botId !== botId)
        return yield* Effect.fail(failure("not_found", "Conversation not found on this bot.", 404));
    });

    const recover = Effect.fn("Routines.recover")(function* () {
      const timestamp = new Date().toISOString();

      const recovered: RoutineRun[] = [];
      const eventsByBot = new Map<string, AgentEvent[]>();

      for (const item of state.runs) {
        if (!active(item)) { recovered.push(item); continue; }

        let events = eventsByBot.get(item.botId);

        if (!events) {
          events = [];
          const eventPath = join(resolve(options.dataDir), "bots", item.botId, "events.jsonl");

          if (yield* storage(() => Bun.file(eventPath).exists())) {
            const content = yield* storage(() => readFile(eventPath, "utf8"));

            for (const line of content.trim().split("\n")) {
              if (!line) continue;
              events.push(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent))(line).pipe(
                Effect.mapError(() => failure("routine_storage", "Saved agent events could not be reconciled.", 500)),
              ));
            }
          }

          eventsByBot.set(item.botId, events);
        }

        const terminal = events.find((event) => event.conversationId === item.conversationId &&
          EventPayload.isAnyOf(["RunCompleted", "RunFailed", "RunCancelled"])(event.payload) && event.payload.runId === item.id);

        const payload = terminal?.payload;

        if (payload && EventPayload.isAnyOf(["RunCompleted", "RunFailed", "RunCancelled"])(payload)) {
          const status = EventPayload.isAnyOf(["RunCompleted"])(payload) ? "completed"
            : EventPayload.isAnyOf(["RunCancelled"])(payload) ? "cancelled" : "failed";

          recovered.push({ ...item, status, finishedAt: terminal.timestamp,
            message: EventPayload.isAnyOf(["RunFailed"])(payload) ? payload.message : `Recovered ${status} outcome from the agent journal.` });
        } else recovered.push({ ...item, status: "interrupted", finishedAt: timestamp,
          message: "The computer restarted before this run completed. It was not retried." });
      }

      const routines: Routine[] = [];

      for (const routine of state.routines) {
        if (!routine.enabled || !routine.nextRunAt || Date.parse(routine.nextRunAt) > Date.now()) {
          routines.push(routine);
          continue;
        }

        recovered.push({
          id: crypto.randomUUID(), routineId: routine.id, botId: routine.botId,
          conversationId: `routine-${routine.id}`, trigger: "scheduled", scheduledAt: routine.nextRunAt,
          startedAt: timestamp, finishedAt: timestamp, status: "missed",
          message: "The computer was unavailable at the scheduled time. This occurrence was skipped.",
        });
        const nextRunAt = yield* nextOccurrence(routine.schedule, Date.now());
        routines.push({ ...routine, nextRunAt, enabled: nextRunAt !== null, updatedAt: timestamp });
      }

      if (recovered.some((item, index) => item !== state.runs[index]) || routines.some((item, index) => item !== state.routines[index]))
        yield* save({ routines, runs: recovered });
    });

    yield* recover();
    yield* Effect.addFinalizer(() => mutex.withPermit(Effect.gen(function* () {
      const finishedAt = new Date().toISOString();

      if (!state.runs.some(active)) return;
      yield* save({ ...state, runs: state.runs.map((item): RoutineRun => {
        if (!active(item)) return item;
        const outcome = pendingFinishes.get(item.id);

        return outcome
          ? { ...item, ...outcome, finishedAt }
          : { ...item, status: "interrupted", finishedAt, message: "The computer stopped before this run completed. It was not retried." };
      }) });
    })).pipe(Effect.tapError((error) => Effect.logError(error.message)), Effect.ignore));

    const pass = Effect.fn("Routines.pass")(function* () {
      for (const [id, outcome] of pendingFinishes)
        yield* finish(id, outcome.status, outcome.message).pipe(
          Effect.tapError((error) => Effect.logError(error.message)), Effect.ignore,
        );

      const due = state.routines.filter((routine) => routine.enabled && routine.nextRunAt &&
        Date.parse(routine.nextRunAt) <= Date.now());

      yield* Effect.forEach(due, (routine) => {
        const scheduledAt = routine.nextRunAt;

        if (!scheduledAt) return Effect.void;

        return start(routine.id, "scheduled", scheduledAt).pipe(
          Effect.tapError((error) => Effect.logError(error.message)), Effect.ignore,
        );
      }, { concurrency: 4, discard: true });
    });

    yield* pass().pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkIn(scope));

    return Service.of({ list, create, update, remove, enabled, runs, run, conversation });
  }),
);

export * as Routines from "./routines";
