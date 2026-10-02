# Labora Linux desktops

The companion runs in a custom Linux container with Xvfb, Openbox, Chromium, files, a terminal, Bun and one Pi host per bot. Each Cloudflare desktop gets its own Durable Object and container. The same authenticated computer protocol is used by a personal computer companion.

The Worker follows the [September 30 Sandbox SDK 1.0 release](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/). Its own Durable Object controls `ctx.container` with `durable_object` scheduling. It selects the image and instance size, serves authenticated ports with `getTcpPort`, saves `snapshotContainer` snapshots, restores them and decides when to stop. `Dockerfile` pins the Linux helper image to `cloudflare/sandbox:1.0.0`; deployed image digest is recorded with deployment evidence. Built-in `sandbox.desktop` was removed upstream. Sources and limits are in [the research](../research/cloudflare-desktop.md).

No `@cloudflare/sandbox` npm package is installed. In 1.0 it supplies the optional `Files`, `S3Mount` and `DirectoryBackup` classes. The cross-machine companion already supplies file APIs, and this release uses container snapshots for persistence. Add `DirectoryBackup` when implementing R2 archives or migration to a new base image.

## Local companion

```sh
bun scripts/computer-build-macos.ts
bun scripts/computer-serve.ts --setup
```

The listener defaults to `127.0.0.1:7778`. Browser setup guides Tailscale sign-in and asks you to enable access. Another Labora client discovers the computer and requests browser approval. `LABORA_COMPUTER_DATA` selects persistent state, and defaults to `~/.labora/computer`. Use a private path shorter than 80 bytes on macOS because Unix sockets have a path limit.

For advanced manual pairing, add `--pair-code`. The printed code expires after five minutes and permits five attempts. Pairing consumes it and returns a revocable 256-bit bearer credential. The companion stores its digest.

On macOS, `Labora Computer.app` owns Screen Recording and Accessibility. Its menu explicitly requests permission. It launches through LaunchServices and communicates over a private socket, never a public port. Building the helper does not prove that macOS granted either permission. Windows and Wayland capture/input are unsupported; their capabilities remain unavailable. For an existing X11 machine, explicitly set `LABORA_DISPLAY` to its chosen display.

The packaged macOS app also supports `--computer --setup`, exposed by its Set up this computer button. Enable access adds a private Tailscale Serve route at `/labora`, using a conditional update that preserves other routes. Setup rejects conflicting routes and Funnel exposure. It never assumes the app's own machine is connected. Each client needs its own approved credential, even on the tailnet.

## Protocol

`GET /health` returns a minimal public response. `POST /v1/pair` accepts `{code,clientName}` and returns `{token,clientId,computer}`. Browser enrollment uses the `/v1/enrollment` routes with trusted Tailscale owner identity, a private verifier, and explicit browser consent. A claimed credential remains inactive until the desktop saves it and acknowledges the claim. Normal computer and bot routes require `Authorization: Bearer <token>` and `X-Computer-Id: <computer.id>`.

The [contracts](../src/computer/contracts.ts) define computer capabilities, displays, permissions and bounded actions. A capture returns PNG bytes and `X-Frame-Id` plus dimensions and coordinate-transform headers. Input identifies that frame and a unique request ID. Frames expire after 30 seconds, geometry changes require a new capture, and duplicate input requests are rejected. Human takeover blocks agent input and releases held buttons. Held buttons also release after five seconds without input, covering a disconnected client. `DELETE /v1/clients/self` revokes the caller. Revoking another client is a local host operation, never a model tool.

Bot routes delegate to the isolated Pi host after authentication. The model's computer adapter forces `actor: "agent"`. These controls authenticate remote clients; they do not sandbox arbitrary host terminal commands against the operating-system user. Personal-machine agents must be trusted with that user's files and terminal authority.

## Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` explicitly to your own account and check `wrangler whoami` before deployment. The public configuration contains no account ID. Existing local deployments can use the ignored `cloud/wrangler.local.jsonc` with `--config cloud/wrangler.local.jsonc` to retain their account selection. Never use the Mentasuave account for this project.

Store the admin secret outside source control and upload it through Wrangler stdin. Credentials, private `.dev.vars` files, deployment evidence and local state are excluded from this repository.

Validate locally:

```sh
bunx tsc -p cloud/tsconfig.json
docker build --platform linux/amd64 -t labora-computer:e2e -f Dockerfile .
bun scripts/computer-e2e-linux.ts
```

The Docker context is allowlisted by `Dockerfile.dockerignore`, excluding credentials, private state and reference clones. The local E2E starts an isolated desktop on an ephemeral loopback port. It uses real screenshots and X11 input, checks takeover and replay protection, restarts the companion to check identity persistence, revokes its credential, and removes its container. It never sends input to the user's computer. The 2026-10-02 run passed 13 assertions; screenshots, recording and results are under `artifacts/computer-e2e`. `--keep` preserves the container for native-client verification and writes a private connection file. The Linux desktop opens a terminal with Ctrl+Alt+T.

Deployment requires a 32-character-or-longer random `LABORA_ADMIN_TOKEN` Worker secret. The owner endpoint `POST /v1/desktops`, with that admin bearer, accepts `{id,name}` and returns the computer URL plus a short-lived pairing code. The URL includes `/computers/<id>`. Clients must retain this base path when appending `/v1/...` routes.

The Worker accepts companion bearer credentials only after a successful pairing and checks their verifiers before waking a container. It strips access to internal management paths. A container-only management credential creates pairing codes and reports active work; it is never returned to the client. Configure one desktop ID per bot when dedicated cloud computers are desired. This provisioning API is for the installation owner, not a complete multi-tenant account or billing system.

The owner can call `POST /v1/desktops/<id>/suspend` to save and stop a desktop. It refuses while an agent is busy. A later authenticated computer request restores the saved filesystem.

`DELETE /v1/desktops/<id>` requires the owner credential and `X-Confirm-Desktop-Id` matching the target. It refuses active agent work, stops the container and removes its identity, client verifiers and saved snapshot reference. This is destructive. It is intended for deliberate removal, including resetting a disposable verification desktop. Cloudflare expires unreferenced snapshots under its retention policy.

## Kitesurf reads

The Cloudflare Worker exposes authenticated `POST /computers/<id>/v1/browser/markdown` with `{url}`. It calls the real `BROWSER.quickAction("markdown", {browser: "kitesurf", ...})` binding. The agent's `browser_read` tool reaches the same operation through a parent-process broker. Only the per-container broker credential reaches the companion; the Pi process receives no broker, admin or client credential.

Reads accept HTTPS domain names without credentials or custom ports, reject private DNS answers, and restrict page requests to the chosen origin. No cookies or credentials are supplied, and results are limited to 2 MiB. Each computer permits ten requests per minute and one concurrent read. DNS is checked before rendering; Cloudflare's browser backend resolves the hostname again. Kitesurf currently rejects the `setJavaScriptEnabled` option, so page scripts can run. These reads run separately from the visible Chromium desktop.

Cloudflare documents [the Worker binding](https://developers.cloudflare.com/browser-run/quick-actions/) and [Kitesurf's limits](https://developers.cloudflare.com/browser-run/kitesurf/). Local Wrangler emulation cannot execute `quickAction`; a successful compile or dry-run does not prove a live Kitesurf call. The beta cannot replace a persistent authenticated browser.

Snapshots save the writable container filesystem and bot data. Idle desktops save before stopping; active desktops checkpoint when no agent is running. A restored desktop starts new X11, Chromium and Pi processes. Snapshots do not save process memory, and background browser writes are not transactionally quiesced. A crash may lose changes after the last checkpoint. Snapshots expire 30 days after creation or latest restore; archival R2 backup is still needed for longer retention. Restore failures remain errors instead of silently creating an empty computer.

The live Cloudflare E2E passed 13 assertions on 2026-10-02, including authenticated pairing, actual X11 capture/input, a typed command writing a workspace file, a real Kitesurf Markdown read, and filesystem/credential persistence across snapshot suspension and restore. The deployed Worker version is `788d4389-c3ed-4a5e-b72b-e6f63da32e43`; image digest is `sha256:46123790c42730735790841a3c5de5e22d90a47ddd74d50044f8d0171af3830e`.

The actual Pi child answered message and provider-status requests. The cloud bot completed its own Executor OAuth flow without copied local credentials. A separate in-memory Pi 1.0 diagnostic session inside that container called Executor's execute tool, found the Cloudflare Docs connection and returned five documentation results. The diagnostic exited cleanly. Executor's authorized state survived another snapshot and restore, while OpenAI remained signed out. The final verification desktop is suspended.

Evidence is in `artifacts/computer-cloud-e2e`, including `result.json`, `pi-runtime.json`, `executor-check.json`, `executor-auth.json`, screenshots and a recording. Model inference, ChatGPT subscription access and authenticated Chromium profile restoration remain unverified. A snapshot preserves files and starts new processes.
