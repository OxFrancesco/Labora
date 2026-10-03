# Labora icon

Generated with OpenAI's built-in imagegen tool. The original artwork is `labora-source.png`; the prompt is in `prompt.txt`.

Run `bun scripts/build-icons.ts` on macOS to rebuild the exports.

- `Labora.icns`: macOS app bundle icon, 16–1024 pixels.
- `favicon.ico`: browser icon with 16, 32, and 48 pixel entries.
- `icon-16.png`, `icon-32.png`, `icon-48.png`: browser PNGs.
- `apple-touch-icon.png`: 180 pixel home screen icon.
- `icon-192.png`, `icon-512.png`: web app icons. Use `purpose: "any"` in a web manifest.
- `icon-1024.png`: large PNG export.
- `favicon.json`: embedded favicon for Labora's local browser pages, which have no public asset server.

The desktop build copies `Labora.icns` into its signed bundle. The connection, approval, and computer setup pages use the same artwork as their favicon.
