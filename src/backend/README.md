# Agent host

`createAgentHttpHandler({ dataDir, computer? })` returns `fetch(request, context)`, `isBusy()`, and `close()`. The companion authenticates requests before calling this handler; the factory does not create a listener or authenticate bearer tokens. Unmatched paths return `undefined`.

Each bot owns a Bun/Pi subprocess and `bots/<id>/{agent,workspace,sessions}`. The host has a heartbeat lock so two hosts cannot own the same data directory. Packaged children launch the current executable with `--agent-worker`; development children launch `worker.ts`. `close()` cancels runs, rejects approvals, shuts down extensions, and waits for children, terminating a child after five seconds if necessary.

Only the configured OpenAI model is selected (`LABORA_OPENAI_MODEL`, default `gpt-5.5`). A prompt is rejected before inference if the bot lacks ChatGPT subscription credentials. Provider API keys and companion management/client credentials are excluded from the child environment. Model cache warming is disabled. A random per-bot device UUID persists in `agent/device-id` for OpenAI's ChatGPT login flow.

Executor uses `agent/mcp-auth.json`, Pi 1.0's namespaced credential format, with file and refresh locks. It can reuse the same bot's CLI Executor login without copying tokens to another store. Interactive OAuth is explicit; a connection with no refresh credential cannot start its own login flow. Credential readiness reports stored credentials, not a successful remote API call. OAuth callback codes are accepted only through the sign-in input command and are never published as events.

| Route                                     | Result                                        |
| ----------------------------------------- | --------------------------------------------- |
| `GET /v1/bots`                            | `{ bots }`                                    |
| `POST /v1/bots`                           | `{ bot }` from `CreateBot`                    |
| `PATCH /v1/bots/:id`                      | `{ bot }` from `UpdateBot`                    |
| `GET /v1/bots/:id/messages`               | `MessageSnapshot`                             |
| `POST /v1/bots/:id/messages`              | `{ runId }`, or an honest admission error     |
| `GET /v1/bots/:id/activity`               | Activity without starting a dormant worker   |
| `POST /v1/bots/:id/inputs`                | Run-scoped steering or queued follow-up      |
| `POST /v1/bots/:id/questions/:requestId` | Answer or skip a pending model question      |
| `POST /v1/bots/:id/cancel`                | Cancels current run or sign-in                |
| `GET /v1/bots/:id/events?cursor=N`        | SSE; `Last-Event-ID` also accepted            |
| `GET /v1/bots/:id/auth`                   | `AuthStatus`                                  |
| `POST /v1/bots/:id/auth/start`            | Starts OpenAI or Executor sign-in             |
| `POST /v1/bots/:id/auth/input`            | Supplies pending sign-in input                |
| `POST /v1/bots/:id/approvals/:requestId`  | Approves or denies exactly one pending action |
| `GET /v1/bots/:id/files`                  | `{ files }` with workspace-relative paths     |
| `GET /v1/bots/:id/files/content?path=...` | File bytes, maximum 50 MB                     |

Clients replace their message list from `MessageSnapshot`, restore its `busy` and `pending` state, then subscribe after its `cursor`. The cursor is captured while consuming the child's snapshot reply. A current streaming assistant fragment is included in the snapshot. Persisted and live message IDs agree. SSE replays the last 2,048 events, rejects expired cursors, and sends a keep-alive comment every 15 seconds. The companion should disable its HTTP idle timeout for SSE. Cloud idle management must use `isBusy()` so a run does not stop when its viewer disconnects.

The optional computer adapter is the only route to a computer. An absent adapter removes computer tools. The host and worker both force `actor: 'agent'`; the companion applies user takeover and frame checks. Computer input, terminal/file mutations, and Executor operations require a per-call human approval, including calls nested inside codemode. Executor resume is never automatically accepted. Approval requests expire after five minutes. This is a trusted personal companion: subprocesses and workspace paths are not an OS security boundary, and approved terminal commands retain the companion user's access.

`bun src/backend/verify.ts` exercises two real Pi subprocesses in temporary storage: ownership, signed-out rejection before inference, event replay, metadata persistence, workspace download and escape rejection, and process cleanup. It uses an unreachable loopback Executor URL and no real credentials. It does not establish live provider, OAuth, or computer-input proof.

OpenAI sign-in uses Labora's provider override in `openai.ts` while retaining Pi's Responses inference implementation. The override preserves the issued client ID after an unsuccessful code exchange, uses Labora's name for initial registration, and validates ID-token signature, issuer, audience, expiry, and nonce before storing login credentials. This follows [OpenAI's registration and sign-in requirements](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). An ID token is never included in an emitted authorization URL.

The earlier registration was rejected for its workspace and plan on 2026-10-02. A later, separate Hydra bot completed fresh Labora authorization and real subscription inference, including model-selected Executor reads. The packaged native client, companion, and Pi worker passed streaming, Stop, and transcript-restoration checks. See [verification evidence](../../verification/README.md). This local authorization does not authenticate a Cloudflare bot.

Model questions use a separate `ask_user` tool and question-response channel. Pi extension `select`, `input`, and `confirm` dialogs use the same native bridge. Pending questions and input queues are replayed from snapshots; answers and queued messages must match the active run and conversation. Client IDs make repeated queue submissions idempotent. Stop clears queued messages so they cannot leak into a later task. Steering resolves a pending question as redirected without approving consequential tools.

`update_plan` stores a validated, conversation-scoped checklist with atomic private writes. Plans restore independently of the event replay window. Bounded tool-progress events provide current output while automatic compaction and retries keep explicit activity states. Default read/search tools are enabled in both the companion worker and diagnostic CLI. The interactive question, queue, and plan UI belongs to the companion/native path.
