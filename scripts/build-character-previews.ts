import { writeFile } from "node:fs/promises";
import { characters, characterModel } from "../src/desktop/avatars";
import { closeAvatarRenderer, renderAvatar } from "../src/desktop/avatar-renderer";
import { avatarPose } from "../src/desktop/avatar-motion";

try {
  for (const character of characters) {
    const model = characterModel(character.color);
    const frame = await renderAvatar({ model, width: 160, height: 160, ...avatarPose("idle", 0, true, false) });
    await writeFile(model.replace(/\.usdz$/, ".rgba"), frame.pixels);
  }
} finally { closeAvatarRenderer(); }
