import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const dist = join(root, "dist");

if (process.platform !== "darwin") throw new Error("The native 3D avatar renderer requires macOS.");

await mkdir(dist, { recursive: true });

const child = Bun.spawn([
  "/usr/bin/swiftc", "-O", "-module-cache-path", join(dist, "avatar-swift-module-cache"),
  "-target", `${process.arch}-apple-macosx14.0`, join(root, "native/desktop/AvatarRenderer.swift"),
  "-o", join(dist, "labora-avatar"),
], { stdout: "inherit", stderr: "inherit" });

if (await child.exited !== 0) throw new Error("Could not build the native 3D avatar renderer.");
