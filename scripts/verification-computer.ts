import { join } from "node:path";
import { createAgentHttpHandler } from "../src/backend/http";
import { createComputerHost } from "../src/computer/host";

export async function startVerificationComputer(root: string, dataDir: string, source: boolean) {
  if (source) {
    const companion = await createComputerHost({
      dataDir, name: "Labora verification", agentFactory: createAgentHttpHandler,
      macAppPath: join(dataDir, "unavailable/Labora Computer.app"),
    });

    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: companion.fetch });
      const pairing = await companion.issuePairingCode();
      const runningServer = server;

      return { endpoint: runningServer.url.origin, code: pairing.code, async close() { await runningServer.stop(true); await companion.close(); } };
    } catch (error) {
      await server?.stop(true);
      await companion.close();

      throw error;
    }
  }

  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = reservation.port;
  await reservation.stop(true);
  const executable = join(root, "dist/Labora.app/Contents/MacOS/Labora");

  const child = Bun.spawn([executable, "--computer", "--pair-code"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LABORA_COMPUTER_HOST: "127.0.0.1", LABORA_COMPUTER_PORT: String(port),
      LABORA_COMPUTER_DATA: dataDir, LABORA_COMPUTER_NAME: "Labora verification",
      LABORA_COMPUTER_APP: join(dataDir, "unavailable/Labora Computer.app"),
      LABORA_AGENT_HOST: "true", LABORA_ALLOW_NETWORK: "false", LABORA_MANAGEMENT_TOKEN: undefined,
    },
  });

  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => child.kill(), 30_000);
  let output = "";
  let code: string | undefined;

  try {
    while (!code) {
      const next = await reader.read();

      if (next.done) throw new Error("The packaged companion did not start.");
      output += decoder.decode(next.value, { stream: true });
      code = /Pairing code: (\d{8})\./.exec(output)?.[1];
    }
  } catch (error) {
    child.kill("SIGTERM");
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 5_000);

    try { await child.exited; await errors; }
    finally { clearTimeout(shutdown); reader.releaseLock(); }

    throw error;
  } finally { clearTimeout(timeout); }

  const drain = (async () => {
    while (!(await reader.read()).done) {}

    reader.releaseLock();
  })();

  return {
    endpoint: `http://127.0.0.1:${port}`, code,
    async close() {
      child.kill("SIGTERM");
      const shutdown = setTimeout(() => child.kill("SIGKILL"), 5_000);

      try { await child.exited; await drain; await errors; }
      finally { clearTimeout(shutdown); }
    },
  };
}
