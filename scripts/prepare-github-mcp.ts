import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(import.meta.dir, "../artifacts/github-mcp");

const archive = join(directory, "github-mcp-server_Darwin_arm64.tar.gz");

const digest = "e3baa88424ecc24ae504a1c98c128823fc2c2edbe9dd64e1456f39edea701140";

await mkdir(directory, { recursive: true });

if (!await Bun.file(archive).exists()) {
  const response = await fetch("https://github.com/github/github-mcp-server/releases/download/v1.14.0/github-mcp-server_Darwin_arm64.tar.gz", { signal: AbortSignal.timeout(120_000) });

  if (!response.ok) throw new Error("Could not download the official GitHub MCP helper.");
  await Bun.write(archive, response);
}

if (createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex") !== digest)
  throw new Error("GitHub MCP helper checksum does not match the pinned official release.");

const extract = Bun.spawn(["/usr/bin/tar", "-xzf", archive, "-C", directory, "github-mcp-server", "LICENSE"], { stdout: "ignore", stderr: "inherit" });

if (await extract.exited !== 0) throw new Error("Could not unpack the GitHub MCP helper.");

await chmod(join(directory, "github-mcp-server"), 0o755);
