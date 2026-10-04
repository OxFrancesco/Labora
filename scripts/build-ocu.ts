import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import upstream from "../native/ocu/upstream.json";

const root = resolve(import.meta.dir, "..");

const cache = join(root, "artifacts/ocu");

const source = join(cache, "source");

const archive = join(cache, "upstream.tar.gz");

const app = join(root, "dist/Labora Open Computer Use.app");

async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });

  if (await child.exited !== 0) throw new Error(`Open Computer Use build failed: ${args[0]}`);
}

await mkdir(source, { recursive: true });

if (!await Bun.file(archive).exists()) {
  const response = await fetch(`https://codeload.github.com/iFurySt/open-codex-computer-use/tar.gz/${upstream.revision}`);

  if (!response.ok) throw new Error(`Open Computer Use download failed: ${response.status}`);
  await Bun.write(archive, response);
}

if (createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex") !== upstream.archiveSha256)
  throw new Error("Open Computer Use archive checksum mismatch");

for (const entry of await readdir(source)) {
  if (entry !== ".build") await rm(join(source, entry), { recursive: true, force: true });
}

await run(["tar", "-xzf", archive, "--strip-components=1", "-C", source]);

await run(["git", "apply", "--check", join(root, "native/ocu/labora.patch")], source);

await run(["git", "apply", join(root, "native/ocu/labora.patch")], source);

await run(["swift", "build", "-c", "release", "--product", "OpenComputerUse"], source);

await mkdir(join(app, "Contents/MacOS"), { recursive: true });

await mkdir(join(app, "Contents/Resources"), { recursive: true });

await cp(join(source, ".build/release/OpenComputerUse"), join(app, "Contents/MacOS/OpenComputerUse"));

for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(join(source, file), join(app, "Contents/Resources", file));

await cp(join(root, "native/ocu/upstream.json"), join(app, "Contents/Resources/upstream.json"));

await Bun.write(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OpenComputerUse</string>
<key>CFBundleIdentifier</key><string>org.buddytools.LaboraOpenComputerUse</string>
<key>CFBundleName</key><string>Labora Open Computer Use</string>
<key>CFBundleDisplayName</key><string>Labora Open Computer Use</string>
<key>CFBundleShortVersionString</key><string>${upstream.version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSAccessibilityUsageDescription</key><string>Use the apps you request through Labora.</string>
<key>NSScreenCaptureUsageDescription</key><string>Observe the app windows needed for your task.</string>
</dict></plist>`);

await run(["codesign", "--force", "--timestamp=none", "--sign", process.env.LABORA_SIGN_IDENTITY ?? "-", app]);

await run(["codesign", "--verify", "--deep", "--strict", app]);

console.log(`Built ${app}`);
