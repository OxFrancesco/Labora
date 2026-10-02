import { Schema } from "effect";
import { BotId, ConversationId } from "./contracts";

const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
);

export const RoutineSchedule = Schema.TaggedUnion({
  Once: { at: Timestamp },
  Cron: {
    expression: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  },
});

export type RoutineSchedule = Schema.Schema.Type<typeof RoutineSchedule>;

export const RoutineId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);

export const CreateRoutine = Schema.Struct({
  botId: BotId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  schedule: RoutineSchedule,
});

export interface CreateRoutine extends Schema.Schema.Type<typeof CreateRoutine> {}

export const UpdateRoutine = Schema.Struct({
  name: Schema.optionalKey(CreateRoutine.fields.name),
  prompt: Schema.optionalKey(CreateRoutine.fields.prompt),
  schedule: Schema.optionalKey(RoutineSchedule),
});

export interface UpdateRoutine extends Schema.Schema.Type<typeof UpdateRoutine> {}

export const SetRoutineEnabled = Schema.Struct({ enabled: Schema.Boolean });

export interface SetRoutineEnabled extends Schema.Schema.Type<typeof SetRoutineEnabled> {}

export const Routine = Schema.Struct({
  ...CreateRoutine.fields,
  id: RoutineId,
  enabled: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  nextRunAt: Schema.NullOr(Timestamp),
});

export interface Routine extends Schema.Schema.Type<typeof Routine> {}

const runFields = {
  id: RoutineId,
  routineId: RoutineId,
  botId: BotId,
  conversationId: ConversationId,
  trigger: Schema.Literals(["scheduled", "manual"]),
  scheduledAt: Timestamp,
  startedAt: Timestamp,
  message: Schema.String,
};

export const RoutineRun = Schema.Union([
  Schema.Struct({
    ...runFields,
    status: Schema.Literals(["starting", "running"]),
    finishedAt: Schema.Null,
  }),
  Schema.Struct({
    ...runFields,
    status: Schema.Literals([
      "completed", "failed", "blocked", "missed", "interrupted", "cancelled",
    ]),
    finishedAt: Timestamp,
  }),
]);

export type RoutineRun = Schema.Schema.Type<typeof RoutineRun>;
