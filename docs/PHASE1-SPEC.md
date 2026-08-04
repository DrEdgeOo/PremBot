# PremBot phase 1 implementation spec: unified registry + reverse channel + MCP

Status: PART DONE. Sections 0 and 1 are IMPLEMENTED and verified (PR #5, branch
`claude/phase1-remote-access-setup-3egtxf`, branched from Y3Um6), pending in-Premiere testing.
Sections 2 through 4 remain DESIGN and have never run inside Premiere: treat every claim about UXP or
Premiere behavior in them as a hypothesis to test, not a house rule. Where this spec and `CLAUDE.md`
conflict, `CLAUDE.md` wins, because it records what has been proven.

Two claims in the original version of this spec were wrong and have been corrected in place, marked
CORRECTED. Both corrections came from implementing section 1. Read them; the section 3 one changes the
architecture.

Once phase 1 completes, distill what proved true into `CLAUDE.md` (repo facts) or a skill (portable
how-to), and discard this file.

Goal: let an external brain (browser Claude via a custom connector) drive PremBot's existing tools, without
changing what any tool does.

---

## 0. Prerequisites — DONE

1. [DONE] Move `client/js/agent.js`, `tools.js`, `transcribe.js`, `main.js`, `ui.js`, `storage.js`,
   `host-bridge.js` into `client/js/_legacy/`. They are the v1 CEP implementation, not loaded by
   `client/index.html`, and they look exactly like the code this spec adds. Leaving them in place invites a
   future session to edit the wrong `tools.js`. Update the note in `CLAUDE.md` when you move them.
2. [DONE] Confirm the helper still boots after the move (it loads only `CSInterface.js` and `bridge.js`).
   Verified: `client/index.html`'s two script tags still resolve, and no live helper code referenced the
   moved files.

Also done in the same pass: both `scripts/*.bat` had a stale `BRANCH=claude/adobe-premiere-plugin-askaU`
and now point at the phase 1 working branch.

---

## 1. The unified tool registry — DONE

Today the two halves are joined by name convention:
- Schemas: `uxp/agent.js` `TOOLS` array (lines 19-1515), shape `{name, description, input_schema}`.
- Handlers: three tables built inside the loop, looked up in order `primitives` → `transcriptHandlers` →
  `helperHandlers` (dispatch at ~line 2529).

Bind them into one object so a tool has exactly one definition.

### New file: `uxp/registry.js`

Loaded in `uxp/index.html` AFTER `index.js`, `helper-client.js`, `transcripts.js`, `audio.js`, `vision.js`
and BEFORE `agent.js` (it depends on the primitive modules; `agent.js` depends on it).

Exports `globalThis.PremBotRegistry` with:

```
build(ctx)      -> returns { tools: [...], handlers: {...}, byName: {...} }
```

`ctx` carries what the handler tables need today (`helper`, `transcripts`, `mediaFolder`, and so on) so
the closures that currently capture those keep working unchanged.

**CORRECTED — do not rebuild the tools array.** The original spec said to send
`registry.tools.map(({name, description, input_schema}) => ...)` to the API. That is unsafe: rebuilding the
objects only yields an identical payload if every literal in `TOOLS` happens to declare its keys in that
exact order. The implemented approach instead returns the ORIGINAL literal array by reference as
`build().tools`, and keeps the new `runsIn` / `mutating` metadata in a separate `TOOL_META` table keyed by
name. The metadata therefore cannot leak into the wire payload by construction, rather than by luck.

Conceptually each tool still has one definition; physically the schema and the metadata live in two tables:

```
{
  name: "add_transition",
  description: "...",          // unchanged, moved from TOOLS
  input_schema: { ... },       // unchanged, moved from TOOLS
  runsIn: "uxp" | "helper" | "node",   // in TOOL_META, NOT in the wire payload
  mutating: true | false,              // in TOOL_META, NOT in the wire payload
  handler: async (input, ctx) => { ... }   // the existing function body
}
```

Two new fields, both load-bearing later:
- `runsIn` — where the work ultimately lands. `"uxp"` for `PremBotPrimitives` and anything touching
  `premierepro` or `ppro.Exporter`. `"helper"` for ExtendScript-routed tools. `"node"` for `NODE_HANDLERS`
  (ffmpeg, Python sidecars). Derive it mechanically from which table the handler lives in today.
  **CORRECTED: this is documentation, NOT a routing key.** See section 3.
- `mutating` — whether the tool changes the project. Used for the confirmation gate and for deciding what
  is safe to expose remotely. Mark every tool that writes to the timeline, bin, or disk.

### Refactor `uxp/agent.js`

- Replace the `TOOLS` array with `PremBotRegistry.build(ctx)`, and send
  `registry.tools.map(({name, description, input_schema}) => ({name, description, input_schema}))` to the
  API. The wire payload must be byte-identical to today's so prompt caching on the tools prefix is not
  invalidated. Verify this: cache misses on every turn would be an expensive silent regression.
- Replace the three-table lookup with `registry.byName[block.name]`.
- Leave everything else alone: `MAX_TURNS`, `callClaude` retry/429 handling, image pruning, the
  `__imageContent` / `__imageContents` result path, and `finish`.

### Acceptance for step 1 — MET (pending in-Premiere confirmation)

Verified by the implementing session:
- Serialized tools payload byte-identical before and after: 50,899 bytes, sha256
  `70a1d676b6a3d1736ecad440cf5f4dd8e2533af467b0af0d276612a6d4547ded`, plus a direct string comparison.
  55 tools including the trailing `cache_control` block. The prompt-cache prefix survives.
- All 55 tools resolve to the same handler table as before (mock-driven test). Same
  primitives → transcripts → helper precedence, same "Unknown tool" error.
- `agent.js` shrank from 2,603 to ~660 lines. Code was sliced out verbatim by script with boundary
  assertions, not retyped.
- `node --check` passes on both files. `PremBotAgent.TOOLS` was dropped (unused; `ui.js` only calls
  `runAgent`).

One deliberate behavior tightening, noted here because it is a security improvement and not a regression:
previously a hallucinated tool name that happened to match a function on `PremBotPrimitives` (`ping`,
`export_frame_at`, the `probe_*` helpers) would silently execute. Now only the 55 DECLARED tools dispatch.
No declared tool changed behavior. This matters much more once a remote surface exists.

Also found: `generate_lut` had a dead duplicate entry in `helperHandlers`; primitives already won.

STILL REQUIRED: run a real multi-step edit inside Premiere covering all three dispatch tables (a pure UXP
primitive, a transcript tool, and a helper-routed tool) and confirm behavior is unchanged.

---

## 2. The reverse channel (the only new architecture)

### Why

MCP needs Node. Only the helper has Node. But `runsIn: "uxp"` tools execute in the UXP panel, and today the
channel is one-way: `PremBotHelper.call()` makes UXP an HTTP *client* of the helper
(`POST http://127.0.0.1:53210/exec/<tool>`). The helper cannot call into UXP. Frame export
(`ppro.Exporter.exportSequenceFrame`) is UXP-only on 26.2.2, so without a reverse path a remote brain
cannot see the timeline.

Fix: UXP dials out and waits for work. Same pattern as Higgsfield's hidden bridge panel.

### Helper side: add a queue to `client/js/bridge.js`

Add an in-memory queue plus three routes in the existing `http.createServer` handler, alongside `/ping` and
`/exec/:tool`:

- `GET /pending` — long-poll. If a command is queued, respond immediately with
  `{ ok:true, command:{ id, tool, input } }`. Otherwise hold the response up to ~25s and then return
  `{ ok:true, command:null }`. Keep the hold under any proxy idle timeout.
- `POST /result` — body `{ id, ok, result?, error? }`. Resolves the pending promise for that id.
- `POST /enqueue` — internal, used by the MCP layer. Body `{ tool, input }`. Returns a promise that
  settles when `/result` arrives, or rejects on timeout.

Implementation notes:
- One `Map` of `id -> { resolve, reject, timer }`. Generate ids with a counter plus a random suffix.
- Per-command timeout, generous (vision and Demucs calls are slow). Reject with a distinct
  `UXP_TIMEOUT` error so it is distinguishable from a tool failure.
- Only one UXP poller is expected. If a second `/pending` arrives while one is waiting, answer the older
  one first (FIFO) rather than fanning out.
- Surface queue depth and last-poll time in the helper panel UI next to the existing status line, so you
  can see at a glance whether UXP is connected.

### UXP side: new file `uxp/remote.js`

Loaded after `registry.js`. Exports `globalThis.PremBotRemote` with `start()`, `stop()`, `isRunning()`.

Loop:
1. Resolve the port with the existing `PremBotHelper.getPort()` (do not duplicate the discovery logic).
2. `GET /pending`. On a command, look it up in `registry.byName`, run the handler, `POST /result`.
3. On network error, back off (1s, 2s, 4s, capped ~15s) and retry. A closed helper panel is the normal
   case, not an error state.
4. Loop until `stop()`.

Rules:
- Run commands one at a time. Premiere's action model does not want concurrent mutations, and your existing
  code assumes sequential execution.
- Never throw out of the loop. Catch per command, post the error as a result, keep polling.
- Image results: `__imageContent` / `__imageContents` carry base64. Post them through `/result` as-is and
  let the MCP layer convert to MCP image content. Do not log the base64.

### Opt-in control

Add a visible toggle in `uxp/ui.js` ("Allow remote control", default OFF) that calls
`PremBotRemote.start()` / `.stop()`, plus a live indicator. Remote drive must never be silently active.
Persist the setting alongside `prembot.settings.v1` if you want it sticky, but default to off on install.

### Acceptance for step 2

Before any AI is involved, drive it by hand:

```
curl -X POST http://127.0.0.1:53210/enqueue \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_sequence_clips","input":{}}'
```

with the toggle on, and get real clip data back. Then repeat with a frame-export tool and confirm base64
comes through. If this works, the hard part of phase 1 is done.

---

## 3. The MCP server

Add to the helper's Node process, on a SEPARATE port from 53210 (keep the UXP channel and the external
surface distinct, so tunneling one never exposes the other).

- Implement Streamable HTTP MCP. Use the official TypeScript/JS MCP SDK if you can vendor it into the CEP
  panel; otherwise implement the JSON-RPC surface directly. Note CEP has no build step here, so a
  dependency must be a plain file you can `require`.
- `tools/list`: serve the registry, mapping `input_schema` to MCP's `inputSchema`. Exclude any tool you do
  not want remotely reachable (see security).
- `tools/call`: **CORRECTED — route ALL tools through `/enqueue` (the reverse channel). One path, no
  special cases.** The original spec said to route by `runsIn`, sending `"helper"` and `"node"` tools
  straight to `/exec/<name>`. That is wrong, and implementing section 1 proved it: every handler closure
  executes in the UXP process, and most helper-routed handlers do real work in UXP before calling the
  helper, reshaping tool names and arguments on the way (for example `trim_v1_clip` lists clips in UXP,
  then calls `/exec/trim_clip`). The MCP tool names are therefore NOT pass-throughs to `/exec` names.
  Shortcutting would silently call the wrong endpoint with the wrong arguments.

  Two consequences, both load-bearing:
  1. **The UXP panel must be open for ANY remote tool call.** The helper alone cannot service the tool
     surface. Surface this clearly: if the reverse channel has no poller attached, the MCP server should
     fail fast with a clear error rather than hanging until timeout.
  2. **The reverse channel is the single point of failure for the entire remote surface.** This raises the
     bar on its timeout handling, error reporting, and queue visibility. Budget for that.

  If you later want a fast path for a specific tool, verify it individually as an exact pass-through and
  allowlist it. Do not infer it from `runsIn`.
- Convert `__imageContent` results into MCP image content blocks.
- Return errors as structured MCP errors, not HTTP 500s.

### Acceptance for step 3

Point a local MCP client at it (before any tunnel) and list plus call tools successfully.

---

## 4. Tunnel and connector

Only after 1-3 pass, and only after the security section is implemented.

1. Cloudflare Tunnel or ngrok to a stable HTTPS URL, pointed at the MCP port only.
2. claude.ai > Settings > Connectors > Add custom connector. Paste the URL. Put the bearer token in
   Request headers (or wire OAuth).
3. Enable it per conversation via the "+" button.

### Phase 1 exit criteria

A browser conversation performs a multi-step Premiere edit through the tunnel, including at least one
`runsIn:"uxp"` tool (proves the reverse channel) and one frame export (proves the agent can see), with
every call authenticated and logged.

---

## 5. Test order (do not skip ahead)

1. Registry refactor, existing panel unchanged.
2. Reverse channel driven by curl, no MCP.
3. MCP server, local client, no tunnel.
4. Tunnel plus connector.

Each layer is separately debuggable. Adding all four at once is how this phase goes bad.

---

## 6. Known risks to watch

- ~~Prompt-cache invalidation if the tools payload changes shape during the refactor.~~ RESOLVED: payload
  verified byte-identical. Re-verify if the registry is restructured again.
- Because all remote calls now traverse the reverse channel, a closed UXP panel disables the whole remote
  surface. Make that state obvious in the UI and in MCP error messages.
- UXP long-poll behavior across panel reload: `stop()` must run on panel unload or you will leak pollers.
- CEP JS loads once per Premiere launch, so every `bridge.js` change needs the helper panel closed and
  reopened. Expect this to be the slowest part of the dev loop.
- A UXP tool that hangs will hold a queue slot until the timeout. Keep timeouts finite.
- Vision results are large. Do not let base64 into the helper log.
