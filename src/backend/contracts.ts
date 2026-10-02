import { Schema } from "effect";

export const BotId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/i));

export const ConversationId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,95}$/i),
);

export const Provider = Schema.Literals(["openai", "executor"]);

export type Provider = Schema.Schema.Type<typeof Provider>;

export const CreateBot = Schema.Struct({
  id: BotId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
});

export interface CreateBot extends Schema.Schema.Type<typeof CreateBot> {}

export const UpdateBot = Schema.Struct({
  name: Schema.optionalKey(CreateBot.fields.name),
  color: Schema.optionalKey(CreateBot.fields.color),
  label: CreateBot.fields.label,
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
  role: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.String,
  createdAt: Schema.String,
  toolName: Schema.optionalKey(Schema.String),
});

export interface Message extends Schema.Schema.Type<typeof Message> {}

export const AuthStart = Schema.Struct({ provider: Provider });

export interface AuthStart extends Schema.Schema.Type<typeof AuthStart> {}

export const AuthInput = Schema.Struct({ value: Schema.String.check(Schema.isMaxLength(16_384)) });

export interface AuthInput extends Schema.Schema.Type<typeof AuthInput> {}

export const ApprovalResponse = Schema.Struct({ decision: Schema.Literals(["approve", "deny"]) });

export interface ApprovalResponse extends Schema.Schema.Type<typeof ApprovalResponse> {}

export const AuthStatus = Schema.Struct({
  openai: Schema.Literals(["ready", "signed-out"]),
  executor: Schema.Literals(["ready", "signed-out"]),
  active: Schema.NullOr(Provider),
});

export interface AuthStatus extends Schema.Schema.Type<typeof AuthStatus> {}

export const EventPayload = Schema.TaggedUnion({
  Ready: { pid: Schema.Number },
  Message: { message: Message },
  TextDelta: { messageId: Schema.String, text: Schema.String },
  ToolStart: { toolCallId: Schema.String, name: Schema.String, input: Schema.Json },
  ToolEnd: {
    toolCallId: Schema.String,
    name: Schema.String,
    isError: Schema.Boolean,
    output: Schema.Json,
  },
  RunStarted: { runId: Schema.String },
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
  ProcessExited: { message: Schema.String },
});

export type EventPayload = Schema.Schema.Type<typeof EventPayload>;

export const isConversationEvent = EventPayload.isAnyOf([
  "Message",
  "TextDelta",
  "ToolStart",
  "ToolEnd",
  "RunStarted",
  "RunCompleted",
  "RunCancelled",
  "RunFailed",
  "ApprovalRequested",
  "ApprovalResolved",
]);

export const MessageSnapshot = Schema.Struct({
  messages: Schema.Array(Message),
  cursor: Schema.Number,
  busy: Schema.Boolean,
  pending: Schema.Array(EventPayload),
});

export interface MessageSnapshot extends Schema.Schema.Type<typeof MessageSnapshot> {}

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
  AuthStatus: {},
  AuthStart: { provider: Provider },
  AuthInput: { value: Schema.String },
  Approval: { requestId: Schema.String, decision: ApprovalResponse.fields.decision },
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
