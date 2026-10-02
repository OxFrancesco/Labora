import { link, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createOpenAiSubscriptionAuth } from "./backend/openai";

export async function createLaboraModelRuntime(agentDir: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const devicePath = join(agentDir, "device-id");
  const temporaryDevicePath = `${devicePath}.${crypto.randomUUID()}.tmp`;

  try {
    await writeFile(temporaryDevicePath, crypto.randomUUID(), { mode: 0o600, flag: "wx" });

    try { await link(temporaryDevicePath, devicePath); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally { await rm(temporaryDevicePath, { force: true }); }

  const deviceId = await readFile(devicePath, "utf8");

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    signal,
  });

  const openai = modelRuntime.getProvider("openai");

  if (!openai) throw new Error("The OpenAI provider is not available.");
  modelRuntime.registerNativeProvider({
    ...openai,
    auth: {
      oauth: createOpenAiSubscriptionAuth({
        registrationPath: join(agentDir, "openai-registration.json"),
        deviceId,
      }),
    },
  });
  await modelRuntime.refresh({ allowNetwork: false, signal });
  signal?.throwIfAborted();

  return { modelRuntime, deviceId };
}
