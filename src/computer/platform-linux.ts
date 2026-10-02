import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Action, type Display } from "./contracts";
import type { PlatformAdapter } from "./platform";

export async function createLinuxAdapter(options: { dataDir: string; display?: string }): Promise<PlatformAdapter> {
  const display = options.display;
  const held = new Set<number>();

  const run = async (argv: string[]) => {
    if (!display) throw new Error("LABORA_DISPLAY must identify an X11 display; Wayland is not supported yet");
    const subprocess = Bun.spawn(argv, { env: { ...process.env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => subprocess.kill(), 15_000);

    try {
      const [stdout, stderr, code] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);

      if (code !== 0) throw new Error(`${argv[0]} failed: ${stderr.trim().slice(0, 500)}`);

      return stdout.trim();
    } finally { clearTimeout(timeout); }
  };

  const release = async () => {
    for (const button of held) await run(["xdotool", "mouseup", String(button)]);
    held.clear();
  };

  await mkdir(join(options.dataDir, "frames"), { recursive: true, mode: 0o700 });

  return {
    async info() {
      try {
        const [widthText, heightText] = (await run(["xdotool", "getdisplaygeometry"])).split(/\s+/);
        const width = Number(widthText), height = Number(heightText);

        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("X11 returned invalid geometry");

        return { platform: "linux", capabilities: ["capture", "input"], displays: [{ id: "x11", name: `X11 ${display}`, x: 0, y: 0, width, height, pixelWidth: width, pixelHeight: height, scale: 1 }], permissions: { screenCapture: "granted", accessibility: "granted" }, diagnostics: [] };
      } catch (error) {
        return { platform: "linux", capabilities: [], displays: [], permissions: { screenCapture: "denied", accessibility: "denied" }, diagnostics: [error instanceof Error ? error.message : "X11 unavailable"] };
      }
    },
    async capture(_display: Display) {
      const path = join(options.dataDir, "frames", `${crypto.randomUUID()}.png`);

      try { await run(["scrot", "-o", path]);

 return new Uint8Array(await Bun.file(path).arrayBuffer()); }
      finally { await unlink(path).catch(() => undefined); }
    },
    async act(action: Action) {
      if ("x" in action) await run(["xdotool", "mousemove", String(Math.round(action.x)), String(Math.round(action.y))]);
      const button = "button" in action ? ({ left: 1, middle: 2, right: 3 }[action.button]) : 1;

      switch (action.type) {
        case "move": return;
        case "click": await run(["xdotool", "click", "--repeat", String(action.count), "--delay", "80", String(button)]);

 return;
        case "pointer_down": await run(["xdotool", "mousedown", String(button)]); held.add(button);

 return;
        case "pointer_up": await run(["xdotool", "mouseup", String(button)]); held.delete(button);

 return;
        case "type": await run(["xdotool", "type", "--clearmodifiers", "--delay", "0", "--", action.text]);

 return;
        case "key": {
          const key = action.key.split("+").map(part => ({ Meta: "super", Command: "super", Cmd: "super", Control: "ctrl", Ctrl: "ctrl", Alt: "alt", Option: "alt", Shift: "shift", Enter: "Return", Backspace: "BackSpace", Escape: "Escape", Space: "space", PageUp: "Prior", PageDown: "Next" })[part] ?? part).join("+");
          await run(["xdotool", "key", "--clearmodifiers", "--", key]);

 return;
        }

        case "scroll":
          for (const [delta, negative, positive] of [[action.deltaY, 4, 5], [action.deltaX, 6, 7]]) {
            if (delta && negative && positive) await run(["xdotool", "click", "--repeat", String(Math.min(40, Math.ceil(Math.abs(delta) / 40))), "--delay", "10", String(delta > 0 ? positive : negative)]);
          }
      }
    },
    release,
    async close() { if (display && held.size) await release(); },
  };
}
