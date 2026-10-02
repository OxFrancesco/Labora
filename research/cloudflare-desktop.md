# Linux desktops for Labora

Checked 2026-10-02. Read-only research. No Cloudflare account was accessed, no container was started, and this design has not been deployed.

Use one custom Linux container per bot, with Xvfb, a window manager, Chromium, and a resident desktop companion. Cloudflare supplies isolation, lifecycle, execution, ports, and filesystem persistence. Labora supplies the screenshot and input API. The same companion contract should address a user's selected personal computer over Tailscale, with platform-specific implementations. Do not hardcode Francesco's Mac as the personal-computer target.

## There is no current built-in desktop API

Cloudflare removed `sandbox.desktop` in SDK 0.10.2. Its official announcement describes the old X server, desktop environment, and VNC/noVNC implementation and directs developers to build the capability on top of Sandbox. Do not copy old `sandbox.desktop.screenshot()` examples into 1.0. [Deprecation announcement](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/)

The similarly named `@cloudflare/computer` is a preview filesystem and execution project, not a ready Linux GUI. Its own README marks it unsuitable for production and warns that design documents describe future intent. [Cloudflare Computer](https://github.com/cloudflare/computer)

## Candidate to implement

Build a Debian-based image with Bun, Pi 1.0, `xvfb`, `openbox`, `pcmanfm`, `xterm`, `chromium`, `scrot`, `xdotool`, `dbus-x11`, and fonts. A supervised entrypoint starts the X display, desktop, browser, and Labora companion. Install applications at image-build time. Start with a fixed 1600 × 900 display and a dedicated Chromium profile under the bot's saved home directory.

The companion should use argument-array subprocess calls for screenshot and input operations, with `DISPLAY` set explicitly. A resident Bun HTTP service is a better match for Labora than a model-specific agent server. Pi calls these operations as ordinary tools, so the desktop does not depend on a particular model vendor's hosted computer-use API.

This packaging follows working public source patterns, but the combined Cloudflare image still needs live verification:

| Reference | What it provides | What to adapt |
| --- | --- | --- |
| [Anthropic's computer-use Dockerfile](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/Dockerfile) and [desktop tool](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py) | Runnable desktop stack; screenshot, click, drag, type, keys, scroll, and coordinate scaling | Reuse the operating-system approach, not its model loop or Streamlit app. |
| [desktop-sandbox Dockerfile](https://github.com/arthurkatcher/desktop-sandbox/blob/main/Dockerfile) and [HTTP server](https://github.com/arthurkatcher/desktop-sandbox/blob/main/sandbox/server.py) | Small desktop-only reference with Openbox, Chromium, screenshots, XTest input, and optional noVNC | Its Python HTTP server needs Cloudflare adaptation. Treat this small project as reference code, not an audited dependency. |
| [Cloudflare Pi recipe](https://developers.cloudflare.com/sandbox/coding-agents/pi/) | Dockerfile, sandbox shim, and Pi-in-container integration | The recipe pins older Pi. Pin Labora's tested Pi 1.0 and Bun versions instead. |
| [Cloudflare preview example](https://developers.cloudflare.com/sandbox/previews/) | Complete Worker/DO HTTP routing, startup readiness polling, and WebSocket bridge | Route only authenticated owners to their bot, and expose the desktop companion rather than a demo web server. |

Before implementation, use codeview to bring the selected reference repositories into `resources/`, coordinated with the root agent because setup updates shared repository metadata. This research inspected their public source directly and did not modify the codeview registry.

## Cloudflare 1.0 API and deployment shape

Configure `containers[].scheduling_policy` as `durable_object`, and a named image through `containers[].images.desktop.dockerfile`. Wrangler builds the image and exposes its pinned reference as `ctx.container.images.desktop`. The policy accepts runtime sizes `lite` and `standard-1` through `standard-4`, not `basic`. It does not accept `max_instances`. Start with `standard-2` as a sizing hypothesis and measure Chromium plus Pi memory before reducing it. [Scheduling policy and complete Wrangler example](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)

The public runtime API provides these operations, not desktop-specific calls:

| Operation | Public API |
| --- | --- |
| Start | `container.start({ image, instance, enableInternet, env?, entrypoint? })` |
| Run command | `container.exec(argv, { cwd?, env?, user?, pty?, stdin?, stdout?, stderr? })` |
| HTTP/WS forwarding | `container.getTcpPort(port).fetch(request)` |
| Idle policy | `container.setInactivityTimeout(milliseconds)` |
| Save workspace | `container.snapshotContainer({})` and subsequent `start({ containerSnapshot, ... })`; the options object is required |

`start()` returns before readiness. `exec()` receives an argument array without shell expansion. Its processes inherit only `PATH` from the container environment, so pass `DISPLAY` and other necessary variables explicitly. [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)

Serve the companion on `0.0.0.0:7090` inside the container; `getTcpPort()` cannot reach a loopback-only listener. Check `/health` before declaring the desktop ready. For optional noVNC, proxy `6080` through the same authenticated Worker. Keep raw VNC internal. A WebSocket merely forwarded through a DO does not keep it active: use the documented bridge that accepts both ends. Do not blindly retry input POST requests. [HTTP and WebSocket example](https://developers.cloudflare.com/sandbox/previews/)

## Proposed portable desktop contract

The following is a Labora API proposal, not a published Cloudflare schema. Both Cloudflare Linux desktops and personal-computer companions implement it. The app selects the computer by a stable ID and routes to the appropriate authenticated transport.

| Method and path | Request / result |
| --- | --- |
| `GET /health` | `{ "ready": true, "desktopReady": true }`; ready only after capture and input backends initialize |
| `GET /v1/computer` | Computer identity, platform, available capabilities, display geometry, and capture/input permission state |
| `GET /v1/displays/:id/frame` | PNG/JPEG bytes, `X-Frame-Id`, `X-Frame-Width`, `X-Frame-Height`, `X-Captured-At`; `Cache-Control: no-store` |
| `POST /v1/actions` | A request ID, display ID, frame geometry, and an ordered action list; returns executed count and any failure |
| `POST /v1/control` | `{ "owner": "user" }` or `{ "owner": "agent" }`; agent input pauses during human takeover |
| `GET /v1/events` | Optional WebSocket carrying frame updates and connection/control/permission changes |

Example metadata:

```json
{
  "id": "computer-123",
  "name": "Work laptop",
  "platform": "macos",
  "capabilities": ["capture", "pointer", "keyboard", "clipboard"],
  "permissions": { "capture": "granted", "input": "granted" },
  "displays": [{ "id": "main", "width": 1600, "height": 900 }],
  "controlOwner": "agent"
}
```

Example input:

```json
{
  "requestId": "action-unique-id",
  "displayId": "main",
  "frame": { "width": 1600, "height": 900 },
  "actions": [
    { "type": "click", "x": 240, "y": 180, "button": "left", "count": 1 },
    { "type": "type", "text": "Hello" },
    { "type": "key", "key": "Enter", "modifiers": [] }
  ]
}
```

Also support `move`, `pointerDown`, `pointerUp`, `keyDown`, `keyUp`, and `scroll` with signed horizontal/vertical deltas. Express keys using stable names, not X11 keycodes. Adapters translate them per OS. Coordinates refer to the returned image's pixels; scale native Retina coordinates inside the Mac adapter. Reject a mismatched display size and request a fresh frame. Deduplicate recent `requestId` values so a transport retry cannot double-click. Release held keys/buttons when control changes or the connection ends.

For an existing public HTTP schema, desktop-sandbox exposes `GET /health`, `GET /screenshot`, `GET /v1/size`, and `POST /action`. Actions include `click`, `double_click`, `right_click`, `move`, `type`, `key`, and `scroll`. Its server serializes screenshot and input operations. This demonstrates the small API shape; it is not automatically a personal-PC adapter. [Project API](https://github.com/arthurkatcher/desktop-sandbox), [server implementation](https://github.com/arthurkatcher/desktop-sandbox/blob/main/sandbox/server.py)

## Native viewing and Open computer

GPUix can consume decoded image frames and send native pointer/key events through the companion without embedding a browser. Screenshot polling is enough to prove the full round trip, but is not proof of smooth interactive viewing. The final Open computer experience needs continuous frames, drag/key-up events, clipboard behavior, disconnection recovery, correct scaling, and explicit handoff between user and agent.

noVNC is an optional established viewer for the same X display, not a second computer. Its public RFB client supports view-only mode, scaling, resize requests, clipboard, keys, and screenshot extraction over WebSocket. It requires DOM/Canvas and cannot be inserted as a GPUix-native component. Use it only as an external viewer or implement a native RFB/frame transport. [noVNC API](https://github.com/novnc/noVNC/blob/master/docs/API.md)

## Constraints to verify

- Cloudflare documents that Python `http.server` servers fail after deployment because of container hostname lookup. The small desktop-sandbox reference uses `ThreadingHTTPServer`; replace its server with Bun or adapt the lookup before expecting it to run. [Cloudflare preview caveat](https://developers.cloudflare.com/sandbox/previews/)
- The public startup API exposes no Docker `--shm-size` option. Chromium's `--disable-dev-shm-usage` is used by the reference launcher, but its stability and memory behavior on Cloudflare must be measured. Do not promise accelerated graphics. [Chromium launcher](https://github.com/arthurkatcher/desktop-sandbox/blob/main/scripts/sandbox-browser)
- Snapshot files survive, processes and the X display do not. Restart the display stack and browser on restore. Keep browser profiles and user files in persisted directories; checkpoint the browser cleanly before snapshot where possible. Snapshots expire after 30 days since creation or restoration. Keep long-term backups in R2. [Lifecycle](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- The largest documented instance has 4 vCPU, 12 GiB RAM, and 20 GB disk. An open viewer or active agent keeps compute billable; implement idle stop and resume. [Limits](https://developers.cloudflare.com/containers/platform/limits/), [pricing](https://developers.cloudflare.com/containers/platform/pricing/)

## Kitesurf still has a separate role

Keep Kitesurf as a browser tool for short, compatible, stateless tasks such as extracting public pages. It cannot supply the interactive Linux desktop, share the desktop Chromium's profile, or stand in for the user's persistent authenticated browser. When the task should appear in Open computer or continue a login, drive Chromium on that same X display. Kitesurf remains beta and lacks persistent authenticated sessions and live view; its source release is still forthcoming. [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/), [live-view limits](https://developers.cloudflare.com/browser-run/features/webmcp/), [source-release update](https://blog.cloudflare.com/kitesurf-update/)

The first proof should launch one real desktop, show its current screen in GPUix, type into its terminal, inspect the resulting file, perform a browser action visible on that same desktop, hand control to the user, then stop and restore the container. Repeat the same companion operations on a separately selected personal computer. A Docker build or a screenshot endpoint alone does not establish these behaviors.
