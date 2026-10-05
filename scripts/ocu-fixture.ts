import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function launchOcuFixture(workspace: string) {
  const app = join(workspace, "Labora OCU Fixture.app");
  const target = `org.buddytools.LaboraOcuFixture-${crypto.randomUUID()}`;
  const countPath = join(workspace, "count.txt");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await Bun.write(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${target}</string><key>CFBundleName</key><string>Labora OCU Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const compiler = Bun.spawn(["/usr/bin/swiftc", "-parse-as-library", resolve(import.meta.dir, "../native/ocu/VerificationFixture.swift"), "-o", join(app, "Contents/MacOS/Fixture")], { stdout: "inherit", stderr: "inherit" });

  if (await compiler.exited !== 0) throw new Error("OCU verification fixture did not compile");
  const child = Bun.spawn([join(app, "Contents/MacOS/Fixture"), countPath], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(500);

  return { target, countPath, async close() { child.kill(); await child.exited; } };
}
