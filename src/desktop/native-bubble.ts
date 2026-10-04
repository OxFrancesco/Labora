import { dlopen, FFIType } from "bun:ffi";
import { dirname, resolve } from "node:path";
import { shortcutCode, shortcutLabel, type Shortcut } from "./shortcut";

export function createNativeBubble() {
  const directory = process.env.LABORA_PACKAGED === "1" ? dirname(process.execPath) : resolve(import.meta.dir, "../../dist");

  const library = dlopen(resolve(directory, "liblabora-bubble.dylib"), {
    labora_shortcut_register: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    labora_shortcut_clear: { args: [], returns: FFIType.void },
    labora_shortcut_poll: { args: [], returns: FFIType.i32 },
    labora_bubble_prepare: { args: [], returns: FFIType.i32 },
    labora_bubble_visible: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });

  return {
    register(shortcut: Shortcut) {
      const { code, modifiers } = shortcutCode(shortcut);
      const status = library.symbols.labora_shortcut_register(code, modifiers);

      if (status !== 0) throw new Error(`${shortcutLabel(shortcut)} is unavailable. Another app or macOS may be using it. Choose another shortcut.`);
    },
    clear: () => library.symbols.labora_shortcut_clear(),
    poll: () => library.symbols.labora_shortcut_poll(),
    prepare: () => library.symbols.labora_bubble_prepare() === 1,
    visible: (show: boolean, restoreFocus = true) => library.symbols.labora_bubble_visible(show ? 1 : 0, restoreFocus ? 1 : 0) === 1,
    close() { library.symbols.labora_shortcut_clear(); library.close(); },
  };
}
