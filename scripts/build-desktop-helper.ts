import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

if (process.platform !== "darwin") throw new Error("The clipboard helper requires macOS.");

const dist = join(root, "dist");

await mkdir(dist, { recursive: true });

const child = Bun.spawn([
  "/usr/bin/swiftc", "-O", "-module-cache-path", join(dist, "clipboard-module-cache"),
  "-target", `${process.arch}-apple-macosx14.0`, join(root, "native/desktop/Clipboard.swift"),
  "-o", join(dist, "labora-desktop"),
], { stdout: "inherit", stderr: "inherit" });

if (await child.exited !== 0) throw new Error("Could not build the native clipboard helper.");
