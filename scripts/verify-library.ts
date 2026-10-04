import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { openDesktop } from "./desktop-driver";

const workspace = await mkdtemp("/private/tmp/labora-library-");

const profile = join(workspace, "desktop");

const source = process.argv.includes("--source");

const executable = process.env.LABORA_VERIFY_EXECUTABLE;

const evidence = resolve("evidence", `library-${source ? "source" : "packaged"}-${Date.now()}`);

const files = [
  "labora-ui-check-20261003.txt",
  "notes/research/quarterly-product-review-with-supporting-documents-and-long-filenames.md",
  "Meeting notes ottobre.txt",
];

const checks: string[] = [];

let driver: Awaited<ReturnType<typeof openDesktop>> | undefined;

let failure: unknown;

await mkdir(profile, { recursive: true });

await mkdir(evidence, { recursive: true });

process.env.LABORA_EXECUTOR_URL = "https://127.0.0.1:9/mcp";

const companion = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Library verification", agentFactory: createAgentHttpHandler, macAppPath: join(workspace, "unavailable/Labora Computer.app") });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: companion.fetch });

try {
  const pairing = await companion.issuePairingCode();
  const connection = await pairComputer(server.url.origin, pairing.code);
  const client = computerClient(connection);
  await client.createBot({ id: "library", name: "Starry", color: "#dfb845" });
  const botWorkspace = join(workspace, "computer/bots/library/workspace");

  for (const path of files) {
    await mkdir(dirname(join(botWorkspace, path)), { recursive: true });
    await Bun.write(join(botWorkspace, path), "Library verification\n");
  }

  await Bun.write(join(profile, "desktop.json"), JSON.stringify({ connections: [connection], selected: `${connection.id}/library`, compact: true, detailsOpen: true, detailsWidth: 336, drafts: [] }));
  driver = await openDesktop({ profileDirectory: profile, evidenceDirectory: evidence, source, executable, foreground: true });
  const app = driver.app;
  await app.getByTestId("tab-library").waitFor({ timeoutMs: 30_000 });
  await app.getByTestId("tab-library").click();
  await app.getByTestId(`file-${files[0]}`).waitFor();
  const { pid } = await app.call("initialize", { protocolVersion: 1, client: "labora-library" });

  for (const [width, height] of [[1224, 768], [800, 540]] as const) {
    const resize = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set size of window 1 to {${width}, ${height}}`]);
    assert.equal(await resize.exited, 0);
    await Bun.sleep(500);

    if (width === 800) {
      await app.getByTestId("details-divider").dragBy(56, 0, { steps: 8 });
      await Bun.sleep(250);
    }

    const list = await app.getByTestId("library-files").bounds();
    let previousBottom = 0;

    for (const path of [...files].sort()) {
      const row = await app.getByTestId(`file-${path}`).bounds();
      const text = await app.getByTestId(`file-text-${path}`).bounds();
      assert.ok(row.height >= 50 && row.height <= 60, `${path}: compact filename and size row, got ${row.height}`);
      assert.ok(text.width >= 150, `${path}: text must use available width, got ${text.width}`);
      assert.ok(row.width <= list.width + 1, `${path}: row fits the panel width`);
      assert.ok(text.x >= list.x && text.x + text.width <= list.x + list.width, `${path}: text stays in panel`);
      assert.ok(row.y >= previousBottom, `${path}: rows do not overlap`);
      assert.ok(row.y + row.height <= height, `${path}: visible at ${width}x${height}`);
      previousBottom = row.y + row.height;
      assert.equal(await new Response(await client.file("library", path)).text(), "Library verification\n");
    }

    await driver.screenshot(`library-${width}`);
    checks.push(`Readable, bounded rows at ${width}x${height}, including nested long paths; file contents download intact`);
  }

  await Bun.write(join(botWorkspace, "new.txt"), "Fresh file\n");
  await app.getByTestId("library-refresh").click();
  await app.getByTestId("file-new.txt").waitFor();
  checks.push("Refresh loads a newly created workspace file");
} catch (error) {
  failure = error;
  await driver?.screenshot("failure");
} finally {
  await driver?.close();
  await server.stop(true);
  await companion.close();
  await Bun.write(join(evidence, "result.json"), JSON.stringify({ passed: !failure, executable: source ? "source" : executable ?? "dist/Labora.app", checks, error: failure instanceof Error ? failure.message : undefined, limits: ["Isolated companion and test workspace", "Native save-folder picker not exercised"] }, null, 2));
  await rm(workspace, { recursive: true, force: true });
}

console.log(evidence);

if (failure) throw failure;
