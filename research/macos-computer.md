# Computer companions and Pi IPC

Reviewed 2026-10-02. This is a source-backed proposal, not an implemented or verified computer-control service. No screens were captured, input events sent, permissions requested, or user credentials read during this research.

## Architecture

Use a computer companion on each user's selected machine. The GPUix app manages connections and chooses a computer by stable `computerId`; its own machine is just another optional target. Keep the agent runtime location separate from the controlled computer. A Pi process may run beside the app or in a Cloudflare Linux container while controlling a different paired computer.

Represent targets as distinct variants: `paired-machine` with a connection ID and `cloud-desktop` with a bot/container ID. Never substitute the local machine when a remote computer is offline. Advertise actual OS, displays, permission state and supported operations. A Windows machine must not inherit macOS capability claims.

T3 is a useful precedent, not an existing Labora dependency. Its server owns execution, files and durable identity; HTTP/WebSocket routes can change without changing the environment ID. Tailscale supplies reachability while the server still authenticates access. Source: [remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md), [stable identity and capability descriptor](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/environment/ServerEnvironment.ts).

## Tailnet connection and pairing

Recommended first implementation:

1. The companion binds its API to loopback only. Check for an existing Labora instance before selecting a port.
2. The user enables Tailscale Serve HTTPS for that local service. Use the node's tailnet hostname as a route, not its identity. Do not enable Funnel.
3. A locally authorized companion UI creates a one-use pairing secret with a short expiry. A pairing URI carries the secret in a fragment; redact it from logs and remove it after exchange.
4. The GPUix client exchanges that secret with the companion for a revocable, scoped client credential. Store the client's credential in OS credential storage; store only its verifier and metadata server-side. Persist a random stable `computerId` atomically.
5. Require companion authentication for HTTP requests and WebSocket upgrades, with per-operation authorization. Limit Tailscale grants to the intended clients and companion port as another boundary.

T3's auth implementation separates pairing, session authority and transport. It supports credential narrowing, revocation, and authenticated creation of short-lived WebSocket tickets so long-lived credentials stay out of socket URLs. Useful source: [environment auth](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md), [auth schemas](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/auth.ts), [auth handlers](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/auth/http.ts), [RPC scope checks](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/auth/RpcAuthorization.ts).

Suggested Labora scopes are `computer:observe`, `computer:input`, `files:read`, `files:write`, `terminal:execute`, and `connections:manage`. Ordinary pairing should not delegate connection administration. Every request includes the intended computer ID and rejects a mismatch. Creating another pairing grant must require authority over every delegated scope.

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) proxies a local service to the tailnet and can add user identity headers. Treat those headers as an optional extra check only behind the trusted local Serve proxy; do not accept them as proof on an arbitrary public listener. Device sharing can include outside users. Tailnet membership alone is not sufficient application authorization.

A Cloudflare Worker does not gain access to a user's tailnet just because the desktop app has Tailscale. A container-side Tailscale client is a possible separate connector: official [userspace networking](https://tailscale.com/docs/concepts/userspace-networking) works through SOCKS5/HTTP proxies without `/dev/net/tun`. Cloudflare support, UDP/TCP behavior, state persistence and the Bun client's proxy handling still need a live proof. Alternatively a paired companion can maintain an outbound authenticated relay connection; that is additional infrastructure, not the direct Tailscale route.

## macOS companion

Recommend a signed `Labora Computer.app` owned by the Labora project, with a stable bundle ID such as `org.buddytools.LaboraComputer`. Launch it using LaunchServices, not a loose Swift binary started by the developer terminal. The app may be installed independently on any Mac, including a remote user's Mac.

The Swift app owns AppKit, ScreenCaptureKit and CGEvent calls. A Bun companion can own transport, authentication and request validation, then talk to the Swift app over a private Unix socket. The socket belongs inside a mode-0700 per-user runtime directory, uses mode 0600, checks peer identity where supported, and requires a process-instance handshake. Do not open its input API directly on the network.

Existing source worth reusing:

| Concern | Source and relevant behavior |
| --- | --- |
| Per-window screenshot | `BuddyMac/native/speech/Platform/ScreenContextCapture.swift:14`: resolves a process's window, constructs `SCContentFilter(desktopIndependentWindow:)`, captures with `SCScreenshotManager.captureImage`, and encodes JPEG. |
| Display/region screenshot | `Liny/apps/macos/Sources/Liny/CaptureManager.swift:64`: `SCShareableContent`, display filtering, `sourceRect`, backing scale, exclusion of its own windows, and image capture. |
| Permission prompts | `BuddyMac/native/speech/Platform/AccessibilityAccess.swift:11`: `AXIsProcessTrusted()` and explicit `AXIsProcessTrustedWithOptions`. The screen capture file has `CGPreflightScreenCaptureAccess()` and an explicit request method. |
| Pointer input | `Liny/resources/ocu/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/InputSimulation.swift:58`: global and process-targeted mouse down/up; scroll at lines 102/112. |
| Text and shortcuts | The same `InputSimulation.swift:162` uses Unicode CGEvent text without replacing the clipboard; line 184 chunks UTF-16 while preserving Characters; line 207 parses keys and posts modifier/key pairs. |
| App launch and socket | `Liny/resources/ocu/apps/OpenComputerUse/Sources/OpenComputerUse/MacOSAppAgentProxy.swift:80`: `NSWorkspace.shared.openApplication`; line 261 sets socket mode 0600. |
| Structured AX targets | `Liny/native/ocu/sources/LinyObservation.swift`: exact, unique selectors, bounded tree traversal and post-action value verification. |
| Cancellation lifecycle | `Liny/native/ocu/sources/LinyParentProcessMonitor.swift` watches owner exit. `Liny/agent/src/computer-use/stdio-mcp-client.ts` cancels/terminates its owned helper and rejects pending work. |

All paths above are relative to `/Volumes/T6-7/Coding/Personal/`. The OCU reference is MIT licensed; retain its license and notices when reusing code. Liny's fork instructions are in `Liny/native/ocu/README.md`, and explicitly distinguish helper permissions from the main app's permissions.

Do not copy two parts of OCU as the new design: its `Permissions.swift` reads TCC databases, and its input source offers a private SkyLight click path. Use public permission APIs and the public CGEvent path. The public [SCScreenshotManager reference](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager) is the API entry point for screenshots.

### Swift helper boundary

Suggested modules are `Permissions.swift`, `Capture.swift`, `Input.swift`, and `CompanionIPC.swift`. The IPC accepts typed requests rather than arbitrary Swift or shell code:

- `permissions.status` reports AX, screen capture, and event-posting capability independently. Include app bundle ID and executable identity for diagnostics. It does not open settings.
- `permissions.request` opens the requested OS prompt or System Settings only after a user action in the companion UI. Accessibility and Screen Recording must be granted to the signed companion that performs the operation. Input Monitoring is only needed if a future feature listens to global input; do not request it just to click/type.
- `capture` requires a display or window identifier. Return PNG/JPEG plus coordinate metadata. Window capture should be the normal choice for a selected app or browser page.
- `click`, `type`, `key`, and `scroll` accept a target and bounded arguments. Resolve the target again immediately before dispatch, check permission, and serialize input operations per computer. Prefer process-targeted CGEvent posting where supported; explicitly report any operation requiring foreground/global input.
- `cancel` stops future events and releases any held modifier/button in cleanup. It cannot undo events already posted. Never automatically retry a click or typed text after a transport timeout.

Capture response metadata should contain `captureId`, `computerId`, display/window ID, logical origin and size, encoded pixel dimensions, timestamp, and an explicit pixel-to-desktop transform. Scaling and multiple displays make image pixels different from desktop points. Input derived from a screenshot must identify its capture and reject stale/unknown captures.

Proposed local artifact path: `~/Library/Application Support/Labora/Computer/artifacts/<runId>/<captureId>.png`, with private directories and files. A remote response returns an opaque artifact ID, dimensions and MIME type, not a machine-local absolute path. Fetch bytes through the authenticated companion API. The GPUix app can cache them under its own private `Labora/artifacts/<computerId>/<runId>/` directory. Paths and retention limits are application policy, not screenshot API behavior.

Source history contains an important verification trap: BuddyMac helpers launched from T3 could work while BuddyMac's own Accessibility permission was absent. Recheck in the installed companion's actual LaunchServices execution context. A successful helper build is not permission or input proof. Do not reset TCC records automatically.

## Windows and Linux scope

Reuse the companion protocol, pairing, capability discovery and artifact model, not Swift implementation details. Windows needs a native capture/input adapter, for example DXGI Desktop Duplication and `SendInput`, running in the interactive user's session. `SendInput` has integrity-level restrictions; reject unsupported targets rather than claim elevated/UAC control. Sources: [Desktop Duplication](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/desktop-duplication-api), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).

For Linux Wayland, start with the [XDG RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) and ScreenCast/PipeWire integration. Capability and consent vary by compositor. X11 requires a separate adapter. A user's logged-in Linux desktop and a Cloudflare-created virtual Linux desktop are separate target variants. None of these adapters has been implemented or tested here.

## GPUix app to isolated Pi process

Use one long-lived Bun process per bot with `PI_CODING_AGENT_DIR` set before importing Pi, and explicit scoped auth/settings/session directories. Do not switch that process-global directory among bots. The GPUix app owns process startup and secret-free status; the child owns Pi sessions and OAuth credentials. Keep provider credentials out of the remote computer companion unless that machine is explicitly chosen to host the agent runtime.

Use versioned JSON lines over inherited stdin/stdout for a local child. Use the same envelopes over authenticated WebSocket when the runtime is remote. Each request has `version`, `id`, `method`, and typed `params`; responses carry the same ID with either `result` or a structured `error`. Events carry `sequence`, `botId`, `sessionId`, `runId`, `type`, and typed data. Reserve stdout for protocol, stderr for redacted diagnostics, and bound message sizes and outbound queues.

| Command | SDK mapping or responsibility |
| --- | --- |
| `session.open` | `createAgentSession`, explicit model/runtime, scoped `SessionManager`, then `bindExtensions`. |
| `run.start` | `session.prompt`; reject a second active run or explicitly queue it. |
| `run.cancel` | `await session.abort()`, plus linked abort signals for auth/companion requests. |
| `auth.begin` | `ModelRuntime.login("openai", "oauth", interaction)` for subscription login. |
| `auth.respond` / `auth.cancel` | Resolve a pending typed prompt or abort that auth attempt. Never send stored tokens to the UI. |
| `approval.respond` | App-only control message bound to a pending approval ID, exact request digest, bot, target, expiry and run. It is never a model tool. |
| `session.close` | Abort active work, reject pending prompts, emit `session_shutdown`, then dispose the session. |

Pi's `AuthInteraction.notify` emits auth URL/progress/device-code events; `prompt` requests text, secret, selection, or manual callback input. Adapt these to `auth.event`/`auth.prompt` messages. Local browser callbacks return to the child. For a remote runtime, a browser's loopback callback is on the browser's machine, so use a supported manual callback/device flow or explicit callback routing; do not silently reuse localhost. Exact source: `resources/pi/packages/coding-agent/src/core/model-runtime.ts:817` and `resources/pi/packages/ai/src/auth/types.ts:156`.

Stream Pi session events into assistant deltas, tool progress, run state and final results. On reconnect, replay events after a cursor or return an authoritative snapshot. A transport reconnect must not re-submit an already accepted turn. Record request IDs before dispatching consequential companion input so duplicate delivery does not replay actions. A lost result after dispatch should report an unknown outcome, then observe state.

Executor's current model-side `resume` block should remain. When approval UI exists, an authenticated app response can let the runtime resume the exact pending execution through its trusted control path. The model must not generate approval responses, inherit a reusable approval credential, or widen the operation after approval. Pi's nested codemode calls already run through the same `tool_call` hooks. On cancellation/disconnect/expiry, pending approvals remain blocked.

The host terminal and Executor integration-management tools are separate powers from computer input. Restricting `resume` alone does not create a security sandbox. Remote connection credentials and the Swift IPC socket must never be passed into model context or general tool output.
