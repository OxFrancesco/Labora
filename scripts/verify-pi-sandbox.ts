import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Match, Schema } from "effect";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { EventPayload } from "../src/backend/contracts";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";

interface Generation {
  input: string;
  text(delta: string): void;
  finish(): void;
  tool(name: string, input: Schema.Schema.Type<typeof Schema.Json>): void;
  fail(): void;
}

const root = resolve(import.meta.dir, "..");

const workspace = await mkdtemp("/private/tmp/labora-controls-e2e-");

const dataDir = join(workspace, "computer");

const profileDirectory = join(workspace, "desktop");

const source = process.argv.includes("--source");

const layoutOnly = process.argv.includes("--layout-only");

const evidenceDirectory = join(root, "evidence", `pi-sandbox-${source ? "source" : "packaged"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const checks: string[] = [];

const requests: string[] = [];

const inputIds: string[] = [];

let loseInputAcknowledgement = false;

let pending = Promise.withResolvers<Generation>();

let failure: Error | undefined;

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

const oauth = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const origin = url.origin;

  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });

  if (url.pathname.startsWith("/.well-known/")) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });

  if (url.pathname === "/register") return Response.json({ ...await request.json(), client_id: "labora-fixture" }, { status: 201 });

  if (url.pathname === "/authorize") return new Response("Labora isolated OAuth verification. No personal account is used.");

  if (url.pathname === "/token") return Response.json({ access_token: "isolated-fixture-token", token_type: "Bearer", expires_in: 3600 });

  if (url.pathname.startsWith("/mcp")) {
    if (!request.headers.has("authorization")) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });

    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json();

    if (!message.id) return new Response(null, { status: 202 });

    const results = {
      initialize: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
      "tools/list": { tools: [{ name: "fixture_echo", description: "Return an isolated verification marker", inputSchema: { type: "object", properties: {} } }] },
      "tools/call": { content: [{ type: "text", text: "EXECUTOR_TOOL_OK" }] },
    };

    return Response.json({ jsonrpc: "2.0", id: message.id, result: Match.value(message.method).pipe(Match.when("initialize", () => results.initialize), Match.when("tools/list", () => results["tools/list"]), Match.orElse(() => results["tools/call"])) });
  }

  return new Response(null, { status: 404 });
} });

process.env.LABORA_EXECUTOR_URL = `${oauth.url.origin}/mcp`;

let companion = await createComputerHost({ dataDir, name: "Agent controls verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "unavailable/Labora Computer.app") });

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path !== "/v1/responses") {
      if (path.endsWith("/inputs") && request.method === "POST") {
        const input = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await request.clone().json());
        inputIds.push(input.id);
        const response = await companion.fetch(request);

        if (response.ok && loseInputAcknowledgement) {
          loseInputAcknowledgement = false;

          return Response.json({ error: { message: "Simulated lost acknowledgement. Your input is preserved." } }, { status: 502 });
        }

        return response;
      }

      return companion.fetch(request);
    }

    const body = Schema.decodeUnknownSync(Schema.Struct({ stream: Schema.Boolean, input: Schema.Json }))(await request.json());
    assert.equal(body.stream, true);
    const input = JSON.stringify(body.input);
    requests.push(input);
    const id = `activity-${crypto.randomUUID()}`;
    let text = "";
    let started = false;

    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: Schema.Schema.Type<typeof Schema.Json>) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        const item = () => ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

        const complete = (output: Schema.Schema.Type<typeof Schema.Json>[]) => {
          send({ type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
          controller.close();
        };

        const generation: Generation = {
          input,
          text(delta) {
            if (!started) {
              started = true;
              send({ type: "response.created", response: { id } });
              send({ type: "response.output_item.added", output_index: 0, item: { ...item(), content: [] } });
            }

            text += delta;
            send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta });
          },
          finish() {
            send({ type: "response.output_item.done", output_index: 0, item: item() });
            complete([item()]);
          },
          tool(name, input) {
            const call = { id, type: "function_call", call_id: id, name, arguments: JSON.stringify(input), status: "completed" };
            send({ type: "response.created", response: { id } });
            send({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } });
            send({ type: "response.output_item.done", output_index: 0, item: call });
            complete([call]);
          },
          fail() {
            send({ type: "response.failed", response: { id, status: "failed", error: { code: "invalid_request_error", message: "Controlled animation verification failure" } } });
            controller.close();
          },
        };

        const current = pending;
        pending = Promise.withResolvers<Generation>();
        current.resolve(generation);
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  },
});

const pairing = await companion.issuePairingCode();

const connection = await pairComputer(server.url.origin, pairing.code);

const client = computerClient(connection);

async function waitUntil(label: string, check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function generation(request: Promise<Generation>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The real Pi worker did not issue the expected provider request.")), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(evidenceDirectory, { recursive: true });
  await client.createBot({ id: "controls", name: "Questions and updates", color: "#dfb845" });
  await client.createBot({ id: "other", name: "Other bot", color: "#6ba87b" });
  const agentDir = join(dataDir, "bots/controls/agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: "local-fixture-access", refresh: "local-fixture-refresh", expires: Date.now() + 3_600_000,
    clientId: "local-fixture", subject: "local-fixture", idToken: "local-fixture", scopes: ["chatgpt.tokens.use.direct"],
  } }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `${server.url.origin}/v1` } } }), { mode: 0o600 });
  const layoutAttachments = layoutOnly ? Array.from({ length: 4 }, (_, index) => join(workspace, `${index}-quarterly-product-review-with-supporting-documents-and-a-very-long-file-name-${"details-".repeat(10)}.txt`)) : [];

  for (const path of layoutAttachments) await writeFile(path, "Layout verification attachment.");
  await writeFile(join(profileDirectory, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/controls`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: layoutOnly ? [{ key: `${connection.id}/controls`, text: "", paths: layoutAttachments }] : [] }), { mode: 0o600 });
  driver = await openDesktop({ profileDirectory, evidenceDirectory, source, foreground: true });
  let app = driver.app;
  let native = driver;
  await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });

  const readyAvatars = async () => {
    await app.getByTestId("avatar3d-view-star-26").waitFor();

    for (const id of ["pebble-42", "star-42", "hexagon-42", "star-26", "star-80"]) {
      if (await app.getByTestId(`avatar3d-view-${id}`).count())
        await app.getByTestId(`avatar3d-ready-${id}`).waitFor({ timeoutMs: 30_000 });
    }
  };

  await readyAvatars();

  const snapshot = () => client.messages("controls");

  const capture = async (name: string) => {
    await readyAvatars();
    await native.screenshot(name);
  };

  const send = async (text: string) => {
    const next = pending.promise;
    await waitUntil("marketplace closed", async () => await app.getByTestId("marketplace").count() === 0);
    await app.getByTestId("composer").fill(text);
    await Bun.sleep(100);
    await app.getByTestId("send").click();

    return generation(next);
  };

  const complete = async (next: Generation, text: string) => {
    next.text(text);
    next.finish();
    await waitUntil("task completion", async () => !(await snapshot()).busy);
    await waitUntil("native completion", async () => await app.getByTestId("cancel").count() === 0);
  };

  const restart = async (name: string) => {
    await native.close();
    driver = undefined;
    driver = await openDesktop({ profileDirectory, evidenceDirectory: join(evidenceDirectory, name), source, foreground: true });
    native = driver;
    app = driver.app;
    await app.getByTestId("composer").waitFor({ timeoutMs: 30_000 });
    await readyAvatars();
  };

  const agentWorkspace = join(dataDir, "bots/controls/workspace");
  await mkdir(agentWorkspace, { recursive: true });
  const sentinel = join(workspace, "outside-workspace.txt");
  await writeFile(sentinel, "outside-workspace-preserved");
  await symlink(sentinel, join(agentWorkspace, "escape-link"));
  let model = await send("Create a small project note, then check the workspace boundary.");
  let next = pending.promise;
  model.tool("write", { path: "notes.md", content: "# Project note\nWorkspace tools run automatically.\n" });
  model = await generation(next);
  assert.equal(await app.getByTestId("approve-tool").count(), 0);
  assert.equal(await Bun.file(join(agentWorkspace, "notes.md")).text(), "# Project note\nWorkspace tools run automatically.\n");
  next = pending.promise;
  model.tool("edit", { path: "notes.md", edits: [{ oldText: "Project note", newText: "Workspace note" }] });
  model = await generation(next);
  assert.match(await Bun.file(join(agentWorkspace, "notes.md")).text(), /Workspace note/);
  next = pending.promise;
  model.tool("bash", { command: "printf 'Workspace ready\\n'; cat notes.md" });
  model = await generation(next);
  assert.ok(model.input.includes("Workspace ready"));
  next = pending.promise;
  model.tool("bash", { command: `rm ${JSON.stringify(sentinel)}; cat escape-link; printf 'ENV=%s' "$LABORA_DATA_DIR"` });
  model = await generation(next);
  assert.equal(await Bun.file(sentinel).text(), "outside-workspace-preserved");
  assert.ok(model.input.includes("Operation not permitted"));
  next = pending.promise;
  model.tool("read", { path: "escape-link" });
  model = await generation(next);
  assert.ok(model.input.includes("Operation not permitted"));
  next = pending.promise;
  model.tool("write", { path: "escape-link", content: "overwritten" });
  model = await generation(next);
  assert.equal(await Bun.file(sentinel).text(), "outside-workspace-preserved");
  await complete(model, "The note is saved in **notes.md**. Workspace commands ran automatically.\n\nAccess to the file outside the workspace was blocked, including through the symlink.");
  await capture("01-pi-transcript");
  const activityMessages = (await snapshot()).messages.filter((message) => message.role === "tool");
  const firstActivity = activityMessages[0]!;
  const firstCommand = activityMessages.find((message) => message.toolName === "bash")!;
  await app.getByTestId(`activity-toggle-${firstActivity.id}`).click();
  await app.getByTestId(`tool-${firstCommand.id}`).click();
  await app.getByTestId(`detail-${firstCommand.id}`).waitFor();
  await capture("01-expanded-command");
  assert.ok((await app.call("getPaintedText", {})).text.join(" ").includes("Workspace ready"));
  await app.getByTestId(`tool-${firstCommand.id}`).click();
  await app.getByTestId(`activity-toggle-${firstActivity.id}`).click();
  checks.push("Native activity group and command disclosures expand and collapse with readable output");
  checks.push("Real Pi write, edit and bash execute automatically; shell deletion and read/write symlink escapes are blocked by macOS; sentinel stays intact");
  await restart("history");
  const history = await snapshot();
  assert.ok(history.messages.some((message) => message.role === "tool" && message.toolName === "bash" && message.text.includes("Workspace ready")));
  await capture("02-persisted-tool-output");
  checks.push("Tool inputs, readable outputs and error state survive restart without protocol JSON");

  model = await send("Keep this response open while I connect Executor.");
  model.text("I am still working on this task.");
  const activeRun = (await snapshot()).activity?.runId;
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-search").fill("Executor");
  await Bun.sleep(150);
  await app.getByTestId("connection-executor").click();
  await waitUntil("Executor OAuth prompt during run", async () => (await client.auth("controls")).active === "executor" && (await snapshot()).pending.some(EventPayload.isAnyOf(["AuthLink"])));
  await capture("03-executor-during-run");
  await app.getByTestId("sheet-close").click();
  await waitUntil("Only OAuth cancelled", async () => !(await client.auth("controls")).active);
  assert.equal((await snapshot()).activity?.runId, activeRun);
  assert.equal((await snapshot()).busy, true);
  model.text(" The task continued after cancelling sign-in.");
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-search").fill("Executor");
  await Bun.sleep(150);
  await app.getByTestId("connection-executor").click();
  await waitUntil("second OAuth prompt", async () => (await snapshot()).pending.some(EventPayload.isAnyOf(["AuthLink"])));
  const link = (await snapshot()).pending.find(EventPayload.isAnyOf(["AuthLink"]));
  assert.ok(link);
  const authorization = new URL(link.url);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("code", "fixture-code");
  assert.ok((await fetch(callback)).ok);
  await waitUntil("OAuth completed with active task", async () => (await client.auth("controls")).executor === "ready");
  assert.equal((await snapshot()).activity?.runId, activeRun);
  assert.equal((await snapshot()).busy, true);
  await waitUntil("native connected label", async () => (await app.getByTestId("connection-executor").textContent()).includes("Connected"));
  await capture("04-executor-connected-during-run");
  await app.getByTestId("sheet-close").click();
  await complete(model, " Executor connected while this task stayed active.");
  checks.push("Native Executor sign-in starts, cancels and completes during one unchanged Pi run; cancelling OAuth does not stop generation");
  model = await send("Confirm the next task starts after connecting.");
  next = pending.promise;
  model.tool("codemode", { code: "text(await tools.mcp__executor__fixture_echo({}));" });
  model = await generation(next);
  assert.ok(model.input.includes("EXECUTOR_TOOL_OK"), "Newly connected Executor tool must work through code mode");
  assert.equal(await app.getByTestId("approve-tool").count(), 0);
  await complete(model, "Ready. The connected tool returned its result for this task.");
  checks.push("The next task refreshes Executor outside the active generation and calls the connected tool through code mode without approval");
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-notion").waitFor();
  await capture("06-marketplace");
  await app.getByTestId("marketplace-search").fill("granola");
  assert.equal(await app.getByTestId("marketplace-granola").count(), 1);
  assert.equal(await app.getByTestId("marketplace-notion").count(), 0);
  await app.getByTestId("marketplace-search").fill("");
  await app.getByTestId("marketplace-github").click();
  assert.equal(await app.getByTestId("github-create-token").count(), 0);
  assert.equal(await app.getByTestId("auth-paste-token").count(), 0);
  await capture("07-github-browser-sign-in");
  await app.getByTestId("marketplace-back").click();
  await app.getByTestId("marketplace-custom").click();
  await app.getByTestId("connector-name").fill("Verification app");
  await app.getByTestId("connector-url").fill(`${oauth.url.origin}/mcp/custom`);
  await app.getByTestId("connector-add").click();
  await waitUntil("custom connector saved", async () => (await client.connectors("controls")).some((item) => item.name === "Verification app"));
  const custom = (await client.connectors("controls")).find((item) => item.name === "Verification app")!;
  await app.getByTestId(`connect-${custom.id}`).waitFor();
  await capture("08-custom-connector");
  await app.getByTestId("sheet-close").click();
  model = await send("Keep working while I connect an official-protocol MCP server.");
  const marketplaceRun = (await snapshot()).activity?.runId;
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-search").fill("Verification app");
  await app.getByTestId(`marketplace-${custom.id}`).waitFor();
  await Bun.sleep(150);
  await app.getByTestId(`marketplace-${custom.id}`).click();
  await app.getByTestId(`connect-${custom.id}`).click();
  await waitUntil("custom OAuth during active run", async () => (await snapshot()).pending.some((event) => EventPayload.isAnyOf(["AuthLink"])(event) && event.provider === custom.id));
  const customLink = (await snapshot()).pending.find((event) => EventPayload.isAnyOf(["AuthLink"])(event) && event.provider === custom.id);
  assert.ok(customLink && EventPayload.isAnyOf(["AuthLink"])(customLink));
  const customAuthorization = new URL(customLink.url);
  const customCallback = new URL(customAuthorization.searchParams.get("redirect_uri")!);
  customCallback.searchParams.set("state", customAuthorization.searchParams.get("state")!);
  customCallback.searchParams.set("code", "fixture-code");
  assert.ok((await fetch(customCallback)).ok);
  await waitUntil("verified custom connection", async () => (await client.connectors("controls")).some((item) => item.id === custom.id && item.enabled && item.status === "connected"));
  assert.equal((await snapshot()).activity?.runId, marketplaceRun);
  await capture("09-connected-during-run");
  await app.getByTestId("sheet-close").click();
  next = pending.promise;
  model.tool("codemode", { code: `text(await tools.mcp__${custom.id}__fixture_echo({}));` });
  model = await generation(next);
  assert.ok(model.input.includes("EXECUTOR_TOOL_OK"), "New MCP tools must be usable in the same run without restarting");
  await complete(model, "The new app connected and returned a result during this task.");
  assert.ok(!(await client.connectors("other")).some((item) => item.id === custom.id));
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-search").fill("Verification app");
  await app.getByTestId(`marketplace-${custom.id}`).waitFor();
  await Bun.sleep(150);
  await app.getByTestId(`marketplace-${custom.id}`).click();
  await app.getByTestId(`toggle-${custom.id}`).click();
  await waitUntil("paused for this agent", async () => !(await client.connectors("controls")).find((item) => item.id === custom.id)!.enabled);
  await waitUntil("native pause finished", async () => (await app.getByTestId(`toggle-${custom.id}`).textContent()).includes("Enable"));
  await Bun.sleep(100);
  await app.getByTestId("sheet-close").click();
  model = await send("Verify the paused app is unavailable.");
  next = pending.promise;
  model.tool("codemode", { code: `text(await tools.mcp__${custom.id}__fixture_echo({}));` });
  model = await generation(next);
  assert.ok(!model.input.slice(model.input.lastIndexOf('Verify the paused app')).includes('EXECUTOR_TOOL_OK'));
  await complete(model, "The app is paused and cannot be called.");
  await client.changeConnector("controls", { id: custom.id, action: "enable" });
  await companion.close();
  companion = await createComputerHost({ dataDir, name: "Agent controls verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "unavailable/Labora Computer.app") });
  await restart("connectors");
  await waitUntil("connector survives restart and verifies again", async () => (await client.connectors("controls")).some((item) => item.id === custom.id && item.enabled && item.status === "connected"));
  await client.changeConnector("controls", { id: custom.id, action: "disconnect" });
  assert.equal((await client.connectors("controls")).find((item) => item.id === custom.id)!.status, "disconnected");
  const authState = await Bun.file(join(agentDir, "mcp-auth.json")).json();
  assert.equal(authState[`mcp__${custom.id}|${custom.url}`].tokens, undefined);
  await client.changeConnector("controls", { id: custom.id, action: "remove" });
  checks.push("Marketplace search, GitHub OAuth-only connection controls, custom OAuth during the same active Pi run, immediate code-mode call, pause enforcement, per-agent isolation, restart persistence, disconnect credential removal and custom removal");
  const { pid } = await app.call("initialize", { protocolVersion: 1, client: "labora-pi-layout" });
  const resize = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set size of window 1 to {800, 540}`]);
  assert.equal(await resize.exited, 0);
  await Bun.sleep(500);
  await app.getByTestId("sidebar-apps").click();
  await app.getByTestId("marketplace-notion").waitFor();
  await capture("10-marketplace-800");
  const marketplaceBounds = await app.getByTestId("marketplace").bounds();
  assert.ok(marketplaceBounds.x >= 0 && marketplaceBounds.x + marketplaceBounds.width <= 800);
  await app.getByTestId("marketplace-linear").click();
  await capture("11-linear-800");
  const connectBounds = await app.getByTestId("connect-linear").bounds();
  assert.ok(connectBounds.y + connectBounds.height <= 540);
  await app.getByTestId("sheet-close").click();
  await app.getByTestId("composer").fill("A long draft with enough text to wrap comfortably across several lines without overlapping the send, stop, attachment, or microphone controls. ".repeat(3));
  const row = await app.getByTestId("composer-row").bounds();
  const body = await app.getByTestId("conversation-body").bounds();
  assert.ok(body.y + body.height <= row.y + 1);
  const input = await app.getByTestId("composer").bounds();
  const sendButton = await app.getByTestId("send").bounds();
  assert.ok(input.x + input.width < sendButton.x);
  await capture("05-compact-layout");
  checks.push("800 by 540 native window keeps wrapped composer and transcript separate, with visible controls");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));

  if (driver) await driver.screenshot("failure").catch(() => undefined);
} finally {
  if (driver) await driver.close().catch((error: Error) => { failure ??= error; });
  await client.cancelAuth("controls").catch(() => undefined);

  if ((await client.messages("controls").catch(() => undefined))?.busy) await client.cancel("controls").catch(() => undefined);
  await server.stop(true);
  await companion.close();
  await oauth.stop(true);
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({ ok: !failure, checks, error: failure?.message, boundary: "Packaged native GPUix app and real source companion/Pi worker with isolated Responses and OAuth providers. No personal credentials or external integration actions." }, null, 2));

  if (!failure) await rm(workspace, { recursive: true, force: true });
}

console.log(evidenceDirectory);

if (failure) throw failure;
