import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { McpClient, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitHubConnector } from "./github-connector";
import { createExecutor } from "./executor";
import { Connector, CustomConnector, officialConnectors, type ConnectorChange } from "./connector-contracts";

const Saved = Schema.Array(Schema.Struct({ ...CustomConnector.fields, enabled: Schema.Boolean, configured: Schema.Boolean }));

type SavedConnector = { -readonly [Key in keyof Schema.Schema.Type<typeof Saved>[number]]: Schema.Schema.Type<typeof Saved>[number][Key] };

interface ConnectorOptions {
  directory: string;
  showLink(id: string, url: string): void;
  input(id: string, message: string, secret: boolean, signal: AbortSignal): Promise<string>;
}

export function connectorUrl(value: string) {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (url.username || url.password || url.search || url.hash)
    throw new Error("Use a server URL without credentials, query parameters, or fragments.");

  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new Error("Use HTTPS for a remote MCP server, or HTTP on localhost.");

  return url.href;
}

export async function createConnectors(options: ConnectorOptions) {
  const github = createGitHubConnector(options.directory, (url) => options.showLink("github", url));
  const path = join(options.directory, "connectors.json");
  const stored = await Bun.file(path).exists() ? Schema.decodeUnknownSync(Schema.fromJsonString(Saved))(await Bun.file(path).text()) : [];
  const entries = new Map<string, SavedConnector>();
  const states = new Map<string, Pick<Connector, "status" | "message">>();
  const credentials = new Map<string, Awaited<ReturnType<typeof createExecutor>>>();
  const pendingChecks = new Map<string, Promise<void>>();
  const transports = new Map<string, Set<McpTransport>>();
  let extension: ExtensionAPI | undefined;
  let saveTail = Promise.resolve();

  for (const item of officialConnectors) entries.set(item.id, { ...item, enabled: false, configured: false });

  for (const item of stored) {
    const official = officialConnectors.find((entry) => entry.id === item.id);
    entries.set(item.id, { ...item, ...official, url: connectorUrl(official?.url ?? item.url) });
  }

  const get = (id: string) => {
    const entry = entries.get(id);

    if (!entry) throw new Error("This connector is not in your marketplace.");

    return entry;
  };

  const save = () => {
    const value = JSON.stringify([...entries.values()]);

    const operation = saveTail.then(async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, path);
    });

    saveTail = operation.catch(() => undefined);

    return operation;
  };

  const credential = async (id: string) => {
    const existing = credentials.get(id);

    if (existing) return existing;
    const entry = get(id);

    const created = await createExecutor({
      name: id, label: entry.name, path: join(options.directory, "mcp-auth.json"), url: entry.url,
      showLink: (url) => options.showLink(id, url),
      manualInput: (signal) => options.input(id, "If the browser cannot reach this computer, paste its full callback URL.", false, signal),
    });

    credentials.set(id, created);

    return created;
  };

  for (const id of entries.keys()) await credential(id);

  const transport = (id: string, probe = false): McpTransport => {
    const entry = get(id);
    const auth = credentials.get(id);

    if (!auth) throw new Error("The connector has not been initialized.");
    const inner = id === "github" ? github.transport() : entry.auth === "none" ? new StreamableHttpTransport({ url: entry.url }) : auth.transport();
    const active = transports.get(id) ?? new Set<McpTransport>();
    transports.set(id, active);
    active.add(inner);
    inner.onClose(() => active.delete(inner));

    return {
      start: () => inner.start(), close: () => inner.close(),
      onMessage: (listener) => inner.onMessage(listener), onError: (listener) => inner.onError(listener), onClose: (listener) => inner.onClose(listener),
      setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
      send: async (message) => {
        if (!probe && (!get(id).enabled || !get(id).configured)) throw new Error("This app is disabled for this agent.");
        await inner.send(message);
      },
    };
  };

  const sync = (id: string) => {
    const entry = get(id);

    if (entry.enabled && entry.configured) extension?.registerMcpServer(id, { url: entry.url, exposure: "codemode" });
    else extension?.unregisterMcpServer(id);
  };

  const check = (id: string, signal = AbortSignal.timeout(15_000)) => {
    const pending = pendingChecks.get(id);

    if (pending) return pending;

    const operation = (async () => {
      states.set(id, { status: "checking", message: "" });
      const client = new McpClient({ name: "Labora", version: "0.1.0", requestTimeoutMs: 12_000 });
      const abort = () => { void client.close(); };

      signal.addEventListener("abort", abort, { once: true });

      try {
        signal.throwIfAborted();
        await client.connect(transport(id, true));
        await client.listTools({ signal, timeoutMs: 12_000 });
        signal.throwIfAborted();
        states.set(id, { status: "connected", message: "" });
      } catch {
        states.set(id, { status: "error", message: "Could not reach this app. Check your access, then reconnect." });
        throw new Error("Could not verify the MCP connection. Check your access and server address, then reconnect.");
      } finally {
        signal.removeEventListener("abort", abort);
        await client.close();
      }
    })();

    pendingChecks.set(id, operation);
    void operation.finally(() => pendingChecks.delete(id)).catch(() => undefined);

    return operation;
  };

  return {
    bind(pi: ExtensionAPI) { extension = pi;

 for (const id of entries.keys()) sync(id); },
    close: () => github.close(),
    has: (id: string) => entries.has(id),
    allowed: (name: string) => [...entries.values()].some((item) => item.enabled && item.configured && name.startsWith(`mcp__${item.id}__`)),
    transport: (id: string) => transport(id),
    list() {
      const connectors: Connector[] = [];

      for (const entry of entries.values()) {
        const official = officialConnectors.find((item) => item.id === entry.id);

        if (entry.id === "github" && entry.configured && !github.ready() && states.get(entry.id)?.status === "connected")
          states.set(entry.id, { status: "error", message: "Sign in to GitHub again to restore this session." });

        if (entry.configured && !states.has(entry.id)) void check(entry.id).catch(() => undefined);
        connectors.push({ ...entry, description: official?.description ?? new URL(entry.url).host, docs: official?.docs ?? "", ...(states.get(entry.id) ?? { status: "disconnected", message: "" }) });
      }

      return { connectors };
    },
    async add(input: CustomConnector) {
      if (!input.id.startsWith("custom_") || entries.has(input.id)) throw new Error("Choose a new custom connector.");

      if (entries.size >= 36) throw new Error("Remove an unused custom connector before adding another.");
      const url = connectorUrl(input.url);

      if ([...entries.values()].some((entry) => entry.url === url)) throw new Error("This server is already in your marketplace.");
      entries.set(input.id, { ...input, url, name: input.name.trim(), enabled: false, configured: false });
      await credential(input.id);
      await save();
    },
    async connect(id: string, signal: AbortSignal) {
      const entry = get(id);
      await pendingChecks.get(id)?.catch(() => undefined);
      const auth = await credential(id);

      if (id === "github") await github.login(signal);
      else if (entry.auth === "oauth") await auth.login(signal);
      await check(id, signal);
      entry.configured = true;
      entry.enabled = true;
      await save();
      sync(id);
    },
    async change(change: ConnectorChange) {
      const entry = get(change.id);
      await pendingChecks.get(entry.id)?.catch(() => undefined);

      if (change.action === "remove" && !entry.id.startsWith("custom_")) throw new Error("Official connectors cannot be removed.");

      if (change.action === "check") return check(entry.id);

      if (change.action === "enable") {
        if (!entry.configured) throw new Error("Connect this app first.");
        await check(entry.id);
        entry.enabled = true;
      } else {
        entry.enabled = false;

        if (change.action === "disconnect" || change.action === "remove") {
          if (entry.id === "github") await github.close();
          await (await credential(entry.id)).clear();
          entry.configured = false;
          states.delete(entry.id);
        }
      }

      sync(entry.id);

      if (!entry.enabled) await Promise.all([...transports.get(entry.id) ?? []].map((item) => item.close()));

      if (change.action === "remove") {
        if (!entry.id.startsWith("custom_")) throw new Error("Official connectors cannot be removed.");
        entries.delete(entry.id);
        credentials.delete(entry.id);
      }

      await save();
    },
  };
}
