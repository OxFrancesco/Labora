# Pi 1.0, Cloudflare, and ChatGPT subscriptions

Checked on 2026-10-02 against upstream source and official documentation. This is a feasibility review. No credentials were read, no model request was sent, and nothing was deployed.

Pi 1.0 is a suitable starting point for a personal Cloudflare-hosted agent. Run the complete Pi process inside a Cloudflare Linux Sandbox, with Workers and Durable Objects managing requests and lifecycle. Pi also includes the new official Sign in with ChatGPT integration. The remaining proof is a real authenticated run with tools inside the deployed sandbox.

## Release and packages

The canonical repository is `earendil-works/pi`. Its `v1.0.0` release was published on October 1, at commit `a13d35a`. The published package is `@earendil-works/pi-coding-agent@1.0.0`, with `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-codemode`, and `@earendil-works/pi-mcp`. The CLI package requires Node 22.19 or later and is MIT licensed. [Release](https://github.com/earendil-works/pi/releases/tag/v1.0.0), [package metadata](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/package.json).

Codemode, MCP, and the new ChatGPT login arrived in 0.99.0 on September 29. Version 0.99.1 fixed a missing-module error in the packaged OpenAI login. Version 1.0 includes those changes and improves codemode output and image generation. [0.99.0 release](https://github.com/earendil-works/pi/releases/tag/v0.99.0), [changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md).

The local `codeview` reference initially contained 0.87.1 despite being marked fresh. It was refreshed to upstream commit `b271b0a524b29e13c0c9e748aea0d34e1597f2db`, dated October 2, 12:30:17 +02:00. Release-specific claims above were checked against the immutable v1.0.0 tag.

## Cloudflare runtime

Cloudflare publishes a Pi deployment recipe using a Linux container, Node 24, a Worker, and a Durable Object. Its current example pins Pi 0.87.1 and routes Anthropic requests through AI Gateway. It demonstrates the architecture, but does not prove Pi 1.0 plus ChatGPT login. [Cloudflare Pi recipe](https://developers.cloudflare.com/sandbox/coding-agents/pi/).

The complete Pi SDK embeds in Node or Bun. Codemode's host imports `node:worker_threads`, and its WebAssembly loader reads a file. The agent also needs filesystem and shell access. Therefore, a Linux Sandbox is the direct hosting path. Running the whole package as an ordinary Worker would require adaptation. [SDK documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/sdk.md), [codemode host](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/src/runtime/host.ts), [WebAssembly loader](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/src/wasm.ts).

Suggested structure, as an implementation inference: one named sandbox and workspace per bot, a Durable Object to own its lifecycle and concurrent requests, persisted conversations and workspace backups, and separate credentials per owner. Use the personal Cloudflare account, never Mentasuave for Labora.

## What codemode means

Pi lets the model write JavaScript that orchestrates its existing tools. Scripts can run calls concurrently and return only selected results. They execute in QuickJS with no direct network, filesystem, Node APIs, or timers. Tools provide those capabilities. This is a local orchestration tool, independent of OpenAI's hosted Code Interpreter or programmatic-tool-calling feature. [Codemode reference](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md).

Pi supports MCP over stdio and Streamable HTTP, including OAuth. MCP tools use codemode exposure by default, with discovery through `searchTools()`, `describeTool()`, and `ALL_TOOLS`. That is a compatible connection shape for Executor Cloud; the actual Executor endpoint and authentication still require setup and verification. [MCP reference](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md).

In SDK mode, `createAgentSession()` does not automatically install MCP and codemode. Add `createCodemodeExtension()`, `createMcpExtension()`, and, if needed, `createToolSearchExtension()` to `DefaultResourceLoader.extensionFactories`. Enable the desired tools and call `session.bindExtensions()` to start MCP connections. The CLI supplies these built-ins itself. [SDK example](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

## ChatGPT subscription

Use `/login openai`, whose provider now offers Sign in with ChatGPT and sends requests to `https://api.openai.com/v1`. Its OAuth implementation uses `dynamic_agent_client`, the `chatgpt.tokens.use.direct` scope, PKCE, an installation host ID, and the issued client ID for token exchange and refresh. [OpenAI provider](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/providers/openai.ts), [ChatGPT OAuth implementation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/auth/oauth/openai-chatgpt.ts).

The separate `openai-codex` provider is explicitly labelled legacy and still targets `chatgpt.com/backend-api`. It should not be the basis of the new integration. OpenAI directs the new subscription flow to the public Responses endpoint. [Legacy provider](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/providers/openai-codex.ts), [official inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

OpenAI documents subscription usage for open-source and locally hosted apps, plus a process for self-hosted VMs. That VM process completes OAuth locally, transfers protected credentials, preserves a distinct VM host ID, and assigns refresh ownership to the VM. Applying it to Francesco's own Cloudflare sandbox is a reasonable implementation inference, not an explicit Cloudflare-specific endorsement. The public docs direct paid or remotely hosted app providers to an interest form. Do not assume a multi-user hosted Labora service receives the same eligibility as personal self-hosting merely because its source is open. [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source), [self-hosted VM procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

Each bot consumes the signed-in account's available usage. Separate bots do not create separate subscription allowances. For Plus, the documented five-hour limit is shared across apps. Store each account registration separately and serialize refreshes for credentials shared by concurrent processes. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Checks required before treating it as ready

1. Complete a fresh ChatGPT authorization and a streamed inference request. Success requires `response.completed`, not merely a token, model listing, or HTTP 200. [Inference completion](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
2. Execute a real codemode script that reads a sandbox file and calls an Executor tool. OpenAI's preview requires `store: false`, `stream: true`, and compatible tool encoding. It does not support hosted MCP, hosted computer use, or Responses `tool_search`. Client-executed shell and MCP calls remain possible through supported function/custom tools. [Preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
3. Check the outgoing tool declarations. OpenAI documents namespaced function/custom tools or `additional_tools`; Pi's generic converter currently builds flat function/custom entries. That is a source-level compatibility concern requiring a real request or a small adapter, not a demonstrated production failure. Keep native Responses `tool_search` disabled on the subscription route. [Pi tool serialization](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/api/openai-responses-shared.ts), [request construction](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/api/openai-responses.ts).
4. For Labora's own account UI, follow the current SIWC account lifecycle rather than copying Pi's login verbatim. Pi 1.0 starts a fresh dynamic registration at each login and only checks that an ID token exists. OpenAI specifies reusing issued client IDs and validating the ID token's signature, issuer, audience, expiry, and nonce. [Registration requirements](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Pi login implementation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/auth/oauth/openai-chatgpt.ts).
5. Restart the sandbox and verify conversation/workspace recovery and token refresh. A successful local run alone does not establish Cloudflare persistence or unattended operation.

Codex app-server is an officially documented alternative if the Pi integration needs more work. It accepts the same SIWC access token through a configured Responses provider, while the app owns refresh. It is optional; Pi already has direct subscription support. [Codex app-server setup](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
