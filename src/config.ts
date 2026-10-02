import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function prepareBot() {
  const id = process.env.LABORA_BOT_ID ?? "main";

  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error("LABORA_BOT_ID must contain 1–64 letters, numbers, underscores, or hyphens.");
  }

  const executorUrl = new URL(process.env.LABORA_EXECUTOR_URL ?? "https://executor.sh/labora/mcp");

  if (executorUrl.protocol !== "https:" || executorUrl.username || executorUrl.password) {
    throw new Error("LABORA_EXECUTOR_URL must be an HTTPS URL without embedded credentials.");
  }

  const dataDir = resolve(process.env.LABORA_DATA_DIR ?? ".labora");
  const botDir = join(dataDir, "bots", id);
  const agentDir = join(botDir, "agent");
  const workspace = join(botDir, "workspace");
  const sessions = join(botDir, "sessions");
  await Promise.all(
    [agentDir, workspace, sessions].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );

  const executor = {
    url: executorUrl.href,
    description: "Labora integrations and their tool policies",
    exposure: "codemode",
    oauth: { clientName: "Labora" },
  };

  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { executor } }, null, 2),
    { mode: 0o600 },
  );

  return { id, agentDir, workspace, sessions, executorUrl: executorUrl.href };
}

export type BotPaths = Awaited<ReturnType<typeof prepareBot>>;
