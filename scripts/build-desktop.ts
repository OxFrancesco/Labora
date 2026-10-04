import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import manifest from "../package.json";
import { allCharacters } from "../src/desktop/avatars";

const root = resolve(import.meta.dir, "..");

const dist = join(root, "dist");

const destination = join(dist, "Labora.app");

const identity = process.env.LABORA_SIGN_IDENTITY ?? "-";

async function run(args: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });

  if (await child.exited !== 0) throw new Error(`Build command failed: ${args[0]}`);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The desktop package currently targets Apple Silicon macOS.");
}

for (const path of ["src/desktop/main.tsx", "src/backend/worker.ts", "scripts/computer-build-macos.ts", "scripts/computer-serve.ts", "native/voice/LaboraVoice.swift"]) {
  if (!existsSync(join(root, path))) throw new Error(`Missing desktop build input: ${path}`);
}

await run([process.execPath, "run", "typecheck"]);

await run([process.execPath, "run", "lint"]);

await run([process.execPath, "scripts/prepare-github-mcp.ts"]);

await run([process.execPath, "scripts/computer-build-macos.ts"]);

await run([process.execPath, "scripts/build-desktop-helper.ts"]);

await run([process.execPath, "scripts/build-bubble-helper.ts"]);

await run([process.execPath, "scripts/build-avatar-renderer.ts"]);

await run([process.execPath, "scripts/build-character-previews.ts"]);

await mkdir(dist, { recursive: true });

await run([
  "/usr/bin/swiftc", "-parse-as-library", "-O", "-module-cache-path", join(dist, "voice-module-cache"),
  "-target", "arm64-apple-macosx14.0", join(root, "native/voice/LaboraVoice.swift"),
  "-o", join(dist, "labora-voice"),
]);

const staging = await mkdtemp(join(dist, ".desktop-build-"));

const app = join(staging, "Labora.app");

const macos = join(app, "Contents/MacOS");

const resources = join(app, "Contents/Resources");

const executable = join(macos, "Labora");

const nativeLibrary = join(macos, "gpuix-native.node");

const helpers = join(app, "Contents/Helpers");

const piPackage = join(root, "node_modules/@earendil-works/pi-coding-agent");

const entry = join(staging, "entry.ts");

const codemodeWorker = join(staging, "src/extensions/codemode/worker.ts");

const imageWorker = join(staging, "src/utils/image-resize-worker.ts");

const entitlements = join(staging, "entitlements.plist");

const voiceEntitlements = join(staging, "voice-entitlements.plist");

await Promise.all([
  mkdir(macos, { recursive: true }),
  mkdir(resources, { recursive: true }),
  mkdir(helpers, { recursive: true }),
  mkdir(join(staging, "src/extensions/codemode"), { recursive: true }),
  mkdir(join(staging, "src/utils"), { recursive: true }),
]);

await writeFile(entry, `import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
const macos = dirname(process.execPath);
const resources = join(macos, "../Resources");
process.env.LABORA_PACKAGED = "1";
process.env.LABORA_ASSETS_DIR = resources;
process.env.PI_PACKAGE_DIR = join(resources, "pi");
process.env.LABORA_COMPUTER_APP ??= join(macos, "../Helpers/Labora Computer.app");
process.env.LABORA_DESKTOP_HELPER = join(macos, "labora-desktop");
process.env.LABORA_AVATAR_HELPER = join(macos, "labora-avatar");
process.env.LABORA_VOICE_HELPER = join(macos, "labora-voice");
process.env.LABORA_GITHUB_MCP_HELPER = join(macos, "github-mcp-server");
if (process.argv.includes("--computer")) {
  await import(${JSON.stringify(join(root, "scripts/computer-serve.ts"))});
} else if (process.argv.includes("--agent-worker")) {
  await import(${JSON.stringify(join(piPackage, "dist/bun/runtime-setup.js"))});
  const { runAgentWorker } = await import(${JSON.stringify(join(root, "src/backend/worker.ts"))});
  await runAgentWorker();
} else {
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(macos, "gpuix-native.node");
  if (process.argv.includes("--check-runtime")) {
    for (const file of ${JSON.stringify(allCharacters.flatMap((character) => ["usdz", "rgba", "gallery.rgba"].map((extension) => character.file.replace(/\.usdz$/, `.${extension}`))))}) {
      if (!existsSync(join(resources, "characters3d", file))) throw new Error("Missing character: " + file);
    }
    const native = await import("@gpuix/native");
    if (!native.GpuixRenderer) throw new Error("GPUix native renderer could not load");
    for (const path of ["pi/package.json", "pi/docs", "pi/theme", "Licenses/GPUix-LICENSE"]) {
      if (!existsSync(join(resources, path))) throw new Error("Missing bundled resource: " + path);
    }
    for (const name of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"]) {
      for (const extension of ["usdz", "glb", "blend", "rgba"]) {
        if (!existsSync(join(resources, "characters3d", name + "." + extension))) throw new Error("Missing bundled 3D character: " + name + "." + extension);
      }
    }
    if (!existsSync(process.env.LABORA_COMPUTER_APP)) throw new Error("Computer helper missing");
    if (!existsSync(process.env.LABORA_DESKTOP_HELPER)) throw new Error("Clipboard helper missing");
    if (!existsSync(process.env.LABORA_AVATAR_HELPER)) throw new Error("3D avatar renderer missing");
    if (!existsSync(process.env.LABORA_VOICE_HELPER)) throw new Error("Dictation helper missing");
    const { NativeVoice } = await import(${JSON.stringify(join(root, "src/desktop/voice.ts"))});
    const voice = new NativeVoice(() => { throw new Error("Unexpected recording event during read-only dictation check"); });
    let dictationOwner;
    try {
      const status = await voice.status();
      dictationOwner = status.owner;
      if (dictationOwner !== "org.buddytools.Labora") throw new Error("Dictation helper does not resolve the Labora bundle identity: " + dictationOwner);
    } finally { voice.close(); }
    await import(${JSON.stringify(join(piPackage, "dist/bun/runtime-setup.js"))});
    const { getQuickJSWasmPath } = await import(${JSON.stringify(join(piPackage, "dist/config.js"))});
    if (!existsSync(getQuickJSWasmPath())) throw new Error("Embedded QuickJS wasm missing");
    process.stdout.write(JSON.stringify({ packaged: true, gpuixNative: true, piAssets: true, quickjsWasm: true, dictationOwner, openedWindow: false }) + "\\n");
  } else {
    await import(${JSON.stringify(join(root, "src/desktop/main.tsx"))});
  }
}
`);

await writeFile(codemodeWorker, 'import "@earendil-works/pi-codemode/worker";\n');

await writeFile(imageWorker, `import ${JSON.stringify(join(piPackage, "dist/utils/image-resize-worker.js"))};\n`);

await run([
  process.execPath, "build", "--compile", "--target=bun-darwin-arm64", "--minify",
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--root", staging, "--outfile", executable, entry, codemodeWorker, imageWorker,
], staging);

await copyFile(join(root, "node_modules/@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node"), nativeLibrary);

await copyFile(join(dist, "labora-desktop"), join(macos, "labora-desktop"));

await copyFile(join(dist, "liblabora-bubble.dylib"), join(macos, "liblabora-bubble.dylib"));

await copyFile(join(dist, "labora-avatar"), join(macos, "labora-avatar"));

await copyFile(join(dist, "labora-voice"), join(macos, "labora-voice"));

await copyFile(join(root, "artifacts/github-mcp/github-mcp-server"), join(macos, "github-mcp-server"));

await run(["/usr/bin/strip", "-x", nativeLibrary]);

await cp(join(dist, "Labora Computer.app"), join(helpers, "Labora Computer.app"), { recursive: true });

await mkdir(join(resources, "characters3d"), { recursive: true });

for (const name of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"]) {
  for (const extension of ["usdz", "glb", "blend", "rgba"]) {
    const file = `${name}.${extension}`;
    await copyFile(join(root, "assets/characters3d", file), join(resources, "characters3d", file));
  }
}

for (const character of allCharacters) {
  for (const extension of ["usdz", "rgba", "gallery.rgba"]) {
    const file = character.file.replace(/\.usdz$/, `.${extension}`);
    await copyFile(join(root, "assets/characters3d", file), join(resources, "characters3d", file));
  }
}

await mkdir(join(resources, "pi"), { recursive: true });

for (const path of ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"]) {
  await cp(join(piPackage, path), join(resources, "pi", path), { recursive: true });
}

for (const [source, target] of [
  ["dist/modes/interactive/theme", "theme"],
  ["dist/modes/interactive/assets", "assets"],
  ["dist/core/export-html", "export-html"],
] as const) {
  await cp(join(piPackage, source), join(resources, "pi", target), { recursive: true });
}

await copyFile(join(root, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), join(resources, "photon_rs_bg.wasm"));

await symlink("../Resources/photon_rs_bg.wasm", join(macos, "photon_rs_bg.wasm"));

await mkdir(join(resources, "Licenses"), { recursive: true });

for (const [source, target] of [
  ["node_modules/@gpuix/native/LICENSE", "GPUix-LICENSE"],
  ["node_modules/react/LICENSE", "React-LICENSE"],
  ["assets/licenses/Pi-LICENSE", "Pi-LICENSE"],
  ["assets/licenses/T3-Code-LICENSE", "T3-Code-LICENSE"],
  ["assets/licenses/GitHub-MCP-LICENSE", "GitHub-MCP-LICENSE"],
  ["node_modules/effect/LICENSE", "Effect-LICENSE"],
] as const) {
  await copyFile(join(root, source), join(resources, "Licenses", target));
}

await writeFile(join(app, "Contents/PkgInfo"), "APPL????");

await copyFile(join(root, "assets/icons/Labora.icns"), join(resources, "Labora.icns"));

await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.buddytools.Labora</string>
<key>CFBundleName</key><string>Labora</string>
<key>CFBundleDisplayName</key><string>Labora</string>
<key>CFBundleExecutable</key><string>Labora</string>
<key>CFBundleIconFile</key><string>Labora.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>${manifest.version}</string>
<key>CFBundleVersion</key><string>${manifest.version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Dictate a message into Labora. Audio is transcribed on this Mac.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Turn your speech into a message draft using on-device recognition.</string>
</dict></plist>
`);

await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`);

await writeFile(voiceEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`);

async function sign(path: string, runtimeEntitlements?: string): Promise<void> {
  const args = ["/usr/bin/codesign", "--force", "--sign", identity];

  if (identity !== "-") args.push("--options", "runtime", "--timestamp");

  if (runtimeEntitlements) args.push("--entitlements", runtimeEntitlements);

  await run([...args, path]);
}

await sign(nativeLibrary);

await sign(join(macos, "github-mcp-server"));

await sign(join(macos, "labora-desktop"));

await sign(join(macos, "liblabora-bubble.dylib"));

await sign(join(macos, "labora-avatar"));

await sign(join(macos, "labora-voice"), voiceEntitlements);

await sign(executable, entitlements);

await sign(app, entitlements);

await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);

await run([executable, "--check-runtime"]);

if (existsSync(destination)) {
  const previous = join(dist, "Labora.previous.app");
  await rm(previous, { recursive: true, force: true });
  await rename(destination, previous);
}

await rename(app, destination);

await rm(staging, { recursive: true, force: true });

process.stdout.write(`Built ${destination} (${identity === "-" ? "ad-hoc signed" : "Developer ID signed"})\n`);
