import { appendFileSync } from "node:fs";
import { Schema } from "effect";
import { CharacterWindowCommand } from "../src/desktop/character-window-contracts";
import { avatarDiagnostics } from "../src/desktop/avatar-diagnostics";
import { closeAvatarRenderer } from "../src/desktop/avatar-renderer";

const event = Schema.Struct({ kind: Schema.Literals(["frame", "pointer"]), time: Schema.Number, model: Schema.String, pixels: Schema.optionalKey(Schema.Uint8Array) });

const video = process.env.LABORA_HOVER_VIDEO;

const encoder = video ? Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-use_wallclock_as_timestamps", "1", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "480x480", "-framerate", "60", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video], { stdin: "pipe", stdout: "ignore", stderr: "inherit" }) : undefined;

avatarDiagnostics.subscribe((input) => {
  const value = Schema.decodeUnknownSync(event)(input);
  const { pixels, ...metadata } = value;
  appendFileSync(process.env.LABORA_HOVER_TRACE!, JSON.stringify(metadata) + "\n");

  if (pixels?.byteLength === 480 * 480 * 4) encoder?.stdin.write(pixels);
});

process.once("exit", closeAvatarRenderer);

process.on("SIGUSR1", () => { process.emit("message", CharacterWindowCommand.cases.Activate.make({})); });

process.on("SIGUSR2", () => {
  encoder?.stdin.end();
  void encoder?.exited.then(() => { appendFileSync(process.env.LABORA_HOVER_TRACE!, JSON.stringify({ kind: "recorded", time: performance.now(), model: "" }) + "\n"); });
});

await import("../src/desktop/character-window");
