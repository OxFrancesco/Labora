import type { StyleDesc } from "@gpuix/react";
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

export const composerTextStyle = {
  flexGrow: 1,
  minWidth: 0,
  paddingTop: 5,
  paddingBottom: 5,
  fontSize: 14,
  lineHeight: 22,
  color: color.text,
  backgroundColor: "transparent",
} satisfies StyleDesc;

export const composerButtonStyle = {
  width: 32,
  height: 32,
  padding: 6,
  flexShrink: 0,
  borderRadius: 16,
} satisfies StyleDesc;
