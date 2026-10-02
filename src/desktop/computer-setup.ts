import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Effect } from "effect";
import { readComputerSetup } from "../computer/setup";

let launching: Promise<string> | undefined;

async function launch(storeDirectory?: string) {
  const configuration = await Effect.runPromise(Effect.gen(function* () {
    return {
      dataDir: yield* Config.String("LABORA_COMPUTER_DATA").pipe(Config.withDefault(join(homedir(), ".labora", "computer"))),
      packaged: yield* Config.Boolean("LABORA_PACKAGED").pipe(Config.withDefault(false)),
    };
  }));

  const dataDir = resolve(storeDirectory ?? configuration.dataDir);
  const existing = await readComputerSetup(dataDir);

  if (existing) return existing.url;

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);

  const log = await open(join(dataDir, "companion.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  await log.chmod(0o600);

  const command = configuration.packaged
    ? [process.execPath, "--computer", "--setup", "--no-open"]
    : [process.execPath, resolve(import.meta.dir, "../../scripts/computer-serve.ts"), "--setup", "--no-open"];

  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(command, {
      cwd: dataDir, stdin: "ignore", stdout: log.fd, stderr: log.fd,
      env: { ...process.env, LABORA_COMPUTER_DATA: dataDir, LABORA_COMPUTER_HOST: "127.0.0.1", LABORA_ALLOW_NETWORK: "false", LABORA_MANAGEMENT_TOKEN: undefined },
    });
    child.unref();
  } finally { await log.close(); }

  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await readComputerSetup(dataDir);

    if (ready) return ready.url;

    if (child.exitCode !== null) throw new Error("The companion could not start. Check the private companion.log file in your Labora computer folder.");
    await Bun.sleep(200);
  }

  throw new Error("Computer setup is still starting. Try Set up this computer again in a moment.");
}

export function launchLocalComputerSetup(storeDirectory?: string): Promise<string> {
  if (!launching) launching = launch(storeDirectory).finally(() => { launching = undefined; });

  return launching;
}
