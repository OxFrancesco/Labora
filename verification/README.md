# Executor verification

Verified on 2026-10-02 with Bun and Pi 1.0.0.

- `bun run typecheck` passed.
- Labora's OAuth client authenticated to `https://executor.sh/labora/mcp` and loaded seven Executor tools.
- `bun run agent check` used the embedded Pi session to call Executor's MCP tool, discover the Cloudflare Docs search tool, and retrieve five real results. See [executor-check.json](executor-check.json).
- The check exits after emitting Pi's session shutdown event, which closes MCP connections. The command completed with exit code 0.
- A fresh bot with a separate data directory reported `needs sign-in` and exited 1. It did not inherit the main bot's Executor credentials.
- A fresh bot with a dummy API key and no subscription OAuth refused chat before inference and exited 1.
- The main bot's OAuth file has mode 0600 inside a directory with mode 0700. `.labora/` is excluded from source control.
- `codex mcp get executor --json` reported `No MCP server named 'executor' found` after the mistaken client integration and OAuth credentials were removed.

The diagnostic invokes a fixed read-only MCP tool directly in the embedded runtime. It does not test an LLM selecting the tool, Pi codemode execution, ChatGPT inference, Cloudflare deployment, or the native Labora interface.

The local folders separate bot state. They do not sandbox terminal access. Model-side Executor resume remains blocked in the diagnostic CLI. The new desktop backend has a human approval channel, which needs its own live integration verification.

## Native source walkthrough

`scripts/verify-desktop.ts --source` passed its initial nine-step walkthrough against a real isolated companion. Evidence is under `evidence/desktop-source-2026-10-02T11-55-52-808Z/`, including a native recording and `verification.json`. It verified pairing rejection and acceptance, two stored bots, independent drafts, continuous panel resizing, tabs, sidebar expansion, and closing/reopening details.

An expanded run also verified bot name/label persistence, a real workspace file, and ordered native clipboard file paste. Its runner failed while reading the clipboard fixture's shutdown response. That run is partial evidence, not a complete pass. The next packaged run covers both the UI and its bundled companion/Pi workers.

## Backend subprocess verification

`bun src/backend/verify.ts` uses actual Pi child processes with isolated temporary storage. It checks exclusive host ownership, separate process identities, signed-out status and inference refusal, event replay, invalid approval rejection, metadata persistence, scoped downloads, traversal/symlink rejection, and process cleanup. It does not send provider requests.

## Packaged native app

`evidence/desktop-packaged-2026-10-02T14-03-23-298Z/verification.json` records 19 passing checks against the actual standalone macOS executable and its packaged companion/Pi workers. It includes the six eyes-only Blender characters, actual pointer-driven 3D rotation, saved Star selection, independent drafts, metadata, workspace files, ordered file/PNG clipboard paste, restored system clipboard, panel changes, and a new GUI process restoring the same profile. A signed-out send correctly leaves the draft and attachments intact. `walkthrough.mp4` and `restart/walkthrough.mp4` record those runs.

Accepted-send draft preservation and OAuth cancellation races have source fixes but no live-provider proof. Finder drag/drop and microphone recording were not verified.

## Cloudflare

`artifacts/computer-cloud-e2e/result.json` records 13 real deployed checks: owner/pairing boundaries, capture, terminal input with independent file readback, a Kitesurf public-page read, snapshot suspension, restored computer identity/credentials/workspace, and final suspension. The Worker uses Francesco's personal account and the September 30 Sandbox 1.0 container APIs. Screenshots and `cloud-desktop.mp4` are alongside the manifest. No model inference occurs in this verification.

## Final 3D characters and installed app

`assets/characters3d/validation.json` records the actual Blender reopen, GLB reimport, and USDZ archive checks. All six have real volume geometry, two eyes and two catchlights, no mouth or eyebrows, and embedded material textures. The editable Blender sources and portable models use distinct clay, glass, metal, silicone, ceramic, and felt materials.

`evidence/avatar3d-packaged-2026-10-02T14-03-16-341Z/verification.json` links each model hash to actual SceneKit/Metal rendering. The native GUI recording verifies that the picker loads all six and a pointer move rotates the Details model. Its cropped window comparison changes 9,753 pixels with both pointer positions inside the avatar. An actual immediate-close/restart flow verifies the preference-saving fix after the UI change appears.

`evidence/installed-cute-2026-10-02/verification.json` confirms that all 255 installed files match the tested bundle, deep strict code-sign verification passes, and the installed runtime loads its dependencies. CUA then launched `~/Applications/Labora.app` and visually confirmed its eyes-only Pebble. The default profile remains unpaired.

## Cloud Executor

`artifacts/computer-cloud-e2e/executor-check.json` records a fixed diagnostic tool read through an in-memory Pi session inside the deployed container. It reports five Cloudflare documentation results and retains three titles and URLs. `executor-auth.json` records Executor ready before and after restoring the filesystem snapshot, OpenAI signed out, and final suspension. This is an actual upstream integration read, without a model-selected tool call.

The final character revision uses smaller, shallow, closely spaced eyes and softer shapes and materials. SceneKit uses broad area lights with fill; its glass import receives a frosted-surface correction. No face contains a mouth, eyebrow, or realistic eyeball.

## Browser enrollment, settings and routines

`evidence/desktop-packaged-2026-10-02T15-15-37-393Z/verification.json` records 24 passing native checks. New coverage includes persisted settings, nested language-menu dismissal, creating a paused routine, enabling/pausing it, and a real signed-out blocked run with an unchanged direct conversation. The 256-file installed bundle matches exactly; `evidence/installed-browser-setup-20261002` records runtime/signature checks and the visible installed connection dialog.

`evidence/enrollment-browser-2026-10-02T15-10-49-212Z/result.json` records actual browser consent, private credential persistence, inactive-before-ack behavior and authenticated access after acknowledgement. `evidence/enrollment-browser-2026-10-02T15-13-03-973Z/lifecycle.json` covers persistence failure, revocation failure/retry, cancellation before consent, and cancellation during saving. Tailscale discovery, HTTPS transport and identity headers are fixtures; the companion, authority store and production browser page are real.

`evidence/computer-setup-browser-2026-10-02T15-17-38-670Z` contains eight passing target-setup browser checks and a recording. It uses an injected Tailscale adapter. Source launcher and packaged companion checks are under `evidence/computer-setup-launcher-2026-10-02T15-16-09-890Z` and `evidence/computer-setup-packaged-2026-10-02T15-18-01-944Z`. No personal Tailscale routes, permissions or enrollment changed.

`artifacts/routines-backend-e2e/result.json` covers 12 routine checks with real Pi processes; `artifacts/enrollment-e2e/result.json` covers 11 companion/authority checks. `artifacts/model-runtime-e2e/result.json` verifies 16 simultaneous real Pi runtimes use one complete private device identity. None sends an inference request.

On-device voice is bundled and runtime verification confirms its permission owner is `org.buddytools.Labora`. No microphone recording was performed.

## Hydra ChatGPT and activity animations

A fresh bot-specific Labora registration completed ChatGPT headless authorization through Helium with the Hydra account. The earlier workspace-scoped registration remains separate. The local Hydra bot answered a real arithmetic request with `437`, then selected Executor through codemode and made three successful documentation calls. `evidence/hydra-chatgpt-20261002/inference.json` records redacted model and integration evidence. No API key or first-party client ID was substituted.

`evidence/live-chatgpt-source-2026-10-02T16-16-43-176Z/result.json` records seven passing checks with the production native composer, companion, Pi worker, and real ChatGPT subscription. Text painted before completion, the deltas exactly reconstructed the final saved reply, Stop cancelled another real response, and a restarted app painted the saved transcript. Screenshots and recordings accompany the result. Computer capture/control was disabled.

`evidence/activity-source-2026-10-02T16-23-56-100Z/result.json` records 17 passing native checks using an isolated local provider fixture. Pixel comparisons prove the actual Metal-rendered Details character moves during idle, thinking, writing, and tool use. Approval, decline, failure, completion, and cancellation display their actual states. Two Unicode deltas painted before completion and persisted once. Approval ran a harmless tool; decline prevented its requested file write. These fixture checks do not claim additional live inference.

`artifacts/streaming-e2e/result.json` records nine production HTTP/Pi checks for replay, offsets, reconnect, independent tools, approvals, and terminal states. Direct process checks prove polling dormant bots does not start Pi workers. `artifacts/avatar-motion/result.json` covers all ten native poses and blinking on all six real USDZ models.

Reduce Motion and inactive-app handling are implemented but were not verified by changing global system preferences. ChatGPT authorization and model use in the Cloudflare bot remain separate and unverified; the successful Hydra runs are local.
