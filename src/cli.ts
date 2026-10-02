import { join } from "node:path";
import { prepareBot } from "./config";

function printHelp() {
  process.stdout.write(
    [
      "Labora agent",
      "  bun run agent connect           Sign this bot in to Executor",
      "  bun run agent tools             Check this bot's Executor connection",
      "  bun run agent login             Sign this bot in to ChatGPT in your browser",
      "  bun run agent login --headless  Print the ChatGPT sign-in link without opening a browser",
      "  bun run agent chat <message>    Send a message to Labora",
      "  bun run agent inspect          Inspect the embedded agent's Executor tools",
      "  bun run agent check            Test Executor through the embedded runtime",
      "",
      "Each process owns one bot. Set LABORA_BOT_ID to choose it.",
      "Login waits for the browser callback. You can also paste the full callback URL into the terminal; input is hidden.",
      "Chat requires this bot's ChatGPT subscription login. LABORA_OPENAI_MODEL defaults to gpt-5.5.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const [command = "help", ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    if (args.length) throw new Error("Usage: bun run agent help");
    printHelp();

    return 0;
  }

  if (!["connect", "tools", "login", "chat", "inspect", "check"].includes(command))
    throw new Error("Unknown command. Run 'bun run agent help' for the available commands.");

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();

    return 0;
  }

  if (command === "login") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--headless"))
      throw new Error("Usage: bun run agent login [--headless]");
  } else if (command === "chat") {
    if (!args.join(" ").trim()) throw new Error("Usage: bun run agent chat <message>");
  } else if (args.length) throw new Error(`Usage: bun run agent ${command}`);

  const paths = await prepareBot();
  process.env.PI_CODING_AGENT_DIR = paths.agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessions;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";

  if (command === "login") {
    const { loginWithChatGpt } = await import("./login");

    return loginWithChatGpt(paths, { headless: args[0] === "--headless" });
  }

  if (command === "connect" || command === "tools") {
    const piCli = join(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const piArgs = command === "connect" ? ["mcp", "login", "executor"] : ["mcp", "list"];

    const child = Bun.spawn([process.execPath, piCli, ...piArgs], {
      cwd: paths.workspace,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return child.exited;
  }

  const { createLaboraSession } = await import("./agent");
  let session: Awaited<ReturnType<typeof createLaboraSession>> | undefined;

  try {
    session = await createLaboraSession(paths, command !== "chat");

    if (command !== "chat") {
      const deadline = Date.now() + 30_000;

      while (!session.getCallableToolNames().some((name) => name.startsWith("mcp__executor__"))) {
        if (Date.now() >= deadline)
          throw new Error("Executor tools did not load. Run 'bun run agent tools' for the connection error.");
        await Bun.sleep(100);
      }

      if (command === "check") {
        const { checkExecutor } = await import("./check");
        await checkExecutor(session);
      } else {
        const tools = session.getAllTools().filter((tool) => tool.name.startsWith("mcp__executor__"));
        process.stdout.write(`${JSON.stringify(
          tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          null,
          2,
        )}\n`);
      }
    } else {
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
          process.stdout.write(event.assistantMessageEvent.delta);
      });
      await session.prompt(args.join(" "));
      process.stdout.write("\n");

      const lastAssistant = session.state.messages
        .slice()
        .reverse()
        .find((message) => message.role === "assistant");

      if (!lastAssistant || lastAssistant.role !== "assistant")
        throw new Error("The agent finished without an assistant response.");

      if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
        throw new Error(lastAssistant.errorMessage || `Request ${lastAssistant.stopReason}`);
    }
  } finally {
    try {
      await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
    }
  }

  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Labora could not complete the command."}\n`);
  process.exitCode = 1;
}
