import { Schema } from "effect";

const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));

const Coordinate = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 32768 }));

const Dimension = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32768 }));

export const PermissionState = Schema.Literals(["granted", "denied", "not-determined", "unsupported"]);

export const Display = Schema.Struct({
  id: BoundedText, name: BoundedText, x: Schema.Number, y: Schema.Number,
  width: Dimension, height: Dimension, pixelWidth: Dimension, pixelHeight: Dimension,
  scale: Schema.Number,
});

export interface Display extends Schema.Schema.Type<typeof Display> {}

export const Computer = Schema.Struct({
  id: BoundedText, name: BoundedText,
  platform: Schema.Literals(["macos", "linux", "windows", "unsupported"]),
  capabilities: Schema.Array(Schema.Literals(["capture", "input", "agent-host"])),
  displays: Schema.Array(Display),
  permissions: Schema.Struct({ screenCapture: PermissionState, accessibility: PermissionState }),
  controlOwner: Schema.Literals(["user", "agent"]),
  diagnostics: Schema.Array(Schema.String),
});

export interface Computer extends Schema.Schema.Type<typeof Computer> {}

export const PairRequest = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^\d{8}$/)), clientName: BoundedText,
});

export interface PairRequest extends Schema.Schema.Type<typeof PairRequest> {}

export const PairResponse = Schema.Struct({ token: Schema.String, clientId: Schema.String, computer: Computer });

export interface PairResponse extends Schema.Schema.Type<typeof PairResponse> {}

export const Button = Schema.Literals(["left", "right", "middle"]);

const Point = { x: Coordinate, y: Coordinate };

export const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("move"), ...Point }),
  Schema.Struct({ type: Schema.Literal("click"), ...Point, button: Button, count: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2 })) }),
  Schema.Struct({ type: Schema.Literal("pointer_down"), ...Point, button: Button }),
  Schema.Struct({ type: Schema.Literal("pointer_up"), ...Point, button: Button }),
  Schema.Struct({ type: Schema.Literal("scroll"), ...Point, deltaX: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: -1000, maximum: 1000 })), deltaY: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: -1000, maximum: 1000 })) }),
  Schema.Struct({ type: Schema.Literal("type"), text: Schema.String.check(Schema.isMaxLength(8192)) }),
  Schema.Struct({ type: Schema.Literal("key"), key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+ -]{1,80}$/)) }),
]);

export type Action = typeof Action.Type;

export const ActionsRequest = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/)),
  displayId: BoundedText, frameId: BoundedText,
  actor: Schema.Literals(["user", "agent"]),
  actions: Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});

export interface ActionsRequest extends Schema.Schema.Type<typeof ActionsRequest> {}

export const ControlRequest = Schema.Struct({ owner: Schema.Literals(["user", "agent"]) });

export interface ControlRequest extends Schema.Schema.Type<typeof ControlRequest> {}

export const Frame = Schema.Struct({
  id: Schema.String, displayId: Schema.String, capturedAt: Schema.Number,
  width: Dimension, height: Dimension,
  originX: Schema.Number, originY: Schema.Number,
  scaleX: Schema.Number, scaleY: Schema.Number,
});

export interface Frame extends Schema.Schema.Type<typeof Frame> {}

export class ComputerError extends Schema.TaggedError<ComputerError>()("ComputerError", {
  status: Schema.Number, code: Schema.String, message: Schema.String,
}) {}
