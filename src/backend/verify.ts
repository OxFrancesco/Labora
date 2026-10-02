import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { createAgentHttpHandler, type AgentHttpHandler } from "./http";
import {
  AgentEvent,
  AuthStatus,
  Bot,
  EventPayload,
  MessageSnapshot,
  WorkspaceFile,
} from "./contracts";

const context = {
  computerId: "verification",
  clientId: "verification",
  controlOwner: "user",
} satisfies Schema.Schema.Type<typeof import("./contracts").AgentRequestContext>;

const dataDir = await mkdtemp(join(tmpdir(), "labora-agent-e2e-"));

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

const host = await createAgentHttpHandler({ dataDir });

const pids: number[] = [];

const request = async (
  target: AgentHttpHandler,
  path: string,
  method = "GET",
  body?: Schema.Schema.Type<typeof Schema.Json>,
) => {
  const options: RequestInit = { method };

  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const result = await target.fetch(
    new Request(`http://companion.test/v1/bots${path}`, options),
    context,
  );

  assert.ok(result);

  return result;
};

const decode = <A>(schema: Schema.Codec<A>, response: Response) =>
  response
    .text()
    .then((value) =>
      Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value)),
    );

try {
  await assert.rejects(createAgentHttpHandler({ dataDir }));

  for (const id of ["one", "two"]) {
    const created = await request(host, "", "POST", { id, name: id, color: "#445566" });
    assert.equal(created.status, 201);
    const bot = await decode(Schema.Struct({ bot: Bot }), created);
    assert.equal(bot.bot.id, id);
    const auth = await request(host, `/${id}/auth`);
    assert.equal(auth.status, 200, await auth.clone().text());
    assert.deepEqual(await decode(AuthStatus, auth), {
      openai: "signed-out",
      executor: "signed-out",
      active: null,
    });
    const snapshot = await decode(MessageSnapshot, await request(host, `/${id}/messages`));
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.pending.length, 0);
    assert.ok(snapshot.cursor >= 1);
    const response = await request(host, `/${id}/events`);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const content = new TextDecoder().decode(first.value);
    const line = content.split("\n").find((item) => item.startsWith("data: "));
    assert.ok(line);

    const event = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent))(line.slice(6)),
    );

    assert.equal(event.payload._tag, "Ready");

    if (EventPayload.isAnyOf(["Ready"])(event.payload)) pids.push(event.payload.pid);
    await reader.cancel();

    const rejected = await request(host, `/${id}/messages`, "POST", {
      text: "This must not send inference without login.",
    });

    assert.equal(rejected.status, 409);
    assert.match(await rejected.text(), /ChatGPT subscription/);
    assert.equal(
      (await request(host, `/${id}/approvals/absent`, "POST", { decision: "approve" })).status,
      409,
    );
  }

  assert.equal(new Set(pids).size, 2);
  assert.equal(await host.isBusy(), false);
  assert.equal(
    (await request(host, "/one", "PATCH", { name: "Renamed", color: "#998877", label: "Inbox" }))
      .status,
    200,
  );
  const workspace = join(dataDir, "bots", "one", "workspace");
  await mkdir(join(workspace, "folder"), { recursive: true });
  await writeFile(join(workspace, "folder", "note.txt"), "Scoped file content");
  await writeFile(join(dataDir, "outside.txt"), "Outside workspace fixture");
  await symlink(join(dataDir, "outside.txt"), join(workspace, "escape.txt"));

  const files = await decode(
    Schema.Struct({ files: Schema.Array(WorkspaceFile) }),
    await request(host, "/one/files"),
  );

  assert.deepEqual(
    files.files.map((file) => file.path),
    ["folder/note.txt"],
  );
  const file = await request(host, "/one/files/content?path=folder%2Fnote.txt");
  assert.equal(await file.text(), "Scoped file content");
  assert.equal((await request(host, "/one/files/content?path=escape.txt")).status, 403);
  assert.equal(
    (await request(host, "/one/files/content?path=..%2F..%2F..%2Foutside.txt")).status,
    403,
  );
  assert.equal((await request(host, "/one/events?cursor=-1")).status, 400);
} finally {
  await host.close();
}

for (const pid of pids) assert.throws(() => process.kill(pid, 0));

const restarted = await createAgentHttpHandler({ dataDir });

try {
  const stored = await decode(
    Schema.Struct({ bots: Schema.Array(Bot) }),
    await request(restarted, ""),
  );

  assert.equal(stored.bots.length, 2);
  assert.equal(stored.bots[0]?.name, "Renamed");
  assert.equal(stored.bots[0]?.label, "Inbox");
  const snapshot = await decode(MessageSnapshot, await request(restarted, "/one/messages"));
  assert.ok(snapshot.cursor > 1);
} finally {
  await restarted.close();
  await rm(dataDir, { recursive: true, force: true });
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    checks: [
      "exclusive host ownership",
      "two isolated real Pi processes",
      "signed-out status",
      "no-inference rejection",
      "SSE replay and cancellation",
      "expired approval rejection",
      "bot metadata persistence",
      "workspace download and escape rejection",
      "process cleanup",
      "restart with persisted events",
    ],
  }) + "\n",
);
