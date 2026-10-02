import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeAvatarRenderer, renderAvatar } from "../src/desktop/avatar-renderer";

const root = resolve(import.meta.dir, "..");

const packaged = process.argv.includes("--packaged");

const resources = packaged ? join(root, "dist/Labora.app/Contents/Resources") : join(root, "assets");

if (packaged) process.env.LABORA_AVATAR_HELPER = join(root, "dist/Labora.app/Contents/MacOS/labora-avatar");

const directory = join(root, "evidence", `avatar3d-${packaged ? "packaged" : "source"}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);

const ffmpeg = Bun.which("ffmpeg");

if (!ffmpeg) throw new Error("ffmpeg is required to save native-renderer evidence.");

await mkdir(directory, { recursive: true });

const results = [];

try {
  for (const name of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"]) {
    const model = join(resources, "characters3d", `${name}.usdz`);
    const first = await renderAvatar({ model, width: 256, height: 256, yaw: 0.16, pitch: -0.08 });
    const turned = await renderAvatar({ model, width: 256, height: 256, yaw: -0.35, pitch: 0.15 });
    let visible = 0;
    let changed = 0;

    for (let offset = 0; offset < first.pixels.length; offset += 4) {
      if (first.pixels[offset + 3]) visible++;

      if (!first.pixels.subarray(offset, offset + 4).equals(turned.pixels.subarray(offset, offset + 4))) changed++;
    }

    assert.equal(first.nodes, name === "pebble" ? 6 : 5, `${name} must load its body, two cartoon eyes, two catchlights, and optional felt fibres`);
    assert(first.materials.length >= 3, `${name} must retain named body and face materials`);
    assert(visible > 5000 && visible < 60000, `${name} must render visible geometry on a transparent background`);
    assert(changed > 5000, `${name} must render a different view when its 3D pose changes`);

    for (const [suffix, frame] of [["front", first], ["turned", turned]] as const) {
      const raw = join(directory, `${name}-${suffix}.rgba`);
      await Bun.write(raw, frame.pixels);
      const encoder: Bun.Subprocess<"ignore", "inherit", "inherit"> = Bun.spawn([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "256x256", "-i", raw, "-frames:v", "1", join(directory, `${name}-${suffix}.png`)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });

      assert.equal(await encoder.exited, 0, "Native frame evidence must encode successfully");
    }

    results.push({ name, nodes: first.nodes, materials: first.materials, visiblePixels: visible, changedPixels: changed, modelSha256: createHash("sha256").update(Buffer.from(await Bun.file(model).arrayBuffer())).digest("hex") });
  }

  await Bun.write(join(directory, "verification.json"), JSON.stringify({ packaged, renderer: "SceneKit/Metal", frameSource: "Runtime USDZ mesh rendering", results }, null, 2));
} finally {
  closeAvatarRenderer();
}

process.stdout.write(`${directory}\n`);
