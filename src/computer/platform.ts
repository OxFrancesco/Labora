import { Context, Effect, Layer } from "effect";
import { ComputerError, type Action, type Computer, type Display } from "./contracts";
import { createLinuxAdapter } from "./platform-linux";
import { createMacAdapter } from "./platform-macos";

export interface PlatformInfo {
  platform: Computer["platform"];
  capabilities: Computer["capabilities"];
  displays: ReadonlyArray<Display>;
  permissions: Computer["permissions"];
  diagnostics: ReadonlyArray<string>;
}

export interface PlatformAdapter {
  info(): Promise<PlatformInfo>;
  capture(display: Display): Promise<Uint8Array>;
  act(action: Action): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
}

const platformAttempt = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: error => error instanceof ComputerError ? error : new ComputerError({
    code: "platform_error", status: 503, message: error instanceof Error ? error.message : "Computer operation failed",
  }),
});

export class DesktopPlatform extends Context.Service<DesktopPlatform, {
  info: () => Effect.Effect<PlatformInfo, ComputerError>;
  capture: (display: Display) => Effect.Effect<Uint8Array, ComputerError>;
  act: (action: Action) => Effect.Effect<void, ComputerError>;
  release: () => Effect.Effect<void, ComputerError>;
}>()("labora/DesktopPlatform") {}

export const platformLayer = (options: { dataDir: string; macAppPath?: string; display?: string }) => Layer.effect(DesktopPlatform,
  Effect.gen(function* () {
    const adapter = yield* Effect.acquireRelease(
      platformAttempt(async (): Promise<PlatformAdapter> => {
        if (process.platform === "linux") return createLinuxAdapter(options);

        if (process.platform === "darwin") return createMacAdapter(options);

        return {
          async info() { return { platform: process.platform === "win32" ? "windows" : "unsupported", capabilities: [], displays: [], permissions: { screenCapture: "unsupported", accessibility: "unsupported" }, diagnostics: ["This operating system has no Labora capture/input adapter yet."] }; },
          async capture() { throw new Error("Screen capture is unsupported on this operating system"); },
          async act() { throw new Error("Input is unsupported on this operating system"); },
          async release() {}, async close() {},
        };
      }),
      (adapter) => Effect.promise(() => adapter.close()),
    );

    return DesktopPlatform.of({
      info: Effect.fn("DesktopPlatform.info")(() => platformAttempt(() => adapter.info())),
      capture: Effect.fn("DesktopPlatform.capture")((display: Display) => platformAttempt(() => adapter.capture(display))),
      act: Effect.fn("DesktopPlatform.act")((action: Action) => platformAttempt(() => adapter.act(action))),
      release: Effect.fn("DesktopPlatform.release")(() => platformAttempt(() => adapter.release())),
    });
  }));
