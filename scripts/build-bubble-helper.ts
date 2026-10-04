import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

await mkdir(resolve(root, "dist"), { recursive: true });

const child = Bun.spawn(["/usr/bin/clang", "-dynamiclib", "-fobjc-arc", "-O2", "-framework", "AppKit", "-framework", "Carbon", "-framework", "QuartzCore", resolve(root, "native/desktop/Bubble.m"), "-o", resolve(root, "dist/liblabora-bubble.dylib")], { stdout: "inherit", stderr: "inherit" });

if (await child.exited !== 0) throw new Error("Could not build the native bubble and shortcut helper.");
