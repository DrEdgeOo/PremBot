# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What PremBot is

An AI editing assistant embedded in Adobe Premiere Pro. The user types a
natural-language prompt ("build a 90-second highlight reel", "make a music
video from these clips") and an agent with tool access to the timeline
transcribes footage, analyzes clips, detects beats, and edits the active
sequence.

**Product direction:** the long-term goal is an all-in-one ("Swiss army
knife") editing companion with a built-in AI agent skilled enough to remove
Premiere's learning curve — letting anyone realize an editorial vision
without years of NLE experience. Evaluate new features and dependencies
against that north star, not just the current feature set. An After Effects
counterpart is a plausible future chapter. Do not treat the current scope as
the ceiling.

## Architecture: the two-panel design

This is the single most important thing to understand, and it requires
reading across `uxp/`, `client/`, and `host/`.

PremBot ships as **two cooperating Premiere panels**:

1. **UXP panel "PremBot"** (`uxp/`) — the real product: the chat UI, the
   agent, and all the analysis modules. Modern UXP add-on (`uxp/manifest.json`,
   `manifestVersion 5`, Premiere `25.6.0+`).

2. **CEP panel "PremBot Helper"** (`client/` + `host/` + `CSXS/`) — a
   companion panel whose only job is to do what UXP cannot. `CSXS/manifest.xml`
   declares it; `client/index.html` loads **only** `CSInterface.js` +
   `client/js/bridge.js`.

**Why two panels exist:** UXP has no `evalScript` (Adobe confirmed this is
permanent) and cannot run a Node server. Additionally, several Premiere
26.2.2 UXP action factories are *stubbed* — they exist but throw "Script
action failed to execute". CEP can both call ExtendScript and run Node. So
the helper backfills those gaps.

**How they talk:** the helper's `bridge.js` runs a Node HTTP server on the
**fixed port 53210**. The UXP side calls it through `PremBotHelper.call(tool,
args)` (`uxp/helper-client.js`) → `POST http://127.0.0.1:53210/exec/<tool>`.
The helper writes a liveness file at `%APPDATA%\PremBot\helper-status.json`
(macOS: `~/Library/Application Support/PremBot/`). If the helper panel is not
open, helper-routed tools return `HELPER_NOT_RUNNING`.

`bridge.js` dispatches each `/exec/<tool>` two ways:
- **`NODE_HANDLERS`** (`extract_wav`, `librosa_beat_track`,
  `librosa_drum_detect`, `demucs_separate`, `analyze_clip`) — spawn ffmpeg or
  Python sidecars. These need Node APIs ExtendScript lacks.
- **Everything else** → `pbRun(tool, jsonArgs)` in `host/index.jsx`
  (ExtendScript) via `CSInterface.evalScript`; returns a JSON string.

## UXP module map (`uxp/`)

`uxp/index.html` loads scripts in order; each attaches one global on
`globalThis`, and later modules depend on earlier ones:

- `index.js` → `PremBotPrimitives` — pure-UXP `premierepro` DOM tools
  (list/move/clone/remove/reorder clips, transitions, frame export, LUT
  generation, capability discovery). Also the panel entrypoint.
- `helper-client.js` → `PremBotHelper` — HTTP client to the CEP helper.
- `transcripts.js` → `PremBotTranscripts` — OpenAI Whisper transcription.
- `audio.js` → `PremBotAudio` — audio levels/fades/ducking (helper-routed)
  and beat/stem analysis.
- `vision.js` → `PremBotVision` — clip visual analysis + the music-video
  arrangement engine (`autoArrangeClips`, `applyArrangement`).
- `agent.js` → `PremBotAgent` — the Claude tool-use loop.
- `ui.js` — wires the DOM (settings, Run/Cancel, Apply Arrangement).

## The agent loop (`uxp/agent.js`)

`PremBotAgent.runAgent()` runs a Claude tool-use loop against
`https://api.anthropic.com/v1/messages` (`MAX_TURNS` 25, `MAX_TOKENS` 8192,
prompt caching on the tools+system prefix). The big `TOOLS` array (~50 tools)
defines every capability; the system prompt is rebuilt per run by
`systemPrompt()`.

Tool calls are dispatched by name against three tables, in order:
`PremBotPrimitives` (pure UXP) → `transcriptHandlers` (`PremBotTranscripts`) →
`helperHandlers` (CEP-helper-routed, plus `PremBotAudio` / `PremBotVision`
entry points). The `finish` tool ends the loop.

## External APIs and keys

Two cloud APIs, both BYO-key (entered in the panel's Settings, persisted to
`localStorage` under `prembot.settings.v1`):
- **Anthropic** — the editing agent (`agent.js`). Model is user-selectable
  (`claude-sonnet-4-6` default, `claude-opus-4-7`, `claude-haiku-4-5`).
- **OpenAI Whisper** — transcription (`transcripts.js`,
  `/v1/audio/transcriptions`, 25 MB file cap).

The vision and audio-analysis pipelines run **locally** (see below) — no API.

## Python sidecars + local models (`client/python/`)

Spawned by `bridge.js`. Python interpreter is resolved in order:
`PREMBOT_PYTHON` env var → `py -3` → `python` → `python3`.

- `beat_track.py` — librosa beat/tempo detection (one-shot per call).
- `drum_detect.py` — per-instrument (kick/snare/hihat) onset detection,
  librosa + scipy.
- `stem_separate.py` — Demucs stem separation.
- Vision: `vision_pipeline.py` holds the shared model logic;
  `vision_daemon.py` is a long-lived JSON-Lines RPC process that keeps models
  resident across calls (avoids the 30–60 s reload tax); `vision_analyze.py`
  is the one-shot fallback used when the daemon can't start.

Vision models run locally: **Qwen2.5-VL-7B** (VLM) + **OpenCLIP ViT-H/14**
(embeddings). Configured via env vars: `PREMBOT_MODEL_DIR`,
`PREMBOT_VISION_MODEL`, `PREMBOT_VISION_MODEL_FALLBACK`,
`PREMBOT_CLIP_VISION_MODEL`, `PREMBOT_VISION_USE_DAEMON`.

Caches (keyed by source-path hash + mtime, so editing a source invalidates):
`%TEMP%\PremBot-audio-cache` (WAV extracts, Demucs stems) and
`%TEMP%\PremBot-vision-cache` (sampled frames + `analysis.json`).

## Premiere 26.2.2: what works, what's stubbed

This build has a quirky UXP surface. The header comment in `uxp/index.js`
tracks it, and the `discover_premiere_capabilities` tool probes liveness
live. The practical split:

**Working `premierepro` UXP factories/APIs:** clip move, clone
(`createCloneTrackItemAction` — the "insert" primitive), remove
(`createRemoveItemsAction`), set-disabled, reorder; `projectItem.create-
SetNameAction` (rename a *bin* item); `project.importFiles` (non-action);
`Transcript.exportToJSON`; `ppro.Exporter.exportSequenceFrame`.

**Stubbed UXP factories — exist but throw "Script action failed to execute";
route through the CEP helper / ExtendScript instead:**
- `clip.createSet[End|OutPoint|Start|InPoint]Action` — trim
- `clip.createSetNameAction` on a *trackItem* — rename a timeline clip
- `editor.createInsertProjectItemAction`, `createOverwriteItemAction`
- the Markers `createAddMarkerAction` — add a sequence marker
- `Transcript.createImportTextSegmentsAction` — throws even with valid
  Adobe-schema JSON + a cast `ClipProjectItem`; use `save_transcript_srt`
- `createAddItemAction` — needs 7 args, still throws "Illegal Parameter
  type"; effectively unreachable

Consequences that shape the whole codebase:
- **Placement** uses `createCloneTrackItemAction` (clone an on-timeline
  clip), not bin insert.
- **Clip moves are relative and forward-only.**
- Trim / rename / insert / overwrite / markers all go through the helper.
When something "should" work but doesn't, suspect a stubbed factory first.

## Commands

There is **no `package.json`, no linter, and no automated test suite** —
testing is manual inside Premiere. Available checks:

- Syntax-check a UXP module: `node --check uxp/<file>.js`
  (`host/index.jsx` is ExtendScript — `node --check` does not apply to it).
- Syntax-check the sidecars: `python -m py_compile client/python/*.py`

Deploy / dev loop (Windows; the project targets Windows + macOS):
- **CEP helper**: `scripts/install-windows.bat` downloads a branch zip and
  robocopies `client/`, `host/`, `CSXS/` into
  `%APPDATA%\Adobe\CEP\extensions\PremBot`. Requires unsigned CEP extensions
  enabled (`PlayerDebugMode`; see `README.md`). Copies files only — no pip
  dependency management.
- **UXP panel**: load the `uxp/` folder in Adobe UXP Developer Tools (UDT)
  via "Load and Watch"; `scripts/update-uxp.bat` does a `git pull` and UDT
  hot-reloads `index.js`/`index.html`.
- Both `scripts/*.bat` hard-code a `BRANCH` value — update it when working on
  a different branch.

## Hard-won lessons / known dead ends

Append to this section whenever a session proves something is a dead end or
finds a materially better approach — it is the cheapest way to stop future
sessions from re-treading the same ground or regressing to a worse practice.
Keep entries short; put deep rationale in code comments next to the code.

**Premiere API shape & gotchas**
- trackItem `getInPoint` / `getOutPoint` / `getName` are **async** on 26.2.2 —
  await them.
- `createRemoveItemsAction(selection, rippleBool, null)` — 3rd arg must be
  `null`; `ripple:true` closes the gap.
- `root.getItems()` returns base `ProjectItem`; upcast with
  `ppro.ClipProjectItem.queryCast()` / `castOrThrow()`.
- `clip.createMoveAction(t)` is **relative** (adds a delta) and forward-only;
  `moveClipsBatch` rejects backward moves; `TickTime.createWithSeconds`
  rejects negatives. Pass `createWithSeconds(0)`, never `TickTime.TIME_ZERO`
  (invalid in factories).
- `ppro.Transcript.importFromJSON(str)` is a **parser** (returns
  TextSegments), not an importer.
- Ticks: 254016000000 per second; `getTimebase()` returns ticks/frame as a
  string.
- `track.insertClip` (`host/index.jsx`) is a ripple insert, but inserting
  past the track's content end leaves a blank gap rather than rippling.
  `applyArrangement` relies on this: it clears V1 first, places left-to-right.
- QE `razor` wants an `HH:MM:SS:FF` timecode string (fps-derived); tick
  strings / Time objects silently no-op.
- UXP `ClipProjectItem` media-path getters all return `null` on 26.2.2 —
  resolve bin item → file path through the CEP helper (`list_project_clips`
  uses ExtendScript `getMediaPath`).
- UXP `OfflineAudioContext` is unavailable — can't decode MP3/M4A in-process;
  ffmpeg-extract via the helper instead.
- `app.beginUndoGroup` is After Effects-only — not in Premiere ExtendScript.
- `<optgroup>` does not render in the UXP webview.
- UXP `network.domains` must be `"all"` — an explicit
  `http://127.0.0.1:53210` entry fails with "Manifest entry not found".

**Frame export** (lives in UXP `exportFrameAt` — only UXP has `ppro.Exporter`)
- ExtendScript `Sequence.exportFrameJPEG/PNG` and `ppro.Utils.export-
  SequenceFrame` are absent on 26.2.2.
- Signature: `ppro.Exporter.exportSequenceFrame(sequence, time:TickTime,
  filename, filepath, width:number, height:number): Promise<boolean>` —
  `filename` and `filepath` are SEPARATE args.
- Empirically on 26.2.2: `.jpg` works, `.jpeg`/`.png` have failed; use a
  native backslash directory path; width/height must be numbers.
- The export Promise resolves BEFORE the file flushes to disk — poll for the
  entry with short backoffs (~`[0,50,100,200,400,600]` ms).
- `ppro.Exporter` methods are non-enumerable — probe by `typeof`, not
  `Object.keys`; `Function.length` is 0 (variadic).
- The CEP `export_frame_b64` handler is an inert fallback (ExtendScript frame
  export is gone); kept in case a future Premiere restores it.

**Vision & the Anthropic API**
- Vision frames are token-expensive (~6k tokens each at full res); cap
  `maxDim` ~768 and prune stale images from agent history.
- Anthropic's rate limit is 30k input tokens/min on a **sliding 60s window,
  cumulative across turns** — image pruning helps but isn't sufficient alone.
  `callClaude` honors `retry-after` on 429 (3 retries, 60s cap), retries 5xx
  once.
- A `tool_result` `content` may be a content-block array (text + image), not
  only a string.
- Don't tune the agent against a weak / free model and ship on a strong one —
  tool-use behavior differs and prompt tuning doesn't transfer.
- For exact `premierepro` signatures, read `@adobe/premierepro`'s
  `premierepro.d.ts` (`npm i` in a scratch dir) instead of guessing.

**Python sidecars**
- Keep stdout clean for JSON: save a real stdout ref, then
  `sys.stdout = sys.stderr` at module load — torch.hub and others print to
  stdout and corrupt JSON parsing.
- Probe Python with `-c "import sys; print(sys.executable)"` (proves it runs
  code + captures the interpreter path), not `--version`.
- Include `pythonExe` / `interpreter` + full `traceback` in every sidecar
  error response — makes failures self-diagnosing.
- **madmom is a dead end** — no `madmom.features.drums` module exists, and
  `pip install madmom` fails on Python 3.10+ (undeclared Cython build dep,
  removed `collections.MutableSequence` / `np.float`).
- Demucs PyPI 4.0.1 has no `demucs.api` — use `demucs.pretrained.get_model`
  + `demucs.apply.apply_model` + `demucs.audio.AudioFile`. It separates by
  instrument family only (`drums.wav` is kick+snare+hihat mixed).
- numba JIT: first librosa call ~5–10 s, then ~1–2 s.
  `librosa.beat.beat_track` returns tempo as a 1-element ndarray (0.11+).

**Audio / beat / drum detection**
- librosa (spectral-flux onsets + DP tracking) is the primary beat engine;
  the hand-rolled JS detector (energy-difference + autocorrelation) scored
  clean tracks at only 0.3–0.4 confidence — kept solely as a no-Python
  fallback.
- librosa's `start_bpm` default 120 causes octave/tactus doubling on slow
  music (a 76 BPM track detects as 152) — pass `bpmHint`. Some worship/live
  tracks are genuinely metric-ambiguous and need a genre hint.
- Beat-quality metric: `beatVsOffRatio` (onset energy at beats vs off-beats;
  density-invariant). Dead ends: `gridSupportPct` and `gridAlignmentPct` —
  both conflate onset density with grid quality.
- `detect_drums` uses bandpass + onset detection but CANNOT separate drums
  with overlapping spectra — kick energy dominates the snare band at any band
  choice (~92–96% kick coincidence). Kept as a fallback; per-drum neural
  transcription is deferred (no maintained OSS drum-component transcriber).
- Quality-scored tools return `confidence` + `verdict` + `risks[]`; the agent
  is gated to refuse destructive ops on a `do_not_commit` verdict.

**Timeline editing & arrangement**
- Address clips by `currentStartSeconds`, not `clipIndex` — indices reshuffle
  after every mutation.
- Placed clips need a frame-quantized **duration contract**: each clip's
  trimmed source window must equal its beat-slot duration, snapped to the
  sequence frame grid (`get_sequence_fps`). Rounding in/out points
  independently drifts them sub-frame and produces millisecond "sliver" clips
  and micro-gaps; `pickWindow` (`vision.js`) returns exact-width windows.
- A clip shorter than its slot is an honest `deficitSec` gap, never a silent
  swap. Optional fill is a user-supplied bin color matte (`gapFillerClipName`)
  placed via the measured-tiling `fill_gap_with_clip` host primitive. Do NOT
  synthesize a color matte via QE/ExtendScript — there is no reliable
  `newColorMatte`; that path is fragile and was rejected.
- `cut_to_beats` returns `RAZOR_NOOP` when a cut coincides with an existing
  clip boundary.
- Caption-track writes / "Create Captions from transcript" are UI-only on
  this build — SRT auto-import into the bin is the automated ceiling.

**Build / deploy / workflow**
- Manifest changes need a UDT Unload + Load and Watch — no hot-reload
  re-evaluates module-scope `const`. CEP JS loads once per Premiere launch,
  so `host/` or `bridge.js` changes need the helper panel closed + reopened.
- Whisper transcription doesn't have to be a paid API — `faster-whisper` /
  `whisper.cpp` run locally as a Python sidecar, consistent with the existing
  local audio/vision sidecars. Considered a planned improvement, not done.
- LUT `.cube` files write to `<Documents>\PremBot LUTs\` (writable without
  admin), applied via the Lumetri `Look` slot. `.cube` axis order is B outer
  / G middle / R inner; 33³ is standard.

## Notes on stale / legacy content

- **`README.md` describes the original pure-CEP v1** (single panel, Plan/Auto
  modes, `client/js/*` as the app). That architecture has been superseded by
  the two-panel design above. Treat the README's install steps as roughly
  current but its "What's in here" and feature description as out of date.
- **`client/js/` is mostly legacy.** The current helper panel
  (`client/index.html`) loads only `CSInterface.js` and `bridge.js`. The other
  `client/js/*` files (`agent.js`, `tools.js`, `transcribe.js`, `main.js`,
  `ui.js`, `storage.js`, `host-bridge.js`) are the original v1 CEP
  implementation and are not loaded by the running helper. Do not edit them
  expecting an effect; the live agent is `uxp/agent.js`.
