import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";
import { computerClient, pairComputer } from "../src/desktop/client";
import { emptyPreferences } from "../src/desktop/store";
import { openDesktop } from "./desktop-driver";

const workspace = await mkdtemp("/private/tmp/labora-signin-");

const profileDirectory = join(workspace, "desktop");

const evidenceDirectory = resolve("evidence", `signin-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

await mkdir(profileDirectory, { recursive: true });

const companion = await createComputerHost({ dataDir: join(workspace, "computer"), name: "Verification Mac", agentFactory: createAgentHttpHandler });

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: companion.fetch });

const pairing = await companion.issuePairingCode();

const connection = await pairComputer(server.url.origin, pairing.code);

const client = computerClient(connection);

const bot = await client.createBot({ id: "signin", name: "Sign-in verification", color: "#f42846" });

assert.equal((await client.auth(bot.id)).openai, "signed-out");

const attachment = join(workspace, "Notes.txt");

await Bun.write(attachment, "Keep this attachment with the draft.");

const draft = { key: `${connection.id}/${bot.id}`, text: "Hi!", paths: [attachment] };

await Bun.write(join(profileDirectory, "desktop.json"), JSON.stringify({ ...emptyPreferences, connections: [connection], selected: draft.key, drafts: [draft] }));

const driver = await openDesktop({ profileDirectory, evidenceDirectory, foreground: true });

const { app } = driver;

const checks: string[] = [];

let failure: Error | undefined;

try {
  await app.getByTestId("attachment-0").waitFor({ timeoutMs: 20_000 });
  await app.getByTestId("send").click();
  await app.getByTestId("connection-openai").waitFor();
  await driver.screenshot("sign-in-prompt");
  const text = (await app.call("getPaintedText", {})).text.join("\n");
  assert(text.includes("Sign in with ChatGPT") && text.includes("Continue with ChatGPT"));
  assert(!text.includes("Sign in with your ChatGPT subscription before sending"));
  checks.push("Send opens an actionable ChatGPT sign-in dialog against a real signed-out Pi worker");
  await app.getByTestId("sheet-close").click();
  await driver.screenshot("draft-preserved");
  assert((await app.call("getPaintedText", {})).text.includes(draft.text));
  assert((await app.getByTestId("attachment-0").textContent()).includes("Notes.txt"));
  checks.push("Cancel preserves the message and attachment");
  await app.getByTestId("composer").press("enter");
  await app.getByTestId("connection-openai").waitFor();
  checks.push("Enter opens the same prompt after cancellation");
  const { pid } = await app.call("initialize", { protocolVersion: 1, client: "labora-signin" });
  const resize = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set size of window 1 to {800, 540}`], { stdout: "ignore", stderr: "pipe" });
  const resizeError = await new Response(resize.stderr).text();
  assert.equal(await resize.exited, 0, resizeError);
  await Bun.sleep(700);
  const button = await app.getByTestId("connection-openai").bounds();
  await Bun.write(join(evidenceDirectory, "button-geometry.json"), JSON.stringify(button));
  assert(button.width <= 500 && button.height <= 100, JSON.stringify(button));
  await driver.screenshot("sign-in-small-window");
  checks.push("Sign-in control fits inside the minimum 800 by 540 window");
  await app.getByTestId("sheet-close").click();
  const messages = await client.messages(bot.id);
  assert.equal(messages.messages.length, 0);
  assert.equal(messages.busy, false);
  checks.push("No message or inference was submitted while signed out");
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  await driver.screenshot("failure").catch(() => undefined);
} finally {
  await driver.close();
  await server.stop(true);
  await companion.close();
  await Bun.write(join(evidenceDirectory, "verification.json"), JSON.stringify({ passed: !failure, checks, error: failure?.message, limits: ["OAuth completion requires user sign-in"] }, null, 2));
  await rm(workspace, { recursive: true, force: true });
}

console.log(evidenceDirectory);

if (failure) throw failure;
