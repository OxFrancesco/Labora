# Labora research and setup status

Updated 2026-10-02.

## Decisions

- Personal agents should run on Cloudflare with separate computers, terminals, files, and browsers.
- Use Pi 1.0 with codemode and ChatGPT subscription authentication if feasible.
- Use Executor Cloud for the initial integration. Executor belongs inside Labora's agent, not in the development assistant's global MCP configuration.
- Copy the installed Mac app Grok Bot's UI and interactions 1:1, using the real app as the reference.
- Build the macOS client in GPUix. Connect any user's computer through Tailscale, plus Cloudflare Linux desktops.
- Use Effect 4.0.0 and the requested current anti-slop rules.
- Keep Labora open source. Never use the Mentasuave Cloudflare account for it.

## Executor implementation and verification

The local Bun CLI in `src/` embeds Pi 1.0 and configures Executor for each bot. A bot has separate workspace, session, and agent directories under `.labora/bots/<bot-id>/`. Each process runs one bot. This is state separation, not a security sandbox.

The `main` bot authenticated to `https://executor.sh/labora/mcp` with OAuth client name `Labora`. Its MCP credentials live in `.labora/bots/main/agent/mcp-auth.json`, excluded from Git. The earlier global Codex Executor configuration was logged out and removed, then its absence was verified. No Codex restart is required for the app's connection.

The embedded Pi session loaded seven Executor tools. Executor now has a Cloudflare Docs integration at `https://docs.mcp.cloudflare.com/mcp`, namespace `cloudflare_docs`, with the personal connection Public Docs.

A diagnostic call followed this path:

```text
Labora embedded Pi session
  -> mcp__executor__execute
  -> tools.search
  -> cloudflare_docs.user.publicDocs.search_cloudflare_documentation
```

The query `Cloudflare Sandbox SDK run Pi coding agent` returned five results, including the official Pi recipe. That diagnostic selected the call directly. A later Hydra bot run used a real GPT-5.5 response to select three Executor execute calls through Pi code mode and returned Cloudflare documentation titles and URLs. The local bot's model-to-integration path is now verified.

Run commands are in the [project README](../README.md).

## Native app and backend

The GPUix app and Effect backend are implemented. Source and packaged native walkthroughs passed 24 checks covering real pairing, separate bot drafts, bot metadata edits, ordered clipboard attachments, panel interactions, settings persistence, routines, and restart persistence. The backend verification runs actual Pi subprocesses and checks state persistence, signed-out refusal, event replay, safe workspace downloads, and process cleanup. Real Linux desktop control and the deployed Cloudflare desktop also passed their checks, including Kitesurf reads and snapshot restoration. Browser enrollment passed with production UI and an isolated companion using injected Tailscale discovery and transport. A live personal-tailnet enrollment and model inference remain separate gates in [the implementation plan](../docs/implementation-plan.md).

## Feasibility

Primary-source findings are in [Pi and ChatGPT](pi-chatgpt.md), [Cloudflare and Kitesurf](cloudflare-kitesurf.md), and [Executor](executor.md). Pi source is available through codeview at `resources/pi`, refreshed to `b271b0a524b29e13c0c9e748aea0d34e1597f2db`. Release claims were checked against v1.0.0.

The documented personal self-hosting architecture is a Worker and per-bot Durable Object managing a Linux Sandbox running Pi, with explicit workspace persistence. Pi 1.0 includes a ChatGPT subscription sign-in flow. A fresh Hydra bot registration and local inference succeeded in Labora. Eligibility remains specific to the account, plan, workspace, and application registration. The separately hosted Cloudflare bot has not been authenticated to ChatGPT.

Kitesurf runs on Workers but does not currently provide persistent authenticated sessions or live viewing. Chromium is needed for those functions. Kitesurf's source release is forthcoming; do not describe that dependency as released open source.

## Grok Bot reference

Inspected `/Applications/Grok Bot.app` through native computer use. Observed the bot sidebar, conversation, pill composer, and resizable right panel. The Details tab shows routine controls, Library shows generated content, and Computer shows a screen preview with an Open computer action. Inspecting Create new Bot created a New Bot with an automatic greeting. Francesco explicitly asked to leave it visible. No user message was sent and no existing routine was changed.

The native implementation follows this reference. Full 1:1 parity has not been established. Settings persistence and paused, enabled, and blocked routine behavior are verified in the packaged app. Voice is implemented and packaged, but a real microphone transcript remains unverified. Group chats and the complete Grok Bot settings flow remain open.

## Remaining work

Verify ChatGPT inference in the separate Cloudflare-hosted bot, a real microphone transcript, and browser enrollment on a personal tailnet. Complete group chats and the remaining Grok Bot settings behavior. Local Hydra inference and model-selected Executor reads are verified, alongside native streaming and cancellation. These checks do not establish full Grok Bot feature parity.
