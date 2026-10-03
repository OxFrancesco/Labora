import { characters } from "./avatars";

export const color = {
  canvas: "#080808",
  sidebar: "#111111",
  panel: "#080808",
  surface: "#252525",
  composer: "#303030",
  selected: "#303030",
  border: "#1b1b1b",
  text: "#eeeeee",
  secondary: "#929292",
  muted: "#656565",
  error: "#ee8b86",
};

export const terminalFont = "Menlo";

export const font = ".AppleSystemUIFont";

export const botColors = characters.map((character) => character.color);
