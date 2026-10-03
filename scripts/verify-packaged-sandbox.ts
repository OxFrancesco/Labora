import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ChildOutput, ChildRequest, ChildCommand, EventPayload } from "../src/backend/contracts";

const root = await mkdtemp("/private/tmp/labora-packaged-sandbox-");

const evidence = join(process.cwd(), "evidence/packaged-sandbox");

await mkdir(evidence, { recursive: true });

const sentinel = join(root, "private.txt");

await writeFile(sentinel, "preserve-me");

let turn = 0;

const calls = [
  { name: "write", arguments: { path: "note.txt", content: "hello" } },
  { name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "hello", newText: "PACKAGED_OK" }] } },
  { name: "bash", arguments: { command: `cat note.txt; printf '\n'; cat ${JSON.stringify(sentinel)}; printf 'ENV:%s\n' "$LABORA_TEST_SECRET"; curl -Is --max-time 20 https://example.com | head -n 4` } },
  { name: "codemode", arguments: { code: 'const result = await tools.bash({command: "printf CODEMODE_OK"}); text(result.output);' } },
];

const selections: { model: string; reasoning: { effort: string } }[] = [];

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  selections.push(Schema.decodeUnknownSync(Schema.Struct({ model: Schema.String, reasoning: Schema.Struct({ effort: Schema.String }) }))(await request.json()));
  const id = `packaged-${turn}`;
  const call = calls[turn++];

  const item = call ? { id, type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" }
    : { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Package verified.", annotations: [] }] };

  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(call ? { arguments: "" } : { content: [] }) } },
    ...(!call ? [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Package verified." }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
} });

const agent = join(root, "bots/fixture/agent");

await mkdir(agent, { recursive: true });

await writeFile(join(agent, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600000, clientId: "fixture", subject: "fixture", idToken: "fixture", scopes: ["chatgpt.tokens.use.direct"] } }));

await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1` } } }));

const child = Bun.spawn([join(process.cwd(), "dist/Labora.app/Contents/MacOS/Labora"), "--agent-worker"], {
  cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LABORA_DATA_DIR: root, LABORA_BOT_ID: "fixture", LABORA_TEST_SECRET: "must-not-reach-shell", LABORA_EXECUTOR_URL: "https://127.0.0.1:9/mcp" },
});

const logs = new Response(child.stderr).text();

const ready = Promise.withResolvers<void>();

const completed = Promise.withResolvers<void>();

const tools: EventPayload[] = [];

const lines = createInterface({ input: (await import("node:stream")).Readable.from((async function* () {
  const reader = child.stdout.getReader();

  try {
    while (true) {
      const part = await reader.read();

      if (part.done) return;
      yield part.value;
    }
  } finally { reader.releaseLock(); }
})()) });

lines.on("line", (line) => {
  const output = Schema.decodeUnknownSync(Schema.fromJsonString(ChildOutput))(line);

  if (!ChildOutput.isAnyOf(["Event"])(output)) return;
  const event = output.payload;

  if (EventPayload.isAnyOf(["Ready"])(event)) ready.resolve();

  if (EventPayload.isAnyOf(["ToolEnd", "ApprovalRequested"])(event)) tools.push(event);

  if (EventPayload.isAnyOf(["RunCompleted"])(event)) completed.resolve();

  if (EventPayload.isAnyOf(["RunFailed"])(event)) completed.reject(new Error(event.message));
});

const timeout = setTimeout(() => completed.reject(new Error("Packaged sandbox test timed out")), 60000);

let failure: Error | undefined;

try {
  await Promise.race([ready.promise, completed.promise]);
  child.stdin.write(JSON.stringify(ChildRequest.make({ id: "prompt", command: ChildCommand.cases.Prompt.make({ runId: "sandbox", message: { text: "Verify sandbox tool execution." } }) })) + "\n");
  await completed.promise;
  assert.ok(selections.length > 0);
  assert.ok(selections.every(selection => selection.model === "gpt-6-astra" && selection.reasoning.effort === "high"), "Every compiled worker request must use Astra with high reasoning by default");
  assert.equal(await Bun.file(join(root, "bots/fixture/workspace/note.txt")).text(), "PACKAGED_OK");
  assert.equal(await Bun.file(sentinel).text(), "preserve-me");
  assert.equal(tools.some(EventPayload.isAnyOf(["ApprovalRequested"])), false);
  const output = JSON.stringify(tools);
  assert.ok(output.includes("Operation not permitted"));
  assert.ok(output.includes("200"), "Sandboxed public HTTPS must work");
  assert.ok(output.includes("CODEMODE_OK"));
  assert.ok(!output.includes("must-not-reach-shell"));
  assert.ok(!tools.some((event) => EventPayload.isAnyOf(["ToolEnd"])(event) && event.isError));
} catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
finally {
  clearTimeout(timeout);
  child.stdin.end();
  await child.exited;
  lines.close();
  await server.stop(true);
  await writeFile(join(evidence, "result.json"), JSON.stringify({ ok: !failure, error: failure?.message, selections, tools, stderr: await logs, boundary: "Compiled packaged Pi worker with minimal PATH; real Seatbelt execution and public HTTPS; isolated provider fixture." }, null, 2));

  if (!failure) await rm(root, { recursive: true, force: true });
}

if (failure) throw failure;

console.log("Packaged write/edit/bash/codemode, HTTPS, secret environment isolation and outside-file denial passed.");
