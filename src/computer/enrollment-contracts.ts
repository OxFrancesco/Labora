import { Schema } from "effect";
import { Computer, PairResponse } from "./contracts";

export const EnrollmentMetadata = Schema.Struct({
  id: Computer.fields.id,
  name: Computer.fields.name,
  platform: Computer.fields.platform,
  endpoint: Schema.String,
  approval: Schema.optionalKey(Schema.Literals(["browser", "code"])),
});

export interface EnrollmentMetadata extends Schema.Schema.Type<typeof EnrollmentMetadata> {}

export const EnrollmentStart = Schema.Struct({
  clientName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  challenge: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  code: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{8}$/))),
});

export interface EnrollmentStart extends Schema.Schema.Type<typeof EnrollmentStart> {}

export const EnrollmentIntent = Schema.Struct({
  id: Schema.String,
  approvalUrl: Schema.String,
  expiresAt: Schema.Number,
});

export interface EnrollmentIntent extends Schema.Schema.Type<typeof EnrollmentIntent> {}

export const EnrollmentClaim = Schema.Struct({
  verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});

export interface EnrollmentClaim extends Schema.Schema.Type<typeof EnrollmentClaim> {}

export const EnrollmentPending = Schema.Struct({ status: Schema.Literal("pending") });

export interface EnrollmentPending extends Schema.Schema.Type<typeof EnrollmentPending> {}

export const EnrollmentConnection = Schema.Struct({ ...PairResponse.fields, endpoint: Schema.String });

export interface EnrollmentConnection extends Schema.Schema.Type<typeof EnrollmentConnection> {}
