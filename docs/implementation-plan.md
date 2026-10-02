# Labora desktop and computers

## Agreed scope

Build a GPUix macOS app matching the installed Grok Bot interface and interactions. A user connects their own computers through Tailscale or selects a Cloudflare Linux desktop. Executor belongs to the running Labora agent. Use Pi 1.0, ChatGPT subscription authentication, Effect 4.0.0, and the current anti-slop rules. Never deploy Labora into Mentasuave.

## Verification gates

The installed native app must create and select bots, preserve chats across restart, accept ordered attachments and clipboard input, resize/collapse panels, show Library and Computer, authenticate integrations, and stream a real agent response. A paired computer must reject unauthenticated requests and support real frame capture, user takeover, and bounded input on a dedicated test window. A Cloudflare desktop must run the same protocol with isolated bot files. Screenshots and recordings accompany each visible gate.

The scope is four runtime components: the GPUix client, authenticated computer companion, isolated Pi processes, and Cloudflare container host. UI inspection covers the sidebar, bot creation, composer, details, library, computer, settings, connection flow, and approval flow. Credentials, OS permissions, and a paid Cloudflare sandbox account are external prerequisites to verify, not features to simulate.

## Work sequence

- [x] Read the Principles section and relevant skill leaves.
- [x] Verify the embedded Executor connection with a real upstream read.
- [x] Inspect Grok Bot and obtain GPUix, Pi, and Effect reference sources with codeview.
- [x] Install Effect 4.0.0 and the requested current anti-slop skill.
- [x] Establish native rendering and an automated screenshot baseline.
- [x] Build persistent bot/chat UI and native attachment interactions.
- [x] Implement the Effect agent host and authenticated computer protocol.
- [x] Wire the native app to streaming agent, OAuth, and approval endpoints.
- [x] Verify a paired computer using the real companion and a dedicated test window.
- [x] Build the Cloudflare desktop image and validate deployment configuration.
- [x] Verify the installed app and deployed desktop.
- [x] Verify real Blender assets in the packaged native renderer and character picker.
- [ ] Verify a model response and model-selected tool turn when ChatGPT eligibility allows.
- [x] Review the evidence and publish the private report.
- [x] Send the final recordings to Telegram.

## Decisions

Computer identity is independent of its Tailscale hostname. Tailscale protects transport; Labora still requires pairing and app credentials. One Pi process owns one bot's credentials and session state. Cloud and personal computers expose the same frame/control protocol. The GUI never silently redirects a remote task to the current Mac.

See `decisions.tsv` for measured checkpoints. Separate directories and APIs are assigned to each implementation agent to avoid concurrent edits.

## Current verification boundary

The packaged macOS app passed 19 recorded checks, including eyes-only Blender character selection and native 3D rotation, process restart, ordered clipboard attachments, and preserving a draft after an honest signed-out send rejection. Real Linux control passed through Tailscale. The Cloudflare Worker passed 13 live checks, including Kitesurf and snapshot restoration; its disposable verification desktop is suspended after each run.

The next source and packaged builds passed 24 recorded native checks, adding settings persistence and real paused/enabled/blocked routine behavior. All 256 installed files match that bundle. CUA verified the installed browser connection choices. Browser enrollment passed discovery, consent, private persistence and acknowledgement with the production UI and a real isolated companion. Its Tailscale discovery and HTTPS transport were injected test fixtures; this does not establish a live personal-tailnet enrollment. Target setup passed eight browser checks plus isolated source and packaged startup checks. Backend verification covers routine cancellation, transcript deletion, inactive enrollment leases, owner/CSRF checks, revocation and concurrent runtime initialization.

ChatGPT was previously rejected for the account's workspace and plan. A new headless Labora sign-in is waiting for browser authorization. No successful model turn or model-selected Executor action has been verified. On-device voice is implemented and packaged, but a real microphone transcript remains unverified. Group chats and complete Grok Bot settings parity remain open.
