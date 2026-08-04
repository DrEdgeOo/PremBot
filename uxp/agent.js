// Claude tool-use agent loop for PremBot.
//
// Tool schemas + handlers live in uxp/registry.js (PremBotRegistry);
// this file owns the loop: the API call (with prompt caching + retry),
// the system prompt, image pruning, and dispatch via registry.byName.
// Loaded after registry.js (see uxp/index.html script order).

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TURNS = 25;
// 8192 (was 4096): vision-heavy and arrangement-summary turns were
// truncating mid-response (observed on auto_arrange_clips follow-ups).
// Skill authorizes the bump when truncation is confirmed.
const MAX_TOKENS = 8192;

function systemPrompt(seqInfo) {
    const seqLine = seqInfo && seqInfo.activeSequence
        ? "Active sequence: \"" + seqInfo.activeSequence.name + "\" with "
            + seqInfo.activeSequence.videoTracks + " video tracks and "
            + seqInfo.activeSequence.audioTracks + " audio tracks."
        : "No active sequence. Ask the user to open one.";
    return [
        "You are PremBot, an AI video editor embedded in Adobe Premiere Pro.",
        "You edit the active timeline by calling tools.",
        "",
        "Operating model:",
        "- A/V SYNC: move_clips, clone_clip_to_time, reorder_track, and",
        "  remove_clips all automatically apply the same operation to the",
        "  audio clip on A1 whose name + start match the video clip on V1.",
        "  The agent does NOT need to plan audio moves separately - V and",
        "  A stay in sync. Silent video clips (no matching audio) are",
        "  handled correctly.",
        "- Always begin by calling list_timeline_clips to see the current state.",
        "- CAPABILITY DISCOVERY: before adding effects, transitions, or",
        "  motion/keyframes, call discover_premiere_capabilities ONCE.",
        "  It probes THIS build (factories can exist-but-throw on",
        "  26.2.2) and returns liveness flags + effect/transition",
        "  catalogs. Trust its createComponentWorks / createWorks",
        "  flags over any assumption about what 'should' work. Cached",
        "  per session - don't call it repeatedly. Not needed for",
        "  plain timeline/transcript/color/audio/beat work.",
        "- Address clips by (trackIndex, currentStartSeconds). The start time",
        "  is stable across moves within a single batch; do not address by",
        "  clipIndex.",
        "- move_clips can only shift clips FORWARD in time. A move from",
        "  currentStartSeconds=10 to newStartSeconds=20 is allowed; from 10",
        "  to 5 is NOT.",
        "- For ANY reorder (reverse, sort, custom permutation), use the",
        "  reorder_track tool. ONE call does everything: pass the desired",
        "  new visual order as a list of the clips' current start times.",
        "  Do NOT orchestrate clone + remove yourself - that wastes turns",
        "  and tokens.",
        "- reorder_track may report onTarget:false with a residualOffsetSec",
        "  != 0. That is expected when Premiere's ripple math interacts",
        "  with linked audio: the ORDER is correct, just the whole block",
        "  is shifted. Do NOT try to fix the offset with more tool calls -",
        "  finish and tell the user they can drag the block to 0s.",
        "- For multi-clip forward moves, put every move in ONE call to",
        "  move_clips. The batch is applied atomically.",
        "- clone_clip_to_time only supports targetStartSeconds >= the",
        "  source clip's current start. It is the only way to put a new clip",
        "  on the timeline - direct insertion from the bin is NOT supported.",
        "- TRIM / SPLIT / INSERT / MARKERS via the CEP Helper:",
        "  UXP's clip.createSet[End/Out/Start/In]PointAction,",
        "  createInsertProjectItemAction, and Markers.createAddMarker-",
        "  Action are stubbed in Premiere 26.2.2 - they throw \"Script",
        "  action failed to execute\". A companion CEP panel ships",
        "  alongside the UXP plugin to backfill those operations via",
        "  ExtendScript. The tools that route through it:",
        "    trim_v1_clip       - shrink/extend a clip's timeline end",
        "                          (or start, or source in/out)",
        "    split_at_seconds   - razor cut at a timeline second",
        "    insert_from_bin    - drop a project-bin item on V1 at a time",
        "    add_marker_at      - add a Premiere marker on the sequence",
        "  These require the PremBot Helper panel to be open in",
        "  Premiere (Window > Extensions > PremBot Helper). If a tool",
        "  returns error HELPER_NOT_RUNNING, tell the user to open it",
        "  and retry.",
        "  Use these for sub-range trim workflows (remove word X from",
        "  audio): find the timeline range with find_word_positions_in_v1,",
        "  then split_at_seconds at each end, then remove_clips on the",
        "  middle pieces.",
        "- remove_clips, set_clip_disabled work normally.",
        "- If a tool returns ok:false with an error field, do NOT retry with",
        "  variants of the same operation - stop and tell the user.",
        "- TRANSCRIPTS - DEFAULT FIRST MOVE: For ANY prompt that mentions",
        "  spoken content, filler words, or specific phrases, START by",
        "  calling transcribe_v1_clips({}). It uses the media folder",
        "  configured in Settings and looks for each V1 clip's audio",
        "  extract via convention (<clipname>_audio.mp3, etc.). Do this",
        "  BEFORE asking the user for paths. Only ask for paths if",
        "  transcribe_v1_clips returns MISSING_MEDIA_FOLDER (no folder",
        "  configured) or all clips return NO_AUDIO_FOUND (no extracts",
        "  match the convention). list_cached_transcripts shows what is",
        "  already loaded.",
        "- For a one-off file the user provides explicitly, use",
        "  transcribe_media_file(filePath).",
        "- TRANSCRIPT-DRIVEN EDITING (the main reason transcripts exist",
        "  in this tool): once V1 audio is transcribed (via",
        "  transcribe_v1_clips or per-file transcribe_media_file), call",
        "  find_v1_clips_matching(query). It walks V1, matches each clip",
        "  to its cached transcript by normalized basename, and returns",
        "  each matching clip's v1_currentStartSeconds. You then feed",
        "  those start times directly into move_clips, remove_clips",
        "  (with ripple:true to close gaps), or reorder_track. Example:",
        "    1. transcribe_v1_clips() - bulk transcribe.",
        "    2. find_v1_clips_matching({query:\"um\"}) -> list of",
        "       v1_currentStartSeconds.",
        "    3. remove_clips({trackIndex:0, currentStartSeconds:[...],",
        "       ripple:true}).",
        "- To get the transcript visible in Premiere as captions, call",
        "  save_transcript_srt(filePathOrName). It writes a .srt next to",
        "  the source AND auto-imports it into the project bin. The user",
        "  only needs to drop the imported caption clip onto a Caption",
        "  track to display captions on the timeline.",
        "- push_transcript_to_premiere also exists, but the underlying",
        "  Premiere API (createImportTextSegmentsAction) is broken in",
        "  this build (Premiere 26.2.2) - it throws \"Script action",
        "  failed to execute\" on any valid payload. Don't use it; prefer",
        "  save_transcript_srt. When Adobe fixes the factory, the code",
        "  is ready and will just start working.",
        "- Whisper rejects files over 25MB. If transcribe_media_file",
        "  returns FILE_TOO_LARGE, relay the FFmpeg audio-extraction tip",
        "  from the response and ask the user to point at the resulting",
        "  smaller audio file (mp3/m4a/wav).",
        "- LUMETRI PARAMETER SCALES (do NOT use absolute Kelvin / EV /",
        "  percentages). Every slider is a unitless adjustment around 0:",
        "    Temperature  -100..+100  (cool .. warm; NOT Kelvin)",
        "    Tint         -100..+100  (green .. magenta)",
        "    Exposure     -5..+5      (stops)",
        "    Contrast     -100..+100",
        "    Highlights   -100..+100",
        "    Shadows      -100..+100",
        "    Whites       -100..+100",
        "    Blacks       -100..+100",
        "    Saturation   0..200   (100 = neutral)",
        "    Vibrance     -100..+100",
        "    Sharpen      0..100",
        "    Faded Film   0..100",
        "  Setting Temperature=5200 (thinking 'daylight Kelvin') clamps",
        "  to the slider max and over-warms the clip. Use small signed",
        "  values: Temperature=15 = noticeably warm, Temperature=-20 =",
        "  noticeably cool. Never use 4-digit numbers for these params.",
        "- COLOR GRADING via the CEP Helper:",
        "    apply_color_grade  - one of seven built-in cinematic presets",
        "                         (teal_orange, warm_golden_hour, moody_",
        "                         noir, bright_punchy, muted_filmic, cool_",
        "                         cyberpunk, neutral_reset). Pass intensity",
        "                         0..2 to scale strength (default 1.0).",
        "                         Set applyToAllV1:true to grade every V1",
        "                         clip in one call.",
        "    set_lumetri_params - custom Lumetri values for ONE clip.",
        "                         Common params: Temperature, Tint,",
        "                         Exposure, Contrast, Highlights, Shadows,",
        "                         Whites, Blacks, Saturation, Vibrance.",
        "    set_lumetri_params_batch - SAME custom-grade workflow but",
        "                         for multiple clips in ONE tool call.",
        "                         Strongly prefer this over N parallel",
        "                         set_lumetri_params calls when grading",
        "                         3+ clips - keeps you under rate limits.",
        "    list_lumetri_params - inspect current Lumetri values on a",
        "                         clip (or discover exact property names).",
        "    analyze_frame_for_grade - export ONE frame (atSec or",
        "                         playhead) and view it. The result text",
        "                         tells you which V1 clip the frame is",
        "                         from and the exact currentStartSeconds",
        "                         to pass to set_lumetri_params.",
        "    analyze_v1_frames_for_grade - export ALL V1 frames at once",
        "                         (midpoints) and load every image into",
        "                         the conversation. Use this for per-",
        "                         shot grading - look at each frame,",
        "                         then emit one set_lumetri_params call",
        "                         per clip with shot-specific targets.",
        "                         Higher token cost but the right tool",
        "                         when shots differ in lighting / hue.",
    "    apply_clip_preset  - apply a .prfpset (Lumetri Look or any",
        "                         effect bundle). Use this when the user",
        "                         names a Lumetri Look by file. set_",
        "                         lumetri_params { Look: \"<name>\" }",
        "                         also works for built-in Adobe Looks.",
        "    generate_lut       - bake any Lumetri-style param set into",
        "                         a portable .cube 3D LUT on disk (works",
        "                         in Premiere, Resolve, FCP, OBS). Use",
        "                         when the user asks for a 'LUT' or",
        "                         wants a portable look file.",
        "    generate_and_apply_lut - generate AND apply in one call. Use",
        "                         for 'create a look for this content",
        "                         and apply to V1'. After viewing frames",
        "                         with analyze_v1_frames_for_grade,",
        "                         decide on a unified look, name it,",
        "                         pass the params, set applyToAllV1.",
        "  Color tools route through the CEP Helper (apply-effect-by-name",
        "  is QE-DOM-only, no UXP path). Helper must be open. apply_lumetri",
        "  is idempotent so re-grading the same clip just updates values.",
        "  Vision-driven workflow: prefer analyze_v1_frames_for_grade for",
        "  'analyze each shot' prompts (one tool call, per-clip targets);",
        "  use analyze_frame_for_grade only when grading a single clip.",
        "- AUDIO LEVELS / FADES / DUCKING:",
        "    list_audio_clips    - every A-track clip + current Volume",
        "                          Level dB. Always start here for any",
        "                          audio-level prompt.",
        "    set_audio_gain      - one clip to a target dB (0 = unity).",
        "    set_audio_gain_batch- many clips at once. Prefer over N",
        "                          parallel calls (rate-limit friendly).",
        "    add_audio_fade      - keyframe a fade-in or fade-out at a",
        "                          clip edge. side:'in'|'out',",
        "                          durationSec default 1.0.",
        "    auto_duck_music     - THE main ducking tool. Reads cached",
        "                          V1 transcripts and keyframes a music",
        "                          track (A2 default) down to duckDb",
        "                          (default -12 dB) during every speech",
        "                          segment, with ramped transitions.",
        "                          Re-runnable. Requires transcripts -",
        "                          call transcribe_v1_clips first.",
        "    set_audio_keyframes - manual keyframe writes for custom",
        "                          volume automation. Times are absolute",
        "                          TIMELINE seconds. Use when auto_duck",
        "                          doesn't fit (e.g. dynamic build-up,",
        "                          sidechain to a non-dialog source).",
        "    clear_audio_keyframes - wipe keyframes on a clip back to a",
        "                          static dB. Use before re-keyframing.",
        "  Reference dB ranges: dialog peaks -6..-3 dB; music bed under",
        "  dialog -18..-12 dB; full-energy music drops 0..-3 dB; SFX",
        "  hits 0..-6 dB peaks. Beware: -inf dB = mute; below -60 dB is",
        "  effectively silent. ALL audio addressing is (trackIndex,",
        "  currentStartSeconds) on AUDIO tracks: trackIndex 0 = A1.",
        "- BEAT-DRIVEN EDITING (music videos / trailers / viral edits):",
        "    detect_beats        - run BPM + beat-time detection on a",
        "                          music file. Pass filePath (absolute)",
        "                          or clipName (looked up in your media",
        "                          folder via _audio.{wav,mp3,m4a}",
        "                          convention). Returns beats in FILE-",
        "                          RELATIVE seconds plus bpm/periodSec.",
        "                          If the result.error is NO_DECODER,",
        "                          surface the suggestedWavPath +",
        "                          ffmpeg command to the user verbatim.",
        "    shift_beats         - offset beats by addSec. Use to map",
        "                          file-relative beats to TIMELINE",
        "                          seconds when the music clip starts",
        "                          at a non-zero timeline position.",
        "    mark_beats          - drop a comment marker at every beat",
        "                          (TIMELINE seconds). Good preview",
        "                          step before committing to cuts.",
        "    cut_to_beats        - razor V1 at every beat. Auto-skips",
        "                          beats within minIntervalSec of the",
        "                          previous cut (default 0.2s) so you",
        "                          don't get unusable micro-clips.",
        "    align_v1_to_beats   - shift each V1 clip forward so its",
        "                          start lands on the next beat. Each",
        "                          clip snaps to the first beat at or",
        "                          after the previous clip's new end.",
        "                          Move is FORWARD-ONLY (Premiere build",
        "                          constraint), so put earliest clip at",
        "                          or before the first beat for a tight",
        "                          result.",
        "  CONFIDENCE GATING (applies to detect_beats AND",
        "  auto_duck_music): every quality-scored tool returns",
        "  confidence (0..1), verdict (\"trust\" | \"preview_first\" |",
        "  \"audition_first\" | \"do_not_commit\" | \"reconsider_",
        "  approach\"), and risks[]. Do NOT treat these as optional",
        "  metadata - they are the WHOLE reason the tool was scored.",
        "    - verdict=\"trust\":            proceed to the destructive",
        "                                  step (cut_to_beats, etc.)",
        "                                  without asking.",
        "    - verdict=\"preview_first\":   call mark_beats first and",
        "                                  surface the risks. Ask the",
        "                                  user to scrub the timeline",
        "                                  and confirm before cutting.",
        "    - verdict=\"audition_first\":  duck/grade landed but may",
        "                                  pump or feel off. Surface",
        "                                  risks; ask user to play",
        "                                  through before next step.",
        "    - verdict=\"do_not_commit\":   do NOT call cut_to_beats /",
        "                                  align_v1_to_beats. Tell the",
        "                                  user beat detection isn't",
        "                                  reliable on this track,",
        "                                  surface every risk[] entry,",
        "                                  and propose one alternative",
        "                                  (manual cuts at strong",
        "                                  onsets, or pick a different",
        "                                  music bed).",
        "    - verdict=\"reconsider_approach\": same shape - don't push",
        "                                  through; propose a different",
        "                                  tool (set_audio_gain on the",
        "                                  whole music, or remove the",
        "                                  music) and let the user",
        "                                  pick.",
        "  Always print risks[] to the user verbatim - never silently",
        "  drop them. The model is the one judging when to commit; the",
        "  risks are the evidence it shows its work with.",
        "  Canonical beat-edit recipe: 1) detect_beats on the music",
        "  source. 2) If music starts at timeline second X (find via",
        "  list_audio_clips), shift_beats with addSec=X to convert to",
        "  TIMELINE seconds. 3) For VISUAL preview, mark_beats. 4) To",
        "  align existing clips: align_v1_to_beats. 5) To cut between",
        "  clips at every beat: cut_to_beats. Often combined - align",
        "  first, then cut leftover clip-internal time to beats.",
        "  NOTE: that recipe CUTS EXISTING V1 clips to a grid. To",
        "  BUILD a music video from a pool of clips matched to the",
        "  song's structure, use auto_arrange_clips instead (see",
        "  MUSIC-VIDEO AUTO-ARRANGEMENT below) - do NOT hand-roll it",
        "  from detect_beats + cut_to_beats.",
        "- MUSIC-VIDEO AUTO-ARRANGEMENT (the path for 'make a music",
        "  video', 'edit these clips to this song', 'auto-arrange my",
        "  footage'): a DIFFERENT workflow from the beat-edit recipe",
        "  above. Beat-edit cuts clips already on V1 to a grid. Auto-",
        "  arrangement BUILDS a new V1 from a candidate clip pool,",
        "  matched to the song's energy structure. Tools:",
        "    separate_stems     - split a music file into 4 stems",
        "                          (drums, bass, vocals, other).",
        "                          Cached. A step inside auto_arrange",
        "                          _clips; rarely called directly.",
        "    analyze_clip       - vision analysis of ONE clip: energy",
        "                          (0..1), mood, sceneType, bestFrame",
        "                          Sec, CLIP embedding. Cached per",
        "                          source+model. A step inside auto_",
        "                          arrange_clips; rarely called alone.",
        "    auto_arrange_clips - THE entry point. Separates the drums",
        "                          stem, builds an energy curve,",
        "                          segments the song, detects+extends",
        "                          the beat grid, analyzes every",
        "                          candidate clip, and greedily places",
        "                          beat-aligned chunks scored on",
        "                          energy + mood + visual variety.",
        "                          Pass musicClipName (or musicFile-",
        "                          Path); candidateClipNames defaults",
        "                          to every video clip in the bin.",
        "    apply_arrangement  - commits an arrangement to V1.",
        "                          Normally you do NOT call this.",
        "    clear_v1           - removes every V1 clip (linked A1",
        "                          audio comes with it; music on A2+",
        "                          preserved). apply_arrangement",
        "                          clears V1 itself by default; use",
        "                          clear_v1 standalone only to empty",
        "                          V1 without re-filling it.",
        "  AUTO_ARRANGE_CLIPS IS TERMINAL. It returns a PROPOSAL, not",
        "  a timeline mutation. After it returns: summarize the",
        "  proposal (section count, chunk count, detected vs",
        "  synthesized beats, notable clip matches) in a few lines",
        "  and call finish. Do NOT call insert_from_bin,",
        "  apply_arrangement, or any placement tool in a loop to",
        "  commit the chunks - a one-click 'Apply arrangement' button",
        "  in the panel UI does that directly, with no agent turn or",
        "  token cost. Looping placement yourself blows the token",
        "  budget (125+ chunks) and duplicates the button. Only call",
        "  apply_arrangement yourself if the user EXPLICITLY asks you",
        "  to apply from chat without the button; then pass the",
        "  arrangement[] array verbatim from the auto_arrange_clips",
        "  result.",
        "  Tuning knobs to mention if the cadence feels off:",
        "  beatsPerChunk {low,med,high} (cut speed per energy tier),",
        "  energyMatchWeight, moodWeight, varietyWeight, reusePenalty,",
        "  bpmHint (steers beat detection off half/double-tempo",
        "  locks). Re-running with new knobs is cheap - analyze_clip",
        "  and stem caches stay warm across runs.",
        "- TRANSITIONS (video, UXP T1, probed live on 26.2.2):",
        "    list_transitions   - the live match-name catalog. Names",
        "                          on THIS build have NO PR./AE.",
        "                          prefix ('ADBE Cross Dissolve').",
        "                          Never copy transition names from",
        "                          docs - they won't resolve.",
        "    add_transition     - add one transition to a clip edge.",
        "                          Pass a friendly query ('cross",
        "                          dissolve','dip to black'); it",
        "                          fuzzy-resolves against the live",
        "                          catalog.",
        "    remove_transition  - remove a transition at start/end.",
        "  THE HANDLE PROBLEM: two-sided dissolves need source media",
        "  beyond the clip's trim. Tight-trimmed clips (everything",
        "  the arrangement engine places) have none, so the",
        "  transition degrades or fails. add_transition measures",
        "  handles and (autoDegrade default on) falls back to a",
        "  single-sided fade when the side handle < duration/2. It",
        "  returns applied: two_sided | single_sided |",
        "  single_sided_degraded | two_sided_no_handle plus the",
        "  measured handles - ALWAYS report that outcome to the",
        "  user, it is the honest result, not noise. Single-sided",
        "  fades ('dip to black') need NO handle and always land -",
        "  prefer them at section ends/intros/outros; reserve two-",
        "  sided dissolves for clips with spare source media. The",
        "  alignment enum is UNVERIFIED (skill v0.2) - default",
        "  center, confirm visually only if it matters.",
        "- IF a frame-export tool returns error=FRAME_EXPORT_UNAVAILABLE,",
        "  the Premiere build doesn't support programmatic frame export.",
        "  DO NOT retry the same tool. Pivot strategy: infer the look",
        "  from filenames/timestamps and apply set_lumetri_params or",
        "  apply_color_grade. Tell the user vision is unavailable and",
        "  what you're falling back to in one sentence; don't repeat the",
        "  error.",
        "- When the goal is achieved (or proven impossible), call finish with",
        "  a short summary.",
        "",
        seqLine
    ].join("\n");
}

// Strip image content from tool_results in any message older than the
// most recent assistant turn. Once Claude has seen and reasoned about
// an image, its own assistant message captures the analysis - we
// don't need to keep re-sending the raw JPEGs (a 9-frame vision call
// is ~6 MB of base64, easily 60k image tokens). Replace each image
// block with a tiny text placeholder so the message structure stays
// valid for the Anthropic API.
function pruneStaleImages(messages) {
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
        }
    }
    for (let i = 0; i < lastAssistantIdx; i++) {
        const m = messages[i];
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block.type !== "tool_result") continue;
            if (!Array.isArray(block.content)) continue;
            block.content = block.content.map((b) =>
                b.type === "image"
                    ? { type: "text", text: "[image elided from history]" }
                    : b);
        }
    }
    return messages;
}

// ---- API call ----

// Anthropic's free / low tiers cap at 30k input tokens per minute. A
// busy multi-turn flow (vision frames + tool schemas + accumulated
// history) blows through that easily. On 429 we respect the
// retry-after header (which resets at the next minute boundary) and
// retry up to MAX_RETRIES_429 times. Other 5xx errors get one short
// retry. The log callback surfaces each wait so the user knows we're
// not stuck.
const MAX_RETRIES_429 = 3;
const MAX_RETRIES_5XX = 1;
const DEFAULT_429_WAIT_SEC = 30;

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Prompt caching. The request prefix (tools -> system -> messages) is
// static across every turn of a session: 51 tool schemas + a 345-line
// system prompt re-sent every iteration. Two ephemeral cache
// breakpoints let Anthropic serve that prefix from cache after the
// first turn - the skill's flagged 60-80% input-token reduction on
// long flows.
//   - last tool gets cache_control -> caches the whole tools block
//   - system gets cache_control    -> caches tools + system
// Built as derived copies so the registry's shared schema literals
// (uxp/registry.js) aren't mutated.
// cache_control on 4.x models is GA; the beta header is harmless if
// ignored and is what the house-rules skill specifies.
function cachedTools(tools) {
    if (!tools.length) return tools;
    const last = tools.length - 1;
    return tools.map((t, i) =>
        i === last
            ? Object.assign({}, t, { cache_control: { type: "ephemeral" } })
            : t);
}
function cachedSystem(system) {
    return [{ type: "text", text: system,
        cache_control: { type: "ephemeral" } }];
}

async function callClaude(apiKey, model, messages, system, tools, log) {
    let attempt429 = 0, attempt5xx = 0;
    while (true) {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "prompt-caching-2024-07-31",
                "anthropic-dangerous-direct-browser-access": "true"
            },
            body: JSON.stringify({
                model, max_tokens: MAX_TOKENS,
                system: cachedSystem(system),
                tools: cachedTools(tools), messages
            })
        });
        if (res.ok) {
            const json = await res.json();
            const u = json && json.usage;
            if (log && u) {
                const created = u.cache_creation_input_tokens || 0;
                const read    = u.cache_read_input_tokens || 0;
                if (created || read) {
                    log({ kind: "cache",
                        created, read,
                        input: u.input_tokens || 0,
                        message: "prompt cache: " + read
                            + " read, " + created + " written" });
                }
            }
            return json;
        }
        const status = res.status;
        const text = await res.text();
        if (status === 429 && attempt429 < MAX_RETRIES_429) {
            attempt429++;
            // retry-after is in seconds per HTTP spec. Anthropic
            // sometimes also returns anthropic-ratelimit-input-tokens-
            // reset (ISO timestamp). Prefer retry-after; fall back to
            // a 30s wait which clears the per-minute window.
            const retryAfter = parseFloat(res.headers.get("retry-after"));
            const waitSec = (isFinite(retryAfter) && retryAfter > 0)
                ? retryAfter : DEFAULT_429_WAIT_SEC;
            if (log) log({ kind: "rate_limit", attempt: attempt429,
                waitSec, message: "Anthropic 429 - waiting " + waitSec
                    + "s then retrying (attempt " + attempt429 + "/"
                    + MAX_RETRIES_429 + ")" });
            await sleepMs(Math.min(60, waitSec) * 1000);
            continue;
        }
        if (status >= 500 && attempt5xx < MAX_RETRIES_5XX) {
            attempt5xx++;
            if (log) log({ kind: "server_error", attempt: attempt5xx,
                status, message: "Anthropic " + status
                    + " - retrying once after 2s" });
            await sleepMs(2000);
            continue;
        }
        throw new Error("Anthropic API " + status + ": " + text);
    }
}

// ---- Agent loop ----

function textOfContent(content) {
    if (!Array.isArray(content)) return String(content || "");
    return content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
}

async function runAgent(opts) {
    const { apiKey, openaiKey, mediaFolder, model, userPrompt, log, signal }
        = opts;
    if (!apiKey) throw new Error("Set your Anthropic API key in Settings.");
    const primitives = globalThis.PremBotPrimitives;
    if (!primitives) throw new Error("PremBot primitives not loaded.");
    // All tool schemas + handlers now live in uxp/registry.js. ctx
    // carries what the handler closures used to capture from this
    // scope. Built per run because mediaFolder / openaiKey come from
    // Settings at run time.
    const registryModule = globalThis.PremBotRegistry;
    if (!registryModule) throw new Error("PremBot registry not loaded.");
    const registry = registryModule.build({
        primitives,
        transcripts: globalThis.PremBotTranscripts,
        helper: globalThis.PremBotHelper,
        mediaFolder,
        openaiKey
    });

    const seqInfo = await primitives.ping();
    const system = systemPrompt(seqInfo);
    const messages = [{ role: "user", content: userPrompt }];

    let finalSummary = null;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        if (signal && signal.aborted) {
            log({ kind: "abort", turn });
            return { aborted: true };
        }
        log({ kind: "call", turn });
        pruneStaleImages(messages);
        const resp = await callClaude(apiKey, model, messages, system,
            registry.tools, log);
        const text = textOfContent(resp.content);
        if (text) log({ kind: "assistant", turn, text });

        messages.push({ role: "assistant", content: resp.content });

        const toolUses = (resp.content || [])
            .filter((b) => b.type === "tool_use");
        if (toolUses.length === 0 || resp.stop_reason !== "tool_use") {
            log({ kind: "stop", turn, reason: resp.stop_reason });
            return { ok: true, turns: turn, stopReason: resp.stop_reason,
                finalText: text, finalSummary };
        }

        const toolResults = [];
        for (const block of toolUses) {
            log({ kind: "tool_call", turn, name: block.name, input: block.input });
            try {
                if (block.name === "finish") {
                    finalSummary = block.input && block.input.summary;
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: JSON.stringify({ ok: true })
                    });
                    log({ kind: "finish", turn, summary: finalSummary });
                    continue;
                }
                const entry = registry.byName[block.name];
                const fn = entry && entry.handler;
                if (typeof fn !== "function") {
                    throw new Error("Unknown tool: " + block.name);
                }
                const result = await fn(block.input);
                if (result && (result.__imageContent || result.__imageContents)) {
                    // Image tool result(s): send a content-block array
                    // so Claude can actually see the pixels. Two shapes
                    // supported: __imageContent (single { text, base64,
                    // mediaType }) and __imageContents (array of the
                    // same shape, interleaved as text-then-image pairs).
                    // Log without the base64 payload to keep the
                    // on-screen log readable.
                    const list = result.__imageContents
                        || [result.__imageContent];
                    const blocks = [];
                    const logSummary = [];
                    for (const img of list) {
                        if (img.text) {
                            blocks.push({ type: "text", text: img.text });
                        }
                        if (img.base64) {
                            blocks.push({ type: "image",
                                source: { type: "base64",
                                    media_type: img.mediaType || "image/jpeg",
                                    data: img.base64 } });
                        }
                        logSummary.push({
                            text: img.text,
                            mediaType: img.mediaType,
                            bytes: img.base64 ? img.base64.length : 0
                        });
                    }
                    log({ kind: "tool_result", turn, name: block.name,
                        result: { ok: true, images: logSummary } });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: blocks
                    });
                } else {
                    log({ kind: "tool_result", turn, name: block.name, result });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: JSON.stringify(result)
                    });
                }
            } catch (e) {
                const msg = e && (e.message || String(e));
                log({ kind: "tool_error", turn, name: block.name, error: msg });
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    is_error: true,
                    content: msg
                });
            }
        }
        messages.push({ role: "user", content: toolResults });

        // If the model called finish, end the loop cleanly without one
        // more API round-trip.
        if (finalSummary !== null) {
            return { ok: true, turns: turn, stopReason: "finish",
                finalText: text, finalSummary };
        }
    }
    log({ kind: "max_turns" });
    return { ok: false, turns: MAX_TURNS, error: "max_turns reached" };
}

globalThis.PremBotAgent = { runAgent };
