# Cloudflare computers and Kitesurf feasibility

Checked 2026-10-02 against current Cloudflare documentation. This is a documentation review, not a deployed integration test.

Cloudflare can host the application, each bot's Linux environment, storage, and browser service. Kitesurf works for short browser tasks. It does not currently satisfy the stronger promise of a persistent, logged-in personal browser. The practical design includes Chromium as the browser for those tasks.

## Each bot's computer

Cloudflare Sandboxes supports full Linux containers in separate microVMs, each with its own kernel and network. These provide the terminal, real filesystem, package installation, and subprocesses that a coding agent needs. Workers alone are the orchestration layer. Dynamic Workers offer isolated generated-code execution, but they are a different environment from the Linux computer. Sandboxes requires Workers Paid. The current Durable Object scheduling policy is public beta. [Sandbox overview](https://developers.cloudflare.com/sandbox/), [environment comparison](https://developers.cloudflare.com/sandbox/concepts/)

There is now an official Pi recipe. It installs `@earendil-works/pi-coding-agent@0.87.1` in a Node 24 Linux image and uses the sandbox 1.0.0 shim. That proves Cloudflare documents Pi hosting. It does not independently prove the compatibility of Pi 1.0 or ChatGPT subscription authentication, because the recipe uses Anthropic through AI Gateway. [Run Pi in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/pi/)

Use a distinct authenticated owner-and-bot identity for each sandbox. Separate Linux users within one sandbox do not provide tenant isolation. Every process can access the sandbox's files and credentials. Keep integration credentials in the Worker and add them through scoped outbound handlers where practical. [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/)

A browser terminal is explicitly supported through WebSockets and a PTY. [Open a terminal](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/)

## Persistence and lifecycle

The Durable Object and its storage survive the Linux instance. Local files and processes do not survive instance termination unless files are saved separately. An open terminal keeps its Durable Object active. Background Linux work alone does not, so an alarm must keep checking an active task. The configurable inactivity timeout extends to six hours. Worker deployments preserve running instances but disconnect existing streams and terminal WebSockets. [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)

Public-beta container snapshots save the writable root filesystem, not memory, processes, or separate mounts. The application must save and restore them. Store agent conversation state durably, restore its workspace, then restart the agent process. [Snapshot guide](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/)

Snapshots expire 30 days after creation or last restore and have a 20 GB maximum. R2 should hold files that need longer retention. R2 can be mounted, but FUSE performance should not be assumed equivalent to a local SSD. [Container limits](https://developers.cloudflare.com/containers/platform/limits/), [Container FAQ](https://developers.cloudflare.com/containers/faq/), [R2 mounting](https://developers.cloudflare.com/sandbox/files/mount-an-r2-bucket/)

## Kitesurf

Kitesurf is Cloudflare's browser built on Workers, exposed through Browser Run. It is currently free in beta within account limits. Use CDP with `browser=kitesurf`, or Quick Actions. Current docs explicitly exclude long-running authenticated sessions requiring persistent state, video, WebGL, and real TLS-fingerprint bot-challenge handshakes. Chromium is the documented alternative. Kitesurf's rendering is not guaranteed pixel-perfect, so target-site compatibility needs real testing. [Kitesurf docs](https://developers.cloudflare.com/browser-run/kitesurf/)

The September 28 update added WebMCP and direct Worker binding support for Kitesurf Quick Actions. It also confirms the engine uses public Workers APIs. However, the same update says its open-source release is still forthcoming. There is no released engine license verified in this review. An open-source application can use the managed Kitesurf service, but we should not describe Kitesurf itself as already open source or promise that users can deploy its source in their own account. [September 28 update](https://blog.cloudflare.com/kitesurf-update/)

Kitesurf CDP sessions cannot combine the browser option with `keep_alive`, `lab`, or `recording`. They do not appear in the browser session list and have no live view. This matters for a product where users watch their bot or take over to approve a website action. [CDP reference](https://developers.cloudflare.com/browser-run/cdp/), [WebMCP limitations](https://developers.cloudflare.com/browser-run/features/webmcp/)

For Chromium Browser Run, paid defaults are 200 concurrent browsers per account and three new instances per second. Session inactivity defaults to 60 seconds, with higher keep-alive available. These are shared account limits, not a permanent browser allocation per bot. [Browser limits](https://developers.cloudflare.com/browser-run/limits/)

## Suggested architecture

This is an architectural inference from the documented capabilities, not an existing tested deployment.

1. Worker handles login, requests, tool authorization, and streaming.
2. One Durable Object owns each bot's identity, conversation state, job progress, and workspace snapshot reference.
3. One Linux sandbox runs Pi and provides terminal and file access when the bot is active.
4. Snapshots restore working files. R2 stores durable artifacts and backups.
5. Kitesurf handles compatible short browser tasks. Browser Run Chromium handles persistent authenticated workflows and human takeover.
6. Integration calls go through a scoped broker so the Linux sandbox does not need every raw credential.

The main operating cost is the active Linux computer. Containers bill provisioned memory and disk while running, active CPU use, plus applicable egress, Workers, and Durable Object usage. They start on the $5/month Workers Paid plan. Keeping every bot's machine running continuously would materially change the bill. [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

Confidence is high for documented infrastructure availability and the Kitesurf limitations. Confidence in an end-to-end product remains unproven until Pi 1.0, authentication refresh, restart recovery, browser login persistence, and one actual integration are exercised together.
