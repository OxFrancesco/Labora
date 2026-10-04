import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import { StdioTransport, isJsonRpcNotification, type McpTransport } from "@earendil-works/pi-mcp";

const Permissions = Schema.Struct({ accessibility: Schema.Boolean, screenRecording: Schema.Boolean });

export function ocuExecutable() {
  return process.env.LABORA_OCU_HELPER ?? resolve(import.meta.dir, "../../dist/Labora Open Computer Use.app/Contents/MacOS/OpenComputerUse");
}

export function createOcuConnector(directory: string) {
  const active = new Set<McpTransport>();

  const environment = {
    HOME: process.env.HOME ?? directory,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? "/private/tmp",
    OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1",
    OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: `labora:${directory}`,
  };

  const executable = () => {
    const path = ocuExecutable();

    if (!existsSync(path)) throw new Error("Open Computer Use is missing on this agent's Mac. Update Labora on that computer.");

    return path;
  };

  return {
    async checkPermissions(signal: AbortSignal, onboarding = false) {
      signal.throwIfAborted();
      const binary = executable();
      const child = Bun.spawn([binary, "--labora-permissions"], { env: environment, stdout: "pipe", stderr: "ignore" });
      const stop = () => child.kill("SIGKILL");
      const timer = setTimeout(stop, 10_000);
      signal.addEventListener("abort", stop, { once: true });

      try {
        const output = await new Response(child.stdout).text();

        if (await child.exited !== 0) throw new Error("Could not check Open Computer Use permissions on this agent's Mac.");
        signal.throwIfAborted();
        const permissions = Schema.decodeUnknownSync(Schema.fromJsonString(Permissions))(output);

        if (!permissions.accessibility || !permissions.screenRecording) {
          if (onboarding) {
            const opened = Bun.spawn(["/usr/bin/open", resolve(dirname(binary), "../..")], { stdout: "ignore", stderr: "ignore" });
            await opened.exited;
          }

          const missing = [!permissions.accessibility ? "Accessibility" : "", !permissions.screenRecording ? "Screen Recording" : ""].filter(Boolean).join(" and ");
          throw new Error(`Allow ${missing} for Labora Open Computer Use on this agent's Mac, then connect again.`);
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
    transport(): McpTransport {
      const inner = new StdioTransport({ command: executable(), args: ["mcp"], inheritEnv: false, env: environment, stderr: "pipe" });
      active.add(inner);
      inner.onClose(() => active.delete(inner));

      return {
        start: () => inner.start(), close: () => inner.close(),
        onMessage: (listener) => inner.onMessage(listener), onError: (listener) => inner.onError(listener), onClose: (listener) => inner.onClose(listener),
        send: async (message) => {
          if (isJsonRpcNotification(message) && message.method === "notifications/cancelled") {
            await inner.close();

            return;
          }

          await inner.send(message);
        },
      };
    },
    async turnEnded() {
      await Promise.all([...active].map((transport) => transport.send({ jsonrpc: "2.0", method: "notifications/turn-ended", params: { source: "labora" } }).catch(() => undefined)));
    },
    async close() { await Promise.all([...active].map((transport) => transport.close())); },
  };
}
