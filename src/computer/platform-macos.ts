import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { Computer, type Action, type Display } from "./contracts";
import type { PlatformAdapter } from "./platform";

const NativeInfo = Schema.Struct({ platform: Computer.fields.platform, capabilities: Computer.fields.capabilities, displays: Computer.fields.displays, permissions: Computer.fields.permissions, diagnostics: Computer.fields.diagnostics });

const NativeResponse = Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String), result: Schema.optionalKey(Schema.Json) });

export async function createMacAdapter(options: { dataDir: string; macAppPath?: string }): Promise<PlatformAdapter> {
  const directory = join(options.dataDir, "native");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const instance = crypto.randomUUID().slice(0, 8);
  // Darwin limits Unix socket paths to 104 bytes. The parent directory remains private.
  const socketPath = join(directory, `${instance}.sock`);

  if (Buffer.byteLength(socketPath) > 103) throw new Error("Computer data directory is too long for the macOS private socket");
  const noncePath = join(directory, `${instance}.nonce`);
  const nonce = randomBytes(32).toString("base64url");
  await writeFile(noncePath, nonce, { mode: 0o600 });
  const appPath = resolve(options.macAppPath ?? "dist/Labora Computer.app");
  let started = false;
  let initialization: Promise<void> | undefined;

  const request = (method: string, params?: Action | { displayId: string }) => new Promise<unknown>((resolve, reject) => {
    let response = "";
    let settled = false;
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");

    const finish = (error?: Error, value?: Schema.Schema.Type<typeof Schema.Json>) => {
      if (settled) return;
      settled = true;
      socket.destroy();

      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(15_000, () => finish(new Error("Labora Computer helper timed out")));
    socket.on("connect", () => socket.write(JSON.stringify({ nonce, method, params }) + "\n"));
    socket.on("data", (bytes) => {
      response += bytes.toString("utf8");

      if (response.length > 64_000_000) return finish(new Error("Native response exceeded limit"));
      const end = response.indexOf("\n");

      if (end < 0) return;

      try {
        const decoded = Schema.decodeUnknownSync(NativeResponse)(JSON.parse(response.slice(0, end)));

        if (!decoded.ok) finish(new Error(decoded.error ?? "Native computer operation failed"));
        else finish(undefined, decoded.result);
      } catch (cause) { finish(cause instanceof Error ? cause : new Error("Invalid native response")); }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Native helper closed before responding")));
  });

  const ensure = () => initialization ??= (async () => {
    try {
      await request("permissions.status");
      started = true;

      return;
    } catch { /* A helper that finished launching after a timeout can be reused. */ }

    if (!(await Bun.file(join(appPath, "Contents/Info.plist")).exists())) throw new Error("Build or install Labora Computer.app before enabling this Mac");
    const launch = Bun.spawn(["/usr/bin/open", "-n", "-a", appPath, "--args", "--socket", socketPath, "--nonce-file", noncePath, "--parent-pid", String(process.pid)], { stdout: "ignore", stderr: "pipe" });

    if (await launch.exited !== 0) throw new Error(`Could not launch Labora Computer.app: ${await new Response(launch.stderr).text()}`);
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      try { await request("permissions.status"); started = true;

 return; }
      catch { await Bun.sleep(100); }
    }

    throw new Error("Labora Computer.app did not open its private connection");
  })().catch(error => {
    initialization = undefined;
    throw error;
  });

  return {
    async info() {
      try { await ensure();

 return Schema.decodeUnknownSync(NativeInfo)(await request("permissions.status")); }
      catch (error) {
        initialization = undefined;
        started = false;

        return { platform: "macos", capabilities: [], displays: [], permissions: { screenCapture: "not-determined", accessibility: "not-determined" }, diagnostics: [error instanceof Error ? error.message : "Native helper unavailable"] };
      }
    },
    async capture(display: Display) {
      await ensure();
      const result = Schema.decodeUnknownSync(Schema.Struct({ png: Schema.String }))(await request("capture", { displayId: display.id }));

      return new Uint8Array(Buffer.from(result.png, "base64"));
    },
    async act(action) { await ensure(); await request("action", action); },
    async release() { if (started) await request("release"); },
    async close() {
      if (started) await request("shutdown").catch(() => undefined);
      await Promise.all([unlink(noncePath).catch(() => undefined), unlink(socketPath).catch(() => undefined)]);
    },
  };
}
