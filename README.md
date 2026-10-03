# Labora

A native GPUix macOS client for personal Pi agents. Connect a computer over Tailscale or pair a Cloudflare Linux desktop. Each bot has its own Pi process, conversation, workspace, and provider credentials. Executor connects to the bot itself.

The backend uses Effect 4.0.0 and Pi 1.0.0. The macOS interface uses GPUix 0.10.0 and React 19.3.0. The current anti-slop and Effect lint rules run during every desktop build.

## Desktop development

```sh
bun install
bun scripts/build-desktop-helper.ts
bun run desktop
```

Build a standalone Apple Silicon app:

```sh
bun run build:desktop
open dist/Labora.app
```

The bundle includes Bun, GPUix, Pi's workers and assets, the clipboard helper, and Labora Computer. It defaults to ad-hoc signing for local development. Set `LABORA_SIGN_IDENTITY` to your Developer ID for a signed build. Distribution notarization is a separate step.

The native app stores its private connection credentials and drafts under `~/Library/Application Support/Labora`. Set `LABORA_DESKTOP_DATA_DIR` to use another profile.

Each bot can use one of six Blender characters: Spark, Cube, Pyramid, Star, Hexagon, or Pebble. Select a character when creating a bot or click its avatar in Details. The app renders the USDZ geometry through SceneKit and Metal, with pointer-driven rotation in Details. Editable Blender sources, GLB/USDZ exports, and validation records are in [assets/characters3d](assets/characters3d/README.md). The image-generation concepts remain in [assets/characters](assets/characters/README.md) as references only.

## Connect a personal computer

In Labora, choose **Connect a computer → Connect with Tailscale**. Your browser guides sign-in, lists your computers, and asks you to approve the selected connection. The app saves the approved connection automatically.

On the computer you want to share, choose **Set up this computer**, sign in to Tailscale, and select **Enable access**. Setup adds only the private `/labora` HTTPS route and preserves existing Tailscale routes. Each client still needs your approval. This does not grant macOS screen or input permissions.

For a companion installed from source, start the same browser setup with:

```sh
bun scripts/computer-build-macos.ts
bun scripts/computer-serve.ts --setup
```

The packaged app also provides a companion command:

```sh
"dist/Labora.app/Contents/MacOS/Labora" --computer --setup
```

The companion listens on `127.0.0.1:7778`. Tailscale must be installed on both devices, and browser approval requires a personal, untagged Tailscale account. If `/labora` is already used by another service, setup stops without replacing it. Manual address/code entry remains under **Advanced connection**; start the companion with `--pair-code` to issue a temporary code. Cloudflare desktops use that separate managed pairing flow.

Set `LABORA_COMPUTER_DATA` for persistent companion state, `LABORA_COMPUTER_NAME` for its display name, or `LABORA_COMPUTER_PORT` for another port. An existing Linux X11 machine also needs `LABORA_DISPLAY` and the capture/input programs documented in [computer setup](cloud/README.md). Windows and Wayland capture/input are not implemented.

On macOS, grant Screen Recording and Accessibility to **Labora Computer** from its menu when you want to enable computer control. A successful build or pairing does not grant those permissions.

## Bots and integrations

Create a bot on a connected computer, then open **Connect apps**. ChatGPT uses the new subscription sign-in flow. Executor uses the bot's own OAuth connection to `https://executor.sh/labora/mcp`. `LABORA_EXECUTOR_URL` changes the endpoint for another organization; `LABORA_OPENAI_MODEL` selects the model, defaulting to `gpt-6-astra` with high reasoning.

The agent streams its messages and tool activity to the client. Characters show thinking, writing, tool use, questions, approval waiting, context compaction, retrying, completion, failure, cancellation, and reconnecting. Idle characters breathe and blink in Details. macOS Reduce Motion keeps distinct static poses, and background windows stop repeating animation frames. Background bot status does not start an idle Pi process.

Connected Executor operations run without per-action approval prompts. Files created in the bot's workspace appear in Library. Desktop control has explicit user/agent ownership and rejects input using stale frames or a different display.

Routines start paused and support a one-time date or recurring schedule. Each routine uses a separate Pi conversation, with its own results and approvals. The companion must be running when a routine is due. Missed runs are recorded without automatic replay. These conversations share the bot's workspace sandbox.

Settings saves sidebar, details-panel and dictation-language preferences. On macOS 14 or later, the microphone button offers on-device dictation when the selected language is available. You review the transcript before inserting it into the draft; it is never sent automatically.

For a headless ChatGPT sign-in, use `bun run agent login --headless`. Open the printed authorization link in your browser on the same machine, or follow the hidden callback-input prompt. This is Labora's own application authorization and remains subject to OpenAI account eligibility.

Each bot keeps its own application registration. To connect a different ChatGPT account or workspace, create a separate bot instead of reusing another account's registration. A fresh Hydra bot successfully authenticated on 2026-10-02, answered through GPT-5.5, and selected Executor documentation tools through Pi code mode. The native client also passed real streaming, Stop, and transcript-restart checks. These local results do not authenticate a separate Cloudflare-hosted bot.

Workspace bash, read, write and edit run without approval prompts inside the OS sandbox. The sandbox allows workspace changes and public web access while denying reads and writes to personal files, sibling bot credentials, private networks and host control. Tools fail closed when sandbox support is unavailable. macOS uses Seatbelt; Linux requires the sandbox runtime dependencies. Commands have a 120-second default timeout, a 600-second maximum and a 16 MB output limit. Connected Executor tools run without per-action approval prompts and use the connected account. They are outside the local filesystem sandbox. Desktop input still requires approval because it can control the host outside that boundary. Executor sign-in can start, finish or be cancelled during an active task; newly connected tools refresh before the next task. Cloudflare desktops instead run in their own containers. See [Cloudflare setup](cloud/README.md) and the [subscription eligibility findings](research/pi-chatgpt.md) before offering a shared hosted service.

## Working with an agent

The model can call `ask_user` with up to three questions, optional choices, and free-text answers. Questions appear in the conversation and remain available after reconnecting. Answer them or choose Skip; questions expire after five minutes. They are separate from permissions and cannot approve a tool action.

You can keep typing while the agent works. **After current step** steers its next model turn after the current response and tool calls. **After this task** queues a follow-up until the current work finishes. Both support attachments. Accepted messages stay visible while queued. Steering dismisses a pending model question as redirected, but never approves a consequential tool. Stop cancels the run and clears its questions and queued messages. Inputs target the exact bot, conversation, and run; rejected sends preserve the draft.

`update_plan` records a short checklist for multi-step work, with one active step at a time. Plans persist with their conversation. Terminal/tool output appears incrementally, and automatic context compaction has its own activity state.

The baseline tools include file/image reading, writing and editing, `bash`, `grep`, `find`, directory listing, code mode, and Executor integration discovery. Computer tools depend on the connected companion's capabilities. Cloud browser reads return public HTTPS pages through Kitesurf; personal companions can use an appropriate Executor integration. A general web-search provider and interactive terminal sessions are not bundled. Search tools download `rg` and `fd` from their official GitHub releases into each bot's private tool cache on first use, so that first use needs network access.

## Verify

```sh
bun run typecheck
bun run lint
bun src/backend/verify.ts
bun run verify:desktop --source
bun run build:desktop
bun run verify:desktop
bun scripts/verify-agent-controls.ts --source
```

The native verification records real pairing, bot creation, persistence, file operations, clipboard attachments, and panel interactions. It uses isolated local state and does not substitute a fake model response or desktop capture. Linux desktop verification is in `scripts/computer-e2e-linux.ts`.

The separate agent-controls verifier uses a controlled local Responses provider with real Pi workers and the native UI. It checks the inputs received by subsequent model requests. `bun scripts/verify-live-agent-controls.ts` uses the already authenticated local Hydra bot and the packaged native app, companion, and worker; it sends actual subscription requests and preserves credentials under `.labora`.

The bounded CLI remains available for diagnosing an integration:

```sh
bun run agent connect
bun run agent tools
bun run agent check
```

`check` invokes Executor through embedded Pi and searches the connected Cloudflare Docs integration. It proves an upstream read, independently of model inference. CLI state is under `.labora/bots/<id>`; choose the bot with `LABORA_BOT_ID` and its root with `LABORA_DATA_DIR`.

See [verification evidence](verification/README.md), [implementation progress](docs/implementation-plan.md), and [research](research/README.md) for what has actually been checked and what remains open.
