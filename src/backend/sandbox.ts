import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve, sep } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function headless<T extends TSchema, D, S>(tool: ToolDefinition<T, D, S>): ToolDefinition {
  return {
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
    outputSchema: tool.outputSchema, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines,
    execute: (id, input, signal, update, context) => tool.execute(id, Value.Parse(tool.parameters, input), signal, update, context),
  };
}

export async function createWorkspaceSandbox(directory: string) {
  const requestedWorkspace = resolve(directory);
  const workspace = await realpath(directory);
  const temporary = join(workspace, ".tmp");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  let initialization: Promise<void> | undefined;

  const initialize = () => initialization ??= (async () => {
    if (!SandboxManager.isSupportedPlatform()) throw new Error("Workspace sandbox is unavailable on this system. No command was run.");
    const dependencies = await SandboxManager.checkDependenciesAsync();

    if (dependencies.errors.length) throw new Error(`Workspace sandbox unavailable: ${dependencies.errors.join(". ")}`);
    await SandboxManager.initialize({
      filesystem: {
        denyRead: ["/"],
        allowRead: [workspace, "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/System", "/Library/Apple", "/Library/Developer/CommandLineTools", "/opt/homebrew", "/private/etc", "/dev"],
        allowWrite: [workspace],
        denyWrite: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["localhost"],
        deniedResolvedAddresses: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1", "fc00::/7", "fe80::/10"],
        allowLocalBinding: false,
      },
    }, async ({ host }) => !isIP(host) && host !== "localhost" && !host.endsWith(".localhost"), false);
  })();

  async function execute(command: string, options: { input?: string; signal?: AbortSignal; timeout?: number; onData?: (data: Buffer) => void } = {}) {
    await initialize();
    options.signal?.throwIfAborted();
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash", undefined, options.signal, workspace);
    const executable = wrapped.argv[0];

    if (!executable) throw new Error("Sandbox did not supply an executable.");

    return await new Promise<{ code: number; output: Buffer }>((resolve, reject) => {
      // Only public runtime settings enter the command. Provider tokens remain in the worker.
      const child = spawn(executable, wrapped.argv.slice(1), {
        cwd: workspace, detached: true,
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", SSL_CERT_FILE: process.platform === "darwin" ? "/private/etc/ssl/cert.pem" : "/etc/ssl/certs/ca-certificates.crt", CURL_CA_BUNDLE: process.platform === "darwin" ? "/private/etc/ssl/cert.pem" : "/etc/ssl/certs/ca-certificates.crt", TMPDIR: temporary, XDG_CACHE_HOME: join(temporary, "cache") },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;

      const stop = (error: Error) => {
        failure ??= error;

        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      };

      const abort = () => stop(new Error("Command cancelled"));
      const timer = setTimeout(() => stop(new Error("Command timed out")), Math.min(options.timeout ?? 120, 600) * 1_000);
      options.signal?.addEventListener("abort", abort, { once: true });

      const receive = (data: Buffer) => {
        bytes += data.length;

        if (bytes > 16 * 1024 * 1024) { stop(new Error("Command output exceeded 16 MB"));

 return; }

        chunks.push(data);
        options.onData?.(data);
      };

      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
      child.on("error", (error) => { failure = error; });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);

        if (failure) reject(failure);
        else resolve({ code: code ?? 1, output: Buffer.concat(chunks) });
      });
    });
  }

  const path = (value: string) => {
    const requested = resolve(workspace, value);

    const absolute = requested === requestedWorkspace || requested.startsWith(requestedWorkspace + sep)
      ? workspace + requested.slice(requestedWorkspace.length) : requested;

    if (absolute !== workspace && !absolute.startsWith(workspace + sep)) throw new Error("This file is outside the agent workspace.");

    return quote(absolute);
  };

  const checked = async (command: string, input?: string) => {
    const result = await execute(command, { input });

    if (result.code !== 0) throw new Error(result.output.toString().trim() || "The sandbox denied this file operation.");

    return result.output;
  };

  const readFile = (file: string) => checked(`/bin/cat -- ${path(file)}`);
  const writeFile = async (file: string, content: string) => { await checked(`/bin/cat > ${path(file)}`, content); };

  const access = async (file: string) => { await checked(`test -r ${path(file)}`); };

  const tools = [
    headless(createBashToolDefinition(workspace, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => ({ exitCode: (await execute(command, options)).code }) } })),
    headless(createReadToolDefinition(workspace, { operations: { readFile, access, detectImageMimeType: async (file) => {
      const data = await readFile(file);

      if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";

      if (data[0] === 255 && data[1] === 216) return "image/jpeg";

      if (data.subarray(0, 3).toString() === "GIF") return "image/gif";

      if (data.subarray(8, 12).toString() === "WEBP") return "image/webp";

      return undefined;
    } } })),
    headless(createWriteToolDefinition(workspace, { operations: { writeFile, mkdir: async (dir) => { await checked(`/bin/mkdir -p -- ${path(dir)}`); } } })),
    headless(createEditToolDefinition(workspace, { operations: { readFile, writeFile, access } })),
  ];

  return { tools, execute, close: () => initialization ? SandboxManager.reset() : Promise.resolve() };
}
