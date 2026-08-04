# PremBot phase 1 implementation spec: unified registry + reverse channel + MCP

Status: PART DONE.

- **Sections 0 and 1: IMPLEMENTED and verified**, in Premiere (26.3.0) as well as offline. See the step 1
  acceptance block for what was actually confirmed.
- **Sections 2 through 4: CODE-REVIEWED, but still UNIMPLEMENTED and UNPROVEN.** A second model reviewed
  them against the code on `main` and its findings are folded in below. That review raised the confidence in
  the *design*; it changes nothing about the *evidence*. No line of sections 2–4 has run inside Premiere.
  Treat every claim about UXP or Premiere behavior in them as a hypothesis to test, not a house rule.

Where this spec and `CLAUDE.md` conflict, `CLAUDE.md` wins, because it records what has been proven — with
one deliberate exception, documented in section 2: the confirmation-gate rule under `CLAUDE.md`'s "Tool
exposure" was **amended in the same commit as this spec revision** to describe session-scoped arming.

Claims in earlier versions of this spec that turned out to be wrong are corrected **in place**, marked
CORRECTED, with the reasoning kept rather than silently rewritten — so a future reader can see what was
assumed versus what was checked. There are now three rounds of them:
1. From implementing section 1: the tools-array rebuild, and `runsIn` as a routing key (the section 3 one
   changed the architecture).
2. From the section 2–4 code review: the acceptance-test tool name, the FIFO second-poller rule, the fixed
   25s long-poll, `getPort()` as a liveness signal, the missing registry instance, `finish`, and the
   connector's Request-headers field.
3. One correction *to* that review, kept for the same reason: `finish` **does** have a `registry.byName`
   entry — see section 2.

Two things this spec deliberately does **not** guess at are written up as numbered steps to perform, not
assumptions to inherit: **STEP 1** (log `process.version`, section 3) and **STEP 2** (check the connector
dialog for a Request headers field, section 4).

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

### Acceptance for step 1 — PASSED (in-Premiere, Premiere 26.3.0)

Verified by the implementing session (offline, before Premiere loaded the panel):
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

Confirmed live inside Premiere (26.3.0, an unplanned mid-project update — see CLAUDE.md), closing out the
"still required" item above:
- All three dispatch tables exercised: `list_timeline_clips` (primitives), `list_cached_transcripts`
  (transcripts), `list_audio_clips` (helper-routed), plus `discover_premiere_capabilities`. No "Unknown
  tool" errors.
- Console clean on panel load — no registry errors.
- Prompt cache confirmed live in production, not just offline: the agent log showed a cache read of
  20330 tokens identically on every turn across a 7-turn session, consistent with the byte-identical
  payload above.
- A real multi-step edit behaved as it did before the refactor.

Also surfaced in this session, unrelated to the registry: Premiere 26.3.0 broke `add_transition` (see
CLAUDE.md "Hard-won lessons"). It reproduces identically with or without the registry refactor and is
tracked separately as a platform regression, not a step-1 defect.

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

- `GET /pending?wait=<seconds>` — poll for work. If a command is queued, respond immediately with
  `{ ok:true, command:{ id, tool, input } }`. Otherwise hold the response up to `wait` seconds and then
  return `{ ok:true, command:null }`. Default ~25s; keep the hold under any proxy idle timeout.
  **CORRECTED — `wait` is a parameter, not a fixed 25s hold, and `wait=0` must return immediately.** The
  original spec mandated a 25s hanging GET. Nobody has verified that a hanging GET survives UXP 9.3.0's
  `fetch`, and this spec's own preamble says not to treat unverified UXP behavior as a house rule. With
  `wait` as a parameter, a 1s short-poll is a drop-in fallback if the long hold misbehaves, and `wait=0`
  makes curl testing trivial. **Short-polling on loopback is an acceptable phase 1 answer** — do not treat
  falling back to it as a failure.
- `POST /result` — body `{ id, ok, result?, error? }`. Resolves the pending promise for that id.
- `POST /enqueue` — kept for curl testing, token-gated (see below). Body `{ tool, input }`. A thin wrapper
  over `enqueueCommand()`; see section 3 — the MCP layer calls that function directly rather than
  HTTP-POSTing to itself.

Implementation notes:
- One `Map` of `id -> { resolve, reject, timer }`. Generate ids with a counter plus a random suffix.
- Per-command timeout, generous (vision and Demucs calls are slow). Reject with a distinct
  `UXP_TIMEOUT` error so it is distinguishable from a tool failure. See section 3 for how this timeout must
  layer under the tunnel ceiling.
- **CORRECTED — second-poller handling. The original FIFO rule is wrong; do not implement it.** The spec
  said "if a second `/pending` arrives while one is waiting, answer the older one first (FIFO)." The
  realistic way a second `/pending` arrives is a UXP panel reload, which leaves the first poll as a dead
  socket the server is still holding. Answering the oldest first writes the next command into that dead
  socket: the command is lost and the enqueue promise hangs until `UXP_TIMEOUT`. Replace with:
  1. Hold **at most one** poller.
  2. When a new `/pending` arrives, immediately answer the existing held response with `command:null` and
     keep the new one.
  3. Listen for `close` on the held response so a dead poller frees its own slot.

  This makes the server authoritative about cleanup, which matters because UXP gives no reliable unload
  hook. Wire `stop()` into the panel lifecycle where you can, but treat it as **best effort, not the safety
  mechanism**.
- **Delivery is at-most-once. The channel never retries a command on its own.** If the write to a poller
  fails or the command times out, fail the enqueue promise with the distinct error and stop. Write this
  down because someone — quite possibly a future session — will otherwise add a retry that double-applies
  a mutation.
- **Cap the queue depth** (4–8; reject beyond it). A remote brain can stack commands while nobody is at the
  machine.
- **Define "poller attached"** explicitly: a `/pending` seen within the hold duration plus a grace window.
- Surface queue depth, last-poll time, and connected state in the helper panel UI next to the existing
  status line **and in `/ping`**, so the UXP pill and a curl probe can both see the same state.

Logging and localhost hardening (verified against the current code):
- `/exec` currently logs full un-truncated args (`log("exec " + tool + " " + JSON.stringify(args))`,
  `bridge.js` line 1034). **The new routes must not copy that pattern** — `/result` carries base64.
  Truncate args in the panel log generally, and add the JSONL audit file `CLAUDE.md` requires: timestamp,
  tool, arg summary or hash, duration, status. Never the base64, never the token.
- `send()` (line 93) sets a wildcard `Access-Control-Allow-Origin` and allows `Content-Type` in preflight
  on **every** response, so the bridge answers any origin. That is tolerable for a
  loopback-only `/exec`; `/enqueue` raises the stakes sharply, because with remote control armed it reaches
  the whole allowlist. Fix that fits the existing plumbing: **have the helper mint a random session token at
  startup and write it into `helper-status.json`** (which UXP already reads). UXP sends it as a header on
  `/pending` and `/result`; require it on `/enqueue` at minimum, ideally on `/exec` too. A web page cannot
  read that file.
- Worth a two-minute test: UXP is not a browser and likely ignores CORS entirely, in which case the ACAO
  headers can be dropped from port 53210 altogether.

### UXP side: new file `uxp/remote.js`

Loaded after `registry.js`. Exports `globalThis.PremBotRemote` with `start()`, `stop()`, `isRunning()`.

Loop:
1. Resolve the port with the existing `PremBotHelper.getPort()` (do not duplicate the discovery logic).
2. `GET /pending`. On a command, look it up in `registry.byName`, run the handler, `POST /result`.
3. On network error, back off (1s, 2s, 4s, capped ~15s) and retry. A closed helper panel is the normal
   case, not an error state.
4. Loop until `stop()`.

Three code-level realities the original spec did not account for. All three were checked against the code
on `main`:

- **CORRECTED — `getPort()` never returns falsy, so do not use it as a liveness signal.**
  `helper-client.js` line 72 is `const port = (status && status.port) || HELPER_PORT`, with
  `HELPER_PORT = 53210`, so it falls back to the hard-coded port unconditionally even with no status file.
  The existing `if (!port)` guards in `call()` and `isAvailable()` are already dead code. A closed helper
  surfaces as a **fetch failure**, not a missing port; the backoff loop handles that correctly. Do not write
  a port-truthiness check expecting it to mean anything.
- **CORRECTED — there is no long-lived registry instance for `remote.js` to grab.** The registry is built
  per run *inside* `runAgent()` (`agent.js` line 552) from ctx assembled at run time, and `loadSettings()`
  is private to `ui.js` (never exported on `globalThis`). Fix: expose a small
  `globalThis.PremBotSettings.load()` accessor, and have `remote.js` call `PremBotRegistry.build()` **per
  command** with fresh settings. `build()` is cheap, and this keeps remote semantics identical to local,
  including picking up mid-session settings changes.
- **CORRECTED, with a precision fix to the review — `finish` has a `byName` entry, but no handler.** The
  review said `finish` "has no entry in `registry.byName`." Verified: it *does* — `registry.byName.finish`
  exists with `name` / `description` / `input_schema` / `runsIn` / `mutating`, because it is in `TOOLS`.
  What it lacks is a `handler` (it is `undefined`, and `handlers.finish` is absent), since the agent loop
  special-cases `finish` before dispatch (`agent.js` line 591). The conclusion is unchanged and the
  distinction is what `remote.js` must code against: **look up `const entry = registry.byName[tool]` and
  check `entry && entry.handler`**, exactly as `agent.js` does — a `byName` hit alone does not mean the tool
  is callable. **Exclude `finish` from the remote surface regardless**: it is loop control for the local
  agent, and a remote brain runs its own loop.

Rules:
- Run commands one at a time. Premiere's action model does not want concurrent mutations, and the existing
  code assumes sequential execution.
- **Serialize against the local agent with a shared async mutex.** `remote.js` running one command at a time
  is not enough: a remote mutation can still land mid-turn while the panel agent is executing its own tools.
  Interleaving `executeTransaction` calls and ExtendScript round-trips from two drivers is untested and
  there is no reason to find out. Add a promise-chain mutex on a global, acquired **per tool call by both**
  the agent loop's dispatch and the remote executor. Roughly ten lines; closes a whole category of
  weirdness.
  **The mutex protects against two drivers, not against the user.** If mutations are armed while you are
  hand-editing in Premiere, the mutex does nothing for you — which is part of why the indicator below has to
  be genuinely loud.
- Never throw out of the loop. Catch per command, post the error as a result, keep polling.
- Image results: `__imageContent` / `__imageContents` carry base64. Post them through `/result` as-is and
  let the MCP layer convert to MCP image content. Do not log the base64.

### Arming control — the deferred decision, now RESOLVED

The original spec said "add a visible toggle, default OFF, persist it if you want it sticky." That under-
specifies the thing `CLAUDE.md` actually requires, and the review was right to flag it: `CLAUDE.md` mandates
a confirmation gate for `mutating` tools and sections 2–4 never designed one.

**DECISION: session-scoped arming, not per-call approval.**

- A **three-position control** in the UXP panel: **off** (default) / **read-only** / **mutations armed**.
- **Reverts to off on every Premiere launch.** Never persisted, never silently re-armed.
- A **loud, persistent indicator** whenever it is above off.
- **Arming IS the deliberate approval.** The user makes it once, consciously, per session.

Rationale, recorded so this does not read as drift: **per-call approval is incoherent for this product.**
The entire point is driving Premiere while not sitting in front of it, and a tool call blocking on a click
against a ~100s tunnel ceiling fails precisely when the feature is being used as designed.

**The allowlist is the real control, not the gate.** Default-deny, non-mutating tools first, each mutating
tool added deliberately. The gate stops accidents; the allowlist stops categories. `CLAUDE.md`'s "Tool
exposure" rule was amended in the same commit as this spec change to describe session-scoped arming — the
weakening is explicit and deliberate, not an accident of implementation.

**Kill switch:** one action that stops the MCP server and **fails every in-flight enqueue**, not merely
drains the queue. A stop that leaves promises hanging is not a kill switch.

### Acceptance for step 2

Before any AI is involved, drive it by hand:

```
curl -X POST http://127.0.0.1:53210/enqueue \
  -H "Content-Type: application/json" \
  -H "X-PremBot-Token: <token from helper-status.json>" \
  -d '{"tool":"list_timeline_clips","input":{}}'
```

**CORRECTED — the tool name was wrong in the original spec.** It said `list_sequence_clips`, which is the
name of the *internal* UXP function (`index.js` line 105); the **registered tool name is
`list_timeline_clips`** (`registry.js` line 156, mapped at `index.js` line 2792). After step 1's tightening
only the 55 declared names dispatch, so the original command would have returned `Unknown tool` and looked
exactly like a broken reverse channel on the first end-to-end test.

Run it with the control armed and get real clip data back. Then repeat with a frame-export tool and confirm
base64 comes through. If this works, the hard part of phase 1 is done.

---

## 3. The MCP server

Add to the helper's Node process, on a SEPARATE port from 53210 (keep the UXP channel and the external
surface distinct, so tunneling one never exposes the other).

- **Do not HTTP-POST to yourself.** The MCP layer lives in `bridge.js`'s own process. Expose
  `enqueueCommand(tool, input)` as a plain in-process function; both the MCP handler and the `/enqueue`
  HTTP route (kept for curl testing, token-gated) call it. One less serialization hop, one less thing to
  secure.
- Implement Streamable HTTP MCP. Use the official TypeScript/JS MCP SDK if you can vendor it into the CEP
  panel; otherwise implement the JSON-RPC surface directly. Note CEP has no build step here, so a
  dependency must be a plain file you can `require`.

  **STEP 1 (do this before choosing SDK vs hand-rolled — it is one line and settles the question):**
  add `log(process.version)` to `bridge.js` startup and read what it prints when the helper panel opens.
  CEP 12 shipped with Premiere 25.0, updated Chromium to 99 and V8 to 9.9, and is the last major CEP
  update — which likely puts the helper's Node in the **17.x** range. The official MCP TypeScript SDK
  targets **Node 18+** and leans on globals like `fetch` that 17 does not ship. Nobody has verified the
  actual version on this machine, so do not speculate: read the line.
  *(This line has already been added to `bridge.js` in the same commit as this spec revision — it prints on
  helper startup as `node <version>`.)*

  Expected outcome is hand-rolling the JSON-RPC surface, which this spec already permits and which fits the
  codebase's no-build-step reality. Scope it to: `initialize` (with protocol version negotiation),
  `notifications/initialized`, `tools/list`, `tools/call`, and `ping`. Stateless operation is legal. Return
  405 on GET if you skip server-push. JSON responses only, no SSE, to start.

  **Verify the protocol revision against the current MCP spec when you write this, rather than assuming.**
  The protocol has had revisions and nobody here can promise which one claude.ai negotiates today.
- `tools/list`: **an explicit allowlist, not the registry.** `CLAUDE.md` already mandates default-deny; the
  original spec's "exclude any tool you do not want remotely reachable" understates it. Start with the
  non-mutating set plus the specific mutating tools you actually intend to drive remotely, and grow
  deliberately. `finish` is out regardless (see section 2). Schema mapping is trivial — `input_schema` to
  `inputSchema`, and the names are already MCP-safe.
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
- Convert `__imageContent` / `__imageContents` results into MCP content arrays of text and image blocks —
  the existing interleaving maps one-to-one. **Watch `analyze_v1_frames_for_grade`**: many clips means many
  megabytes of base64 in a single response. Consider capping frames per remote call.
- **The `ok:false` convention, decided now.** Handler-level failures (`{ok:false, ...}`) travel as **normal
  tool results with `isError`**, exactly as the local agent sees them. Reserve **MCP protocol errors** for
  channel failures — no poller attached, `UXP_TIMEOUT`, token rejected. Do not collapse the two: a tool that
  legitimately reports `ok:false` is not a transport failure, and a remote brain needs to tell them apart to
  decide whether retrying could ever help.
- **Timeout layering, one deliberate choice.** The reverse-channel per-command timeout must be **shorter**
  than what the client-plus-tunnel path tolerates, or the client gives up while the helper still holds the
  slot. Cloudflare's proxy cuts responses at roughly **100 seconds** on non-Enterprise plans — verify on
  whichever plan is actually in use. **Demucs, bulk transcription, and multi-clip vision will blow through
  that: document them as local-only for phase 1 and leave them out of the remote allowlist.** A
  start/poll job-handle pattern is the phase 2 answer if they are wanted remotely.

### Acceptance for step 3

Point a local MCP client at it (before any tunnel) and list plus call tools successfully.

---

## 4. Tunnel and connector

Only after 1-3 pass, and only after the security section is implemented.

**STEP 2 (do this before committing to bearer auth — it is a dialog check, not a code decision):**
open claude.ai > Settings > Connectors > **Add custom connector** and look for a **Request headers** field.
Request-header auth for custom connectors is documented — with header names restricted to an allowlist like
`authorization`, `x-api-key`, `x-auth-token` — but the feature has been in beta and rolling out slowly, and
users have reported a connector UI offering only OAuth fields with no way to set a bearer token. So do not
design as though the field is guaranteed to be there; look first.

**CORRECTED — build the server to accept the token from EITHER a header OR a URL path segment.** The
original spec said simply "put the bearer token in Request headers." Accepting both means the capability-URL
fallback needs **no redeploy** if the dialog turns out to lack the header field:
- **Header present** → proceed as originally specced.
- **Header absent** → an unguessable URL path segment as a capability URL. Full OAuth is not worth spending
  on phase 1.
- Cloudflare Access service tokens do **not** help here, since claude.ai cannot send arbitrary headers.

Then:
1. Cloudflare Tunnel or ngrok to an HTTPS URL, pointed at the MCP port only. Note that a **named** Cloudflare
   tunnel requires a domain in your Cloudflare account; **quick tunnels rotate their URL on every start**.
   Given `CLAUDE.md`'s bring-the-tunnel-down-when-not-working rule, a rotating quick-tunnel URL is arguably
   a phase 1 *feature*, not a defect. Either way the MCP port binds `127.0.0.1` only and the tunnel connects
   locally.
2. claude.ai > Settings > Connectors > Add custom connector. Paste the URL. Supply the token by whichever of
   the two paths STEP 2 established.
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
- ~~UXP long-poll behavior across panel reload: `stop()` must run on panel unload or you will leak
  pollers.~~ SUPERSEDED by the corrected second-poller rule in section 2: the server releases the old poller
  itself and watches for `close`. `stop()` on unload is best effort, not the safety mechanism.
- CEP JS loads once per Premiere launch, so every `bridge.js` change needs the helper panel closed and
  reopened. Expect this to be the slowest part of the dev loop.
- A UXP tool that hangs will hold a queue slot until the timeout. Keep timeouts finite.
- **UXP panel throttling when hidden.** Verify the poller keeps its cadence with the panel docked behind
  another tab and during a long render. Premiere's suspension behavior for background UXP panels is unknown
  and it gates the entire remote surface — if a hidden panel stops polling, remote control silently dies
  exactly when you are away from the machine.
- **Machine sleep kills in-flight polls.** The backoff loop already covers recovery; stating it so nobody
  reads a post-sleep reconnect as a bug.
- **Premiere modal states** (export dialogs, rendering) can block transactions queued from remote while
  nobody is watching. The mutex plus the queue depth cap contain this, but they do not eliminate it.
- Vision results are large. Do not let base64 into the helper log.
