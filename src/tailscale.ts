import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { request as requestHttp } from "node:http";
import { Effect, Result, Schema } from "effect";

export const TailscaleNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  dnsName: Schema.String,
  online: Schema.Boolean,
  tagged: Schema.Boolean,
  ownerLogin: Schema.optionalKey(Schema.String),
});

export interface TailscaleNode extends Schema.Schema.Type<typeof TailscaleNode> {}

export const TailscaleStatus = Schema.Struct({
  installed: Schema.Boolean,
  running: Schema.Boolean,
  backendState: Schema.String,
  authUrl: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(TailscaleNode),
  peers: Schema.Array(TailscaleNode),
  ownerLogin: Schema.optionalKey(Schema.String),
  unavailableReason: Schema.optionalKey(Schema.String),
});

export interface TailscaleStatus extends Schema.Schema.Type<typeof TailscaleStatus> {}

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", {
  code: Schema.String,
  message: Schema.String,
  authUrl: Schema.optionalKey(Schema.String),
}) {}

const RawNode = Schema.Struct({
  ID: Schema.String,
  HostName: Schema.String,
  DNSName: Schema.String,
  Online: Schema.Boolean,
  UserID: Schema.optionalKey(Schema.Number),
  Tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

const RawStatus = Schema.Struct({
  BackendState: Schema.String,
  AuthURL: Schema.optionalKey(Schema.String),
  Self: Schema.optionalKey(Schema.NullOr(RawNode)),
  CurrentTailnet: Schema.optionalKey(Schema.NullOr(Schema.Struct({ MagicDNSSuffix: Schema.String }))),
  Peer: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, RawNode))),
  User: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ LoginName: Schema.String })))),
});

const UpOutput = Schema.Struct({
  AuthURL: Schema.optionalKey(Schema.String),
  BackendState: Schema.optionalKey(Schema.String),
  Error: Schema.optionalKey(Schema.String),
});

const JsonObject = Schema.Record(Schema.String, Schema.Json);

type JsonObject = Schema.Schema.Type<typeof JsonObject>;

const WebServer = Schema.Struct({ Handlers: Schema.Record(Schema.String, JsonObject) });

const ServeNode = Schema.Struct({
  TCP: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
  Web: Schema.optionalKey(Schema.Record(Schema.String, WebServer)),
  AllowFunnel: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});

const ServeConfig = Schema.Struct({
  ...ServeNode.fields,
  Foreground: Schema.optionalKey(Schema.Record(Schema.String, ServeNode)),
});

interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

const attempt = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: (error) => error instanceof TailscaleError
    ? error
    : new TailscaleError({ code: "unavailable", message: "Tailscale could not complete this operation." }),
});

async function run<A>(operation: Effect.Effect<A, TailscaleError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));

  if (Result.isFailure(result)) throw result.failure;

  return result.success;
}

function authUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TailscaleError({ code: "invalid_auth_url", message: "Tailscale returned an invalid sign-in link." });
  }

  if (url.protocol !== "https:" || url.hostname !== "login.tailscale.com" || url.username || url.password || url.port || [...value].some((character) => character.charCodeAt(0) <= 32))
    throw new TailscaleError({ code: "invalid_auth_url", message: "This sign-in link is not from Tailscale." });

  return url.href;
}

function executables() {
  const candidates = [
    "tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(homedir(), "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
  ];

  const found = new Set<string>();

  for (const candidate of candidates) {
    const path = Bun.which(candidate);

    if (path) found.add(path);
  }

  return [...found];
}

async function command(executable: string, args: string[], options: CommandOptions = {}) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;

  try {
    child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  } catch {
    throw new TailscaleError({ code: signal.aborted ? "cancelled" : "unavailable", message: signal.aborted ? "Tailscale setup was cancelled." : "Tailscale could not start. Open the Tailscale app and try again." });
  }

  const read = async (stream: ReadableStream<Uint8Array>, notify?: (chunk: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
      while (true) {
        const next = await reader.read();

        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        text += chunk;

        if (text.length > 2_000_000)
          throw new TailscaleError({ code: "invalid_response", message: "Tailscale returned too much data." });
        notify?.(chunk);
      }

      const tail = decoder.decode();
      text += tail;
      notify?.(tail);

      return text;
    } finally {
      reader.releaseLock();
    }
  };

  try {
    const [stdout, stderr, exitCode] = await Promise.all([read(child.stdout, options.onStdout), read(child.stderr, options.onStderr), child.exited]);

    if (signal.aborted)
      throw new TailscaleError({ code: timeout.aborted && !options.signal?.aborted ? "timeout" : "cancelled", message: timeout.aborted && !options.signal?.aborted ? "Tailscale did not finish in time. Try again." : "Tailscale setup was cancelled." });

    return { stdout, stderr, exitCode };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

function summarize(raw: Schema.Schema.Type<typeof RawStatus>): TailscaleStatus {
  const suffix = raw.CurrentTailnet?.MagicDNSSuffix.toLowerCase().replace(/\.$/, "");
  const validSuffix = suffix && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(suffix);

  const node = (value: Schema.Schema.Type<typeof RawNode>): TailscaleNode | undefined => {
    const dnsName = value.DNSName.toLowerCase().replace(/\.$/, "");

    if (!validSuffix || !dnsName.endsWith(`.${suffix}`)) return undefined;

    const label = dnsName.slice(0, -(suffix.length + 1));

    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return undefined;

    const tagged = Boolean(value.Tags?.length);

    const ownerLogin = !tagged && value.UserID !== undefined && Number.isSafeInteger(value.UserID)
      ? raw.User?.[String(value.UserID)]?.LoginName
      : undefined;

    return { id: value.ID, name: value.HostName || label, dnsName, online: value.Online, tagged, ownerLogin };
  };

  const peers: TailscaleNode[] = [];

  if (raw.BackendState === "Running") {
    for (const peer of Object.values(raw.Peer ?? {})) {
      const value = node(peer);

      if (value) peers.push(value);
    }
  }

  const self = raw.Self ? node(raw.Self) : undefined;

  return {
    installed: true, running: raw.BackendState === "Running", backendState: raw.BackendState,
    self, peers, ownerLogin: self?.ownerLogin,
    authUrl: raw.BackendState !== "Running" && raw.AuthURL ? authUrl(raw.AuthURL) : undefined,
  };
}

function jsonFrames(receive: (text: string) => void) {
  let buffer = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;

  return (chunk: string) => {
    for (const character of chunk) {
      if (!depth && character !== "{") continue;
      buffer += character;

      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;

        if (!depth) {
          receive(buffer);
          buffer = "";
        }
      }
    }
  };
}

function failedCommand(stderr: string): TailscaleError {
  if (/permission denied|access denied|must be root|not permitted|permission-denied/i.test(stderr))
    return new TailscaleError({ code: "permission_denied", message: "Tailscale has not allowed this app to change sharing settings. Open Tailscale and check access for your account." });

  if (/unknown subcommand|flag provided but not defined|not supported/i.test(stderr))
    return new TailscaleError({ code: "unsupported", message: "This Tailscale installation does not support the required sharing command. Update Tailscale and try again." });

  return new TailscaleError({ code: "setup_failed", message: "Tailscale setup did not finish. Check the Tailscale app and try again." });
}

async function readServe(executable: string, signal?: AbortSignal) {
  const result = await command(executable, ["serve", "status", "--json"], { signal });

  if (result.exitCode !== 0) throw failedCommand(result.stderr);

  return parseServe(result.stdout);
}

function parseServe(text: string) {
  const raw = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.NullOr(JsonObject)))(text);

  if (Result.isFailure(raw))
    throw new TailscaleError({ code: "invalid_response", message: "Tailscale returned an unreadable sharing configuration." });
  const config = raw.success ?? {};
  const parsed = Schema.decodeUnknownResult(ServeConfig)(config);

  if (Result.isFailure(parsed))
    throw new TailscaleError({ code: "invalid_response", message: "This Tailscale sharing configuration is not supported." });

  return { raw: config, parsed: parsed.success };
}

interface LocalTransport {
  port?: number;
  socketPath?: string;
  authorization?: string;
}

async function localTransport(executable: string, signal?: AbortSignal): Promise<LocalTransport> {
  if (process.platform === "win32")
    throw new TailscaleError({ code: "unsupported", message: "Automatic Tailscale sharing setup is currently available on macOS and Linux." });
  const result = await command(executable, ["debug", "local-creds"], { signal });

  if (result.exitCode !== 0) throw failedCommand(result.stderr);
  const tcp = /^curl -u:([a-f0-9]{16,512}) http:\/\/localhost:(\d{1,5})\/localapi\/v0\/status$/.exec(result.stdout.trim());

  if (tcp?.[1] && tcp[2]) {
    const port = Number(tcp[2]);

    if (port > 0 && port <= 65535)
      return { port, authorization: `Basic ${Buffer.from(`:${tcp[1]}`).toString("base64")}` };
  }

  const socket = /^curl --unix-socket (\/[^\r\n]+) http:\/\/local-tailscaled\.sock\/localapi\/v0\/status$/.exec(result.stdout.trim());

  if (socket?.[1]) return { socketPath: socket[1] };

  throw new TailscaleError({ code: "unsupported", message: "This Tailscale installation does not provide the local access needed to configure sharing safely." });
}

interface LocalRequest {
  method: "GET" | "POST";
  path: string;
  body?: string;
  etag?: string;
  signal?: AbortSignal;
}

function localRequest(transport: LocalTransport, options: LocalRequest): Promise<{ body: string; etag?: string }> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  return new Promise((resolve, reject) => {
    const headers: import("node:http").OutgoingHttpHeaders = { Host: "local-tailscaled.sock", "Content-Type": "application/json" };

    if (transport.authorization) headers.Authorization = transport.authorization;

    if (options.etag) headers["If-Match"] = options.etag;

    const request = requestHttp({ hostname: "127.0.0.1", port: transport.port, socketPath: transport.socketPath, method: options.method, path: `/localapi/v0/${options.path}`, headers, signal }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;

        if (size > 2_000_000) {
          request.destroy();
          reject(new TailscaleError({ code: "invalid_response", message: "Tailscale returned too much data." }));

          return;
        }

        chunks.push(chunk);
      });
      response.once("error", () => reject(new TailscaleError({ code: "unavailable", message: "The connection to Tailscale closed. Try again." })));
      response.once("end", () => {
        if (response.statusCode === 412) {
          reject(new TailscaleError({ code: "configuration_changed", message: "Tailscale sharing changed during setup. No routes were overwritten. Try again." }));

          return;
        }

        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(new TailscaleError({ code: "permission_denied", message: "Tailscale has not allowed this app to configure sharing. Check access in the Tailscale app." }));

          return;
        }

        if (response.statusCode !== 200) {
          reject(new TailscaleError({ code: "setup_failed", message: "Tailscale could not update sharing. Check the Tailscale app and try again." }));

          return;
        }

        resolve({ body: Buffer.concat(chunks).toString("utf8"), etag: response.headers.etag });
      });
    });

    request.once("error", () => reject(new TailscaleError({ code: signal.aborted ? "cancelled" : "unavailable", message: signal.aborted ? "Tailscale setup was cancelled or timed out." : "Tailscale's local service is unavailable." })));
    request.end(options.body);
  });
}

function guardServe(config: Schema.Schema.Type<typeof ServeConfig>, host: string, target: string) {
  for (const foreground of Object.values(config.Foreground ?? {})) {
    if (foreground.TCP?.["443"] || Object.keys(foreground.Web ?? {}).some((key) => key.endsWith(":443")))
      throw new TailscaleError({ code: "route_conflict", message: "Another foreground Tailscale sharing session uses HTTPS port 443. Labora has left it unchanged." });
  }

  if (config.AllowFunnel && host in config.AllowFunnel)
    throw new TailscaleError({ code: "funnel_conflict", message: "This HTTPS address has Funnel settings. Labora cannot add private computer access without changing them." });

  const tcp = config.TCP?.["443"];

  if (tcp && !isDeepStrictEqual(tcp, { HTTPS: true }))
    throw new TailscaleError({ code: "route_conflict", message: "Another Tailscale service uses port 443. Labora has left it unchanged." });

  const handlers = config.Web?.[host]?.Handlers ?? {};

  for (const [path, handler] of Object.entries(handlers)) {
    if ((path === "/labora" || path.startsWith("/labora/")) && !(path === "/labora" && isDeepStrictEqual(handler, { Proxy: target })))
      throw new TailscaleError({ code: "route_conflict", message: "The /labora address is already in use. Labora has left the existing route unchanged." });
  }

  return isDeepStrictEqual(handlers["/labora"], { Proxy: target });
}

function expectedServe(before: JsonObject, host: string, target: string): JsonObject {
  const object = (value: Schema.Schema.Type<typeof Schema.Json> | undefined) => {
    const parsed = Schema.decodeUnknownResult(JsonObject)(value ?? {});

    if (Result.isFailure(parsed))
      throw new TailscaleError({ code: "invalid_response", message: "This sharing configuration cannot be updated safely." });

    return parsed.success;
  };

  const web = object(before.Web);
  const existingHost = object(web[host]);

  return {
    ...before,
    TCP: { ...object(before.TCP), "443": { HTTPS: true } },
    Web: { ...web, [host]: { ...existingHost, Handlers: { ...object(existingHost.Handlers), "/labora": { Proxy: target } } } },
  };
}

interface TailscaleOptions {
  listenerHost?: "127.0.0.1" | "::1";
}

export function createTailscaleAdapter(options: TailscaleOptions = {}) {
  let preferred: string | undefined;
  let mutating = false;
  const targetFor = (port: number) => `http://${options.listenerHost === "::1" ? "[::1]" : "127.0.0.1"}:${port}`;

  const inspect = async (signal?: AbortSignal) => {
    const available = executables();

    const choices = preferred && available.includes(preferred)
      ? [preferred, ...available.filter((path) => path !== preferred)]
      : available;

    let stopped: { executable: string; status: TailscaleStatus } | undefined;

    for (const executable of choices) {
      let result: Awaited<ReturnType<typeof command>>;

      try { result = await command(executable, ["status", "--json"], { signal, timeoutMs: 5_000 }); } catch (cause) {
        if (signal?.aborted) throw cause;
        continue;
      }

      if (result.exitCode !== 0) continue;

      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(RawStatus))(result.stdout);

      if (Result.isFailure(decoded)) continue;

      const status = summarize(decoded.success);

      if (status.running) {
        preferred = executable;

        return { executable, status };
      }

      stopped ??= { executable, status };
    }

    if (stopped) {
      preferred = stopped.executable;

      return stopped;
    }

    return {
      executable: undefined,
      status: TailscaleStatus.make({ installed: choices.length > 0, running: false, backendState: "Unavailable", peers: [], unavailableReason: choices.length ? "Open Tailscale to start its background service." : "Install Tailscale on this computer." }),
    };
  };

  const statusEffect = Effect.fn("Tailscale.status")((signal?: AbortSignal) => attempt(async () => (await inspect(signal)).status));

  const loginEffect = Effect.fn("Tailscale.login")((onAuthUrl: (url: string) => void, signal: AbortSignal) => attempt(async () => {
    const initial = await inspect(signal);

    if (initial.status.running) return initial.status;

    if (!initial.executable)
      throw new TailscaleError({ code: initial.status.installed ? "unavailable" : "not_installed", message: initial.status.unavailableReason ?? "Open Tailscale and try again." });

    let lastUrl = "";

    const receive = jsonFrames((frame) => {
      const event = Schema.decodeUnknownResult(Schema.fromJsonString(UpOutput))(frame);

      if (Result.isFailure(event)) return;

      if (event.success.AuthURL) {
        const next = authUrl(event.success.AuthURL);

        if (next !== lastUrl) { lastUrl = next; onAuthUrl(next); }
      }
    });

    const result = await command(initial.executable, ["up", "--json"], { signal, timeoutMs: 600_000, onStdout: receive });

    if (result.exitCode !== 0) throw failedCommand(result.stderr);

    const current = (await inspect(signal)).status;

    if (!current.running)
      throw new TailscaleError({ code: current.backendState === "NeedsMachineAuth" ? "needs_approval" : "needs_login", message: current.backendState === "NeedsMachineAuth" ? "A Tailscale administrator needs to approve this computer." : "Finish signing in to Tailscale, then try again." });

    return current;
  }));

  const serveStatusEffect = Effect.fn("Tailscale.serveStatus")((port: number, signal?: AbortSignal) => attempt(async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new TailscaleError({ code: "invalid_port", message: "Labora's local computer port is invalid." });
    const current = await inspect(signal);

    if (!current.executable || !current.status.running || !current.status.self)
      throw new TailscaleError({ code: "needs_login", message: "Connect this computer to Tailscale before enabling access." });
    const self = current.status.self;
    const config = await readServe(current.executable, signal);

    return { endpoint: `https://${self.dnsName}/labora`, configured: guardServe(config.parsed, `${self.dnsName}:443`, targetFor(port)), self };
  }));

  const serveEffect = Effect.fn("Tailscale.ensureServe")((port: number, onConsentUrl?: (url: string) => void, signal?: AbortSignal) => attempt(async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new TailscaleError({ code: "invalid_port", message: "Labora's local computer port is invalid." });
    const current = await inspect(signal);

    if (!current.executable || !current.status.running || !current.status.self)
      throw new TailscaleError({ code: "needs_login", message: "Connect this computer to Tailscale before enabling access." });
    const dnsName = current.status.self.dnsName;
    const host = `${dnsName}:443`;
    const target = targetFor(port);
    const endpoint = `https://${dnsName}/labora`;
    const transport = await localTransport(current.executable, signal);
    const initial = await localRequest(transport, { method: "GET", path: "serve-config", signal });
    const before = parseServe(initial.body);

    if (guardServe(before.parsed, host, target)) return { endpoint, changed: false };

    if (!initial.etag)
      throw new TailscaleError({ code: "unsupported", message: "Update Tailscale to enable sharing without overwriting other routes." });
    const featureReply = await localRequest(transport, { method: "POST", path: "query-feature?feature=serve", signal });
    const feature = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({ Complete: Schema.optionalKey(Schema.Boolean), URL: Schema.optionalKey(Schema.String) })))(featureReply.body);

    if (Result.isFailure(feature))
      throw new TailscaleError({ code: "invalid_response", message: "Tailscale returned an unreadable HTTPS setup response." });

    if (!feature.success.Complete) {
      const consentUrl = feature.success.URL ? authUrl(feature.success.URL) : undefined;

      if (consentUrl) onConsentUrl?.(consentUrl);
      throw new TailscaleError({ code: consentUrl ? "consent_required" : "needs_approval", message: consentUrl ? "Approve HTTPS sharing in Tailscale, then try enabling access again." : "A Tailscale administrator needs to enable HTTPS sharing for this computer.", authUrl: consentUrl });
    }

    const expected = expectedServe(before.raw, host, target);
    await localRequest(transport, { method: "POST", path: "serve-config", body: JSON.stringify(expected), etag: initial.etag, signal });
    const verified = await localRequest(transport, { method: "GET", path: "serve-config", signal });
    const after = parseServe(verified.body);
    guardServe(after.parsed, host, target);

    if (!isDeepStrictEqual(expected, after.raw))
      throw new TailscaleError({ code: "configuration_changed", message: "Tailscale's sharing configuration changed during setup. Check Tailscale before trying again." });
    const final = (await inspect(signal)).status;

    if (!final.running || final.self?.id !== current.status.self.id || final.self?.dnsName !== dnsName || final.ownerLogin !== current.status.ownerLogin)
      throw new TailscaleError({ code: "configuration_changed", message: "The Tailscale account or computer changed during setup. Try again." });

    return { endpoint, changed: true };
  }));

  async function mutate<A>(operation: Effect.Effect<A, TailscaleError>) {
    if (mutating)
      throw new TailscaleError({ code: "busy", message: "Another Tailscale setup step is still running." });
    mutating = true;

    try {
      return await run(operation);
    } finally {
      mutating = false;
    }
  }

  return {
    status: (signal?: AbortSignal) => run(statusEffect(signal)),
    serveStatus: (port: number, signal?: AbortSignal) => run(serveStatusEffect(port, signal)),
    beginLogin(onAuthUrl: (url: string) => void) {
      const controller = new AbortController();

      return { done: mutate(loginEffect(onAuthUrl, controller.signal)), cancel: () => controller.abort() };
    },
    ensureServe: (port: number, onConsentUrl?: (url: string) => void, signal?: AbortSignal) => mutate(serveEffect(port, onConsentUrl, signal)),
  };
}
