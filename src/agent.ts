import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BotPaths } from "./config";
import { createLaboraModelRuntime } from "./model-runtime";

export async function createLaboraSession(paths: BotPaths, diagnostic = false) {
  const settingsManager = SettingsManager.create(paths.workspace, paths.agentDir);
  settingsManager.setCacheWarmingMode("off");
  settingsManager.applyOverrides({ defaultTools: ["+codemode", "+grep", "+find", "+ls"] });

  const { modelRuntime } = await createLaboraModelRuntime(paths.agentDir);

  const modelId = process.env.LABORA_OPENAI_MODEL ?? "gpt-6-astra";
  const model = modelRuntime.getModel("openai", modelId);

  if (!model) throw new Error(`Unknown OpenAI model: ${modelId}. Check LABORA_OPENAI_MODEL.`);

  if (!diagnostic && !modelRuntime.isUsingSubscription("openai")) {
    throw new Error(
      "This bot needs a ChatGPT subscription login. Run 'bun run agent login' or 'bun run agent login --headless'.",
    );
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.workspace,
    agentDir: paths.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      "You are Labora, a personal agent. Use your workspace for files and terminal tasks. Discover connected apps through Executor. Follow their approval policies. Executor approval requests must wait for the user; this CLI cannot approve or resume them. Report tool failures honestly and ask before consequential actions.",
    extensionFactories: [
      createCodemodeExtension({ mode: "on", models: false }),
      createMcpExtension(
        diagnostic
          ? {
              loadConfig: () => ({
                servers: [
                  {
                    name: "executor",
                    config: {
                      url: paths.executorUrl,
                      exposure: "direct",
                      oauth: { clientName: "Labora" },
                    },
                    source: "labora",
                    scope: "extension",
                  },
                ],
                errors: [],
              }),
            }
          : {},
      ),
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName === "mcp__executor__resume") {
            return {
              block: true,
              reason:
                "Executor resume requires a human approval interface. It is disabled in this CLI.",
              terminate: true,
            };
          }
        });
      },
    ],
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: paths.workspace,
    agentDir: paths.agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    model,
    thinkingLevel: "high",
    sessionManager: SessionManager.continueRecent(paths.workspace, paths.sessions),
  });

  await session.bindExtensions({});
  session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), "grep", "find", "ls", "codemode"])]);

  return session;
}
