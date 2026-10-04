import { join } from "node:path";

export const characters = [
  { color: "#8450e5", name: "Spark", material: "Lavender matte silicone", file: "spark.usdz" },
  { color: "#0788e9", name: "Cube", material: "Blue frosted glass", file: "cube.usdz" },
  { color: "#f42846", name: "Pyramid", material: "Coral glazed ceramic", file: "pyramid.usdz" },
  { color: "#dfb845", name: "Star", material: "Hand-worked yellow clay", file: "star.usdz" },
  { color: "#6ba87b", name: "Hexagon", material: "Green brushed metal", file: "hexagon.usdz" },
  { color: "#ececec", name: "Pebble", material: "Ivory felt", file: "pebble.usdz" },
] as const;

export const collectionCharacters = [
  {"color": "#f5bf35", "name": "Scout", "material": "The curious one", "file": "scout.usdz"},
  {"color": "#cdbda3", "name": "Dozer", "material": "The unhurried one", "file": "dozer.usdz"},
  {"color": "#b9be79", "name": "Pip", "material": "The patient grower", "file": "pip.usdz"},
  {"color": "#ded0e4", "name": "Mochi", "material": "The affectionate one", "file": "mochi.usdz"},
  {"color": "#172643", "name": "Nib", "material": "The thoughtful writer", "file": "nib.usdz"},
  {"color": "#d98950", "name": "Crumb", "material": "The eager imperfect one", "file": "crumb.usdz"},
  {"color": "#788044", "name": "Moss", "material": "The quiet caretaker", "file": "moss.usdz"},
  {"color": "#d58474", "name": "Pocket", "material": "The helpful organizer", "file": "pocket.usdz"},
  {"color": "#f4cd58", "name": "Tumble", "material": "The playful problem solver", "file": "tumble.usdz"},
  {"color": "#7b8795", "name": "Peb", "material": "The steady companion", "file": "peb.usdz"},
  {"color": "#f6aa39", "name": "Flick", "material": "The restless idea maker", "file": "flick.usdz"},
  {"color": "#f2b18a", "name": "Loop", "material": "The patient explainer", "file": "loop.usdz"},
  {"color": "#a5d5d6", "name": "Jelly", "material": "The easily impressed one", "file": "jelly.usdz"},
  {"color": "#9492ce", "name": "Orbit", "material": "The distracted stargazer", "file": "orbit.usdz"},
  {"color": "#8ca0b7", "name": "Echo", "material": "The attentive listener", "file": "echo.usdz"},
  {"color": "#f3e6d0", "name": "Wisp", "material": "The shy night owl", "file": "wisp.usdz"},
  {"color": "#e7b637", "name": "Knob", "material": "The stubborn perfectionist", "file": "knob.usdz"},
  {"color": "#ee8b78", "name": "Sprig", "material": "The cheerful tinkerer", "file": "sprig.usdz"},
  {"color": "#b8d3e8", "name": "Puff", "material": "The comforting daydreamer", "file": "puff.usdz"},
  {"color": "#494443", "name": "Rook", "material": "The resourceful little builder", "file": "rook.usdz"},
  {"color": "#eee0ca", "name": "Marble", "material": "The meticulous collector", "file": "marble.usdz"},
  {"color": "#f79a48", "name": "Noodle", "material": "The flexible improviser", "file": "noodle.usdz"},
  {"color": "#a7ae91", "name": "Patch", "material": "The earnest apprentice", "file": "patch.usdz"},
  {"color": "#bf6370", "name": "Dimple", "material": "The mischievous minimalist", "file": "dimple.usdz"},
] as const;

export const allCharacters = [...collectionCharacters, ...characters];

const assets = process.env.LABORA_ASSETS_DIR ?? join(import.meta.dir, "../../assets");

export function characterForColor(tint: string) {
  return allCharacters.find((character) => character.color === tint.toLowerCase()) ?? characters[5];
}

export function characterModel(tint: string) {
  return join(assets, "characters3d", characterForColor(tint).file);
}
