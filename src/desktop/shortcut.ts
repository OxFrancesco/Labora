import { Schema } from "effect";

export const Shortcut = Schema.Struct({
  key: Schema.String,
  cmd: Schema.Boolean,
  shift: Schema.Boolean,
  alt: Schema.Boolean,
  ctrl: Schema.Boolean,
});

export interface Shortcut extends Schema.Schema.Type<typeof Shortcut> {}

export const defaultShortcut: Shortcut = { key: "space", cmd: true, shift: true, alt: false, ctrl: false };

const keyCodes = new Map<string, number>(Object.entries({ a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, tab: 48, space: 49, "`": 50, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103, f10: 109, f12: 111, f4: 118, f2: 120, f1: 122, left: 123, right: 124, down: 125, up: 126 }));

export function shortcutCode(shortcut: Shortcut) {
  const code = keyCodes.get(shortcut.key);

  if (code === undefined || !(shortcut.cmd || shortcut.alt || shortcut.ctrl)) throw new Error("Use Command, Option, or Control with a letter, number, Space, or function key.");

  return { code, modifiers: (shortcut.cmd ? 256 : 0) | (shortcut.shift ? 512 : 0) | (shortcut.alt ? 2048 : 0) | (shortcut.ctrl ? 4096 : 0) };
}

export function shortcutLabel(shortcut: Shortcut) {
  return `${shortcut.ctrl ? "⌃" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${shortcut.cmd ? "⌘" : ""}${shortcut.key === "space" ? "Space" : shortcut.key.toUpperCase()}`;
}
