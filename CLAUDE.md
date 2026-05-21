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
action failed to execute" (trim/in-out points, insert-from-bin, overwrite,
add-marker). CEP can both call ExtendScript and run Node. So the helper
backfills those gaps.

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
  (ExtendScript) via `CSInterface.evalScript`.

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

## Recurring constraint: Premiere 26.2.2 UXP gaps

The header comment in `uxp/index.js` lists which `premierepro` factories work
vs. throw on this build. Practical consequences that shape the whole codebase:
- **Placement** uses `createCloneTrackItemAction` (clone an on-timeline clip),
  not insert-from-bin — direct bin insert is stubbed in UXP and routes
  through the helper.
- **Clip moves are forward-only.**
- Trim, set-name, insert, overwrite, add-marker → all helper/ExtendScript.
When something "should" work but doesn't, suspect a stubbed factory before
suspecting your code; `discover_premiere_capabilities` probes liveness live.

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
  enabled (`PlayerDebugMode`; see `README.md`). Reload the panel after copy.
- **UXP panel**: load the `uxp/` folder in Adobe UXP Developer Tools (UDT)
  via "Load and Watch"; `scripts/update-uxp.bat` does a `git pull` and UDT
  hot-reloads `index.js`/`index.html`. A `manifest.json` change needs a manual
  Unload + Load in UDT.
- Both `scripts/*.bat` hard-code a `BRANCH` value — update it when working on
  a different branch.

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
