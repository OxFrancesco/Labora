import { renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { Computer } from "../computer/contracts";

export const Connection = Schema.Struct({
  id: Schema.String,
  endpoint: Schema.String,
  token: Schema.String,
  clientId: Schema.String,
  computer: Computer,
});

export interface Connection extends Schema.Schema.Type<typeof Connection> {}

export const Draft = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  paths: Schema.Array(Schema.String),
});

export interface Draft extends Schema.Schema.Type<typeof Draft> {}

const Preferences = Schema.Struct({
  connections: Schema.Array(Connection),
  selected: Schema.String,
  compact: Schema.Boolean,
  detailsOpen: Schema.Boolean,
  detailsWidth: Schema.Number,
  drafts: Schema.Array(Draft),
  voiceLocale: Schema.optionalKey(Schema.Literals(["", "en-GB", "en-US", "it-IT"])),
});

export interface Preferences extends Schema.Schema.Type<typeof Preferences> {}

export const emptyPreferences: Preferences = {
  connections: [],
  selected: "",
  compact: true,
  detailsOpen: true,
  detailsWidth: 336,
  drafts: [],
};

export async function createDesktopStore() {
  const directory = await Effect.runPromise(
    Config.String("LABORA_DESKTOP_DATA_DIR").pipe(
      Config.withDefault(join(homedir(), "Library/Application Support/Labora")),
    ),
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "desktop.json");
  const file = Bun.file(path);

  const preferences = (await file.exists())
    ? Schema.decodeUnknownSync(Preferences)(await file.json())
    : emptyPreferences;

  let pending = Promise.resolve();
  let latest = preferences;
  let written = preferences;

  function save(value: Preferences) {
    latest = value;

    const write = async () => {
      if (latest === written) return;
      const snapshot = latest;
      const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;

      try {
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });

        if (snapshot !== latest || snapshot === written) return;
        renameSync(temporary, path);
        written = snapshot;
      } finally {
        await rm(temporary, { force: true });
      }
    };

    pending = pending.then(write, write);

    return pending;
  }

  function flush() {
    if (latest === written) return;
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
      writeFileSync(temporary, JSON.stringify(latest), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      written = latest;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  return { preferences, save, flush, directory };
}
