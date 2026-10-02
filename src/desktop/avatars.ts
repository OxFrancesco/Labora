import { join } from "node:path";

export const characters = [
  { color: "#8450e5", name: "Spark", material: "Lavender matte silicone", file: "spark.usdz" },
  { color: "#0788e9", name: "Cube", material: "Blue frosted glass", file: "cube.usdz" },
  { color: "#f42846", name: "Pyramid", material: "Coral glazed ceramic", file: "pyramid.usdz" },
  { color: "#dfb845", name: "Star", material: "Hand-worked yellow clay", file: "star.usdz" },
  { color: "#6ba87b", name: "Hexagon", material: "Green brushed metal", file: "hexagon.usdz" },
  { color: "#ececec", name: "Pebble", material: "Ivory felt", file: "pebble.usdz" },
] as const;

const assets = process.env.LABORA_ASSETS_DIR ?? join(import.meta.dir, "../../assets");

export function characterForColor(tint: string) {
  return characters.find((character) => character.color === tint.toLowerCase()) ?? characters[5];
}

export function characterModel(tint: string) {
  return join(assets, "characters3d", characterForColor(tint).file);
}
