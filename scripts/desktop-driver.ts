import { launch } from "@gpuix/react/automation";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DesktopDriverOptions {
  profileDirectory: string;
  evidenceDirectory: string;
  source?: boolean;
  executable?: string;
  foreground?: boolean;
}

export async function openDesktop(options: DesktopDriverOptions) {
  const root = resolve(import.meta.dir, "..");
  const executable = options.executable ?? join(root, "dist/Labora.app/Contents/MacOS/Labora");
  const ffmpeg = Bun.which("ffmpeg");

  if (!ffmpeg) throw new Error("ffmpeg is required to record native desktop verification.");

  if (!options.source && !existsSync(executable)) throw new Error("Build Labora.app before packaged desktop verification.");

  const encoderPath = ffmpeg;

  const framesDirectory = join(options.evidenceDirectory, "frames");
  await mkdir(framesDirectory, { recursive: true });

  const app = await launch({
    command: options.source ? process.execPath : executable,
    args: options.source ? [join(root, "src/desktop/main.tsx")] : [],
    cwd: root,
    env: {
      ...process.env,
      LABORA_DESKTOP_DATA_DIR: options.profileDirectory,
      GPUIX_BACKGROUND: options.foreground ? "0" : "1",
      PATH: options.source ? process.env.PATH : "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });

  const frames: { path: string; time: number }[] = [];
  let recording = true;
  let captureError: Error | undefined;

  const capture = (async () => {
    while (recording) {
      const path = join(framesDirectory, `${String(frames.length).padStart(5, "0")}.png`);
      await app.screenshot({ path });
      frames.push({ path, time: performance.now() });
      await Bun.sleep(250);
    }
  })().catch((error) => { captureError = error instanceof Error ? error : new Error(String(error)); });

  async function screenshot(name: string): Promise<string> {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Screenshot names must use lowercase letters, numbers, and hyphens.");

    const path = join(options.evidenceDirectory, `${name}.png`);
    await app.screenshot({ path });

    return path;
  }

  async function close(): Promise<void> {
    recording = false;
    await capture;

    try {
      const finalFrame = join(framesDirectory, `${String(frames.length).padStart(5, "0")}.png`);
      await app.screenshot({ path: finalFrame });
      frames.push({ path: finalFrame, time: performance.now() });
    } finally {
      await app.close();
    }

    if (captureError) throw captureError;

    if (frames.length < 2) throw new Error("The native walkthrough did not produce enough frames.");

    const last = frames.at(-1);

    if (!last) throw new Error("The native walkthrough has no final frame.");

    const list = frames.map((frame, index) => {
      const next = frames[index + 1];
      const duration = ((next?.time ?? frame.time + 500) - frame.time) / 1000;

      return `file '${frame.path.replaceAll("'", "'\\''")}'\nduration ${duration}`;
    }).join("\n");

    const timeline = join(framesDirectory, "frames.txt");
    await writeFile(timeline, `${list}\nfile '${last.path.replaceAll("'", "'\\''")}'\n`);

    const encoder = Bun.spawn([
      encoderPath, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", timeline,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", join(options.evidenceDirectory, "walkthrough.mp4"),
    ], { stdout: "inherit", stderr: "inherit" });

    if (await encoder.exited !== 0) throw new Error("Could not encode the native desktop walkthrough.");
  }

  return { app, screenshot, close, executable: options.source ? "source" : executable };
}
