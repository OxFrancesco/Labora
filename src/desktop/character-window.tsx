import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { render, useGpuixRequired, type ImgInstance } from "@gpuix/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { Schema } from "effect";
import { allCharacters, characterForColor, characterModel } from "./avatars";
import { Avatar, Button, Label } from "./icons";
import { color } from "./theme";
import { CharacterWindowAction, CharacterWindowCommand } from "./character-window-contracts";

function Preview({ tint, name }: { tint: string; name: string }) {
  const image = useRef<ImgInstance | null>(null);
  useLayoutEffect(() => {
    const pixels = readFileSync(characterModel(tint).replace(/\.usdz$/, ".gallery.rgba"));
    image.current?.setImagePixels(320, 320, pixels);
  }, [tint]);

  return <img ref={image} alt={name} objectFit="contain" style={{ width: 104, height: 104, pointerEvents: "none" }} />;
}

function CharacterWindow() {
  const renderer = useGpuixRequired();
  const [state, setState] = useState({ color: "", saving: false, error: "" });
  const [choice, setChoice] = useState<string | null>(null);
  const character = characterForColor(choice ?? state.color);
  const selected = character.color === state.color;

  useEffect(() => {
    const receive = (input: CharacterWindowCommand) => CharacterWindowCommand.match(Schema.decodeUnknownSync(CharacterWindowCommand)(input), {
      State: (next) => setState(next),
      Activate: () => renderer.activateWindow?.(),
    });

    process.on("message", receive);
    const directory = process.env.LABORA_PACKAGED === "1" ? dirname(process.execPath) : resolve(import.meta.dir, "../../dist");
    const native = dlopen(resolve(directory, "liblabora-bubble.dylib"), { labora_character_window_prepare: { args: [], returns: FFIType.void } });
    native.symbols.labora_character_window_prepare();
    process.send?.(CharacterWindowAction.cases.Ready.make({}));

    return () => { process.off("message", receive); native.close(); };
  }, [renderer]);

  return (
    <div testId="character-window" onKeyDown={(event) => { if (event.key === "escape") process.exit(0); }} style={{ width: "100%", height: "100%", backgroundColor: color.canvas, display: "flex", flexDirection: "column", padding: 24, gap: 20 }}>
      <Label size={22}>Choose a character</Label>
      <div style={{ display: "flex", flexGrow: 1, minHeight: 0, gap: 24 }}>
        <div testId="character-grid" style={{ display: "flex", flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflowY: "scroll", flexDirection: "column" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start", paddingRight: 12, paddingBottom: 12 }}>
            {allCharacters.map((item) => <Button key={item.file} id={`character-${item.name.toLowerCase()}`} label={`Preview ${item.name}`} active={item.color === character.color} onClick={() => setChoice(item.color)} style={{ width: 120, height: 140, padding: 6, flexDirection: "column", gap: 2, borderWidth: 1, borderColor: item.color === character.color ? color.secondary : "transparent", borderRadius: 14 }}>
              <Preview tint={item.color} name={item.name} />
              <Label size={13}>{item.name}</Label>
            </Button>)}
          </div>
        </div>
        <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <Avatar tint={character.color} size={240} />
          <Label size={24}>{character.name}</Label>
          <Label secondary size={14} style={{ textAlign: "center" }}>{character.material}</Label>
          <Button id="character-use" label={state.saving ? "Saving character" : selected ? `${character.name} selected` : `Use ${character.name}`} active onClick={() => { if (!state.saving && !selected && state.color) process.send?.(CharacterWindowAction.cases.Select.make({ color: character.color })); }} style={{ marginTop: 12, width: 208, minHeight: 42, opacity: state.saving ? 0.6 : 1 }}>
            <Label>{state.saving ? "Saving…" : selected ? "Selected" : `Use ${character.name}`}</Label>
          </Button>
          {state.error ? <Label size={13} style={{ color: color.error, textAlign: "center" }}>{state.error}</Label> : null}
        </div>
      </div>
    </div>
  );
}

process.on("disconnect", () => process.exit(0));

render(<CharacterWindow />, { title: "Labora Characters", appName: "Labora", width: 1000, height: 760, minWidth: 760, minHeight: 540, windowBackground: "opaque", resizable: true });
