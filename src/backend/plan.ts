import { renameSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Result, Schema, Semaphore } from "effect";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { PlanState, UpdatePlan } from "./plan-contracts";

const Conversation = PlanState.fields.conversationId;

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", { message: Schema.String }) {}

interface PlanContext {
  conversationId: string;
  runId?: string;
}

interface PlanOptions {
  botDirectory: string;
  getContext: () => PlanContext;
  emit: (plan: PlanState) => void;
}

const parameters = Type.Object({
  steps: Type.Array(Type.Object({
    text: Type.String({ minLength: 1, maxLength: 240 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  }), { minItems: 1, maxItems: 12 }),
  explanation: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

async function run<A>(effect: Effect.Effect<A, PlanError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));

  if (Result.isFailure(result)) throw result.failure;

  return result.success;
}

const storage = Effect.fn("Plan.storage")(<A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: (cause) => cause instanceof PlanError ? cause : new PlanError({ message: "The conversation plan could not be read or saved." }),
}));

export async function createPlanTool(options: PlanOptions) {
  const directory = resolve(options.botDirectory);
  const plans = new Map<string, PlanState>();
  const mutex = Semaphore.makeUnsafe(1);

  const conversationId = (value: string) => {
    const decoded = Schema.decodeUnknownResult(Conversation)(value);

    if (Result.isFailure(decoded)) throw new PlanError({ message: "The conversation ID is invalid." });

    return decoded.success;
  };

  const location = (id: string) => id === "direct"
    ? join(directory, "plans", "direct.json")
    : join(directory, "conversations", conversationId(id), "plan.json");

  const load = Effect.fn("Plan.load")((id: string) => storage(async () => {
    const path = location(id);

    try {
      const info = await lstat(path);

      if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768)
        throw new PlanError({ message: "The saved conversation plan is invalid." });

      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(PlanState))(await readFile(path, "utf8"));

      if (Result.isFailure(decoded) || decoded.success.conversationId !== id)
        throw new PlanError({ message: "The saved conversation plan is invalid." });
      plans.set(id, decoded.success);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
      throw cause;
    }
  }));

  await run(load("direct"));

  const conversations = await run(storage(async () => {
    try { return await readdir(join(directory, "conversations"), { withFileTypes: true }); } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
      throw cause;
    }
  }));

  for (const entry of conversations) {
    if (entry.name === "direct" || !entry.isDirectory() || Result.isFailure(Schema.decodeUnknownResult(Conversation)(entry.name))) continue;
    await run(load(entry.name));
  }

  const requireCurrent = (context: PlanContext, signal?: AbortSignal) => {
    const active = options.getContext();

    if (signal?.aborted || !context.runId || active.runId !== context.runId || active.conversationId !== context.conversationId)
      throw new PlanError({ message: "This run is no longer accepting plan updates." });
  };

  const update = Effect.fn("Plan.update")((input: Schema.Schema.Type<typeof UpdatePlan>, context: PlanContext, signal?: AbortSignal) =>
    mutex.withPermit(storage(async () => {
      requireCurrent(context, signal);
      const id = conversationId(context.conversationId);
      const path = location(id);
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;

      let plan: PlanState = {
        conversationId: id,
        steps: input.steps.map((step) => ({ text: step.text.trim(), status: step.status })),
        updatedAt: new Date().toISOString(),
      };

      if (input.explanation !== undefined) plan = { ...plan, explanation: input.explanation.trim() };

      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        requireCurrent(context, signal);
        await writeFile(temporary, `${JSON.stringify(plan)}\n`, { mode: 0o600, flag: "wx", signal });
        requireCurrent(context, signal);
        // Keep the atomic commit, snapshot, and event in one turn so cancellation cannot split them.
        renameSync(temporary, path);
        plans.set(id, plan);
        options.emit(plan);

        return plan;
      } finally { await unlink(temporary).catch(() => undefined); }
    })),
  );

  const tool: ToolDefinition = {
    name: "update_plan",
    label: "Update plan",
    description: "Replace this conversation's plan with 1–12 concise steps. Use pending, in_progress, or completed for each step, with at most one in_progress. Update the plan as work progresses. Use it for multi-step work, not simple answers. This records a plan; it does not execute tasks or request permission.",
    parameters,
    async execute(_id, input, signal) {
      const context = { ...options.getContext() };
      requireCurrent(context, signal);

      const decoded = await run(Schema.decodeUnknownEffect(UpdatePlan)(input).pipe(
        Effect.mapError(() => new PlanError({ message: "Use 1–12 non-empty steps, at most one in progress, and an optional short explanation." })),
      ));

      const plan = await run(update(decoded, context, signal));

      return { content: [{ type: "text", text: "Plan updated." }], details: plan };
    },
  };

  return {
    tool,
    snapshot: (id: string): PlanState | null => plans.get(conversationId(id)) ?? null,
    forget: (id: string) => { plans.delete(conversationId(id)); },
  };
}
