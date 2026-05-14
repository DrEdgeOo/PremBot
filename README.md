# PremBot

An AI editing assistant that lives inside Adobe Premiere Pro as a CEP panel. Type a prompt like *"build a 90-second highlight reel emphasizing the demo"* and an agent with tool access to the timeline transcribes your footage, finds the right moments, and lays down a rough cut.

Personal-use, BYO API keys. Two modes:

- **Plan** — the agent proposes an edit, you review it in the panel, click **Apply** to commit to the timeline.
- **Auto** — the agent writes directly to the active sequence as it goes.

## Install (development, unsigned)

1. **Enable unsigned CEP extensions** (one-time):
   - **macOS**: `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`
   - **Windows**: in `HKEY_CURRENT_USER\Software\Adobe\CSXS.11`, add string `PlayerDebugMode` = `1`
   - (CSXS version: 11 for Premiere 2022+. For older Premiere use 10/9.)
2. **Symlink or copy this repo** into the Adobe CEP extensions folder:
   - macOS: `~/Library/Application Support/Adobe/CEP/extensions/PremBot`
   - Windows: `%APPDATA%\Adobe\CEP\extensions\PremBot`
3. **Restart Premiere Pro**.
4. Open the panel: **Window → Extensions → PremBot**.

## First-run setup

1. **Settings tab**: paste your Anthropic API key (used for the editing agent) and OpenAI API key (used for Whisper transcription). Edit the *Style profile* — this is the system-prompt-level house style the agent will follow on every cut. Click **Save**.
2. **Footage tab**: click **Refresh project clips**, then **Transcribe untranscribed**. Each clip must be ≤25 MB (Whisper limit). Transcripts are cached in `~/.prembot/transcripts.json`.
3. **Chat tab**: make sure a sequence is open in Premiere, then type a prompt and hit Send.

## What's in here

```
CSXS/manifest.xml       CEP extension manifest
.debug                  Lets unsigned extensions load during dev
host/index.jsx          ExtendScript bridge — clip listing, sequence edits
host/json2.js           JSON polyfill (ExtendScript has no native JSON)
client/index.html       Panel UI
client/css/style.css    Styling
client/js/agent.js      Claude tool-use loop
client/js/tools.js      Tool definitions + executors (Plan vs Auto gated)
client/js/transcribe.js Whisper integration
client/js/host-bridge.js Promise wrapper around CSInterface.evalScript
client/js/storage.js    Persists settings + transcript cache to ~/.prembot
client/js/ui.js         UI helpers (tabs, messages, plan rendering)
client/js/main.js       Entry point
```

## Known v1 limits

- Whisper file-size limit (25 MB). Long clips need to be pre-exported to compressed audio (out of scope for MVP — would add ffmpeg + chunking next).
- No transitions yet — agent only places hard cuts. The `add_segment` tool is the only mutating action.
- Requires an existing active sequence in Premiere; doesn't create one for you (Premiere needs a preset to programmatically create a sequence; easiest to make one by hand for now).
- Multi-track / audio-only edits not yet implemented.
