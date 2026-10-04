# Labora 3D characters

Six original volumetric characters built in Blender 5.2.0. Their only facial features are two small, shallow matte cartoon eyes, each with one cream catchlight. There are no mouths or eyebrows. Each body, eye, catchlight, and felt strand is mesh geometry. The concept PNGs, including `assets/characters/cute-reference/concept.png`, are visual inspiration only. No model contains an image plane or a base-color photograph.

| Character | Surface | Triangles |
| --- | --- | ---: |
| Star | Warm yellow clay with a soft puffed shape and subtle grain | 12,768 |
| Cube | Blue frosted glass with broad rounded bevels | 8,588 |
| Hexagon | Green satin brushed metal with soft rounded bevels | 8,932 |
| Spark | Lavender matte silicone | 11,392 |
| Pyramid | Coral ceramic with a soft glaze and rounded tip | 6,900 |
| Pebble | Ivory felt, including 1,800 short, tidy solid fibre strands | 49,408 |

Each character has an editable `{name}.blend`, a self-contained `{name}.glb`, and a self-contained `{name}.usdz`. `labora-characters.blend` contains the complete collection and portrait lighting. Individual Blender files retain separate named eye and catchlight objects and an editable copy of the procedural source material. The eyes follow the body curvature and protrude by at most 0.016 units. Their centers are 0.35 units apart, with slightly smaller proportions on Spark. Each model contains five mesh objects; Pebble has a sixth mesh for its fibres. Surface normal textures are baked for portability and packed inside the exported models and Blender files.

The six exported models use **+Y up and +Z facing forward**. Their maximum extent is roughly 2.2 units. GLB viewers can start with `camera-orbit="15deg 78deg 105%"`; a native orthographic camera can use a scale near 2.8. Camera and lights are omitted from each portable model so the application controls lighting.

glTF preserves transmission, clearcoat, sheen, and anisotropy through material extensions. USDZ exports use USD Preview Surface; viewers may approximate glass transmission, silicone subsurface scattering, and sheen differently. The baked normal detail and mesh fibres remain portable. Runtime color should be checked under the application's light rig.

`contact-sheet.png` shows the six final Blender renders. `turnaround.png` shows front, side, and back views in that order. `manifest.json` records source mesh counts, bounds, and the eyes-only face specification. `validation.json` records hashes and actual reopen/import results for every format: two eyes and two catchlights with no mouth or eyebrow, shallow eye dimensions, closed original mesh components with positive volume, matching mesh and triangle counts on GLB reimport, embedded textures, and the USDZ coordinate system.

Rebuild from the repository root:

```sh
blender --background --factory-startup --python scripts/blender-characters.py
blender --background --factory-startup --python scripts/blender-characters.py -- --validate
```

Use `--only star` to rebuild one character, `--contact-sheet` to refresh the collection render and manifest, or `--turnaround` to regenerate the three-view proof. On this Mac, Blender's Metal initialization requires execution outside the restricted filesystem sandbox.

The official exporter reference was obtained with `codeview` at `resources/gltf-blender-io`. The running exporter comes from Blender's bundled `io_scene_gltf2` version 5.2.39. All geometry and material recipes are in `scripts/blender-characters.py`.

The native app also bundles a 160 x 160 RGBA preview per character. `bun scripts/build-character-previews.ts` renders these from the USDZ models with the same SceneKit lighting and neutral pose used by the app. The picker and the first visible avatar frame use these local previews immediately; the large avatar then renders its interactive 3D animation. Desktop builds regenerate and validate the previews.

## Expanded collection

The native gallery includes 24 additional Blender pets, Scout through Dimple. Their editable sources are versioned in `sources/`. Generated GLB exports and render deliverables remain in `output/blender/labora-pets-20261004/`. These pets have their own faces and silhouettes; the eyes-only specification above applies to the original six.

`bun scripts/build-character-previews.ts` generates 160-pixel avatar previews and 320-pixel gallery previews for all 30 characters. Gallery tiles use static previews; the selected large preview uses the interactive SceneKit model. The package includes the additional USDZ models and both preview sizes, without duplicating the editable source collection.

To regenerate the editable collection, run `scripts/blender-pet-collection.py` in Blender and copy the resulting individual `.blend` files from `output/blender/labora-pets-20261004/` into `sources/`. The generation prompts are versioned in `collection-concepts.json`; local concept images are optional editing references.

Export the new runtime models with `blender --background --python scripts/export-pet-runtime.py`. The exporter selects the neutral frame, omits hidden smiling-eye geometry, reduces dense mesh detail, and exports Y-up USDZ without stage lights or cameras. It never modifies the editable Blender sources. Mesh counts and export sizes are recorded in `collection-runtime.json`.

`bun scripts/verify-character-gallery.ts` exercises the native + window, all 24 saves, failure/retry, minimum window size, Escape, and reopening. Set `LABORA_GALLERY_EXECUTABLE` to test a packaged gallery executable. Screenshots and a walkthrough are saved in `evidence/character-gallery/`.
