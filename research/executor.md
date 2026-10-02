# Executor feasibility and first connection

Updated 2026-10-02. Executor Cloud is connected inside Labora's local agent runtime. The first upstream documentation read succeeded through the embedded Pi session. Cloudflare self-hosting remains research only.

## Recommendation

Francesco chose Executor Cloud for the first connection. Native Cloudflare self-hosting remains an option for running the integration layer in his own account. Current official docs support this directly, although the supplied onboarding prompt mentions only Docker. Local desktop and CLI require a machine to remain available. [Hosting overview](https://executor.sh/docs)

Cloud's current free tier includes three members, 100,000 executions per month, and unlimited integrations. An execution is one agent call into Executor and can contain several upstream tool calls. The free tier pauses calls when exhausted. [Pricing](https://executor.sh/pricing)

The repository is MIT licensed. [License](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/LICENSE)

## Labora connection

The Labora organization uses `https://executor.sh/labora/mcp`. The application authenticates with OAuth client name `Labora` and keeps the main bot's MCP credentials in `.labora/bots/main/agent/mcp-auth.json`. Each bot has its own authentication directory. The accidental global Codex connection was logged out and removed; Executor is loaded by Labora itself.

The embedded Pi session loaded seven Executor tools. Commands for connecting another bot and inspecting its tools are in the [project README](../README.md). The normal chat configuration exposes Executor through Pi codemode; diagnostic commands expose its tools directly for inspection and verification.

Executor's source builds organization-specific URLs from the authenticated workspace. For another workspace, use its generated URL. [Onboarding page](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/apps/cloud/src/web/pages/setup-mcp.tsx), [URL builder](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/packages/react/src/components/mcp-install-card.tsx)

Source-level auth detail: Cloud accepts OAuth bearer credentials and user API keys. Its MCP auth code rejects organization API keys for opening MCP sessions. Do not substitute a workspace API key when configuring a headless MCP agent. [MCP auth](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/apps/cloud/src/mcp/auth.ts)

## Self-hosting on Cloudflare

The documented host serves the UI, API, and `/mcp` from a Worker, uses D1 for storage, and delegates login to Cloudflare Access. It is single-tenant. Interactive MCP clients can use Access Managed OAuth; unattended bots can use an Access service token with a Service Auth policy and the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Scope Access to the whole hostname so OAuth discovery routes are protected too. An HTML response from `/mcp` usually means the client reached the Access login page. [Cloudflare hosting guide](https://executor.sh/docs/hosted/cloudflare)

Current source is ahead of the prose documentation. At commit `98d606bd2b47b9dcc2c03a129a14b5134d9852c8`, its Wrangler configuration also includes:

- An R2 bucket for integration blobs too large for D1.
- Durable Objects for MCP sessions and execution ownership.
- A Worker Loader binding for dynamic worker execution. Source falls back to QuickJS when that binding is absent.

[Wrangler configuration](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/apps/host-cloudflare/wrangler.jsonc), [Execution selection](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/apps/host-cloudflare/src/execution.ts)

The setup script provisions or reuses D1, uploads the encryption secret, builds the UI, and deploys. It does not explicitly provision the R2 bucket. Its instructions additionally set `ADMIN_EMAILS` alongside `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Inspect and adapt this configuration before deploying into the correct personal account. Never use Mentasuave for Labora. [Deployment script](https://github.com/UsefulSoftwareCo/executor/blob/98d606bd2b47b9dcc2c03a129a14b5134d9852c8/apps/host-cloudflare/scripts/deploy.sh)

The deployment has not been attempted, so build success, plan compatibility, actual authentication, and persistence remain unverified.

## Docker alternative

The published image is `ghcr.io/rhyssullivan/executor-selfhost:latest`, listening on port 4788. Persist `/data`, which contains the SQLite database and encryption keys. Set `EXECUTOR_WEB_BASE_URL` to the exact external HTTPS origin when hosted behind a domain. The first signup becomes the owner; later users need invitations. MCP is served at `/mcp`. [Docker guide](https://executor.sh/docs/hosted/docker)

## First integration verified

Added Cloudflare Docs with MCP URL `https://docs.mcp.cloudflare.com/mcp`, namespace `cloudflare_docs`, and personal connection Public Docs. It requires no upstream credentials.

Labora's diagnostic used its embedded Pi session to invoke `mcp__executor__execute`. The code searched for the tool, discovered `cloudflare_docs.user.publicDocs.search_cloudflare_documentation`, and called it with `Cloudflare Sandbox SDK run Pi coding agent`. It returned five documentation results, including Cloudflare's official Pi recipe.

This was a real MCP call from the app through Executor to the upstream integration. It was selected directly by diagnostic code, so it does not prove LLM-selected tool use, Pi codemode reasoning, or ChatGPT inference. Those remain to be tested after the bot's ChatGPT sign-in.

Keep tool policies in Executor when adding integrations. [Policy model](https://executor.sh/docs/concepts/policies)
