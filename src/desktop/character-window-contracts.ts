import { Schema } from "effect";

export const CharacterWindowAction = Schema.TaggedUnion({
  Ready: {},
  Select: { color: Schema.String },
});

export type CharacterWindowAction = Schema.Schema.Type<typeof CharacterWindowAction>;

export const CharacterWindowCommand = Schema.TaggedUnion({
  State: { color: Schema.String, saving: Schema.Boolean, error: Schema.String },
  Activate: {},
});

export type CharacterWindowCommand = Schema.Schema.Type<typeof CharacterWindowCommand>;
