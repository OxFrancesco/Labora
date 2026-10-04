import { Schema } from "effect";
import { CustomConnector, ConnectorChange } from "./connector-contracts";
import { PlanState } from "./plan-contracts";

export const BotId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/i));

export const ConversationId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,95}$/i),
);

export const Provider = Schema.String.check(Schema.isPattern(/^(openai|executor|notion|linear|github|granola|raindrop|ocu|custom_[a-z0-9]{1,32})$/));

export type Provider = Schema.Schema.Type<typeof Provider>;

export const CreateBot = Schema.Struct({
  id: BotId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
});

export interface CreateBot extends Schema.Schema.Type<typeof CreateBot> {}

export const UpdateBot = Schema.Struct({
  name: Schema.optionalKey(CreateBot.fields.name),
  color: Schema.optionalKey(CreateBot.fields.color),
});

export interface UpdateBot extends Schema.Schema.Type<typeof UpdateBot> {}

export const WorkspaceFile = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  modifiedAt: Schema.String,
});

export interface WorkspaceFile extends Schema.Schema.Type<typeof WorkspaceFile> {}

export const Bot = Schema.Struct({
  ...CreateBot.fields,
  createdAt: Schema.String,
});

export interface Bot extends Schema.Schema.Type<typeof Bot> {}

export const Attachment = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  data: Schema.String.check(
    Schema.isMaxLength(20_000_000),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});

export interface Attachment extends Schema.Schema.Type<typeof Attachment> {}

export const SendMessage = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(200_000)),
  attachments: Schema.optionalKey(Schema.Array(Attachment).check(Schema.isMaxLength(12))),
});

export interface SendMessage extends Schema.Schema.Type<typeof SendMessage> {}

export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "tool", "thinking"]),
  text: Schema.String,
  createdAt: Schema.String,
  toolName: Schema.optionalKey(Schema.String),
  toolInput: Schema.optionalKey(Schema.String),
  toolStatus: Schema.optionalKey(Schema.Literals(["running", "complete", "error"])),
});

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const AuthStart = Schema.Struct({ provider: Provider });

export interface AuthStart extends Schema.Schema.Type<typeof AuthStart> {}

export const AuthInput = Schema.Struct({ value: Schema.String.check(Schema.isMaxLength(16_384)) });

export interface AuthInput extends Schema.Schema.Type<typeof AuthInput> {}

export const ApprovalResponse = Schema.Struct({ decision: Schema.Literals(["approve", "deny"]) });

export interface ApprovalResponse extends Schema.Schema.Type<typeof ApprovalResponse> {}

export const UserQuestion = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
  question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  options: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(Schema.isMaxLength(6))),
});

export interface UserQuestion extends Schema.Schema.Type<typeof UserQuestion> {}

export const UserQuestions = Schema.Array(UserQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(3));

export const QuestionAnswers = Schema.Array(Schema.Struct({
  id: UserQuestion.fields.id,
  answer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
})).check(Schema.isMinLength(1), Schema.isMaxLength(3));

export const QuestionResponse = Schema.Struct({ runId: Schema.String, answers: Schema.NullOr(QuestionAnswers) });

export interface QuestionResponse extends Schema.Schema.Type<typeof QuestionResponse> {}

export const QuestionOutcome = Schema.Literals(["answered", "dismissed", "cancelled", "expired", "redirected"]);

export const QueuedInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,96}$/)),
  mode: Schema.Literals(["steer", "followUp"]),
  text: SendMessage.fields.text,
  attachments: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Attachment.fields.name, mimeType: Attachment.fields.mimeType }))),
});

export interface QueuedInput extends Schema.Schema.Type<typeof QueuedInput> {}

export const QueueInput = Schema.Struct({ ...SendMessage.fields, id: QueuedInput.fields.id, mode: QueuedInput.fields.mode, runId: Schema.String });

export interface QueueInput extends Schema.Schema.Type<typeof QueueInput> {}

export const QueuedInputResult = Schema.Struct({ id: QueuedInput.fields.id, runId: Schema.String, disposition: Schema.Literals(["queued", "handled"]) });

export interface QueuedInputResult extends Schema.Schema.Type<typeof QueuedInputResult> {}

export const AuthStatus = Schema.Struct({
  openai: Schema.Literals(["ready", "signed-out"]),
  executor: Schema.Literals(["ready", "signed-out"]),
  active: Schema.NullOr(Provider),
});

export interface AuthStatus extends Schema.Schema.Type<typeof AuthStatus> {}

export const EventPayload = Schema.TaggedUnion({
  Ready: { pid: Schema.Number },
  Message: { message: Message },
  TextDelta: {
    messageId: Schema.String,
    text: Schema.String,
    offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  },
  ToolStart: { toolCallId: Schema.String, name: Schema.String, input: Schema.Json },
  ToolProgress: { toolCallId: Schema.String, name: Schema.String, text: Schema.String.check(Schema.isMaxLength(2_000)) },
  ToolEnd: {
    toolCallId: Schema.String,
    name: Schema.String,
    isError: Schema.Boolean,
    output: Schema.Json,
  },
  RunStarted: { runId: Schema.String },
  RunActivity: {
    runId: Schema.String,
    phase: Schema.Literals(["thinking", "retrying", "compacting"]),
    message: Schema.optionalKey(Schema.String),
  },
  RunCompleted: { runId: Schema.String },
  RunCancelled: { runId: Schema.String },
  RunFailed: { runId: Schema.String, message: Schema.String },
  AuthLink: { provider: Provider, url: Schema.String, message: Schema.String },
  AuthPrompt: { provider: Provider, message: Schema.String, secret: Schema.Boolean },
  AuthCompleted: { provider: Provider },
  AuthFailed: { provider: Provider, message: Schema.String },
  ApprovalRequested: {
    requestId: Schema.String,
    toolName: Schema.String,
    input: Schema.Json,
    expiresAt: Schema.String,
  },
  ApprovalResolved: { requestId: Schema.String, decision: Schema.Literals(["approve", "deny"]) },
  QuestionRequested: { requestId: Schema.String, runId: Schema.String, questions: UserQuestions, expiresAt: Schema.String },
  QuestionResolved: { requestId: Schema.String, runId: Schema.String, outcome: QuestionOutcome },
  InputQueueChanged: { runId: Schema.String, items: Schema.Array(QueuedInput) },
  PlanUpdated: { plan: PlanState },
  ProcessExited: { message: Schema.String },
});

export type EventPayload = Schema.Schema.Type<typeof EventPayload>;

export const isConversationEvent = EventPayload.isAnyOf([
  "Message",
  "TextDelta",
  "ToolStart",
  "ToolProgress",
  "ToolEnd",
  "RunStarted",
  "RunActivity",
  "RunCompleted",
  "RunCancelled",
  "RunFailed",
  "ApprovalRequested",
  "ApprovalResolved",
  "QuestionRequested",
  "QuestionResolved",
  "InputQueueChanged",
  "PlanUpdated",
]);

export const BotActivity = Schema.Struct({
  phase: Schema.Literals([
    "idle", "thinking", "streaming", "working", "waiting", "asking", "retrying", "compacting",
    "complete", "failed", "cancelled", "reconnecting",
  ]),
  runId: Schema.optionalKey(Schema.String),
  tools: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  approvalIds: Schema.Array(Schema.String),
  questionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
});

export interface BotActivity extends Schema.Schema.Type<typeof BotActivity> {}

export const MessageSnapshot = Schema.Struct({
  messages: Schema.Array(Message),
  cursor: Schema.Number,
  busy: Schema.Boolean,
  pending: Schema.Array(EventPayload),
  activity: Schema.optionalKey(BotActivity),
  botActivity: Schema.optionalKey(BotActivity),
  plan: Schema.optionalKey(Schema.NullOr(PlanState)),
});

export interface MessageSnapshot extends Schema.Schema.Type<typeof MessageSnapshot> {}

export const WorkerMessages = Schema.Struct({ messages: Schema.Array(Message), plan: Schema.NullOr(PlanState) });

export const AgentEvent = Schema.Struct({
  sequence: Schema.Number,
  botId: BotId,
  timestamp: Schema.String,
  payload: EventPayload,
  conversationId: Schema.optionalKey(ConversationId),
});

export interface AgentEvent extends Schema.Schema.Type<typeof AgentEvent> {}

export const AgentRequestContext = Schema.Struct({
  computerId: Schema.String,
  clientId: Schema.String,
  controlOwner: Schema.Literals(["user", "agent"]),
});

export interface AgentRequestContext extends Schema.Schema.Type<typeof AgentRequestContext> {}

export const ChildCommand = Schema.TaggedUnion({
  Messages: { conversationId: Schema.optionalKey(ConversationId) },
  ForgetConversation: { conversationId: ConversationId },
  Prompt: {
    runId: Schema.String,
    message: SendMessage,
    conversationId: Schema.optionalKey(ConversationId),
  },
  Cancel: {
    conversationId: Schema.optionalKey(ConversationId),
    runId: Schema.optionalKey(Schema.String),
  },
  Connectors: {},
  ConnectorAdd: CustomConnector.fields,
  ConnectorChange: ConnectorChange.fields,
  AuthStatus: {},
  AuthStart: { provider: Provider },
  AuthCancel: {},
  AuthInput: { value: Schema.String },
  Approval: { requestId: Schema.String, decision: ApprovalResponse.fields.decision },
  QuestionResponse: { ...QuestionResponse.fields, requestId: Schema.String, conversationId: Schema.optionalKey(ConversationId) },
  QueueInput: { ...QueueInput.fields, conversationId: Schema.optionalKey(ConversationId) },
  Close: {},
  ComputerResult: {
    requestId: Schema.String,
    value: Schema.Json,
    error: Schema.optionalKey(Schema.String),
  },
});

export type ChildCommand = Schema.Schema.Type<typeof ChildCommand>;

export const ChildRequest = Schema.Struct({ id: Schema.String, command: ChildCommand });

export interface ChildRequest extends Schema.Schema.Type<typeof ChildRequest> {}

export const ChildOutput = Schema.TaggedUnion({
  Response: { id: Schema.String, value: Schema.Json },
  Failure: { id: Schema.String, code: Schema.String, message: Schema.String },
  Event: { payload: EventPayload, conversationId: Schema.optionalKey(ConversationId) },
  Computer: {
    id: Schema.String,
    operation: Schema.Literals(["info", "capture", "act", "browser"]),
    input: Schema.Json,
  },
});

export type ChildOutput = Schema.Schema.Type<typeof ChildOutput>;

export class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}
