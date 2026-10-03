import assert from "node:assert/strict";
import { launch } from "@gpuix/react/automation";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { emptyPreferences } from "../src/desktop/store";

const workspace = await mkdtemp("/private/tmp/labora-perf-");

const profileDirectory = join(workspace, "desktop");

const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "baseline";

const evidenceDirectory = resolve("evidence", `performance-${label}`);

await mkdir(profileDirectory, { recursive: true });

await mkdir(evidenceDirectory, { recursive: true });

const companion = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Performance Mac", agentFactory: createAgentHttpHandler });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: companion.fetch });

const pairing = await companion.issuePairingCode();

const connection = await pairComputer(server.url.origin, pairing.code);

const client = computerClient(connection);

await client.createBot({ id: "first", name: "First bot", color: "#f42846" });

await client.createBot({ id: "second", name: "Second bot", color: "#6ba87b" });

await Bun.write(join(profileDirectory, "desktop.json"), JSON.stringify({ ...emptyPreferences, connections: [connection], selected: `${connection.id}/first` }));

const started = performance.now();

const source = process.argv.includes("--source");

const app = await launch({ command: source ? process.execPath : resolve("dist/Labora.app/Contents/MacOS/Labora"), args: source ? [resolve("src/desktop/main.tsx")] : [], env: { ...process.env, LABORA_DESKTOP_DATA_DIR: profileDirectory, GPUIX_BACKGROUND: "0" } });

const samples: Record<string, number[]> = {};

const initialized = await app.call("initialize", { protocolVersion: 1, client: "labora-perf" });

await Bun.write(join(evidenceDirectory, "pid"), String(initialized.pid));

let error: unknown;

async function painted(value: string) {
  const deadline = performance.now() + 3000;

  while (performance.now() < deadline) {
    if ((await app.call("getPaintedText", {})).text.join("\n").includes(value)) return;
    await Bun.sleep(1);
  }

  throw Error(`Text did not paint: ${value}`);
}

async function measure(name: string, operation: () => Promise<void>) {
  const start = performance.now();
  await operation();
  (samples[name] ??= []).push(performance.now() - start);
}

async function measuredClick(id: string) {
  let point = { x: 0, y: 0 };
  await measure("lookup", async () => { const b = await app.getByTestId(id).bounds(); point = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await measure("dispatch", async () => { await app.call("click", point); });
  await measure("paintQuery", async () => { await app.call("getPaintedText", {}); });
}

try {
  await app.getByTestId("composer").waitFor({ timeoutMs: 20000 });
  await painted("First bot");
  samples.startup = [performance.now() - started];
  await Bun.sleep(1200);

  if (!process.argv.includes("--no-capture")) await app.screenshot({ path: join(evidenceDirectory, "before.png") });
  const node = await app.getByTestId("composer").waitFor();
  await app.call("focus", { elementId: node.id });
  let text = "";

  for (const char of "Typing should keep up with my fingers.") {
    text += char;
    await measure("typing", async () => {
      await app.call("keystrokes", { keys: char === " " ? "space" : char, elementId: node.id });
      await painted(text);
    });
  }

  if (!process.argv.includes("--no-capture")) await app.screenshot({ path: join(evidenceDirectory, "typed.png") });

  for (let index = 0; index < 8; index++) {
    await measure("sidebar", async () => { await measuredClick("sidebar-toggle"); });
    await measure("details", async () => { await measuredClick("details-toggle"); });
  }

  for (let index = 0; index < 6; index++) {
    const id = index % 2 === 0 ? "second" : "first";
    await measure("switchBot", async () => { await app.getByTestId(`bot-${id}`).click(); await app.getByTestId("conversation-title").waitFor(); await painted(id === "first" ? "First bot" : "Second bot"); });
  }

  await app.screenshot({ path: join(evidenceDirectory, "after.png") });

  if (process.argv.includes("--stress")) {
    for (let index = 0; index < 20; index++) {
      await app.screenshot({ path: join(evidenceDirectory, "capture-stress.png") });
      await measure("afterCapture", async () => { await measuredClick("sidebar-toggle"); });
    }

    await assert.rejects(app.screenshot({ path: join(workspace, "missing/failure.png") }));
    await measure("afterFailedCapture", async () => { await measuredClick("sidebar-toggle"); });
    await app.getByTestId("composer").fill("");
    text = "";
    const composer = await app.getByTestId("composer").waitFor();

    for (const char of "Still responsive after repeated screenshots.") {
      text += char;
      await measure("typingAfterCapture", async () => {
        await app.call("keystrokes", { keys: char === " " ? "space" : char, elementId: composer.id });
        await painted(text);
      });
    }

    await app.screenshot({ path: join(evidenceDirectory, "stress-complete.png") });
  }
} catch (reason) { error = reason; await app.screenshot({ path: join(evidenceDirectory, "failure.png") }); }
finally {
  await app.close();
  await server.stop(true);
  await companion.close();
  await rm(workspace, { recursive: true, force: true });
}

const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
  const sorted = [...values].sort((a, b) => a - b);

  return [name, { count: values.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }];
}));

await Bun.write(join(evidenceDirectory, "timings.json"), JSON.stringify({ label, summary, samples, error: error instanceof Error ? error.message : undefined }, null, 2));

console.log(JSON.stringify(summary, null, 2));

if (error) throw error;

if (!process.argv.includes("--baseline")) for (const [name, timing] of Object.entries(summary)) {
  if (name !== "startup") assert((timing.p95 ?? Infinity) < 100, `${name} exceeds 100 ms p95`);
}
