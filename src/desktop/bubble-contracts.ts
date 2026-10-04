import { Schema } from "effect";
import { Bot, BotActivity, EventPayload, Message, QuestionResponse } from "../backend/contracts";
import { PlanState } from "../backend/plan-contracts";
import { Draft } from "./store";

export const BubbleSnapshot = Schema.Struct({
  key: Schema.String,
  bot: Schema.NullOr(Bot),
  messages: Schema.Array(Message),
  draft: Draft,
  busy: Schema.Boolean,
  error: Schema.String,
  activity: BotActivity,
  question: Schema.NullOr(EventPayload.cases.QuestionRequested),
  plan: Schema.NullOr(PlanState),
  approval: Schema.NullOr(Schema.Struct({ requestId: Schema.String, toolName: Schema.String, input: Schema.String })),
});

export interface BubbleSnapshot extends Schema.Schema.Type<typeof BubbleSnapshot> {}

export const BubbleAction = Schema.TaggedUnion({
  Ready: {},
  Hide: {},
  Open: {},
  Draft: { key: Schema.String, draft: Draft },
  Send: { key: Schema.String },
  Stop: { key: Schema.String },
  Approve: { key: Schema.String, decision: Schema.Literals(["approve", "deny"]) },
  Answer: { key: Schema.String, requestId: Schema.String, runId: Schema.String, answers: QuestionResponse.fields.answers },
});

export type BubbleAction = Schema.Schema.Type<typeof BubbleAction>;

export const BubbleCommand = Schema.TaggedUnion({
  State: { snapshot: BubbleSnapshot },
  Visibility: { visible: Schema.Boolean, restoreFocus: Schema.Boolean },
});

export type BubbleCommand = Schema.Schema.Type<typeof BubbleCommand>;
