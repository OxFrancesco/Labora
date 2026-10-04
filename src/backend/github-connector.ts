import { resolve } from "node:path";
import { Schema } from "effect";
import { McpClient, StdioTransport, isJsonRpcRequest, isJsonRpcNotification, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

const Elicitation = Schema.Struct({ url: Schema.String });

export function createGitHubConnector(directory: string, showLink: (url: string) => void) {
  let client: McpClient | undefined;
  let signingIn = false;
  let connected = false;

  const close = async () => {
    connected = false;
    const previous = client;
    client = undefined;
    await previous?.close();
  };

  return {
    close,
    ready: () => connected,
    async login(signal: AbortSignal) {
      await close();
      const executable = process.env.LABORA_GITHUB_MCP_HELPER ?? resolve(import.meta.dir, "../../artifacts/github-mcp/github-mcp-server");

      if (!await Bun.file(executable).exists()) throw new Error("The GitHub sign-in helper is missing. Reinstall Labora.");
      const next = new McpClient({ name: "Labora", version: "0.1.0", capabilities: { elicitation: { url: {} } }, requestTimeoutMs: 300_000 });
      client = next;
      signingIn = true;
      next.setRequestHandler("elicitation/create", (params) => {
        if (!signingIn) throw new Error("Reconnect GitHub from the marketplace.");
        const { url } = Schema.decodeUnknownSync(Elicitation)(params);
        const parsed = new URL(url);

        if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("GitHub returned an unexpected sign-in address.");
        showLink(url);

        return { action: "accept" };
      });
      const abort = () => { void close(); };

      signal.addEventListener("abort", abort, { once: true });

      try {
        signal.throwIfAborted();
        await next.connect(new StdioTransport({ command: executable, args: ["stdio"], inheritEnv: false, env: { HOME: directory, PATH: "/nonexistent", TMPDIR: process.env.TMPDIR ?? "/private/tmp" }, stderr: "pipe" }));
        const identity = await next.callTool("get_me", {}, { signal, timeoutMs: 300_000 });

        if (identity.isError) throw new Error("GitHub sign-in did not complete. Try connecting again.");
        await next.listTools({ signal });
        signal.throwIfAborted();
        connected = true;
        next.onClose(() => { connected = false; });
      } catch {
        await close();
        throw new Error(signal.aborted ? "GitHub sign-in cancelled." : "GitHub sign-in did not complete. Try connecting again.");
      } finally {
        signingIn = false;
        signal.removeEventListener("abort", abort);
      }
    },
    transport(): McpTransport {
      const upstream = client;

      if (!upstream || !connected) throw new Error("Sign in to GitHub from the marketplace.");
      const pair = createInMemoryTransportPair();
      const calls = new Map<string | number, AbortController>();
      pair.server.onMessage((message) => {
        if (isJsonRpcNotification(message) && message.method === "notifications/cancelled") {
          const parsed = Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.Union([Schema.String, Schema.Number]) }))(message.params);
          calls.get(parsed.requestId)?.abort();

          return;
        }

        if (!isJsonRpcRequest(message)) return;
        const controller = new AbortController();
        calls.set(message.id, controller);

        const respond = async () => {
          try {
            const current = client;

            if (!connected || !current) throw new Error("GitHub is disconnected.");

            const result = message.method === "initialize"
              ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: current.serverInfo ?? { name: "github", version: "1.14.0" } }
              : await current.request(message.method, message.params === undefined ? undefined : Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(message.params), { signal: controller.signal });

            await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
          } catch {
            await pair.server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "GitHub could not complete this request. Check your access or reconnect." } }).catch(() => undefined);
          } finally { calls.delete(message.id); }
        };

        void respond();
      });
      pair.server.onClose(() => { for (const controller of calls.values()) controller.abort(); });

      return {
        start: async () => { await pair.server.start(); await pair.client.start(); },
        send: (message) => pair.client.send(message), close: () => pair.client.close(),
        onMessage: (listener) => pair.client.onMessage(listener), onError: (listener) => pair.client.onError(listener), onClose: (listener) => pair.client.onClose(listener),
      };
    },
  };
}
