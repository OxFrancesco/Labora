import { readFileSync } from "node:fs";

const previews = new Map<string, Buffer>();

export function avatarPreview(model: string): Buffer {
  const cached = previews.get(model);

  if (cached) return cached;
  const pixels = readFileSync(model.replace(/\.usdz$/, ".rgba"));

  if (pixels.length !== 160 * 160 * 4) throw new Error("The bundled character preview is invalid.");
  previews.set(model, pixels);

  return pixels;
}
