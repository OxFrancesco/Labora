import { Schema } from "effect";

const Conversation = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,95}$/i));

export const PlanStep = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isPattern(/\S/)),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
});

export interface PlanStep extends Schema.Schema.Type<typeof PlanStep> {}

export const UpdatePlan = Schema.Struct({
  steps: Schema.Array(PlanStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
    Schema.makeFilter((steps) => steps.filter((step) => step.status === "in_progress").length <= 1 || "Only one plan step can be in progress."),
  ),
  explanation: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isPattern(/\S/))),
});

export const PlanState = Schema.Struct({
  ...UpdatePlan.fields,
  conversationId: Conversation,
  updatedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)),
});

export interface PlanState extends Schema.Schema.Type<typeof PlanState> {}
