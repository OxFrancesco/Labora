import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Match } from "effect";
import type { BotPaths } from "./config";
import { createLaboraModelRuntime } from "./model-runtime";

interface LoginOptions {
  readonly headless: boolean;
}

function readCallback(signal: AbortSignal, cancel: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("ChatGPT sign-in cancelled."));

      return;
    }

    const silentOutput = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });

    const input = createInterface({
      input: process.stdin,
      output: silentOutput,
      terminal: process.stdin.isTTY === true,
      historySize: 0,
    });

    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      input.removeAllListeners();
      input.close();
      silentOutput.end();
    };

    const abort = () => {
      cleanup();
      reject(new Error("ChatGPT sign-in cancelled."));
    };

    signal.addEventListener("abort", abort, { once: true });
    input.once("SIGINT", cancel);
    input.once("error", () => {
      cleanup();
      reject(new Error("Could not read the callback URL."));
    });
    input.on("line", (line: string) => {
      const value = line.trim();

      if (!value) return;
      cleanup();
      resolve(value);
    });
    process.stderr.write(
      "Waiting for ChatGPT sign-in. If the browser cannot return here, paste the full callback URL and press Enter. Input is hidden.\n",
    );
  });
}

function openBrowser(url: string, signal: AbortSignal) {
  const command = Match.value(process.platform).pipe(
    Match.when("darwin", () => ["/usr/bin/open", url]),
    Match.when("win32", () => ["rundll32.exe", "url.dll,FileProtocolHandler", url]),
    Match.orElse(() => ["xdg-open", url]),
  );

  const report = () => {
    if (!signal.aborted)
      process.stderr.write("Could not open a browser. Open the sign-in link above.\n");
  };

  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    void child.exited.then((code) => { if (code !== 0) report(); }, report);
  } catch {
    report();
  }
}

export async function loginWithChatGpt(paths: BotPaths, options: LoginOptions): Promise<number> {
  const controller = new AbortController();
  let cancelled = 0;

  const interrupt = () => {
    cancelled = 130;
    controller.abort();
  };

  const terminate = () => {
    cancelled = 143;
    controller.abort();
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    const { modelRuntime, deviceId } = await createLaboraModelRuntime(paths.agentDir, controller.signal);
    await modelRuntime.login("openai", "oauth", {
      signal: controller.signal,
      notify: (event) => {
        if (event.type !== "auth_url") return;
        process.stdout.write(`Sign in to ChatGPT for Labora bot "${paths.id}":\n${event.url}\n`);

        if (!options.headless) openBrowser(event.url, controller.signal);
      },
      prompt: (request) => {
        if (request.type !== "manual_code")
          return Promise.reject(new Error("ChatGPT sign-in requested unsupported input."));

        return readCallback(request.signal ?? controller.signal, interrupt);
      },
    }, { getDeviceId: () => deviceId });
    process.stdout.write(`ChatGPT is connected to Labora bot "${paths.id}".\n`);

    return 0;
  } catch (error) {
    if (!cancelled) throw error;
    process.stderr.write("ChatGPT sign-in cancelled.\n");

    return cancelled;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
