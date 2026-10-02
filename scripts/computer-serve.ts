import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { Config, Effect, Match, Option, Redacted } from "effect";
import { createComputerHost } from "../src/computer/host";
import { createAgentHttpHandler } from "../src/backend/http";
import { readComputerSetup, startComputerSetup } from "../src/computer/setup";

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--computer");

const accepted = new Set(["--setup", "--pair-code", "--no-open", "--help"]);

if (arguments_.some((argument) => !accepted.has(argument)) || new Set(arguments_).size !== arguments_.length)
  throw new Error("Use --setup for browser setup, or --pair-code for advanced manual pairing. See --help.");

if (arguments_.includes("--help")) {
  console.log("Usage: bun scripts/computer-serve.ts [--setup [--no-open]] [--pair-code]\n\n--setup      Set up Tailscale access in your browser.\n--no-open    Prepare browser setup without opening a browser.\n--pair-code  Print a short-lived code for advanced manual pairing.\n\nThe companion listens on loopback by default. Tailscale changes require an explicit browser action.");
  process.exit(0);
}

const wantsSetup = arguments_.includes("--setup");

const noOpen = arguments_.includes("--no-open");

if (noOpen && !wantsSetup) throw new Error("--no-open requires --setup.");

async function openSetup(url: string) {
  const command = Match.value(process.platform).pipe(
    Match.when("darwin", () => ["open", url]),
    Match.when("win32", () => ["rundll32", "url.dll,FileProtocolHandler", url]),
    Match.orElse(() => ["xdg-open", url]),
  );

  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

  if (await child.exited !== 0) throw new Error("The browser could not open. Use Set up this computer in Labora to reopen setup.");
}

const config = await Effect.runPromise(Effect.gen(function* () {
  return {
    dataDir: yield* Config.String("LABORA_COMPUTER_DATA").pipe(Config.withDefault(join(homedir(), ".labora", "computer"))),
    name: yield* Config.String("LABORA_COMPUTER_NAME").pipe(Config.withDefault(hostname())),
    host: yield* Config.String("LABORA_COMPUTER_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: yield* Config.Number("LABORA_COMPUTER_PORT").pipe(Config.withDefault(7778)),
    allowNetwork: yield* Config.Boolean("LABORA_ALLOW_NETWORK").pipe(Config.withDefault(false)),
    macApp: yield* Config.option(Config.String("LABORA_COMPUTER_APP")),
    display: yield* Config.option(Config.String("LABORA_DISPLAY")),
    managementToken: yield* Config.option(Config.Redacted("LABORA_MANAGEMENT_TOKEN")),
    browserBroker: yield* Config.option(Config.String("LABORA_BROWSER_BROKER")),
    agentHost: yield* Config.Boolean("LABORA_AGENT_HOST").pipe(Config.withDefault(true)),
  };
}));

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("LABORA_COMPUTER_PORT must be a valid port");

if (config.host !== "127.0.0.1" && config.host !== "::1" && !config.allowNetwork) throw new Error("A network listener requires explicit LABORA_ALLOW_NETWORK=true; use loopback and Tailscale Serve for personal machines");

const local = config.host === "127.0.0.1" || config.host === "::1";

const dataDir = resolve(config.dataDir);

if (wantsSetup && (!local || Option.isSome(config.managementToken))) throw new Error("Browser setup requires a personal companion listening on loopback.");

if (arguments_.includes("--pair-code") && Option.isSome(config.managementToken)) throw new Error("Manual pairing is not available on a managed companion.");

await mkdir(dataDir, { recursive: true, mode: 0o700 });

await chmod(dataDir, 0o700);

let release: () => Promise<void>;

try {
  release = await lockfile.lock(dataDir, { lockfilePath: join(dataDir, ".computer-instance.lock"), stale: 10_000, update: 2_000, retries: 0 });
} catch (cause) {
  const existing = wantsSetup ? await readComputerSetup(dataDir) : undefined;

  if (existing) {
    if (!noOpen) await openSetup(existing.url);
    console.log("Labora computer setup is ready.");
    process.exit(0);
  }

  throw new Error("A companion already owns this computer's data. Close it before starting another, or reopen setup in Labora.", { cause });
}

let host: Awaited<ReturnType<typeof createComputerHost>>;

try {
  host = await createComputerHost({ dataDir, name: config.name, macAppPath: Option.getOrUndefined(config.macApp), display: Option.getOrUndefined(config.display), browserBroker: Option.getOrUndefined(config.browserBroker), managementToken: Option.isSome(config.managementToken) ? Redacted.value(config.managementToken.value) : undefined, agentFactory: config.agentHost ? createAgentHttpHandler : undefined });
} catch (cause) { await release(); throw cause; }

let server: ReturnType<typeof Bun.serve>;

let setup: Awaited<ReturnType<typeof startComputerSetup>> | undefined;

try {
  server = Bun.serve({ hostname: config.host, port: config.port, idleTimeout: 0, maxRequestBodySize: 25_000_000, async fetch(request, listener) {
    const peer = listener.requestIP(request)?.address;
    const handled = await setup?.fetch(request, peer);

    return handled ?? host.fetchFrom(request, peer);
  } });
} catch (error) { await host.close(); await release(); throw error; }

try {
  if (local && Option.isNone(config.managementToken)) setup = await startComputerSetup({ host, dataDir, port: config.port, localOrigin: server.url.origin });

  if (wantsSetup && setup && !noOpen) await openSetup(setup.url);
} catch (cause) { await server.stop(true); await setup?.close(); await host.close(); await release(); throw cause; }

console.log(`Labora computer ${host.id} listening on ${server.url}`);

if (arguments_.includes("--pair-code") && Option.isNone(config.managementToken)) {
  const pairing = await host.issuePairingCode();
  console.log(`Pairing code: ${pairing.code}. Expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}. Five attempts.`);
  console.log("This code grants computer and agent access. Enter it only in your Labora client.");
}

let closing = false;

const close = async () => {
  if (closing) return;
  closing = true;
  await server.stop(true);
  await setup?.close();
  await host.close();
  await release();
  process.exit(0);
};

process.on("SIGINT", close);

process.on("SIGTERM", close);
