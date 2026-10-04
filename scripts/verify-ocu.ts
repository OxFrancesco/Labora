import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpClient } from "@earendil-works/pi-mcp";
import { createConnectors } from "../src/backend/connectors";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";

const workspace = await mkdtemp("/private/tmp/labora-ocu-");

const evidence = resolve("evidence", `ocu-${Date.now()}`);

const profile = join(workspace, "profile");

const fixture = join(workspace, "Labora OCU Fixture.app");

const countPath = join(workspace, "count.txt");

const checks: string[] = [];

const target = "org.buddytools.LaboraOcuFixture";

await mkdir(join(fixture, "Contents/MacOS"), { recursive: true });

await mkdir(profile, { recursive: true });

await mkdir(evidence, { recursive: true });

await Bun.write(join(fixture, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${target}</string><key>CFBundleName</key><string>Labora OCU Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);

const compiler = Bun.spawn(["swiftc", "-parse-as-library", "native/ocu/VerificationFixture.swift", "-o", join(fixture, "Contents/MacOS/Fixture")], { stdout: "inherit", stderr: "inherit" });

assert.equal(await compiler.exited, 0);

const fixtureProcess = Bun.spawn([join(fixture, "Contents/MacOS/Fixture"), countPath], { stdout: "ignore", stderr: "ignore" });

process.env.LABORA_OCU_HELPER = resolve(process.env.LABORA_OCU_HELPER ?? "dist/Labora.app/Contents/Helpers/Labora Open Computer Use.app/Contents/MacOS/OpenComputerUse");

const registryPath = join(workspace, "registry");

await mkdir(registryPath);

let registry = await createConnectors({ directory: registryPath, showLink() { throw new Error("Local connector must not use browser OAuth"); }, input: async () => { throw new Error("Local connector must not request credentials"); } });

let mcp = new McpClient({ name: "Labora verification", version: "1", requestTimeoutMs: 15_000 });

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

let failure: unknown;

const host = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Computer-use verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "none") });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: host.fetch });

try {
  await registry.connect("ocu", AbortSignal.timeout(20_000));
  await mcp.connect(registry.transport("ocu"));
  const tools = await mcp.listTools();
  assert.equal(tools.length, 9);
  await Bun.sleep(500);
  const before = await mcp.callTool("get_app_state", { app: target });
  assert.ok(!before.isError, JSON.stringify(before));
  const text = before.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  await Bun.write(join(evidence, "fixture-before.txt"), text);
  const index = text.match(/(\d+) button Increment counter/)?.[1];
  assert.ok(index, text);
  const result = await mcp.callTool("click", { app: target, element_index: index });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(await Bun.file(countPath).text(), "1");
  const after = await mcp.callTool("get_app_state", { app: target });
  assert.ok(after.content.some((part) => part.type === "text" && part.text.includes("Counter: 1")));
  const screenshot = after.content.find((part) => part.type === "image");
  assert.ok(screenshot && screenshot.type === "image");
  await Bun.write(join(evidence, "native-action.png"), Buffer.from(screenshot.data, "base64"));
  checks.push("Real bundled MCP discovers nine tools, captures an isolated AppKit window, and clicks a snapshot element in the same persistent process; fixture counter confirms one action");
  await registry.turnEnded();
  await registry.change({ id: "ocu", action: "disable" });
  await assert.rejects(mcp.callTool("get_app_state", { app: target }));
  assert.equal(registry.allowed("mcp__ocu__click"), false);
  await registry.change({ id: "ocu", action: "enable" });
  await registry.close();
  registry = await createConnectors({ directory: registryPath, showLink() {}, input: async () => "" });
  assert.equal(registry.list().connectors.find((entry) => entry.id === "ocu")?.enabled, true);
  await registry.change({ id: "ocu", action: "check" });
  mcp = new McpClient({ name: "Labora verification", version: "1" });
  await mcp.connect(registry.transport("ocu"));
  await mcp.listTools();
  await registry.change({ id: "ocu", action: "disconnect" });
  await assert.rejects(mcp.listTools());
  checks.push("Pause closes active transport; enable, persisted reload, reconnect, and disconnect work without OAuth");

  const connection = await pairComputer(server.url.origin, (await host.issuePairingCode()).code);
  const client = computerClient(connection);
  await client.createBot({ id: "ocu", name: "Labo", color: "#dfb845" });
  await Bun.write(join(profile, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/ocu`, compact: true, detailsOpen: false, detailsWidth: 336, drafts: [] }));
  driver = await openDesktop({ profileDirectory: profile, evidenceDirectory: evidence, executable: process.env.LABORA_VERIFY_EXECUTABLE, foreground: true });
  await driver.app.getByTestId("sidebar-apps").click();
  await driver.app.getByTestId("marketplace-ocu").waitFor();
  await driver.screenshot("marketplace");
  await driver.app.getByTestId("marketplace-ocu").click();
  await driver.app.getByTestId("connect-ocu").click();
  await driver.app.getByTestId("toggle-ocu").waitFor({ timeoutMs: 25_000 });
  assert.equal((await client.connectors("ocu")).find((entry) => entry.id === "ocu")?.enabled, true);
  await driver.screenshot("connected");
  await driver.app.getByTestId("toggle-ocu").click();
  await Bun.sleep(1000);
  assert.equal((await client.connectors("ocu")).find((entry) => entry.id === "ocu")?.enabled, false);
  await driver.app.getByTestId("toggle-ocu").click();
  await Bun.sleep(1000);
  assert.equal((await client.connectors("ocu")).find((entry) => entry.id === "ocu")?.enabled, true);
  await driver.screenshot("enabled");
  checks.push("Packaged native marketplace connects, pauses, and enables through the real companion and agent worker");
} catch (error) {
  failure = error;
  await driver?.screenshot("failure");
} finally {
  await driver?.close();
  await mcp.close();
  await registry.close();
  await server.stop(true);
  await host.close();
  fixtureProcess.kill();
  await fixtureProcess.exited;
  await Bun.write(join(evidence, "result.json"), JSON.stringify({ passed: !failure, checks, error: failure instanceof Error ? failure.message : undefined, boundary: "Isolated native fixture, registry, agent, and profile. No unrelated apps manipulated. No live model invocation." }, null, 2));
  await rm(workspace, { recursive: true, force: true });
}

console.log(evidence);

if (failure) throw failure;
