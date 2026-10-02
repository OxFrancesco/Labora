import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { AgentSession, ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { EventPayload, UserQuestions } from "./contracts";
import type { QuestionResponse, QuestionOutcome, QueuedInput, QueueInput, QueuedInputResult, SendMessage, UserQuestion } from "./contracts";

interface ActiveRun { id: string; conversationId: string }

interface QuestionResult {
  status: typeof QuestionOutcome.Type;
  answers: NonNullable<QuestionResponse["answers"]>;
}

interface PendingQuestion {
  run: ActiveRun;
  questions: readonly UserQuestion[];
  finish: (status: QuestionResult["status"], answers?: QuestionResult["answers"]) => void;
}

interface PreparedInput {
  text: string;
  images: { type: "image"; data: string; mimeType: string }[];
}

interface PendingInput {
  item: QueuedInput;
  text: string;
  state: "submitting" | "queued";
}

interface InteractionOptions {
  run: () => ActiveRun | undefined;
  session: () => AgentSession;
  emit: (payload: EventPayload, conversationId?: string) => void;
  prepare: (message: SendMessage) => Promise<PreparedInput>;
}

export function createAgentInteractions(options: InteractionOptions) {
  const questions = new Map<string, PendingQuestion>();
  const accepted = new Map<string, { signature: string; result: Promise<QueuedInputResult> }>();
  const inFlight = new Set<Promise<QueuedInputResult>>();
  let queued: PendingInput[] = [];

  const requireRun = (runId: string, conversationId: string) => {
    const active = options.run();

    if (!active || active.id !== runId || active.conversationId !== conversationId)
      throw new Error("This run is no longer accepting input. Reload the conversation and try again.");

    return active;
  };

  const emitQueue = (run: ActiveRun) => options.emit(EventPayload.cases.InputQueueChanged.make({
    runId: run.id, items: queued.filter((entry) => entry.state === "queued").map((entry) => entry.item),
  }), run.conversationId);

  const ask = async (input: readonly UserQuestion[], signal?: AbortSignal, timeout = 300_000): Promise<QuestionResult> => {
    const run = options.run();

    if (!run || signal?.aborted) throw new Error("This run is no longer accepting questions.");
    const decoded = Schema.decodeUnknownSync(UserQuestions)(input);

    if (new Set(decoded.map((question) => question.id)).size !== decoded.length)
      throw new Error("Every question must have a different ID.");

    if (questions.size >= 8) throw new Error("Wait for the pending questions before asking more.");
    const requestId = crypto.randomUUID();
    const duration = Math.max(1, Math.min(300_000, timeout));

    return new Promise((resolve) => {
      const finish = (status: QuestionResult["status"], answers: QuestionResult["answers"] = []) => {
        if (!questions.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        options.emit(EventPayload.cases.QuestionResolved.make({ requestId, runId: run.id, outcome: status }), run.conversationId);
        resolve({ status, answers });
      };

      const abort = () => finish("cancelled");
      const timer = setTimeout(() => finish("expired"), duration);
      questions.set(requestId, { run, questions: decoded, finish });
      signal?.addEventListener("abort", abort, { once: true });
      options.emit(EventPayload.cases.QuestionRequested.make({
        requestId, runId: run.id, questions: decoded, expiresAt: new Date(Date.now() + duration).toISOString(),
      }), run.conversationId);
    });
  };

  const answer = (requestId: string, response: QuestionResponse, conversationId: string) => {
    requireRun(response.runId, conversationId);
    const pending = questions.get(requestId);

    if (!pending || pending.run.id !== response.runId || pending.run.conversationId !== conversationId)
      throw new Error("This question is no longer waiting for an answer.");

    if (response.answers === null) {
      pending.finish("dismissed");

      return;
    }

    const ids = new Set(response.answers.map((answer) => answer.id));

    if (ids.size !== pending.questions.length || response.answers.length !== pending.questions.length ||
      pending.questions.some((question) => !ids.has(question.id)) || response.answers.some((answer) => !answer.answer.trim()))
      throw new Error("Answer each question once, or skip the question.");
    pending.finish("answered", response.answers);
  };

  const queueChanged = (steering: readonly string[], followUp: readonly string[]) => {
    const run = options.run();

    if (!run) return;
    const remaining = { steer: [...steering], followUp: [...followUp] };
    const retained = new Set<PendingInput>();

    const claim = (entry: PendingInput) => {
      const list = remaining[entry.item.mode];
      const index = list.lastIndexOf(entry.text);

      if (index < 0) return false;
      list.splice(index, 1);

      return true;
    };

    for (const entry of [...queued].reverse())
      if (entry.state === "queued" && claim(entry)) retained.add(entry);

    for (const entry of queued) {
      if (entry.state !== "submitting") continue;

      if (claim(entry)) entry.state = "queued";
      retained.add(entry);
    }

    queued = queued.filter((entry) => retained.has(entry));
    emitQueue(run);
  };

  const queueInput = (input: QueueInput, conversationId: string): Promise<QueuedInputResult> => {
    const run = requireRun(input.runId, conversationId);
    const signature = createHash("sha256").update(JSON.stringify({ ...input, conversationId })).digest("hex");
    const previous = accepted.get(input.id);

    if (previous) {
      if (previous.signature !== signature) throw new Error("This input ID was already used for a different message.");

      return previous.result;
    }

    if (!input.text.trim() && !input.attachments?.length) throw new Error("Enter a message or attach a file.");

    if (queued.length + inFlight.size >= 20 || accepted.size >= 128) throw new Error("Too many messages are queued for this run.");

    const result = (async (): Promise<QueuedInputResult> => {
      const prepared = await options.prepare(input);
      requireRun(input.runId, conversationId);
      const session = options.session();

      if (!session.isStreaming) throw new Error("The agent has finished this run. Send the message as a new request.");

      let item: QueuedInput = {
        id: input.id, mode: input.mode, text: input.text,
      };

      if (input.attachments?.length) item = { ...item, attachments: input.attachments.map(({ name, mimeType }) => ({ name, mimeType })) };
      queued.push({ item, text: prepared.text, state: "submitting" });

      try {
        const disposition = await (input.mode === "steer"
          ? session.steer(prepared.text, prepared.images, { source: "rpc" })
          : session.followUp(prepared.text, prepared.images, { source: "rpc" }));

        requireRun(input.runId, conversationId);

        if (!session.isStreaming) {
          session.clearQueue();
          throw new Error("The agent finished before it could accept this message. Send it as a new request.");
        }

        if (disposition === "handled") {
          queued = queued.filter((entry) => entry.item.id !== input.id);
          emitQueue(run);
        } else if (input.mode === "steer") {
          for (const pending of questions.values())
            if (pending.run.id === run.id) pending.finish("redirected");
        }

        return { id: input.id, runId: run.id, disposition };
      } catch (error) {
        queued = queued.filter((entry) => entry.item.id !== input.id);
        emitQueue(run);
        throw error;
      }
    })();

    accepted.set(input.id, { signature, result });
    inFlight.add(result);
    void result.then(() => inFlight.delete(result), () => inFlight.delete(result));

    return result;
  };

  const clear = (run: ActiveRun, status: "cancelled" | "expired" = "cancelled") => {
    options.session().clearQueue();
    queued = [];
    accepted.clear();
    emitQueue(run);

    for (const pending of questions.values())
      if (pending.run.id === run.id) pending.finish(status);
  };

  const ui = (base: ExtensionUIContext): ExtensionUIContext => {
    const question = (title: string, choices?: string[], opts?: ExtensionUIDialogOptions) => {
      let question: UserQuestion = { id: "answer", question: title };

      if (choices) question = { ...question, options: choices };

      return ask([question], opts?.signal, opts?.timeout);
    };

    return {
      ...base,
      select: async (title, choices, opts) => (await question(title, choices, opts)).answers[0]?.answer,
      input: async (title, placeholder, opts) => (await question(placeholder ? `${title}\n${placeholder}` : title, undefined, opts)).answers[0]?.answer,
      confirm: async (title, message, opts) => (await question(`${title}\n${message}`, ["Yes", "No"], opts)).answers[0]?.answer === "Yes",
    };
  };

  return { ask, answer, queueInput, queueChanged, clear, ui, waitForInputs: () => Promise.allSettled(inFlight) };
}
