import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

if (process.platform !== "darwin") throw new Error("The macOS helper must be built on macOS");

const app = resolve("dist/Labora Computer.app");

await mkdir(join(app, "Contents/MacOS"), { recursive: true });

await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.buddytools.LaboraComputer</string>
<key>CFBundleName</key><string>Labora Computer</string>
<key>CFBundleDisplayName</key><string>Labora Computer</string>
<key>CFBundleExecutable</key><string>LaboraComputer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Show this computer's screen to your paired Labora client.</string>
</dict></plist>`);

async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });

  if (await process.exited !== 0) throw new Error(`${args[0]} failed`);
}

await run(["swiftc", "-parse-as-library", "-O", "-module-cache-path", resolve("dist/computer-module-cache"), "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`, "native/computer/LaboraComputer.swift", "-o", join(app, "Contents/MacOS/LaboraComputer")]);

await run(["codesign", "--force", "--sign", process.env.LABORA_SIGN_IDENTITY ?? "-", app]);

console.log(app);
