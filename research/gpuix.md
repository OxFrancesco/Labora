# GPUix implementation notes for Labora

Checked 2026-10-02 against official docs, source snapshot `4ecca30f68057b4d9830d32675ba4ed999eeeaaa`, public npm metadata, installed package types, and the existing BuddyMac source. Labora now pins GPUix React/native `0.10.0` and React `19.3.0`. Implementation and packaged-app verification are separate from the API research below.

## Versions and entry point

Live npm metadata reports `@gpuix/react@0.10.0`, `@gpuix/native@0.10.0`, `@gpuix/cli@0.1.1`, and `react@19.3.0`. GPUix declares React `^18.0.0 || ^19.0.0`. Pin both GPUix packages exactly and upgrade them together. BuddyMac currently uses both at `0.10.0` with React `19.2.4`; that is an existing local reference, not proof that Labora has been tested. [React package](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/react/package.json), [Native package](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/package.json), [npm metadata](https://registry.npmjs.org/@gpuix/react/latest)

GPUix is a native renderer. Use its elements and controls, not DOM ShadCN, Tailwind, or Motion components. TypeScript needs `jsx: "react-jsx"` and `jsxImportSource: "@gpuix/react"`. A desktop entry imports `render` and calls `render(<App />, options)`. `bun --hot src/desktop.tsx` updates the existing window. [Quickstart](https://gpuix.dev/#quickstart)

The Grok-style window can use `titlebarTransparent`, `trafficLightX`, `trafficLightY`, `width`, `height`, `minWidth`, `minHeight`, `resizable`, and `windowBackground`. `appName` changes Hide/Quit labels; the macOS application-menu name requires an actual `.app` bundle. `focus: false` opens behind the active app. `show: false` creates a hidden window; `activateWindow()` reveals it. [Window options](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/index.d.ts#L697)

Start by reading `resources/gpuix/examples/chat.tsx` for a native chat layout and `examples/timeline.tsx` for dragging. These are reference implementations with demo behavior. The chat example's copy action explicitly does not implement a real clipboard copy. Use `example-app/` for the smallest standalone package structure. [Chat example](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/examples/chat.tsx), [Standalone example](https://github.com/remorses/gpuix/tree/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/example-app)

## APIs for the Grok interface

| Need | GPUix implementation |
| --- | --- |
| Sidebar, chat, right panel | Flex layout with numeric or percentage dimensions. Give shrinking columns `minWidth: 0` and scroll regions `minHeight: 0`. Use explicit text colors. |
| Conversation | `<virtual-list>` for long histories, `<markdown>` for messages, `<code>` for code. Read scroll position before deciding whether new tokens should scroll to the bottom. |
| Composer | `<textarea value={draft} onChange={e => setDraft(e.value ?? "")} onSubmit={send} minRows={1} maxRows={8} />`. Enter submits when `onSubmit` exists; Shift+Enter inserts a newline. |
| Tabs and icon controls | Clickable `<div role="button" aria-label="…" tabIndex={0}>`, or GPUix's Button. Implement keyboard activation and selected state. There is no intrinsic DOM `<button>`. |
| Menus and dialogs | GPUix Select, Combobox, Dialog, Tooltip, or `<anchored deferred>`. Plain absolute overlays can paint below the virtual list and misroute clicks. |
| Small transitions | GPUix exports `motion` and `AnimatePresence`. Use these only for motion present in the Grok reference. |
| Native file chooser | `useGpuix().renderer.promptForPaths(options)` returns file paths or `null` on cancel. |
| Computer preview | `<img>` with a source, or renderer `setImage` / `setImagePixels` for updated image buffers. A preview does not implement remote desktop control. |

[Host types and controls](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/js/host.ts), [React exports](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/react/src/index.ts), [Renderer methods](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/index.d.ts)

For the resizable right panel, put `onMouseDown`, `onMouseMove`, and `onMouseUp` on the same divider. GPUix captures that pressed element so movement and release continue outside its bounds, including outside the window. Store the initial pointer coordinate and panel width in a ref; compute a clamped width from their difference. Do not create a drag overlay after mouse-down to capture events. Use `cursor: "col-resize"`. The timeline example documents and exercises this behavior. [Pointer capture example](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/examples/timeline.tsx#L26)

## Attachments, paste, and drag/drop

`onFileDrop` receives absolute filesystem paths in `event.paths`. Read and validate those files at Labora's attachment boundary, preserve the selected order, and copy any content needed after the source moves into bot-owned storage. Internal attachment reordering can use captured pointer gestures. [Drop event contract](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/index.d.ts#L590)

Native input supports text selection, caret movement, IME, undo/redo, and ordinary clipboard text. When the clipboard contains only images or files, paste continues to `onKeyDown`, where the app can handle it. A mixed text/image clipboard pastes the text. The native API does not expose a general image/file clipboard reader or native file drag-out method in the inspected public types. Those require a small macOS bridge. [Input documentation](https://gpuix.dev/#text-input), [Public renderer API](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/index.d.ts)

BuddyMac has relevant existing bridges:

- [native/files/main.swift](/Volumes/T6-7/Coding/Personal/BuddyMac/native/files/main.swift:34) reads file URLs from `NSPasteboard` and uses AppKit for copying, choosing, opening, and revealing files.
- [native/platform.m](/Volumes/T6-7/Coding/Personal/BuddyMac/native/platform.m:148) starts an `NSDraggingSession` with `NSDraggingItem` file URL writers. Completion is a separate callback; starting a drag does not prove delivery.
- [src/files-view.tsx](/Volumes/T6-7/Coding/Personal/BuddyMac/src/files-view.tsx:114) handles GPUix file drops and starts native drag-out after a movement threshold.

Read these patterns; do not import BuddyMac's application identity, data directory, runtime helpers, or unrelated utility behavior. Image clipboard handling needs its own implementation and visible verification.

## Accessibility and macOS control

GPUix uses AccessKit for macOS AX, Windows UIA, and Linux AT-SPI. Generic clickable divs need an explicit role and accessible name. `aria-id` supplies a native automation identifier; `testId` supplies a GPUix automation locator. They are separate. `onClick` is also wired to the accessibility Press action. Inputs, textareas, images, and text have native default roles. Browser-rendered GPUix does not have this AccessKit adapter. [Accessibility implementation](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/src/accessibility.rs)

Making Labora accessible does not grant it permission to control other apps. The THIS MAC computer requires Labora's own Accessibility and Screen Recording authorization, plus any relevant helper identity. A helper launched from T3 Code can inherit different permission behavior. Verify the installed Labora process and actual captured/input result before claiming local computer control. BuddyMac's [native verification fixture](/Volumes/T6-7/Coding/Personal/BuddyMac/native/verification/README.md) separates an independent input/drop receiver from the product app.

## Native UI verification

Use `launch` from `@gpuix/react/automation` to start the actual app executable. It communicates over stdin/stdout using the native automation protocol. The renderer enables automation when stdin is not a TTY; the launcher supplies pipes. No HTTP port is needed. Locators provide `click`, `fill`, `press`, `hover`, `wheel`, `dragTo`, `dragBy`, `textContent`, and `waitFor`. Screenshots come from the native renderer. [Automation client](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/js/automation/client.ts), [Automatic transport setup](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/js/runtime.ts#L38)

Minimal verification shape, with test IDs assigned by Labora:

```ts
import { launch } from "@gpuix/react/automation";
import { mkdtemp, mkdir } from "node:fs/promises";

const dataDir = await mkdtemp("/private/tmp/labora-ui-");
await mkdir("evidence", { recursive: true });
const app = await launch({
  command: "/absolute/path/Labora.app/Contents/MacOS/Labora",
  env: { LABORA_DESKTOP_DATA_DIR: dataDir },
});
try {
  await app.getByTestId("composer").waitFor();
  await app.getByTestId("composer").fill("Draft to preserve across bot switches");
  await app.getByTestId("details-divider").dragBy(-120, 0, { steps: 12 });
  await app.getByTestId("tab-library").click();
  await app.screenshot({ path: "/absolute/path/evidence/library.png" });
} finally {
  await app.close();
}
```

Use isolated fixture storage for UI-only runs. A second explicit live flow must verify authenticated agent behavior; synthetic transcripts do not prove inference, Executor, or computer access. Compare Grok and Labora at the same window dimensions and scale. Exercise bot switching with draft preservation, submission/cancellation, tabs, divider limits, menus, keyboard shortcuts, ordered attachments, copy/paste, and library/computer actions. Inspect the screenshots rather than accepting successful automation calls alone.

The built-in automation protocol has no OS file-drop method. `TestGpuixRenderer.simulateFileDrop` exists, but it is a test-renderer API, not proof of a Finder drag into the packaged app. Verify real Finder drops and external drag-out through native computer use and an independent receiver. Likewise, GPUix injected clicks prove its UI path, not Labora's permission to inject input into another application. [Protocol methods](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/js/automation/protocol.ts)

For a native walkthrough recording, BuddyMac's [scripts/verify-ui.ts](/Volumes/T6-7/Coding/Personal/BuddyMac/scripts/verify-ui.ts:12) captures timestamped native screenshots and encodes their real durations with ffmpeg. It supports either a source entry or a packaged executable. Adapt the mechanism and label fixture runs accurately. OS-native walkthroughs should also include an independent screen capture or native UI inspection when proving installed-app appearance and permissions.

Labora now has [desktop-driver.ts](/Volumes/T6-7/Coding/Personal/Labora/scripts/desktop-driver.ts) and [verify-desktop.ts](/Volumes/T6-7/Coding/Personal/Labora/scripts/verify-desktop.ts). Run `bun run verify:desktop --source` for the source UI or omit `--source` for `dist/Labora.app`. Each run creates an isolated companion and desktop profile, records native screenshots and a timed MP4, and closes its own processes. The packaged run removes external Bun from the GUI's PATH. The first completed source run verified pairing rejection/success, creation of two real bots, separate persisted drafts, continuous divider dragging, tabs, and sidebar/details state. [Source evidence](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-source-2026-10-02T11-55-52-808Z/verification.json). This is not inference, Executor, or computer-control proof.

GPUix's automation tree deliberately omits `customProps`, so input assertions should read `getPaintedText` and compare the persisted draft. Checking `element().customProps.value` fails even when the input is correct. SSE companion listeners need `idleTimeout: 0`; Bun's default idle timeout otherwise closes an idle agent event stream.

The earlier PNG-avatar standalone app run passed 18 native interaction checks, including ordered native file paste, PNG paste, metadata edits, Library readback, all six generated character assets, and Star selection. A second native app process restored the selected bot, draft, attachments, character, sidebar, and panel width. Both real Pi workers exposed empty signed-out sessions; a real rejected send preserved the draft and attachments. The compiled GUI and companion ran with external Bun absent from PATH. The clipboard fixture restored all previous clipboard representations internally. [Packaged results](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T12-58-03-596Z/verification.json), [104-second recording](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T12-58-03-596Z/walkthrough.mp4), [character picker](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T12-58-03-596Z/06-character-picker.png), [restored app](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T12-58-03-596Z/restart/12-restarted.png). Successful-send behavior remains unverified while ChatGPT authentication is unavailable.

The real Linux desktop E2E uncovered a GPUix limitation: `<img>` supports only `click`, `mouseEnter`, `mouseLeave`, and `fileDrop`. It silently discards pointer-down/move/up, scroll, and keyboard handlers. Use a regular focusable `<div>` around the image for computer input; compute the contained image bounds within that wrapper. A successful text-box action did not prove image keyboard or pointer delivery. [Image event whitelist](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/src/custom_elements/img.rs#L267), [custom-element event filtering](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/src/custom_elements/mod.rs#L376).

After moving input handlers onto that wrapper, the source native app passed the real Linux desktop flow through Tailscale HTTPS. The runner paired through the native dialog, rendered a real X11 screenshot, transferred control through the buttons, clicked the contained image at an independently verified X11 coordinate, and typed a unique marker plus Return into an isolated terminal. A separate Docker read matched the terminal's resulting file; the test then revoked its client credential. [Results](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T12-40-31-293Z/verification.json), [inspected desktop screenshot](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T12-40-31-293Z/03-typed-linux-terminal.png), [37-second recording](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T12-40-31-293Z/walkthrough.mp4). This proves the source client and local Linux container over the private Tailscale route; it does not prove a Cloudflare deployment or macOS Screen Recording/Accessibility permissions.

The final standalone package repeated that flow and additionally delivered right and middle press/release events to an independent native `xev` receiver. GPUix automation uses button 2 for right and 1 for middle; the receiving X11 events were button 3 and 2 respectively. All seven checks passed with external Bun absent from the GUI's PATH. [Packaged remote results](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T13-02-48-028Z/verification.json), [actual desktop in Labora](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T13-02-48-028Z/03-typed-linux-terminal.png), [independent X11 event log](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T13-02-48-028Z/x11-pointer-events.txt), [49-second recording](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-computer-2026-10-02T13-02-48-028Z/walkthrough.mp4). The runner revoked its temporary client and removed its terminal/event-receiver fixtures afterward.

## Packaging

The official simple path is `bun build --compile` followed by an `.app` wrapper. A raw executable has no application bundle identity or Dock icon. Use an `.icns` rather than passing a 1024-pixel PNG to cargo-packager. Packaging and code signing do not enable automatic updates. [Packaging guide](https://gpuix.dev/#5-wrap-it-in-an-app-with-an-icon)

BuddyMac's existing packaging provides a concrete local pattern:

1. Compile a small entry module into `Contents/MacOS/Labora`.
2. Copy the matching native GPUix `.node` into `Contents/MacOS`.
3. Set `NAPI_RS_NATIVE_LIBRARY_PATH` before dynamically importing the UI. Static UI imports would load the addon too early.
4. Copy required resources and licenses, and write Labora's own Info.plist and icon.
5. Sign native libraries and helpers before signing the app, verify signatures, and execute a runtime check against the bundled addon.
6. Launch and test the packaged executable with external Bun absent from PATH. Test GUI launch separately from that runtime check.

[Build script](/Volumes/T6-7/Coding/Personal/BuddyMac/scripts/build.ts:39), [Loader entry](/Volumes/T6-7/Coding/Personal/BuddyMac/src/entry.ts:5), [GPUix loader override](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/index.js#L70)

BuddyMac's entitlements and minimum macOS version are application-specific; do not copy them blindly. Labora's compiled Bun runtime, native addon, local computer helpers, and privacy usage descriptions must match its actual behavior. Notarization, installed-app permissions, successful inference, and Cloudflare execution are separate checks.

Labora's [build script](/Volumes/T6-7/Coding/Personal/Labora/scripts/build-desktop.ts) stages a standalone Apple Silicon application and retains the previous successful artifact. It sets the GPUix addon path before loading the UI, dispatches `--agent-worker` before any UI import, and packages the complete `Labora Computer.app` under `Contents/Helpers`. `LABORA_COMPUTER_APP` points to this app bundle because the helper needs its own LaunchServices and privacy identity. The minimum version is macOS 14 for the computer helper; the published GPUix binary itself reports a macOS 11 deployment target.

Pi's compiled runtime also needs explicit packaging. The official build embeds workers under the exact specifiers `./src/extensions/codemode/worker.ts` and `./src/utils/image-resize-worker.ts`. Labora creates those entries in build staging, loads Pi's Bun runtime setup to embed QuickJS WASM and register Bun OAuth, and sets `PI_PACKAGE_DIR` to the bundled Pi resources. Photon WASM lives in `Contents/Resources`, with a relative symlink next to the executable; placing the raw WASM file in `Contents/MacOS` makes strict code signing reject it as unsigned nested code. Built-in themes, export templates, docs, examples, and package metadata travel with the app. A worker that starts successfully has not yet proved that codemode or inference works. [Pi binary build](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json), [Bun runtime setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/bun/runtime-setup.ts), [Pi resource paths](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/config.ts)

The build defaults to local ad-hoc signing. `LABORA_SIGN_IDENTITY` selects an installed signing identity; Developer ID signing still does not imply notarization. The compiled executable disables automatic dotenv and bunfig loading. Its `--check-runtime` mode checks bundled dependencies without opening a window. Native interaction, OS permissions, and authenticated agent calls need their own evidence.

The same binary's `--computer` branch loads the companion host before GPUix initialization; `--agent-worker` starts a separate Pi worker. The computer branch defaults to loopback port 7778 and accepts the settings documented in `scripts/computer-serve.ts`. Check existing listeners before launching another host. Clipboard support is a separate AppKit command-line helper, bundled as `Contents/MacOS/labora-desktop`; `LABORA_DESKTOP_HELPER` tells the UI where to find it. Source runs use `dist/labora-desktop` after `bun scripts/build-desktop-helper.ts`.

Character assets now ship as editable Blender `.blend`, portable `.glb`, and native `.usdz` files in `Contents/Resources/characters3d`. The bootstrap sets `LABORA_ASSETS_DIR` to Resources and `LABORA_AVATAR_HELPER` to the signed `Contents/MacOS/labora-avatar` executable. The package contains no PNG avatar fallback. Source runs build the renderer with `bun scripts/build-avatar-renderer.ts`.

The [clipboard wrapper](/Volumes/T6-7/Coding/Personal/Labora/src/desktop/clipboard.ts) reads ordered native file URLs and PNG/TIFF images and copies text. It does not implement dictation. The E2E-only clipboard fixture keeps the original clipboard representations inside its process, restores them after the paste action, and preserves a newer clipboard if the user changes it during verification. The fixture is not shipped in the application.

GPUix packages are Apache-2.0. Preserve their license notices in the packaged app. The published native targets currently list Apple Silicon macOS, x86-64 GNU Linux, and x86-64 Windows; Intel macOS and Linux ARM64 are not listed. Cloudflare Linux computers do not need to run this macOS GUI, but their screenshot/control stack must be implemented separately. [Native package and targets](https://github.com/remorses/gpuix/blob/4ecca30f68057b4d9830d32675ba4ed999eeeaaa/packages/native/package.json)


## Blender models rendered at runtime

GPUix 0.10.0 exposes `ImgInstance.setImagePixels(width, height, pixels)` for packed RGBA. Its public API does not expose a 3D mesh renderer. The inspected upstream main branch has a newer optional pixel-format argument; do not pass that fourth argument to the installed 0.10.0 API. Labora uses a persistent Swift SceneKit renderer with a Metal device, then uploads each resulting raw RGBA frame directly to GPUix. The app never loads the Blender preview PNGs. [Installed API](/Volumes/T6-7/Coding/Personal/Labora/node_modules/@gpuix/react/dist/types/host.d.ts:74), [SceneKit snapshot API](https://developer.apple.com/documentation/scenekit/scnrenderer/snapshot%28attime%3Awith%3Aantialiasingmode%3A%29).

The source assets are real volumetric meshes with two small, shallow matte cartoon eyes and one tiny geometric catchlight per eye, with no mouth or eyebrow, baked surface-normal textures, and distinct PBR materials. GLB retains portable glTF materials; USDZ supplies the native SceneKit loader, which does not import GLB through ModelIO on this Mac. USD Preview Surface approximates some Blender effects, especially glass transmission. The native renderer uses the imported material palette and deliberately restrained lighting; it does not replace body colors with screenshots. All models are Y-up, face +Z, and normalize to a common viewing size. [Blender USD export documentation](https://docs.blender.org/manual/en/latest/files/import_export/usd.html), [Asset validation](/Volumes/T6-7/Coding/Personal/Labora/assets/characters3d/validation.json).

The helper normalizes model bounds, caches loaded scenes, lights them, renders only when a frame is requested, and returns straight-alpha pixels after removing CGContext premultiplication. The TypeScript bridge validates every response and frame length, caches a bounded number of rendered poses, and kills the helper on malformed output, timeout, or app exit. Large Details avatars respond to pointer movement by changing the mesh yaw/pitch. Small avatars are static runtime renders; there is no continuous idle animation. [Swift renderer](/Volumes/T6-7/Coding/Personal/Labora/native/desktop/AvatarRenderer.swift), [GPUix component](/Volumes/T6-7/Coding/Personal/Labora/src/desktop/avatar-3d.tsx).

`bun scripts/verify-avatars.ts --packaged` loads all six bundled USDZ files through the bundled Metal renderer, checks mesh/material counts and transparency, renders two poses, compares pixel changes, and saves source model hashes with the native frames. `bun scripts/verify-desktop.ts` additionally waits for all six rendered models in the picker and compares cropped native-window pixels before and after a real pointer move over the Details avatar. These are separate from Blender's source/export validation. Running the helper inside the filesystem sandbox cannot enumerate a Metal device; actual rendering requires the same native graphics access as the GPUix app.


The final softer-character package passed verification on 2026-10-02 at 14:05 UTC. The bundled renderer loaded exactly 5 meshes per character (6 for Pebble), retained named body/eye/catchlight materials, and produced different views at two poses. The models use smaller shallow matte eyes, fuller shapes, and restrained surface texture. Model hashes identify the tested bundled assets. [Final packaged renderer results](/Volumes/T6-7/Coding/Personal/Labora/evidence/avatar3d-packaged-2026-10-02T14-03-16-341Z/verification.json).

The compiled GUI passed all 19 native E2E checks. The picker visibly rendered all six models; moving between two positions inside the Details avatar changed 9,753 cropped window pixels. Closing immediately after reopening Details and launching a new app process restored Details, the selected Star bot, both drafts, ordered attachments, name/label, sidebar state, and divider width. The earlier run caught a 150ms preference-save debounce that lost the last toggle at close; the final run verifies its fix. Clipboard contents were restored, and the temporary companion/profile were removed after success. [Final native results](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/verification.json), [pointer comparison](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/avatar-interaction.json), [picker](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/06-character-picker.png), [restored app](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/restart/12-restarted.png), [94-second walkthrough](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/walkthrough.mp4), [13-second restart walkthrough](/Volumes/T6-7/Coding/Personal/Labora/evidence/desktop-packaged-2026-10-02T14-03-23-298Z/restart/walkthrough.mp4).

Native inspection identified Cube's clear reflective-frame artifact: Blender transmission 0.52 imported as SceneKit transparent 0.48 with both faces rendered. The renderer now adapts only the named blue-glass material: retain its imported color, keep roughness at least 0.48 and opacity at least 0.94, render one transparent layer with backfaces culled, and reduce clear-coat highlights. The final Blender source also uses lower transmission. Broad native area lights, lower-side fill, and a brighter neutral environment replace the original small point highlights and dark lower shadows. Star, metal, and felt were visually compared to preserve their colors. [Original glass mapping](/Volumes/T6-7/Coding/Personal/Labora/evidence/avatar3d-material-study/cube-original.png), [corrected glass mapping](/Volumes/T6-7/Coding/Personal/Labora/evidence/avatar3d-material-study/cube-frosted.png), [final native Star](/Volumes/T6-7/Coding/Personal/Labora/evidence/avatar3d-packaged-2026-10-02T14-03-16-341Z/star-front.png), [final native Cube](/Volumes/T6-7/Coding/Personal/Labora/evidence/avatar3d-packaged-2026-10-02T14-03-16-341Z/cube-front.png).

The app passed full TypeScript/anti-slop checks, strict deep signature verification, and the standalone runtime check. Main executable SHA-256: `9e5493cf8d7e4b42800686de875dd7f8b4846355fd8dd6290cac0c7c1d26108c`. Native 3D renderer SHA-256: `aebca278a01503249157a257dbd4f2149841baa99aca8d44a5f7caa5041e0a34`. This is packaged-app evidence; installation identity is verified separately by the parent task.
