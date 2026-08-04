# PremBot phase 1 implementation spec: unified registry + reverse channel + MCP

Status: DESIGN, unproven. This describes work that has never run inside Premiere. Treat every claim about
Premiere behavior here as a hypothesis to test, not a house rule. Once phase 1 runs, distill what actually
proved true into `CLAUDE.md` (repo facts) or a skill (portable how-to), and discard this file.

Branch: do this on its own branch. It touches the agent loop, the helper, and adds a UXP module.

Goal: let an external brain (browser Claude via a custom connector) drive PremBot's existing tools, without
changing what any tool does.

---

## 0. Prerequisites (do these first, they are cheap)

1. Move `client/js/agent.js`, `tools.js`, `transcribe.js`, `main.js`, `ui.js`, `storage.js`,
   `host-bridge.js` into `client/js/_legacy/`. They are the v1 CEP implementation, not loaded by
   `client/index.html`, and they look exactly like the code this spec adds. Leaving them in place invites a
   future session to edit the wrong `tools.js`. Update the note in `CLAUDE.md` when you move them.
2. Confirm the helper still boots after the move (it loads only `CSInterface.js` and `bridge.js`).

---

## 1. The unified tool registry

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

Each registry entry:

```
{
  name: "add_transition",
  description: "...",          // unchanged, moved from TOOLS
  input_schema: { ... },       // unchanged, moved from TOOLS
  runsIn: "uxp" | "helper" | "node",
  mutating: true | false,
  handler: async (input, ctx) => { ... }   // the existing function body
}
```

Two new fields, both load-bearing later:
- `runsIn` — where the work executes. `"uxp"` for `PremBotPrimitives` and anything touching `premierepro`
  or `ppro.Exporter`. `"helper"` for ExtendScript-routed tools. `"node"` for `NODE_HANDLERS` (ffmpeg,
  Python sidecars). This is what the MCP layer uses to decide whether a call must go through the reverse
  channel. Derive it mechanically from which table the handler lives in today.
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

### Acceptance for step 1

The existing panel does exactly what it did before. Run a real multi-step edit and diff the behavior. No
new capability is added in this step; that is the point.

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
- `tools/call`: route by `runsIn`. `"node"` and `"helper"` execute directly in the helper exactly as
  `/exec/:tool` does today. `"uxp"` goes through `/enqueue`.
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

- Prompt-cache invalidation if the tools payload changes shape during the refactor.
- UXP long-poll behavior across panel reload: `stop()` must run on panel unload or you will leak pollers.
- CEP JS loads once per Premiere launch, so every `bridge.js` change needs the helper panel closed and
  reopened. Expect this to be the slowest part of the dev loop.
- A UXP tool that hangs will hold a queue slot until the timeout. Keep timeouts finite.
- Vision results are large. Do not let base64 into the helper log.
