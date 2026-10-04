import { writeFile } from "node:fs/promises";
import { allCharacters, characterModel } from "../src/desktop/avatars";
import { closeAvatarRenderer, renderAvatar } from "../src/desktop/avatar-renderer";
import { avatarPose } from "../src/desktop/avatar-motion";

try {
  for (const character of allCharacters) {
    const model = characterModel(character.color);
    const frame = await renderAvatar({ model, width: 160, height: 160, ...avatarPose("idle", 0, true, false) });
    await writeFile(model.replace(/\.usdz$/, ".rgba"), frame.pixels);
    const gallery = await renderAvatar({ model, width: 320, height: 320, ...avatarPose("idle", 0, true, false) });
    await writeFile(model.replace(/\.usdz$/, ".gallery.rgba"), gallery.pixels);
  }
} finally { closeAvatarRenderer(); }
