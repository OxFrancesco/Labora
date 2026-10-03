import { createInterface } from "node:readline";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Config, Effect, Result, Schema, Stream } from "effect";
import { Type } from "typebox";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
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
  UserQuestions,
} from "./contracts";
import { toolInput, toolOutput } from "../tool-presentation";
import { createWorkspaceSandbox } from "./sandbox";
import { createExecutor } from "./executor";
import { createAgentInteractions } from "./interaction";
import { createPlanTool } from "./plan";
import { createLaboraModelRuntime } from "../model-runtime";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const output = (value: ChildOutput) => process.stdout.write(`${JSON.stringify(value)}\n`);

const CaptureResult = Schema.Struct({ frame: Frame, png: Schema.String });

const CaptureInput = Schema.Struct({ displayId: Schema.String });

const ActInput = Schema.Struct({ ...ActionsRequest.fields });

const ProgressResult = Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })) });

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
  const sandbox = yield* Effect.promise(() => createWorkspaceSandbox(workspace));
  const { modelRuntime, deviceId } = yield* Effect.promise(() => createLaboraModelRuntime(agentDir));
  const model = modelRuntime.getModel("openai", modelId);

  if (!model) return yield* Effect.fail(new Error(`Unknown OpenAI model: ${modelId}`));
  let pendingInput: PendingInput | undefined;
  let auth: { provider: Provider; controller: AbortController } | undefined;
  let runId: string | undefined;
  let cancelledRunId: string | undefined;
  let activeConversationId = "direct";
  let activeSession: AgentSession;
  let executorReloadPending = false;

  const emit = (payload: EventPayload, conversationId = activeConversationId) => {
    output(isConversationEvent(payload)
      ? ChildOutput.cases.Event.make({ payload, conversationId })
      : ChildOutput.cases.Event.make({ payload }));
  };

  let assistantId = "";
  let streamingAssistant: Message | undefined;
  const approvals = new Map<string, Approval>();
  const computerCalls = new Map<string, ComputerCall>();
  const progressTimes = new Map<string, number>();

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

  const prepareMessage = async (message: SendMessage) => {
    let text = message.text;
    const images: { type: "image"; data: string; mimeType: string }[] = [];

    for (const attachment of message.attachments ?? []) {
      if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType))
        images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      else {
        const path = join(workspace, `${crypto.randomUUID()}-${attachment.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`);
        await writeFile(path, Buffer.from(attachment.data, "base64"), { mode: 0o600 });
        text += `\nAttached file: ${path}`;
      }
    }

    return { text, images };
  };

  const interactions = createAgentInteractions({
    run: () => runId && cancelledRunId !== runId ? { id: runId, conversationId: activeConversationId } : undefined,
    session: () => activeSession,
    prepare: prepareMessage,
    emit,
  });

  const plans = yield* Effect.promise(() => createPlanTool({
    botDirectory: botDir,
    getContext: () => ({ conversationId: activeConversationId, runId: cancelledRunId === runId ? undefined : runId }),
    emit: (plan) => emit(EventPayload.cases.PlanUpdated.make({ plan }), plan.conversationId),
  }));

  const bindExtensions = async (session: AgentSession) => {
    const runner = session.extensionRunner;

    if (!runner) throw new Error("The agent extension runtime did not initialize.");
    await session.bindExtensions({ mode: "rpc", uiContext: interactions.ui(runner.getUIContext()) });
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  };

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

  tools.push({
    name: "ask_user",
    label: "Ask a question",
    description: "Ask the user one to three questions when their answer is needed. Each question can offer choices; free text is always accepted. Wait for the result. Never invent skipped, expired or redirected answers, and never use this tool to approve consequential actions.",
    parameters: Type.Object({ questions: Type.Array(Type.Object({
      id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
      question: Type.String({ minLength: 1, maxLength: 2_000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 6 })),
    }), { minItems: 1, maxItems: 3 }) }),
    async execute(_id, input, signal) {
      const parsed = Schema.decodeUnknownSync(Schema.Struct({ questions: UserQuestions }))(input);
      const result = await interactions.ask(parsed.questions, signal);

      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  tools.push(plans.tool, ...sandbox.tools);

  const settingsManager = SettingsManager.create(workspace, agentDir);
  settingsManager.setCacheWarmingMode("off");

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
      "You are Labora, a personal agent. Use the selected computer only through its computer tools. File and terminal tools run in your agent workspace. Discover integrations through Executor. Use ask_user when a user's answer is needed; do not guess missing answers. Steering messages redirect your current task; follow-up messages are delivered when the current work is done. Workspace bash, read, write and edit run automatically inside an OS sandbox. You may read and change your own workspace and access public websites. Host files, credentials, private networks and system changes are unavailable. Use bash for searching or listing workspace files. Never attempt to escape the sandbox. Connected Executor tools run without per-action permission prompts. They act through the connected account and are outside the local filesystem sandbox. Desktop input outside the sandbox waits for a human decision. Never approve your own requests or bypass an approval. Report errors honestly.",
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
          if (["grep", "find", "ls", "powershell"].includes(event.toolName))
            return { block: true, reason: "Use the sandboxed bash tool for this operation." };

          if (event.toolName.startsWith("mcp__executor__")) return;

          if (
            [
              "read",
              "bash",
              "write",
              "edit",
              "codemode",
              "computer_info",
              "computer_capture",
              "browser_read",
              "ask_user",
              "update_plan",
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

          if (!approved) cancelledRunId = runId;

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
      excludeTools: ["grep", "find", "ls", "powershell"],
      sessionManager: SessionManager.continueRecent(workspace, sessions),
    }),
  );

  activeSession = created.session;
  yield* Effect.promise(() => bindExtensions(activeSession));

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
    if (event.type === "queue_update") interactions.queueChanged(event.steering, event.followUp);

    if (event.type === "compaction_start" && runId)
      emit(EventPayload.cases.RunActivity.make({ runId, phase: "compacting" }));

    if (event.type === "compaction_end" && runId)
      emit(EventPayload.cases.RunActivity.make({ runId, phase: event.willRetry ? "retrying" : "thinking" }));

    if (event.type === "message_start" && event.message.role === "assistant") {
      if (runId) emit(EventPayload.cases.RunActivity.make({ runId, phase: "thinking" }));
      assistantId = `assistant-${event.message.timestamp}`;
      streamingAssistant = Message.make({
        id: assistantId,
        role: "assistant",
        text: "",
        createdAt: new Date(event.message.timestamp).toISOString(),
      });
    }

    if (event.type === "auto_retry_start" && runId)
      emit(EventPayload.cases.RunActivity.make({
        runId, phase: "retrying", message: `Retrying request (${event.attempt}/${event.maxAttempts})`,
      }));

    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start" && runId)
      emit(EventPayload.cases.RunActivity.make({ runId, phase: "thinking" }));

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const offset = streamingAssistant?.text.length ?? 0;

      if (streamingAssistant)
        streamingAssistant = Message.make({
          ...streamingAssistant,
          text: streamingAssistant.text + event.assistantMessageEvent.delta,
        });
      emit(
        EventPayload.cases.TextDelta.make({
          messageId: assistantId,
          offset,
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

    if (event.type === "tool_execution_update" && Date.now() - (progressTimes.get(event.toolCallId) ?? 0) >= 250) {
      const partial = Schema.decodeUnknownResult(ProgressResult)(event.partialResult);

      if (Result.isSuccess(partial)) {
        const text = partial.success.content.slice(-8).flatMap((part) => part.type === "text" && part.text ? [part.text.slice(-2_000)] : []).join("\n").slice(-2_000);

        if (text) {
          progressTimes.set(event.toolCallId, Date.now());
          emit(EventPayload.cases.ToolProgress.make({ toolCallId: event.toolCallId, name: event.toolName, text }));
        }
      }
    }

    if (event.type === "tool_execution_end") {
      progressTimes.delete(event.toolCallId);
      emit(
        EventPayload.cases.ToolEnd.make({
          toolCallId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          output: json(JSON.stringify(event.result)),
        }),
      );
    }

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
      excludeTools: ["grep", "find", "ls", "powershell"],
      sessionManager: SessionManager.continueRecent(workspace, directory),
    });

    try {
      await bindExtensions(next.session);
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

    if (runId) interactions.clear({ id: runId, conversationId: activeConversationId });

    for (const [requestId, approval] of approvals) {
      clearTimeout(approval.timer);
      approval.resolve(false);
      emit(EventPayload.cases.ApprovalResolved.make({ requestId, decision: "deny" }));
    }

    approvals.clear();

    for (const call of computerCalls.values()) call.reject(new Error("Run cancelled"));
    computerCalls.clear();
    await activeSession.abort();
  };

  const cancelAuth = () => {
    auth?.controller.abort();
    pendingInput?.reject(new Error("Sign-in cancelled"));
  };

  const refreshExecutor = async () => {
    if (!executorReloadPending) return;
    await activeSession.reload();
    await bindExtensions(activeSession);
    executorReloadPending = false;
  };

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;

    try {
      cancelAuth();
      await cancel();
      await activeSession.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      activeSession.dispose();
      await sandbox.close();
    }
  };

  const prompt = async (id: string, message: SendMessage) => {
    const previousAssistantIds = new Set(activeSession.state.messages.flatMap((item) =>
      item.role === "assistant" ? [item.timestamp] : []));

    try {
      if (!modelRuntime.isUsingSubscription("openai"))
        throw new Error("Sign in with your ChatGPT subscription before sending a message.");
      const { text, images } = await prepareMessage(message);
      await activeSession.prompt(text, { images, expandPromptTemplates: false });
      await interactions.waitForInputs();
      interactions.clear({ id, conversationId: activeConversationId });

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
      await interactions.waitForInputs();
      interactions.clear({ id, conversationId: activeConversationId });

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
        executorReloadPending = true;
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

  const readMessages = (conversationId: string) => {
    const history = conversationId === activeConversationId
      ? activeSession.state.messages
      : SessionManager.continueRecent(workspace, sessionDirectory(conversationId))
          .buildSessionContext().messages;

    const calls = new Map(history.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" ? [[part.id, part] as const] : []) : []));

    const messages = history.flatMap((message) => {
      if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);

        return [Message.make({
          id: `tool-${message.toolCallId}`, role: "tool", toolName: message.toolName,
          toolInput: call ? toolInput(message.toolName, json(JSON.stringify(call.arguments))) : "",
          text: toolOutput(json(JSON.stringify({ content: message.content }))),
          toolStatus: message.isError ? "error" : "complete", createdAt: new Date(message.timestamp).toISOString(),
        })];
      }

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
  };

  const handle = Effect.fn("AgentWorker.handle")((request: ChildRequest) =>
    Effect.tryPromise({
      try: async () => {
        // Keep the transcript and its IPC event cursor in the same synchronous turn.
        if (ChildCommand.isAnyOf(["Messages"])(request.command)) {
          const conversationId = request.command.conversationId ?? "direct";
          const value = json(JSON.stringify({ messages: readMessages(conversationId), plan: plans.snapshot(conversationId) }));
          output(ChildOutput.cases.Response.make({ id: request.id, value }));

          return;
        }

        const value = await ChildCommand.match<Promise<Schema.Schema.Type<typeof Schema.Json>>>(
          request.command,
          {
            Messages: async (command) => ({ messages: readMessages(command.conversationId ?? "direct"), plan: plans.snapshot(command.conversationId ?? "direct") }),
            ForgetConversation: async (command) => {
              if (command.conversationId === "direct") throw new Error("The direct conversation cannot be deleted here.");

              if (command.conversationId === activeConversationId) {
                if (runId || auth) throw new Error("Wait for this bot to become idle before deleting its conversation.");
                await switchConversation("direct");
              }

              plans.forget(command.conversationId);

              return { forgotten: true };
            },
            Prompt: async (command) => {
              if (runId || auth) throw new Error("This bot is busy.");

              if (!modelRuntime.isUsingSubscription("openai"))
                throw new Error("Sign in with your ChatGPT subscription before sending a message.");
              await refreshExecutor();
              await switchConversation(command.conversationId ?? "direct");
              runId = command.runId;
              emit(EventPayload.cases.RunStarted.make({ runId }));
              void prompt(runId, command.message);

              return { runId };
            },
            Cancel: async (command) => {
              if (runId && (command.conversationId ?? "direct") !== activeConversationId)
                throw new Error("The active run belongs to another conversation.");

              if (command.runId && command.runId !== runId)
                throw new Error("The requested run is no longer active.");
              await cancel();

              return { cancelled: true };
            },
            AuthStatus: async () => ({
              openai: modelRuntime.isUsingSubscription("openai") ? "ready" : "signed-out",
              executor: (await executor.status()) ? "ready" : "signed-out",
              active: auth?.provider ?? null,
            }),
            AuthStart: async (command) => {
              if (auth || (runId && command.provider !== "executor")) throw new Error("This bot is busy.");
              void startAuth(command.provider);

              return { started: true };
            },
            AuthCancel: async () => {
              cancelAuth();

              return { cancelled: true };
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
            QuestionResponse: async (command) => {
              interactions.answer(command.requestId, command, command.conversationId ?? "direct");

              return { accepted: true };
            },
            QueueInput: async (command) => interactions.queueInput(command, command.conversationId ?? "direct"),
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
