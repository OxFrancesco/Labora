import { Schema } from "effect";
import { AuthStatus } from "../src/backend/contracts";
import type { Action } from "../src/computer/contracts";

const connection = Schema.decodeUnknownSync(Schema.Struct({ base: Schema.String, token: Schema.String, computerId: Schema.String, desktopId: Schema.String }))(await Bun.file(".labora/cloud-verification.json").json());

if (connection.desktopId !== "verification-20261002") throw new Error("Diagnostic is restricted to the task-owned verification computer");

const headers = { Authorization: `Bearer ${connection.token}`, "X-Computer-Id": connection.computerId, "Content-Type": "application/json" };

const api = (path: string, init?: RequestInit) => fetch(`${connection.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(90_000) });

const bot = "/v1/bots/cloud-verification";

const auth = Schema.decodeUnknownSync(AuthStatus)(await (await api(`${bot}/auth`)).json());

if (auth.executor !== "ready" || auth.active !== null || auth.openai !== "signed-out") throw new Error("Executor must be ready, OAuth idle and OpenAI signed out before the diagnostic");

const program = `
import { createExecutor } from "/opt/labora/src/backend/executor.ts";
import { checkExecutor } from "/opt/labora/src/check.ts";
const { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("/opt/labora/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const workspace = "/home/bun/.labora/computer/bots/cloud-verification/workspace";
const agentDir = "/home/bun/.labora/computer/bots/cloud-verification/agent";
const url = "https://executor.sh/labora/mcp";
const executor = await createExecutor({ path: agentDir + "/mcp-auth.json", url, showLink() { throw new Error("Diagnostic cannot start OAuth"); }, async manualInput() { throw new Error("Diagnostic cannot accept OAuth input"); } });
const settingsManager = SettingsManager.inMemory();
settingsManager.setCacheWarmingMode("off");
const modelRuntime = await ModelRuntime.create({ authPath: "/tmp/labora-diagnostic-empty-auth.json", modelsPath: "/tmp/labora-diagnostic-empty-models.json" });
const model = modelRuntime.getModel("openai", "gpt-5.5");
const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "This diagnostic executes one fixed read-only integration check without model inference.", extensionFactories: [createMcpExtension({ loadConfig: () => ({ servers: [{ name: "executor", config: { url, exposure: "direct" }, source: "Labora diagnostic", scope: "extension" }], errors: [] }), createTransport: () => executor.transport() })] });
await loader.reload();
const { session } = await createAgentSession({ cwd: workspace, agentDir, settingsManager, resourceLoader: loader, modelRuntime, model, sessionManager: SessionManager.inMemory(workspace) });
try { await session.bindExtensions({}); const deadline = Date.now() + 30000; while (!session.getCallableToolNames().includes("mcp__executor__execute")) { if (Date.now() > deadline) throw new Error("Executor tools did not load"); await Bun.sleep(100); } await checkExecutor(session); } finally { try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); } }
`;

const encoded = Buffer.from(program).toString("base64");

const workspace = "/home/bun/.labora/computer/bots/cloud-verification/workspace";

const command = `rm -f ${workspace}/cloud-executor-check.exit; printf '%s' '${encoded}' | base64 -d > /tmp/labora-executor-diagnostic.ts; bun /tmp/labora-executor-diagnostic.ts > ${workspace}/cloud-executor-check.json 2> ${workspace}/cloud-executor-check.err; printf '%s' "$?" > ${workspace}/cloud-executor-check.exit; printf '\\nExecutor diagnostic finished\\n'`;

const actions = async (input: readonly Action[]) => {
  const capture = await api("/v1/displays/x11/frame");
  await capture.arrayBuffer();
  const frameId = capture.headers.get("X-Frame-Id");

  if (!capture.ok || !frameId) throw new Error("Cloud frame capture failed");
  const response = await api("/v1/actions", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), frameId, displayId: "x11", actor: "user", actions: input }) });

  if (!response.ok) throw new Error(`Cloud diagnostic input failed with ${response.status}`);
};

await actions([{ type: "key", key: "Ctrl+c" }, { type: "key", key: "Ctrl+Alt+t" }]);

await Bun.sleep(1000);

await actions([{ type: "type", text: command }, { type: "key", key: "Enter" }]);

const Result = Schema.Struct({ path: Schema.String, resultCount: Schema.Number.check(Schema.isGreaterThan(0)), results: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })) });

const deadline = Date.now() + 90_000;

while (Date.now() < deadline) {
  const exited = await api(`${bot}/files/content?path=cloud-executor-check.exit`);
  const exitCode = exited.ok ? (await exited.text()).trim() : undefined;

  if (exitCode !== undefined && exitCode !== "0") throw new Error(`Cloud Executor diagnostic exited with ${exitCode}; inspect its private workspace stderr`);
  const response = await api(`${bot}/files/content?path=cloud-executor-check.json`);
  const text = await response.text();

  if (exitCode === "0" && response.ok && text.trim()) {
    const result = Schema.decodeUnknownSync(Schema.fromJsonString(Result))(text);
    await Bun.write("artifacts/computer-cloud-e2e/executor-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), runtime: "separate in-memory Pi1 diagnostic session in the cloud container", noModelInference: true, result }, null, 2));
    const screenshot = await api("/v1/displays/x11/frame");
    await Bun.write("artifacts/computer-cloud-e2e/cloud-executor.png", await screenshot.arrayBuffer());
    await actions([{ type: "key", key: "Alt+F4" }]);
    console.log(JSON.stringify({ executorVerified: true, resultCount: result.resultCount, path: result.path }));
    process.exit(0);
  }

  await Bun.sleep(1000);
}

throw new Error("Cloud Executor diagnostic produced no valid result within90seconds; inspect its private workspace stderr");
