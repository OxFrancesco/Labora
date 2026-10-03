import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(import.meta.dir, "../assets/icons");

const source = join(directory, "labora-source.png");

const temporary = await mkdtemp("/private/tmp/labora-icons-");

const iconset = join(temporary, "Labora.iconset");

async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: "ignore", stderr: "inherit" });

  if (await process.exited !== 0) throw new Error(`Icon export failed: ${args[0]}`);
}

try {
  await mkdir(iconset);

  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await run(["/usr/bin/sips", "-z", String(size * scale), String(size * scale), source,
        "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
    }
  }

  await run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", join(directory, "Labora.icns")]);

  for (const [name, size] of [["icon-16", 16], ["icon-32", 32], ["icon-48", 48], ["apple-touch-icon", 180], ["icon-192", 192], ["icon-512", 512], ["icon-1024", 1024]] as const) {
    await run(["/usr/bin/sips", "-z", String(size), String(size), source, "--out", join(directory, `${name}.png`)]);
  }

  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map(async (size) => Buffer.from(await Bun.file(join(directory, `icon-${size}.png`)).arrayBuffer())));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((png, index) => {
    const entry = 6 + index * 16;
    header[entry] = sizes[index]!;
    header[entry + 1] = sizes[index]!;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  await Bun.write(join(directory, "favicon.ico"), Buffer.concat([header, ...images]));
  await Bun.write(join(directory, "favicon.json"), JSON.stringify({ dataUrl: `data:image/png;base64,${images[1]!.toString("base64")}` }) + "\n");
  console.log("Exported macOS and web icons to assets/icons.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
