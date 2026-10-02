import { createInterface } from "node:readline";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Config, Effect, Schema, Stream } from "effect";
import { Type } from "typebox";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ActionsRequest, Computer, Frame } from "../computer/contracts";
import {
  ChildCommand,
  ChildOutput,
  ChildRequest,
  EventPayload,
  Message,
  isConversationEvent,
  type Provider,
  type SendMessage,
} from "./contracts";
import { createExecutor } from "./executor";
import { createLaboraModelRuntime } from "../model-runtime";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const output = (value: ChildOutput) => process.stdout.write(`${JSON.stringify(value)}\n`);

const CaptureResult = Schema.Struct({ frame: Frame, png: Schema.String });

const CaptureInput = Schema.Struct({ displayId: Schema.String });

const ActInput = Schema.Struct({ ...ActionsRequest.fields });

interface PendingInput {
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

interface Approval {
  readonly resolve: (approved: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ComputerCall {
  readonly resolve: (value: Schema.Schema.Type<typeof Schema.Json>) => void;
  readonly reject: (error: Error) => void;
}

const initialize = Effect.fn("AgentWorker.initialize")(function* () {
  const dataDir = yield* Config.String("LABORA_DATA_DIR");
  const botId = yield* Config.String("LABORA_BOT_ID");
  const modelId = yield* Config.String("LABORA_OPENAI_MODEL").pipe(Config.withDefault("gpt-5.5"));

  const executorUrl = yield* Config.String("LABORA_EXECUTOR_URL").pipe(
    Config.withDefault("https://executor.sh/labora/mcp"),
  );

  const computerEnabled = yield* Config.Boolean("LABORA_COMPUTER_ENABLED").pipe(
    Config.withDefault(false),
  );

  const browserEnabled = yield* Config.Boolean("LABORA_BROWSER_ENABLED").pipe(
    Config.withDefault(false),
  );

  const botDir = join(dataDir, "bots", botId);
  const agentDir = join(botDir, "agent");
  const workspace = join(botDir, "workspace");
  const sessions = join(botDir, "sessions");
  yield* Effect.promise(() =>
    Promise.all(
      [agentDir, workspace, sessions].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    ),
  );
  const { modelRuntime, deviceId } = yield* Effect.promise(() => createLaboraModelRuntime(agentDir));
  const model = modelRuntime.getModel("openai", modelId);

  if (!model) return yield* Effect.fail(new Error(`Unknown OpenAI model: ${modelId}`));
  let pendingInput: PendingInput | undefined;
  let auth: { provider: Provider; controller: AbortController } | undefined;
  let runId: string | undefined;
  let cancelledRunId: string | undefined;
  let activeConversationId = "direct";

  const emit = (payload: EventPayload, conversationId = activeConversationId) => {
    output(isConversationEvent(payload)
      ? ChildOutput.cases.Event.make({ payload, conversationId })
      : ChildOutput.cases.Event.make({ payload }));
  };

  let assistantId = "";
  let streamingAssistant: Message | undefined;
  const approvals = new Map<string, Approval>();
  const computerCalls = new Map<string, ComputerCall>();

  const input = (provider: Provider, message: string, secret: boolean, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Sign-in cancelled"));

        return;
      }

      const abort = () => {
        pendingInput = undefined;
        reject(new Error("Sign-in cancelled"));
      };

      signal.addEventListener("abort", abort, { once: true });
      pendingInput = {
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          pendingInput = undefined;
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          pendingInput = undefined;
          reject(error);
        },
      };
      emit(EventPayload.cases.AuthPrompt.make({ provider, message, secret }));
    });

  const executor = yield* Effect.promise(() =>
    createExecutor({
      path: join(agentDir, "mcp-auth.json"),
      url: executorUrl,
      showLink: (url) =>
        emit(
          EventPayload.cases.AuthLink.make({
            provider: "executor",
            url,
            message: "Sign in to Executor",
          }),
        ),
      manualInput: (signal) =>
        input(
          "executor",
          "If the browser cannot reach this computer, paste its full callback URL.",
          false,
          signal,
        ),
    }),
  );

  const computer = (
    operation: "info" | "capture" | "act" | "browser",
    value: Schema.Schema.Type<typeof Schema.Json>,
    signal?: AbortSignal,
  ) =>
    new Promise<Schema.Schema.Type<typeof Schema.Json>>((resolve, reject) => {
      const id = crypto.randomUUID();

      if (signal?.aborted) {
        reject(new Error("Computer request cancelled"));

        return;
      }

      const abort = () => {
        computerCalls.delete(id);
        reject(new Error("Computer request cancelled"));
      };

      signal?.addEventListener("abort", abort, { once: true });
      computerCalls.set(id, {
        resolve: (result) => {
          signal?.removeEventListener("abort", abort);
          computerCalls.delete(id);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          computerCalls.delete(id);
          reject(error);
        },
      });
      output(ChildOutput.cases.Computer.make({ id, operation, input: value }));
    });

  const tools: ToolDefinition[] = computerEnabled
    ? [
        {
          name: "computer_info",
          label: "Computer",
          description: "Read this connected computer's displays, capabilities and control owner.",
          parameters: Type.Object({}),
          async execute(_id, _params, signal) {
            const result = await computer("info", {}, signal);
            const info = await Effect.runPromise(Schema.decodeUnknownEffect(Computer)(result));

            return { content: [{ type: "text", text: JSON.stringify(info) }], details: {} };
          },
        },
        {
          name: "computer_capture",
          label: "Screenshot",
          description:
            "Capture one display of the connected computer. Use the returned frame ID and coordinates for actions.",
          parameters: Type.Object({ displayId: Type.String() }),
          async execute(_id, params, signal) {
            const parsed = await Effect.runPromise(
              Schema.decodeUnknownEffect(CaptureInput)(params),
            );

            const result = await computer("capture", { displayId: parsed.displayId }, signal);

            const capture = await Effect.runPromise(
              Schema.decodeUnknownEffect(CaptureResult)(result),
            );

            return {
              content: [
                { type: "text", text: JSON.stringify(capture.frame) },
                { type: "image", data: capture.png, mimeType: "image/png" },
              ],
              details: {},
            };
          },
        },
        {
          name: "computer_actions",
          label: "Control computer",
          description:
            "Run a bounded list of input actions on a recent frame after human approval. Supply JSON with requestId, displayId, frameId, actor:'agent', actions. Actions: click {x,y,button,count}, move {x,y}, scroll {x,y,deltaX,deltaY}, type {text}, key {key}.",
          parameters: Type.Object({ request: Type.String() }),
          async execute(_id, params, signal) {
            const parsed = await Effect.runPromise(
              Schema.decodeUnknownEffect(Schema.Struct({ request: Schema.String }))(params),
            );

            const action = await Effect.runPromise(
              Schema.decodeUnknownEffect(Schema.fromJsonString(ActInput))(parsed.request),
            );

            const result = await computer(
              "act",
              json(JSON.stringify({ ...action, actor: "agent" })),
              signal,
            );

            return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
          },
        },
      ]
    : [];

  if (browserEnabled)
    tools.push({
      name: "browser_read",
      label: "Read web page",
      description:
        "Read a public HTTPS page as Markdown using Kitesurf. This read supplies no credentials or cookies and uses no persistent session. It does not navigate the visible desktop browser.",
      parameters: Type.Object({ url: Type.String() }),
      async execute(_id, params, signal) {
        const input = await Effect.runPromise(
          Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))(params),
        );

        const result = await computer("browser", { url: input.url }, signal);

        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      },
    });

  const settingsManager = SettingsManager.create(workspace, agentDir);
  settingsManager.setCacheWarmingMode("off");
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

  const makeLoader = () => new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      "You are Labora, a personal agent. Use the selected computer only through its computer tools. File and terminal tools run in your agent workspace. Discover integrations through Executor. Consequential tools wait for a human decision. Never approve your own requests or bypass an approval. Report errors honestly.",
    extensionFactories: [
      createCodemodeExtension({ mode: "on", models: false }),
      createMcpExtension({
        loadConfig: () => ({
          servers: [
            {
              name: "executor",
              config: { url: executorUrl, exposure: "codemode" },
              source: "Labora",
              scope: "extension",
            },
          ],
          errors: [],
        }),
        createTransport: () => executor.transport(),
      }),
      (pi) => {
        pi.on("tool_call", async (event) => {
          if (
            [
              "read",
              "grep",
              "find",
              "ls",
              "codemode",
              "computer_info",
              "computer_capture",
              "browser_read",
            ].includes(event.toolName)
          )
            return;
          const requestId = crypto.randomUUID();

          const approved = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              approvals.delete(requestId);
              emit(EventPayload.cases.ApprovalResolved.make({ requestId, decision: "deny" }));
              resolve(false);
            }, 300_000);

            approvals.set(requestId, { resolve, timer });
            emit(
              EventPayload.cases.ApprovalRequested.make({
                requestId,
                toolName: event.toolName,
                input: json(JSON.stringify(event.input)),
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              }),
            );
          });

          return approved
            ? undefined
            : { block: true, reason: "The user did not approve this action.", terminate: true };
        });
      },
    ],
  });

  const loader = makeLoader();
  yield* Effect.promise(() => loader.reload());

  const created = yield* Effect.promise(() =>
    createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      model,
      settingsManager,
      resourceLoader: loader,
      customTools: tools,
      sessionManager: SessionManager.continueRecent(workspace, sessions),
    }),
  );

  let activeSession = created.session;
  yield* Effect.promise(() => activeSession.bindExtensions({}));

  const messageFromAssistant = () => {
    const last = activeSession.state.messages
      .slice()
      .reverse()
      .find((message) => message.role === "assistant");

    if (!last || last.role !== "assistant") return;
    const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

    if (text)
      emit(
        EventPayload.cases.Message.make({
          message: Message.make({
            id: assistantId,
            role: "assistant",
            text,
            createdAt: new Date(last.timestamp).toISOString(),
          }),
        }),
      );

    return last;
  };

  const bindSession = () => activeSession.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistantId = `assistant-${event.message.timestamp}`;
      streamingAssistant = Message.make({
        id: assistantId,
        role: "assistant",
        text: "",
        createdAt: new Date(event.message.timestamp).toISOString(),
      });
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (streamingAssistant)
        streamingAssistant = Message.make({
          ...streamingAssistant,
          text: streamingAssistant.text + event.assistantMessageEvent.delta,
        });
      emit(
        EventPayload.cases.TextDelta.make({
          messageId: assistantId,
          text: event.assistantMessageEvent.delta,
        }),
      );
    }

    if (event.type === "tool_execution_start")
      emit(
        EventPayload.cases.ToolStart.make({
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: json(JSON.stringify(event.args)),
        }),
      );

    if (event.type === "tool_execution_end")
      emit(
        EventPayload.cases.ToolEnd.make({
          toolCallId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          output: json(JSON.stringify(event.result)),
        }),
      );

    if (event.type === "message_end" && event.message.role === "assistant") {
      messageFromAssistant();
      streamingAssistant = undefined;
    }

    if (event.type === "message_end" && event.message.role === "user") {
      const message = event.message;

      const text = Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        : message.content;

      emit(
        EventPayload.cases.Message.make({
          message: Message.make({
            id: `user-${message.timestamp}`,
            role: "user",
            text,
            createdAt: new Date(message.timestamp).toISOString(),
          }),
        }),
      );
    }
  });

  let unsubscribe = bindSession();

  const sessionDirectory = (conversationId: string) =>
    conversationId === "direct" ? sessions : join(botDir, "conversations", conversationId);

  const switchConversation = async (conversationId: string) => {
    if (conversationId === activeConversationId) return;
    const nextLoader = makeLoader();
    await nextLoader.reload();
    const directory = sessionDirectory(conversationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const next = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      model,
      settingsManager,
      resourceLoader: nextLoader,
      customTools: tools,
      sessionManager: SessionManager.continueRecent(workspace, directory),
    });

    try {
      await next.session.bindExtensions({});
    } catch (error) {
      next.session.dispose();
      throw error;
    }

    await activeSession.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    unsubscribe();
    activeSession.dispose();
    activeSession = next.session;
    activeConversationId = conversationId;
    assistantId = "";
    streamingAssistant = undefined;
    unsubscribe = bindSession();
  };

  const cancel = async () => {
    cancelledRunId = runId;

    for (const [requestId, approval] of approvals) {
      clearTimeout(approval.timer);
      approval.resolve(false);
      emit(EventPayload.cases.ApprovalResolved.make({ requestId, decision: "deny" }));
    }

    approvals.clear();
    auth?.controller.abort();
    pendingInput?.reject(new Error("Sign-in cancelled"));

    for (const call of computerCalls.values()) call.reject(new Error("Run cancelled"));
    computerCalls.clear();
    await activeSession.abort();
  };

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;

    try {
      await cancel();
      await activeSession.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      activeSession.dispose();
    }
  };

  const prompt = async (id: string, message: SendMessage) => {
    const previousAssistantIds = new Set(activeSession.state.messages.flatMap((item) =>
      item.role === "assistant" ? [item.timestamp] : []));

    try {
      if (!modelRuntime.isUsingSubscription("openai"))
        throw new Error("Sign in with your ChatGPT subscription before sending a message.");
      let text = message.text;
      const images: { type: "image"; data: string; mimeType: string }[] = [];

      for (const attachment of message.attachments ?? []) {
        if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType))
          images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        else {
          const path = join(
            workspace,
            `${crypto.randomUUID()}-${attachment.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
          );

          await writeFile(path, Buffer.from(attachment.data, "base64"), { mode: 0o600 });
          text += `\nAttached file: ${path}`;
        }
      }

      await activeSession.prompt(text, { images, expandPromptTemplates: false });

      const last = activeSession.state.messages
        .slice()
        .reverse()
        .find((item) => item.role === "assistant");

      if (cancelledRunId === id)
        emit(EventPayload.cases.RunCancelled.make({ runId: id }));
      else if (!last || last.role !== "assistant" || previousAssistantIds.has(last.timestamp))
        throw new Error("The provider returned no new assistant response.");
      else if (last.stopReason === "aborted")
        emit(EventPayload.cases.RunCancelled.make({ runId: id }));
      else if (last.stopReason === "error")
        throw new Error(last.errorMessage || "Provider request failed");
      else emit(EventPayload.cases.RunCompleted.make({ runId: id }));
    } catch (error) {
      if (cancelledRunId === id) emit(EventPayload.cases.RunCancelled.make({ runId: id }));
      else emit(
        EventPayload.cases.RunFailed.make({
          runId: id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      runId = undefined;

      if (cancelledRunId === id) cancelledRunId = undefined;
    }
  };

  const startAuth = async (provider: Provider) => {
    const controller = new AbortController();
    auth = { provider, controller };

    try {
      if (provider === "executor") {
        await executor.login(controller.signal);
        await activeSession.reload();
      } else
        await modelRuntime.login(
          "openai",
          "oauth",
          {
            signal: controller.signal,
            prompt: (request) =>
              input(
                "openai",
                request.message,
                request.type === "secret",
                request.signal ?? controller.signal,
              ),
            notify: (event) => {
              if (event.type === "auth_url")
                emit(
                  EventPayload.cases.AuthLink.make({
                    provider: "openai",
                    url: event.url,
                    message: event.instructions ?? "Sign in with ChatGPT",
                  }),
                );

              if (event.type === "device_code")
                emit(
                  EventPayload.cases.AuthLink.make({
                    provider: "openai",
                    url: event.verificationUri,
                    message: `Enter code ${event.userCode}`,
                  }),
                );
            },
          },
          { getDeviceId: () => deviceId },
        );
      emit(EventPayload.cases.AuthCompleted.make({ provider }));
    } catch (error) {
      emit(
        EventPayload.cases.AuthFailed.make({
          provider,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      auth = undefined;
    }
  };

  const handle = Effect.fn("AgentWorker.handle")((request: ChildRequest) =>
    Effect.tryPromise({
      try: async () => {
        const value = await ChildCommand.match<Promise<Schema.Schema.Type<typeof Schema.Json>>>(
          request.command,
          {
            Messages: async (command) => {
              const conversationId = command.conversationId ?? "direct";

              const history = conversationId === activeConversationId
                ? activeSession.state.messages
                : SessionManager.continueRecent(workspace, sessionDirectory(conversationId))
                    .buildSessionContext().messages;

              const messages = history.flatMap((message) => {
                if (message.role !== "user" && message.role !== "assistant") return [];

                const text = Array.isArray(message.content)
                  ? message.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("")
                  : message.content;

                return [
                  Message.make({
                    id: `${message.role}-${message.timestamp}`,
                    role: message.role,
                    text,
                    createdAt: new Date(message.timestamp).toISOString(),
                  }),
                ];
              });

              const partial = conversationId === activeConversationId ? streamingAssistant : undefined;

              if (partial && !messages.some((message) => message.id === partial.id))
                messages.push(partial);

              return messages;
            },
            ForgetConversation: async (command) => {
              if (command.conversationId === "direct") throw new Error("The direct conversation cannot be deleted here.");

              if (command.conversationId === activeConversationId) {
                if (runId || auth) throw new Error("Wait for this bot to become idle before deleting its conversation.");
                await switchConversation("direct");
              }

              return { forgotten: true };
            },
            Prompt: async (command) => {
              if (runId || auth) throw new Error("This bot is busy.");

              if (!modelRuntime.isUsingSubscription("openai"))
                throw new Error("Sign in with your ChatGPT subscription before sending a message.");
              await switchConversation(command.conversationId ?? "direct");
              runId = command.runId;
              emit(EventPayload.cases.RunStarted.make({ runId }));
              void prompt(runId, command.message);

              return { runId };
            },
            Cancel: async (command) => {
              if (runId && (command.conversationId ?? "direct") !== activeConversationId)
                throw new Error("The active run belongs to another conversation.");

              if (runId && command.runId && command.runId !== runId)
                throw new Error("The requested run is no longer active.");
              const knownRun = runId;
              await cancel();

              if (!knownRun && command.runId)
                emit(EventPayload.cases.RunCancelled.make({ runId: command.runId }), command.conversationId ?? "direct");

              return { cancelled: true };
            },
            AuthStatus: async () => ({
              openai: modelRuntime.isUsingSubscription("openai") ? "ready" : "signed-out",
              executor: (await executor.status()) ? "ready" : "signed-out",
              active: auth?.provider ?? null,
            }),
            AuthStart: async (command) => {
              if (auth || runId) throw new Error("This bot is busy.");
              void startAuth(command.provider);

              return { started: true };
            },
            AuthInput: async (command) => {
              if (!pendingInput) throw new Error("No sign-in input is pending.");
              pendingInput.resolve(command.value);

              return { accepted: true };
            },
            Approval: async (command) => {
              const pending = approvals.get(command.requestId);

              if (!pending) throw new Error("This approval is no longer pending.");
              approvals.delete(command.requestId);
              clearTimeout(pending.timer);
              pending.resolve(command.decision === "approve");
              emit(
                EventPayload.cases.ApprovalResolved.make({
                  requestId: command.requestId,
                  decision: command.decision,
                }),
              );

              return { accepted: true };
            },
            ComputerResult: async (command) => {
              const pending = computerCalls.get(command.requestId);

              if (command.error) pending?.reject(new Error(command.error));
              else pending?.resolve(command.value);

              return { accepted: true };
            },
            Close: async () => {
              await close();

              return { closed: true };
            },
          },
        );

        output(
          ChildOutput.cases.Response.make({ id: request.id, value: json(JSON.stringify(value)) }),
        );
      },
      catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          output(
            ChildOutput.cases.Failure.make({
              id: request.id,
              code: "agent_error",
              message: error.message,
            }),
          ),
        ),
      ),
    ),
  );

  emit(EventPayload.cases.Ready.make({ pid: process.pid }));

  return { handle, close };
});

export async function runAgentWorker(): Promise<void> {
  registerBunOAuthFlows();

  const program = Effect.gen(function* () {
    const worker = yield* initialize();
    const lines = createInterface({ input: process.stdin });
    yield* Effect.addFinalizer(() => Effect.promise(() => worker.close()));
    yield* Stream.fromAsyncIterable(lines, (error) => new Error(String(error))).pipe(
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(ChildRequest))(line),
      ),
      Stream.runForEach(worker.handle),
    );
  }).pipe(Effect.scoped);

  await Effect.runPromise(program);
}

if (import.meta.main) await runAgentWorker();
