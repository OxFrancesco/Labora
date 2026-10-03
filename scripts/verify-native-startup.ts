import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMacAdapter } from "../src/computer/platform-macos";

const directory = await mkdtemp("/private/tmp/labora-retry-");

const appPath = join(directory, "Labora Computer.app");

const adapter = await createMacAdapter({ dataDir: directory, macAppPath: appPath });

try {
  const unavailable = await adapter.info();
  assert(unavailable.diagnostics.some((message) => message.includes("Build or install")));
  await cp(resolve("dist/Labora Computer.app"), appPath, { recursive: true, verbatimSymlinks: true });
  const deadline = Date.now() + 45_000;
  let ready = await adapter.info();

  while (!ready.displays.length && Date.now() < deadline) {
    await Bun.sleep(250);
    ready = await adapter.info();
  }

  assert(ready.displays.length > 0, "The adapter must retry initialization once the real native helper becomes available.");
  assert(!ready.diagnostics.some((message) => /timed out|did not open|Build or install/.test(message)));
  console.log(JSON.stringify({ recovered: true, displays: ready.displays.length, permissions: ready.permissions }));
} finally {
  await adapter.close();
  await rm(directory, { recursive: true, force: true });
}
