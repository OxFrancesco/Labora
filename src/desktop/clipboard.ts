import { resolve } from "node:path";
import { Schema } from "effect";

export const ClipboardContents = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(Schema.String),
  image: Schema.optionalKey(
    Schema.Struct({
      data: Schema.String,
      mimeType: Schema.Literal("image/png"),
      name: Schema.String,
    }),
  ),
});

export interface ClipboardContents extends Schema.Schema.Type<typeof ClipboardContents> {}

function executable(): string {
  return process.env.LABORA_DESKTOP_HELPER ?? resolve(import.meta.dir, "../../dist/labora-desktop");
}

export async function readClipboard(): Promise<ClipboardContents> {
  const child = Bun.spawn([executable(), "clipboard-read"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(error.trim() || "Could not read the macOS clipboard.");

  return Schema.decodeUnknownSync(Schema.fromJsonString(ClipboardContents))(output);
}

export async function copyText(text: string): Promise<void> {
  const child = Bun.spawn([executable(), "clipboard-copy-text"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });

  child.stdin.write(text);
  child.stdin.end();
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  if (code !== 0) throw new Error(error.trim() || "Could not copy text to the macOS clipboard.");
}
