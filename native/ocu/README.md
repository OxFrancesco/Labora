# Open Computer Use for Labora

Labora bundles Open Computer Use 0.3.3 from the same pinned upstream revision used by Liny. `upstream.json` records the source revision and archive checksum. `bun scripts/build-ocu.ts` verifies that archive, applies `labora.patch`, compiles Swift, and signs `dist/Labora Open Computer Use.app`. The desktop build embeds it in `Contents/Helpers` with its MIT license and third-party notices.

The patch gives the helper its own `org.buddytools.LaboraOpenComputerUse` permission identity and adds a read-only JSON permission command. It does not reuse Liny's permissions or include Liny's custom automation-plan tools. The nine upstream MCP tools run through Pi's persistent stdio transport on the agent's computer. `LABORA_OCU_HELPER` can override the binary in development.

Connect from the marketplace for each agent. Missing Accessibility or Screen Recording permission opens the helper's native setup window on that agent's Mac. After granting permissions, connect again. No API key or browser account is required. Pause and disconnect close the MCP process; cancellation closes the process group without replaying actions. The app-agent proxy is explicitly disabled, so cancelled work cannot continue in a detached MCP server.

Enabled OCU tools run without per-action Labora approval prompts, including calls through code mode. Paused or disconnected connectors remain unavailable. The separate built-in desktop input tools retain their approval flow. macOS Accessibility and Screen Recording permissions are still required.

`bun scripts/verify-ocu.ts` exercises the bundled server against a dedicated AppKit fixture, checks that a snapshot element click increments its counter exactly once, and verifies pause, re-enable, persistence, disconnect, and the packaged marketplace. Screenshots and a native recording go to `evidence/ocu-*`. The fixture does not manipulate unrelated apps or invoke a model.
