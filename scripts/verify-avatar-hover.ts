import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { launch } from "@gpuix/react/automation";
import { allCharacters } from "../src/desktop/avatars";
import { Schema } from "effect";

const directory = resolve(process.env.LABORA_HOVER_EVIDENCE ?? "evidence/avatar-hover");

await mkdir(directory, { recursive: true });

const record = process.argv.includes("--record");

const pet = process.env.LABORA_HOVER_PET ?? "Noodle";

const trace = join(directory, `${pet.toLowerCase()}.jsonl`);

await Bun.write(trace, "");

const app = await launch({ command: process.execPath, args: ["scripts/hover-fixture.tsx"], cwd: process.cwd(), env: { ...process.env, LABORA_HOVER_TRACE: trace, LABORA_HOVER_VIDEO: record ? join(directory, "hover.mp4") : undefined, GPUIX_BACKGROUND: "0" } });

try {
  await app.getByTestId("character-grid").waitFor();

  if (allCharacters.findIndex((item) => item.name === pet) >= 20) {
    await app.call("scrollTo", { elementId: (await app.getByTestId("character-grid").element()).id, x: 0, y: -450 });
  }

  await app.getByTestId(`character-${pet.toLowerCase()}`).click();
  const avatar = app.getByTestId(`avatar3d-view-${pet.toLowerCase()}-240`);
  await avatar.waitFor();
  const { pid } = await app.call("initialize", { protocolVersion: 1, client: "hover-verification" });
  process.kill(pid, "SIGUSR1");
  await avatar.click();
  await Bun.sleep(1600);
  const bounds = await avatar.bounds();
  await app.screenshot({ path: join(directory, `${pet.toLowerCase()}-before.png`) });

  for (let index = 0; index < (record ? 720 : 240); index++) {
    const x = bounds.x + bounds.width * (0.5 + Math.sin(index / 60 * Math.PI) * 0.4);
    const y = bounds.y + bounds.height * (0.5 + Math.cos(index / 60 * Math.PI) * 0.25);
    await app.mouse.move({ x, y });
    await Bun.sleep(6);
  }

  await Bun.sleep(350);
  await app.screenshot({ path: join(directory, `${pet.toLowerCase()}-after.png`) });
  const Event = Schema.Struct({ kind: Schema.Literals(["frame", "pointer"]), time: Schema.Number, model: Schema.String });
  const events = (await Bun.file(trace).text()).trim().split("\n").map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Event))(line));
  const pointers = events.filter((item) => item.kind === "pointer");
  const first = pointers[0]!.time;
  const last = pointers.at(-1)!.time;
  const frames = events.filter((item) => item.kind === "frame" && item.time >= first && item.time <= last);
  const gaps = frames.slice(1).map((frame, i) => frame.time - frames[i]!.time).sort((a, b) => a - b);
  const result = { pet, pointerEvents: pointers.length, frames: frames.length, durationMs: last - first, fps: frames.length * 1000 / (last - first), p95FrameGapMs: gaps[Math.floor(gaps.length * .95)] ?? null, maxFrameGapMs: gaps.at(-1) ?? null, firstFrameMs: (frames[0]?.time ?? last) - first };
  await Bun.write(join(directory, `${pet.toLowerCase()}-results.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));

  if (!record) {
  assert(result.frames > 0 && result.fps >= 45, "Hover must keep rendering during continuous pointer movement");
  assert((result.p95FrameGapMs ?? Infinity) < 45, "Hover frame gaps must stay below 45ms at p95");
  assert(result.firstFrameMs < 100, "Hover must respond within 100ms");
  }

  if (record) {
    process.kill(pid, "SIGUSR2");
    const deadline = Date.now() + 10000;

    while (!(await Bun.file(trace).text()).includes('"recorded"')) {
      assert(Date.now() < deadline, "Recording did not finish");
      await Bun.sleep(100);
    }
  }
} finally { await app.close(); }
