import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  stat,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { Config, Context, Effect, Layer, PubSub, Result, Schema, Scope, Semaphore, Stream } from "effect";
import lockfile from "proper-lockfile";
import type { Subprocess } from "bun";
import { idleActivity, reduceActivity } from "./activity";
import type { BotActivity } from "./contracts";
import { ActionsRequest, type Computer, type Frame } from "../computer/contracts";
import {
  AgentEvent,
  BackendError,
  Bot,
  ChildCommand,
  ChildOutput,
  ChildRequest,
  CreateBot,
  ConversationId,
  EventPayload,
  isConversationEvent,
  MessageSnapshot,
  WorkerMessages,
  UpdateBot,
  WorkspaceFile,
} from "./contracts";

export interface ComputerAdapter {
  readonly info: () => Promise<Computer>;
  readonly capture: (displayId: string) => Promise<{ frame: Frame; png: Uint8Array }>;
  readonly act: (request: ActionsRequest) => Promise<{ executed: number }>;
  readonly browser?: (input: {
    readonly url: string;
  }) => Promise<Schema.Schema.Type<typeof Schema.Json>>;
}

export interface HostOptions {
  readonly dataDir: string;
  readonly computer?: ComputerAdapter;
}

interface Pending {
  readonly conversationId: string;
  readonly resolve: (value: Reply) => void;
  readonly reject: (error: BackendError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Reply {
  readonly value: Schema.Schema.Type<typeof Schema.Json>;
  readonly cursor: number;
  readonly busy: boolean;
  readonly activity: BotActivity;
  readonly botActivity: BotActivity;
  readonly interactive: readonly EventPayload[];
}

interface Worker {
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  readonly pending: Map<string, Pending>;
  readonly events: AgentEvent[];
  readonly bus: PubSub.PubSub<AgentEvent>;
  readonly publishing: Semaphore.Semaphore;
  readonly activity: Set<string>;
  readonly interactive: Map<string, {
    readonly payload: EventPayload;
    readonly conversationId: string;
  }>;
  readonly conversationActivities: Map<string, BotActivity>;
  botActivity: BotActivity;
  activeConversationId: string;
  activeRunId: string | undefined;
  sequence: number;
  exited: boolean;
}

export interface Interface {
  readonly isBusy: () => Effect.Effect<boolean>;
  readonly list: () => Effect.Effect<readonly Bot[], BackendError>;
  readonly create: (input: CreateBot) => Effect.Effect<Bot, BackendError>;
  readonly update: (id: string, input: UpdateBot) => Effect.Effect<Bot, BackendError>;
  readonly files: (id: string) => Effect.Effect<readonly WorkspaceFile[], BackendError>;
  readonly file: (id: string, path: string) => Effect.Effect<Uint8Array, BackendError>;
  readonly request: (
    id: string,
    command: ChildCommand,
  ) => Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, BackendError>;
  readonly startRun: (
    id: string,
    command: Schema.Schema.Type<typeof ChildCommand.cases.Prompt>,
  ) => Effect.Effect<{
    readonly admission: Result.Result<Schema.Schema.Type<typeof Schema.Json>, BackendError>;
    readonly events: Stream.Stream<AgentEvent>;
  }, BackendError>;
  readonly snapshot: (id: string, conversationId?: string) => Effect.Effect<MessageSnapshot, BackendError>;
  readonly activity: (id: string) => Effect.Effect<BotActivity, BackendError>;
  readonly forgetConversation: (id: string, conversationId: string) => Effect.Effect<void, BackendError>;
  readonly events: (
    id: string,
    cursor: number,
    conversationId?: string | null,
  ) => Effect.Effect<Stream.Stream<AgentEvent>, BackendError>;
}

export class Service extends Context.Service<Service, Interface>()("Labora/AgentHost") {}

const filesystem = Effect.fn("AgentHost.filesystem")(
  <A>(operation: string, action: () => Promise<A>) =>
    Effect.tryPromise({
      try: action,
      catch: (error) =>
        new BackendError({
          code: "storage_error",
          message: `${operation}: ${error instanceof Error ? error.message : String(error)}`,
          status: 500,
        }),
    }),
);

const decodeBot = Schema.decodeUnknownEffect(Schema.fromJsonString(Bot));

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent));

const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ChildOutput));

const EventSequence = Schema.Struct({ sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) });

const schemaError = (message: string) =>
  new BackendError({ code: "invalid_data", message, status: 400 });

export const layer = (options: HostOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;

      const packaged = yield* Config.Boolean("LABORA_PACKAGED").pipe(
        Config.withDefault(false),
        Effect.mapError(() => schemaError("Invalid LABORA_PACKAGED setting")),
      );

      const dataDir = resolve(options.dataDir);
      const botsDir = join(dataDir, "bots");
      yield* filesystem("Create bot storage", () =>
        mkdir(botsDir, { recursive: true, mode: 0o700 }),
      );

      const release = yield* filesystem("Acquire agent host ownership", () =>
        lockfile.lock(dataDir, {
          lockfilePath: join(dataDir, ".agent-host.lock"),
          stale: 10_000,
          update: 2_000,
          retries: 0,
        }),
      );

      const workers = new Map<string, Worker>();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const worker of workers.values()) {
            if (worker.exited) continue;
            worker.child.stdin.write(
              `${JSON.stringify(ChildRequest.make({ id: crypto.randomUUID(), command: ChildCommand.cases.Close.make({}) }))}\n`,
            );
            worker.child.stdin.end();
          }

          await Promise.all(
            [...workers.values()].map(async (worker) => {
              const timer = setTimeout(() => worker.child.kill(), 5_000);
              await worker.child.exited;
              clearTimeout(timer);
            }),
          );
          await release();
        }),
      );

      const isBusy = Effect.fn("AgentHost.isBusy")(() =>
        Effect.sync(() =>
          [...workers.values()].some(
            (worker) => !worker.exited && (worker.activity.size > 0 || worker.pending.size > 0),
          ),
        ),
      );

      const getBot = Effect.fn("AgentHost.getBot")(function* (id: string) {
        yield* Schema.decodeUnknownEffect(CreateBot.fields.id)(id).pipe(
          Effect.mapError(() => schemaError("Invalid bot ID")),
        );
        const path = join(botsDir, id, "bot.json");
        const exists = yield* filesystem("Find bot", () => Bun.file(path).exists());

        if (!exists)
          return yield* Effect.fail(
            new BackendError({ code: "not_found", message: "Bot not found", status: 404 }),
          );
        const content = yield* filesystem("Read bot", () => readFile(path, "utf8"));

        return yield* decodeBot(content).pipe(
          Effect.mapError(() => schemaError("Invalid stored bot metadata")),
        );
      });

      const publish = Effect.fn("AgentHost.publish")(
        (id: string, worker: Worker, payload: EventPayload, conversationId?: string) =>
          worker.publishing.withPermit(
            Effect.gen(function* () {
              const event = AgentEvent.make({
                botId: id,
                sequence: ++worker.sequence,
                timestamp: new Date().toISOString(),
                payload,
                conversationId: conversationId ?? "direct",
              });

              if (isConversationEvent(payload)) {
                const key = conversationId ?? "direct";
                worker.conversationActivities.set(key, reduceActivity(worker.conversationActivities.get(key) ?? idleActivity(), payload));
                worker.botActivity = reduceActivity(worker.botActivity, payload);
              }

              if (EventPayload.isAnyOf(["ProcessExited"])(payload)) {
                if (["thinking", "streaming", "working", "waiting", "asking", "retrying", "compacting"].includes(worker.botActivity.phase))
                  worker.botActivity = reduceActivity(worker.botActivity, payload);

                for (const [key, activity] of worker.conversationActivities)
                  if (["thinking", "streaming", "working", "waiting", "asking", "retrying", "compacting"].includes(activity.phase))
                    worker.conversationActivities.set(key, reduceActivity(activity, payload));
              }

              yield* filesystem("Persist agent event", () =>
                appendFile(join(botsDir, id, "events.jsonl"), `${JSON.stringify(event)}\n`, {
                  mode: 0o600,
                }),
              );
              worker.events.push(event);

              if (worker.events.length > 2048) worker.events.shift();
              yield* PubSub.publish(worker.bus, event);
            }),
          ),
      );

      const replyComputer = Effect.fn("AgentHost.computer")(function* (
        worker: Worker,
        request: Schema.Schema.Type<typeof ChildOutput.cases.Computer>,
      ) {
        const result = yield* Effect.tryPromise({
          try: async () => {
            if (!options.computer) throw new Error("No computer is connected to this agent host.");

            if (request.operation === "info") return options.computer.info();

            if (request.operation === "browser") {
              if (!options.computer.browser)
                throw new Error("Kitesurf is unavailable on this computer.");

              const input = await Effect.runPromise(
                Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))(request.input),
              );

              const url = new URL(input.url);

              if (url.protocol !== "https:" || url.username || url.password)
                throw new Error("Browser reads require a public HTTPS URL without credentials.");

              return options.computer.browser({ url: url.href });
            }

            if (request.operation === "capture") {
              const parsed = await Effect.runPromise(
                Schema.decodeUnknownEffect(Schema.Struct({ displayId: Schema.String }))(
                  request.input,
                ),
              );

              const result = await options.computer.capture(parsed.displayId);

              return { frame: result.frame, png: Buffer.from(result.png).toString("base64") };
            }

            const actions = await Effect.runPromise(
              Schema.decodeUnknownEffect(ActionsRequest)(request.input),
            );

            return options.computer.act({ ...actions, actor: "agent" });
          },
          catch: (error) =>
            new BackendError({
              code: "computer_error",
              message: error instanceof Error ? error.message : String(error),
              status: 409,
            }),
        }).pipe(
          Effect.match({
            onSuccess: (value) =>
              ChildCommand.cases.ComputerResult.make({
                requestId: request.id,
                value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                  JSON.stringify(value),
                ),
              }),
            onFailure: (error) =>
              ChildCommand.cases.ComputerResult.make({
                requestId: request.id,
                value: null,
                error: error.message,
              }),
          }),
        );

        worker.child.stdin.write(
          `${JSON.stringify(ChildRequest.make({ id: crypto.randomUUID(), command: result }))}\n`,
        );
      });

      const consume = Effect.fn("AgentHost.consume")(function* (
        id: string,
        worker: Worker,
        line: string,
      ) {
        const message = yield* decodeOutput(line).pipe(
          Effect.mapError(() => schemaError("Agent worker sent invalid IPC")),
        );

        return yield* ChildOutput.match<Effect.Effect<void, BackendError>>(message, {
          Event: (event) =>
            Effect.gen(function* () {
              const payload = event.payload;

              if (EventPayload.isAnyOf(["RunStarted"])(payload)) {
                worker.activity.add("run");
                worker.activeConversationId = event.conversationId ?? "direct";
                worker.activeRunId = payload.runId;
              }

              if (EventPayload.isAnyOf(["RunCompleted", "RunCancelled", "RunFailed"])(payload) &&
                payload.runId === worker.activeRunId) {
                worker.activity.delete("run");
                worker.activeRunId = undefined;
              }

              if (EventPayload.isAnyOf(["AuthLink", "AuthPrompt"])(payload))
                worker.activity.add("auth");

              if (EventPayload.isAnyOf(["AuthCompleted", "AuthFailed"])(payload))
                worker.activity.delete("auth");

              if (EventPayload.isAnyOf(["ApprovalRequested"])(payload))
                worker.activity.add(`approval:${payload.requestId}`);

              if (EventPayload.isAnyOf(["ApprovalResolved"])(payload))
                worker.activity.delete(`approval:${payload.requestId}`);

              if (EventPayload.isAnyOf(["ApprovalRequested"])(payload))
                worker.interactive.set(payload.requestId, { payload, conversationId: event.conversationId ?? "direct" });

              if (EventPayload.isAnyOf(["ApprovalResolved"])(payload))
                worker.interactive.delete(payload.requestId);

              if (EventPayload.isAnyOf(["QuestionRequested"])(payload)) {
                worker.activity.add(`question:${payload.requestId}`);
                worker.interactive.set(payload.requestId, { payload, conversationId: event.conversationId ?? "direct" });
              }

              if (EventPayload.isAnyOf(["QuestionResolved"])(payload)) {
                worker.activity.delete(`question:${payload.requestId}`);
                worker.interactive.delete(payload.requestId);
              }

              if (EventPayload.isAnyOf(["InputQueueChanged"])(payload)) {
                if (payload.items.length) worker.interactive.set("input-queue", { payload, conversationId: event.conversationId ?? "direct" });
                else worker.interactive.delete("input-queue");
              }

              if (EventPayload.isAnyOf(["AuthLink"])(payload))
                worker.interactive.set("auth-link", { payload, conversationId: "direct" });

              if (EventPayload.isAnyOf(["AuthPrompt"])(payload))
                worker.interactive.set("auth-prompt", { payload, conversationId: "direct" });

              if (EventPayload.isAnyOf(["AuthCompleted", "AuthFailed"])(payload)) {
                worker.interactive.delete("auth-link");
                worker.interactive.delete("auth-prompt");
              }

              yield* publish(id, worker, payload, event.conversationId);
            }),
          Response: (response) =>
            Effect.sync(() => {
              const pending = worker.pending.get(response.id);

              if (!pending) return;
              clearTimeout(pending.timer);
              worker.pending.delete(response.id);
              const conversationId = pending.conversationId;
              pending.resolve({
                value: response.value,
                cursor: worker.sequence,
                busy: !worker.exited && worker.activity.has("run") && worker.activeConversationId === conversationId,
                activity: worker.conversationActivities.get(conversationId) ?? idleActivity(),
                botActivity: worker.botActivity,
                interactive: [...worker.interactive.values()].flatMap((item) =>
                  (!isConversationEvent(item.payload) && conversationId === "direct") || item.conversationId === conversationId
                    ? [item.payload] : []),
              });
            }),
          Failure: (failure) =>
            Effect.sync(() => {
              const pending = worker.pending.get(failure.id);

              if (!pending) return;
              clearTimeout(pending.timer);
              worker.pending.delete(failure.id);
              pending.reject(
                new BackendError({ code: failure.code, message: failure.message, status: 409 }),
              );
            }),
          Computer: (request) =>
            replyComputer(worker, request).pipe(Effect.forkIn(scope), Effect.asVoid),
        });
      });

      const ensureWorker = Effect.fn("AgentHost.ensureWorker")(function* (id: string) {
        yield* getBot(id);
        const previous = workers.get(id);

        if (previous && !previous.exited) return previous;
        const eventPath = join(botsDir, id, "events.jsonl");
        const events: AgentEvent[] = [];

        if (yield* filesystem("Find events", () => Bun.file(eventPath).exists())) {
          const lines = yield* filesystem("Read events", () => readFile(eventPath, "utf8"));

          for (const line of lines.trim().split("\n").slice(-2048)) {
            if (!line) continue;
            events.push(
              yield* decodeEvent(line).pipe(
                Effect.mapError(() => schemaError("Invalid stored event")),
              ),
            );
          }
        }

        const bus = yield* PubSub.sliding<AgentEvent>({ capacity: 2048 });
        const publishing = yield* Semaphore.make(1);
        const sequencePath = join(botsDir, id, "event-sequence.json");
        let sequence = events.at(-1)?.sequence ?? 0;

        if (yield* filesystem("Find event cursor", () => Bun.file(sequencePath).exists())) {
          const content = yield* filesystem("Read event cursor", () => readFile(sequencePath, "utf8"));

          const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EventSequence))(content).pipe(
            Effect.mapError(() => schemaError("Invalid stored event cursor")),
          );

          sequence = Math.max(sequence, saved.sequence);
        }

        const concurrent = workers.get(id);

        if (concurrent && !concurrent.exited) return concurrent;

        const args = packaged
          ? [process.execPath, "--agent-worker"]
          : [process.execPath, join(import.meta.dir, "worker.ts")];

        const environment: NodeJS.ProcessEnv = {};

        for (const key of [
          "PATH",
          "HOME",
          "USER",
          "SHELL",
          "TMPDIR",
          "TEMP",
          "TMP",
          "SYSTEMROOT",
          "WINDIR",
          "LANG",
          "LC_ALL",
          "LABORA_OPENAI_MODEL",
          "LABORA_EXECUTOR_URL",
          "PI_PACKAGE_DIR",
          "LABORA_PACKAGED",
        ]) {
          const value = process.env[key];

          if (value !== undefined) environment[key] = value;
        }

        const child = Bun.spawn(args, {
          cwd: dataDir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...environment,
            LABORA_DATA_DIR: dataDir,
            LABORA_BOT_ID: id,
            LABORA_COMPUTER_ENABLED: String(Boolean(options.computer)),
            LABORA_BROWSER_ENABLED: String(Boolean(options.computer?.browser)),
            PI_CODING_AGENT_DIR: join(botsDir, id, "agent"),
            PI_CODING_AGENT_SESSION_DIR: join(botsDir, id, "sessions"),
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
          },
        });

        const conversationActivities = new Map<string, BotActivity>();
        let botActivity = idleActivity();

        for (const event of events) {
          if (!isConversationEvent(event.payload)) continue;
          const key = event.conversationId ?? "direct";
          conversationActivities.set(key, reduceActivity(conversationActivities.get(key) ?? idleActivity(), event.payload));
          botActivity = reduceActivity(botActivity, event.payload);
        }

        for (const [key, activity] of conversationActivities)
          if (["thinking", "streaming", "working", "waiting", "asking", "retrying", "compacting"].includes(activity.phase))
            conversationActivities.set(key, reduceActivity(activity, EventPayload.cases.ProcessExited.make({
              message: "The agent restarted before this run finished.",
            })));

        if (["thinking", "streaming", "working", "waiting", "asking", "retrying", "compacting"].includes(botActivity.phase))
          botActivity = reduceActivity(botActivity, EventPayload.cases.ProcessExited.make({
            message: "The agent restarted before this run finished.",
          }));

        const worker: Worker = {
          child,
          pending: new Map(),
          events,
          bus,
          publishing,
          activity: new Set(),
          interactive: new Map(),
          conversationActivities,
          botActivity,
          activeConversationId: "direct",
          activeRunId: undefined,
          sequence,
          exited: false,
        };

        workers.set(id, worker);
        yield* Stream.fromReadableStream({
          evaluate: () => child.stdout,
          onError: (error) => schemaError(String(error)),
        }).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.length > 0),
          Stream.runForEach((line) => consume(id, worker, line)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              worker.child.kill();
              yield* publish(
                id,
                worker,
                EventPayload.cases.ProcessExited.make({ message: error.message }),
              );
            }),
          ),
          Effect.forkIn(scope),
        );
        yield* Stream.fromReadableStream({
          evaluate: () => child.stderr,
          onError: (error) => schemaError(String(error)),
        }).pipe(
          Stream.runDrain,
          Effect.catch(() => Effect.void),
          Effect.forkIn(scope),
        );
        yield* Effect.promise(() => child.exited).pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              worker.exited = true;

              for (const pending of worker.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(
                  new BackendError({
                    code: "worker_exited",
                    message: `Agent process exited (${code})`,
                    status: 503,
                  }),
                );
              }

              worker.pending.clear();
              yield* publish(
                id,
                worker,
                EventPayload.cases.ProcessExited.make({
                  message: `Agent process exited (${code})`,
                }),
              );
            }),
          ),
          Effect.forkIn(scope),
        );

        return worker;
      });

      const list = Effect.fn("AgentHost.list")(function* () {
        const entries = yield* filesystem("List bots", () =>
          readdir(botsDir, { withFileTypes: true }),
        );

        const bots: Bot[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          if (
            !(yield* filesystem("Find bot metadata", () =>
              Bun.file(join(botsDir, entry.name, "bot.json")).exists(),
            ))
          )
            continue;
          bots.push(yield* getBot(entry.name));
        }

        return bots.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });

      const create = Effect.fn("AgentHost.create")(function* (input: CreateBot) {
        const bot = Bot.make({ ...input, createdAt: new Date().toISOString() });
        const directory = join(botsDir, bot.id);

        if (
          yield* filesystem("Find existing bot", () =>
            Bun.file(join(directory, "bot.json")).exists(),
          )
        )
          return yield* Effect.fail(
            new BackendError({
              code: "already_exists",
              message: "A bot with this ID already exists",
              status: 409,
            }),
          );
        yield* filesystem("Create bot directory", () =>
          mkdir(directory, { recursive: true, mode: 0o700 }),
        );
        yield* filesystem("Save bot", () =>
          writeFile(join(directory, "bot.json"), JSON.stringify(bot), { mode: 0o600, flag: "wx" }),
        );

        return bot;
      });

      const requestReply = Effect.fn("AgentHost.requestReply")(function* (
        id: string,
        command: ChildCommand,
        observedWorker?: Worker,
      ) {
        if (ChildCommand.isAnyOf(["QueueInput", "QuestionResponse"])(command) ||
          (ChildCommand.isAnyOf(["Cancel"])(command) && command.runId)) {
          const active = workers.get(id);

          if (!active || active.exited || !active.activeRunId || active.activeRunId !== command.runId ||
            active.activeConversationId !== (command.conversationId ?? "direct"))
            return yield* Effect.fail(new BackendError({
              code: "stale_run", message: "This run is no longer accepting input. Reload the conversation and try again.", status: 409,
            }));
        }

        const worker = observedWorker ?? (yield* ensureWorker(id));

        if (worker.exited)
          return yield* Effect.fail(new BackendError({
            code: "worker_exited", message: "The agent process exited before accepting this request.", status: 503,
          }));

        const activity = ChildCommand.isAnyOf(["Prompt"])(command)
          ? "run"
          : ChildCommand.isAnyOf(["AuthStart"])(command)
            ? "auth"
            : undefined;

        if (activity && worker.activity.size > 0)
          return yield* Effect.fail(new BackendError({
            code: "bot_busy",
            message: "This bot is busy in another run or sign-in.",
            status: 409,
          }));

        if (activity) worker.activity.add(activity);

        if (ChildCommand.isAnyOf(["Prompt"])(command)) {
          worker.activeConversationId = command.conversationId ?? "direct";
          worker.activeRunId = command.runId;
        }

        if (ChildCommand.isAnyOf(["Cancel"])(command) && worker.activeRunId &&
          worker.activeConversationId !== (command.conversationId ?? "direct"))
          return yield* Effect.fail(new BackendError({
            code: "conversation_busy", message: "The active run belongs to another conversation.", status: 409,
          }));

        const outgoing = ChildCommand.isAnyOf(["Cancel"])(command) && !command.runId && worker.activeRunId
          ? ChildCommand.cases.Cancel.make({ ...command, runId: worker.activeRunId })
          : command;

        return yield* Effect.tryPromise({
          try: () =>
            new Promise<Reply>((resolve, reject) => {
              const requestId = crypto.randomUUID();

              const timer = setTimeout(() => {
                worker.pending.delete(requestId);
                reject(
                  new BackendError({
                    code: "worker_timeout",
                    message:
                      "The agent did not acknowledge the request. Its outcome is unknown; it was not retried.",
                    status: 504,
                  }),
                );
              }, 30_000);

              worker.pending.set(requestId, {
                resolve, reject, timer,
                conversationId: ChildCommand.isAnyOf(["Messages"])(command) ? command.conversationId ?? "direct" : "direct",
              });
              worker.child.stdin.write(
                `${JSON.stringify(ChildRequest.make({ id: requestId, command: outgoing }))}\n`,
              );
            }),
          catch: (error) =>
            error instanceof BackendError
              ? error
              : new BackendError({
                  code: "worker_error",
                  message: error instanceof Error ? error.message : String(error),
                  status: 503,
                }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (activity && error.code === "agent_error") {
                worker.activity.delete(activity);

                if (activity === "run") worker.activeRunId = undefined;
              }
            }),
          ),
        );
      });

      const request = Effect.fn("AgentHost.request")((id: string, command: ChildCommand) =>
        requestReply(id, command).pipe(Effect.map((reply) => reply.value)),
      );

      const snapshot = Effect.fn("AgentHost.snapshot")(function* (
        id: string,
        conversationId = "direct",
      ) {
        const reply = yield* requestReply(id, ChildCommand.cases.Messages.make({ conversationId }));
        const bundle = yield* Schema.decodeUnknownEffect(WorkerMessages)(reply.value).pipe(Effect.mapError(() => schemaError("Invalid worker messages")));

        return yield* Schema.decodeUnknownEffect(MessageSnapshot)({
          messages: bundle.messages,
          plan: bundle.plan,
          cursor: reply.cursor,
          busy: reply.busy,
          pending: reply.interactive,
          activity: reply.activity,
          botActivity: reply.botActivity,
        }).pipe(Effect.mapError(() => schemaError("Invalid worker message snapshot")));
      });

      const activity = Effect.fn("AgentHost.activity")(function* (id: string) {
        yield* getBot(id);

        return workers.get(id)?.botActivity ?? idleActivity();
      });

      const workerEvents = (
        worker: Worker,
        cursor: number,
        conversationId: string | null,
      ) => Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(worker.bus);
            const first = worker.events[0]?.sequence;

            if (first !== undefined && cursor > 0 && cursor < first - 1)
              return yield* Effect.die(new Error("The event cursor expired. Reload the conversation snapshot."));
            const replay = worker.events.filter((event) => event.sequence > cursor);
            const through = replay.at(-1)?.sequence ?? cursor;
            let previous = cursor;

            return Stream.fromIterable(replay).pipe(
              Stream.concat(
                Stream.fromSubscription(queue).pipe(
                  Stream.filter((event) => event.sequence > through),
                ),
              ),
              Stream.mapEffect((event) => {
                if (previous > 0 && event.sequence !== previous + 1)
                  return Effect.die(new Error("The agent stream lost an update. Reload the conversation snapshot."));
                previous = event.sequence;

                return Effect.succeed(event);
              }),
              Stream.filter((event) => conversationId === null || !isConversationEvent(event.payload) ||
                (event.conversationId ?? "direct") === conversationId),
              Stream.takeUntil((event) => worker.exited && EventPayload.isAnyOf(["ProcessExited"])(event.payload)),
            );
          }),
        );

      const startRun = Effect.fn("AgentHost.startRun")(function* (
        id: string,
        command: Schema.Schema.Type<typeof ChildCommand.cases.Prompt>,
      ) {
        const worker = yield* ensureWorker(id);
        const events = workerEvents(worker, worker.sequence, command.conversationId ?? "direct");

        const admission = yield* requestReply(id, command, worker).pipe(
          Effect.map((reply) => reply.value), Effect.result,
        );

        return { admission, events };
      });

      const events = Effect.fn("AgentHost.events")(function* (
        id: string,
        cursor: number,
        conversationId: string | null = "direct",
      ) {
        const worker = yield* ensureWorker(id);
        const earliest = worker.events[0]?.sequence ?? 0;

        if (cursor > 0 && cursor < earliest - 1)
          return yield* Effect.fail(
            new BackendError({
              code: "cursor_expired",
              message: "Reload messages before reconnecting to events.",
              status: 409,
            }),
          );

        return workerEvents(worker, cursor, conversationId);
      });

      const update = Effect.fn("AgentHost.update")(function* (id: string, input: UpdateBot) {
        const previous = yield* getBot(id);
        const bot = Bot.make({ ...previous, ...input });
        const path = join(botsDir, id, "bot.json");
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        yield* filesystem("Save bot metadata", async () => {
          await writeFile(temporary, JSON.stringify(bot), { mode: 0o600 });
          await rename(temporary, path);
        });

        return bot;
      });

      const forgetConversation = Effect.fn("AgentHost.forgetConversation")(function* (id: string, conversationId: string) {
        yield* getBot(id);
        yield* Schema.decodeUnknownEffect(ConversationId)(conversationId).pipe(
          Effect.mapError(() => schemaError("Invalid conversation ID")),
        );

        if (conversationId === "direct") return yield* Effect.fail(schemaError("Direct conversations cannot be deleted here"));
        const worker = workers.get(id);

        if (worker && !worker.exited) {
          if (worker.activeRunId && worker.activeConversationId === conversationId)
            return yield* Effect.fail(new BackendError({ code: "bot_busy", message: "This conversation still has active work.", status: 409 }));
          yield* requestReply(id, ChildCommand.cases.ForgetConversation.make({ conversationId }), worker);
        }

        const purge = Effect.gen(function* () {
          const eventPath = join(botsDir, id, "events.jsonl");

          if (yield* filesystem("Find event history", () => Bun.file(eventPath).exists())) {
            const content = yield* filesystem("Read event history", () => readFile(eventPath, "utf8"));
            const kept: AgentEvent[] = [];
            let sequence = worker?.sequence ?? 0;

            for (const line of content.trim().split("\n")) {
              if (!line) continue;
              const event = yield* decodeEvent(line).pipe(Effect.mapError(() => schemaError("Invalid stored event")));
              sequence = Math.max(sequence, event.sequence);

              if (!isConversationEvent(event.payload) || (event.conversationId ?? "direct") !== conversationId) kept.push(event);
            }

            const temporary = `${eventPath}.${crypto.randomUUID()}.tmp`;
            const sequencePath = join(botsDir, id, "event-sequence.json");
            const sequenceTemporary = `${sequencePath}.${crypto.randomUUID()}.tmp`;
            yield* filesystem("Remove conversation event history", async () => {
              try {
                await writeFile(sequenceTemporary, JSON.stringify({ sequence }), { mode: 0o600, flag: "wx" });
                await rename(sequenceTemporary, sequencePath);
                await writeFile(temporary, kept.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
                await rename(temporary, eventPath);
              } finally {
                await rm(temporary, { force: true });
                await rm(sequenceTemporary, { force: true });
              }
            });

            if (worker) worker.events.splice(0, worker.events.length, ...kept.slice(-2048));
          }

          yield* filesystem("Remove conversation messages", () =>
            rm(join(botsDir, id, "conversations", conversationId), { recursive: true, force: true }));
        });

        if (worker) yield* worker.publishing.withPermit(purge);
        else yield* purge;
      });

      const files = Effect.fn("AgentHost.files")(function* (id: string) {
        yield* getBot(id);
        const workspace = join(botsDir, id, "workspace");
        yield* filesystem("Create workspace", () =>
          mkdir(workspace, { recursive: true, mode: 0o700 }),
        );

        const canonicalBot = yield* filesystem("Resolve bot directory", () =>
          realpath(join(botsDir, id)),
        );

        const canonicalWorkspace = yield* filesystem("Resolve workspace", () =>
          realpath(workspace),
        );

        if (canonicalWorkspace !== join(canonicalBot, "workspace"))
          return yield* Effect.fail(
            new BackendError({
              code: "path_rejected",
              message: "Workspace cannot point outside this bot's directory",
              status: 403,
            }),
          );

        return yield* filesystem("List workspace files", async () => {
          const result: WorkspaceFile[] = [];
          const pending = [""];

          while (pending.length > 0) {
            const directory = pending.pop();

            if (directory === undefined) break;

            for (const entry of await readdir(join(workspace, directory), {
              withFileTypes: true,
            })) {
              const relative = join(directory, entry.name);

              if (entry.isDirectory()) pending.push(relative);

              if (!entry.isFile()) continue;
              const metadata = await stat(join(workspace, relative));
              result.push(
                WorkspaceFile.make({
                  path: relative,
                  name: entry.name,
                  size: metadata.size,
                  modifiedAt: metadata.mtime.toISOString(),
                }),
              );

              if (result.length >= 5000) return result;
            }
          }

          return result;
        });
      });

      const file = Effect.fn("AgentHost.file")(function* (id: string, path: string) {
        yield* getBot(id);
        const workspace = join(botsDir, id, "workspace");

        const resolved = yield* filesystem("Resolve workspace file", () =>
          realpath(resolve(workspace, path)),
        );

        const root = yield* filesystem("Resolve workspace", () => realpath(workspace));

        const canonicalBot = yield* filesystem("Resolve bot directory", () =>
          realpath(join(botsDir, id)),
        );

        if (root !== join(canonicalBot, "workspace"))
          return yield* Effect.fail(
            new BackendError({
              code: "path_rejected",
              message: "Workspace cannot point outside this bot's directory",
              status: 403,
            }),
          );

        if (!resolved.startsWith(`${root}${sep}`))
          return yield* Effect.fail(
            new BackendError({
              code: "path_rejected",
              message: "File is outside this bot's workspace",
              status: 403,
            }),
          );
        const metadata = yield* filesystem("Inspect workspace file", () => stat(resolved));

        if (!metadata.isFile() || metadata.size > 50_000_000)
          return yield* Effect.fail(
            new BackendError({
              code: "file_unavailable",
              message: `${basename(path)} is not a downloadable file under 50 MB`,
              status: 413,
            }),
          );

        return yield* filesystem("Read workspace file", () => readFile(resolved));
      });

      return Service.of({ isBusy, list, create, update, files, file, request, startRun, snapshot, activity, forgetConversation, events });
    }),
  );

export * as AgentHost from "./host";
