// Claude tool-use agent loop for PremBot.
//
// Imports `primitives` (the module-scope object the main entry exposes via
// globalThis.PremBotPrimitives) so this file can be loaded after index.js
// without circular-require issues.

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TURNS = 25;
const MAX_TOKENS = 4096;

// ---- Tool schemas ----
//
// Names map 1:1 to keys in globalThis.PremBotPrimitives. Keep schemas
// minimal and unambiguous so the model doesn't have to guess.

const TOOLS = [
    {
        name: "list_project_clips",
        description: "List every media item in the project's bin (root and "
            + "subfolders). Use this to discover what source clips exist.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "list_timeline_clips",
        description: "List every clip currently placed on the active "
            + "sequence's video and audio tracks. Returns each clip's "
            + "trackIndex, clipIndex, name, timeline start/end seconds and "
            + "source in/out seconds. Use trackIndex/clipIndex to address "
            + "clips in subsequent calls.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "move_clips",
        description: "Move one or more clips on a video track. All moves "
            + "in a single call apply atomically (one undo entry, no "
            + "intermediate state), which is the correct way to reorder "
            + "clips - addressing by current start time is stable across "
            + "the batch. Each move is { currentStartSeconds, "
            + "newStartSeconds }: currentStartSeconds identifies the clip "
            + "(must match its current timeline start, within ~0.05s); "
            + "newStartSeconds is where it should end up. Duration is "
            + "preserved.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0 = V1, 1 = V2, ..." },
                moves: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            currentStartSeconds: { type: "number" },
                            newStartSeconds:     { type: "number" }
                        },
                        required: ["currentStartSeconds", "newStartSeconds"]
                    }
                }
            },
            required: ["trackIndex", "moves"]
        }
    },
    {
        name: "clone_clip_to_time",
        description: "Clone an existing on-timeline clip to a new start "
            + "time on the same track. The original stays in place; a "
            + "duplicate appears at targetStartSeconds. This is the only "
            + "way to put a new clip on the timeline in this Premiere "
            + "build - direct insert from the bin is not available, so "
            + "the source clip must already be on the timeline somewhere. "
            + "Identify the source clip by its current start time.",
        input_schema: {
            type: "object",
            properties: {
                srcTrackIndex:           { type: "integer" },
                srcCurrentStartSeconds:  { type: "number" },
                targetStartSeconds:      { type: "number" }
            },
            required: ["srcTrackIndex", "srcCurrentStartSeconds",
                "targetStartSeconds"]
        }
    },
    {
        name: "set_clip_disabled",
        description: "Disable or re-enable a clip on the timeline. "
            + "Disabled clips are skipped on playback but stay in place. "
            + "Identify the clip by its current start time.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "number" },
                disabled:            { type: "boolean" }
            },
            required: ["trackIndex", "currentStartSeconds", "disabled"]
        }
    },
    {
        name: "remove_clips",
        description: "Remove one or more clips from a video track in a "
            + "single transaction. Pass an array of currentStartSeconds "
            + "values identifying clips on the SAME track. Set "
            + "ripple=true to close the gap (clips after the removed "
            + "ones slide left to fill); ripple=false (default) leaves "
            + "an empty gap in place.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "array",
                                       items: { type: "number" } },
                ripple:              { type: "boolean",
                    description: "If true, clips after each removed "
                        + "clip slide back to close the gap." }
            },
            required: ["trackIndex", "currentStartSeconds"]
        }
    },
    {
        name: "reorder_track",
        description: "Reorder all clips on a video track into a new "
            + "sequence in ONE atomic call. `newOrder` is an array of "
            + "the clips' CURRENT start times, in the order you want "
            + "them to appear left-to-right after the operation. The "
            + "result is reported with an `onTarget` flag and a "
            + "`residualOffsetSec` - the order will be correct, but "
            + "the whole block may end up offset from 0 because of "
            + "Premiere's ripple-remove math. Do NOT try to chase the "
            + "offset with more tool calls; report it in finish and "
            + "let the user drag the block left manually if needed.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer" },
                newOrder: {
                    type: "array",
                    items: { type: "number" },
                    description: "Array of currentStartSeconds values "
                        + "from list_timeline_clips, in the desired "
                        + "final visual order."
                }
            },
            required: ["trackIndex", "newOrder"]
        }
    },
    {
        name: "check_media_file",
        description: "Check whether UXP can read a media file at the "
            + "given absolute path. Returns file size, whether it is "
            + "within Whisper's 25MB limit, and the resolved file:// "
            + "URL. Use this before transcribe_media_file if a path "
            + "lookup fails - it confirms the path is reachable "
            + "without spending a Whisper call.",
        input_schema: {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"]
        }
    },
    {
        name: "transcribe_media_file",
        description: "Run OpenAI Whisper on a media file on disk and "
            + "cache the resulting segments (text + start/end seconds) "
            + "in memory. Returns segment count and duration. The user "
            + "must provide an absolute file path to the media; this "
            + "Premiere build doesn't expose source paths via UXP. "
            + "Cached results are reused on subsequent calls.",
        input_schema: {
            type: "object",
            properties: {
                filePath: { type: "string",
                    description: "Absolute path to a media file (mp4, "
                        + "mov, mp3, wav, m4a). Example: "
                        + "E:\\\\Video Projects\\\\source.mp4" },
                language: { type: "string",
                    description: "Optional ISO 639-1 language hint, e.g. \"en\"." }
            },
            required: ["filePath"]
        }
    },
    {
        name: "search_transcripts",
        description: "Search a case-insensitive substring across all "
            + "transcripts cached by transcribe_media_file. Returns "
            + "each matching segment with clip name, start/end seconds, "
            + "and the segment text. Use this to find clips by what is "
            + "said in them.",
        input_schema: {
            type: "object",
            properties: {
                query:      { type: "string" },
                maxResults: { type: "integer" }
            },
            required: ["query"]
        }
    },
    {
        name: "get_clip_transcript",
        description: "Return the full cached transcript (every segment) "
            + "for one clip by name or absolute file path. Returns null "
            + "if the clip is not yet transcribed.",
        input_schema: {
            type: "object",
            properties: {
                filePathOrName: { type: "string" }
            },
            required: ["filePathOrName"]
        }
    },
    {
        name: "push_transcript_to_premiere",
        description: "Push a cached Whisper transcript into Premiere as "
            + "a real transcript attached to a bin clip, using Adobe's "
            + "documented JSON format. After this succeeds, the user can "
            + "open Window > Text > Transcript and see the transcript, "
            + "and use Create Captions to populate a Caption track. "
            + "If clipNameInBin is omitted, the audio file's basename is "
            + "used to find the matching bin item.",
        input_schema: {
            type: "object",
            properties: {
                filePathOrName: { type: "string",
                    description: "Identifier of a previously transcribed "
                        + "media file (the path you passed to "
                        + "transcribe_media_file)." },
                clipNameInBin:  { type: "string",
                    description: "Optional bin item name. Defaults to "
                        + "the audio file's basename." },
                speakerName:    { type: "string",
                    description: "Optional human-readable speaker label. "
                        + "Default \"Speaker 1\"." }
            },
            required: ["filePathOrName"]
        }
    },
    {
        name: "save_transcript_srt",
        description: "Write a cached transcript to disk as a standard "
            + ".srt subtitle file AND auto-import it into the active "
            + "project's bin so it shows up as a project item. The user "
            + "only needs to drop the imported caption clip onto a "
            + "Caption track to display captions on the timeline.",
        input_schema: {
            type: "object",
            properties: {
                filePathOrName: { type: "string",
                    description: "The clip identifier - the path or "
                        + "name you used with transcribe_media_file." },
                outputPath: { type: "string",
                    description: "Optional absolute path for the .srt. "
                        + "Defaults to the source file's path with the "
                        + "extension swapped to .srt." }
            },
            required: ["filePathOrName"]
        }
    },
    {
        name: "transcribe_v1_clips",
        description: "Bulk-transcribe every clip currently on V1 by "
            + "looking up source audio files in a media folder. For "
            + "each V1 clip named 'Foo.mp4', tries (in order) "
            + "Foo_audio.mp3, Foo.mp3, Foo_audio.m4a, Foo.m4a, "
            + "Foo_audio.wav, Foo.wav, Foo.mp4 - first file that "
            + "exists and fits under Whisper's 25MB limit is "
            + "transcribed. Already-cached clips are skipped. "
            + "mediaFolder defaults to the value saved in Settings.",
        input_schema: {
            type: "object",
            properties: {
                mediaFolder: { type: "string",
                    description: "Absolute directory path. Optional; "
                        + "falls back to the Settings value." }
            }
        }
    },
    {
        name: "find_word_positions_in_v1",
        description: "Find the exact timeline start/end seconds of "
            + "specific words (e.g. fillers like 'um','uh','like') "
            + "across every V1 clip with a cached transcript. Use this "
            + "to surface the per-word ranges a user would need to "
            + "razor-cut + delete in Premiere's UI - this build's UXP "
            + "API can't trim or split clips, so trimming a sub-range "
            + "is a manual step. Returns hits[] with clipName, "
            + "v1_currentStartSeconds (whole clip), word, timelineStart"
            + "Sec, timelineEndSec, durationSec.",
        input_schema: {
            type: "object",
            properties: {
                words: { type: "array", items: { type: "string" },
                    description: "Words to locate (case-insensitive)." }
            },
            required: ["words"]
        }
    },
    {
        name: "add_markers_for_words",
        description: "Same scan as find_word_positions_in_v1, plus tries "
            + "to drop a Premiere marker at each hit so the user can "
            + "navigate visually and Razor-cut at each marker. Reports "
            + "markersAdded count + the hit ranges. If Premiere's "
            + "marker API rejects the call in this build, the hits are "
            + "still returned so the user has the data.",
        input_schema: {
            type: "object",
            properties: {
                words: { type: "array", items: { type: "string" } }
            },
            required: ["words"]
        }
    },
    {
        name: "find_v1_clips_matching",
        description: "Find V1 timeline clips whose audio (per cached "
            + "transcript) contains a given phrase. Returns each "
            + "matching clip's v1_currentStartSeconds (ready to feed "
            + "into move_clips / remove_clips / reorder_track), its "
            + "name, the cached transcript source path, and the "
            + "specific segments that matched. Requires the relevant "
            + "audio to have been transcribed via transcribe_media_file "
            + "first. Pass query: \"\" to get every V1 clip with a "
            + "cached transcript (no filtering).",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string",
                    description: "Case-insensitive substring to look "
                        + "for in transcript segment text." }
            },
            required: ["query"]
        }
    },
    {
        name: "list_cached_transcripts",
        description: "List every clip with a cached transcript (from "
            + "this session). Useful before search_transcripts to see "
            + "what is even available.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "helper_status",
        description: "Check whether the PremBot CEP Helper panel is "
            + "running and reachable. Returns { ok, port, helper } on "
            + "success or { ok:false, reason, hint } if not. Call this "
            + "before trim_v1_clip / split_at_seconds / insert_from_bin "
            + "/ add_marker_at if you're unsure - those tools require "
            + "the helper.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "trim_v1_clip",
        description: "Trim a V1 clip's timeline END (or start, or "
            + "source in/out point). Routes through the CEP Helper "
            + "because UXP's clip.createSet[End|Out|Start|In]PointAction "
            + "are stubbed in Premiere 26.2.2. Address clip by its "
            + "currentStartSeconds (visible in list_timeline_clips). "
            + "field defaults to \"end\" (shrinks/extends timeline "
            + "right edge). Returns before/after snapshots.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer", description: "0=V1." },
                currentStartSeconds: { type: "number" },
                field: { type: "string", enum: ["end","start","outPoint","inPoint"],
                    description: "Which edge to set. \"end\" / \"start\" "
                        + "are timeline-side; \"outPoint\" / \"inPoint\" "
                        + "are source-media-side." },
                newSec: { type: "number",
                    description: "The new value for the chosen field, "
                        + "in seconds." }
            },
            required: ["currentStartSeconds", "newSec"]
        }
    },
    {
        name: "split_at_seconds",
        description: "Razor-cut the active sequence at a timeline "
            + "second (splits whichever clip is at that time on every "
            + "track). Routes through the CEP Helper - uses QE DOM.",
        input_schema: {
            type: "object",
            properties: { atSec: { type: "number" } },
            required: ["atSec"]
        }
    },
    {
        name: "insert_from_bin",
        description: "Insert a project bin item onto the timeline at "
            + "a specific second. Routes through the CEP Helper - UXP's "
            + "createInsertProjectItemAction is stubbed in 26.2.2. "
            + "projectItemName must match a bin item's name exactly.",
        input_schema: {
            type: "object",
            properties: {
                projectItemName: { type: "string" },
                atSec:           { type: "number" },
                trackIndex:      { type: "integer",
                    description: "0=V1 (default)." }
            },
            required: ["projectItemName"]
        }
    },
    {
        name: "add_marker_at",
        description: "Add a marker on the active sequence at a "
            + "timeline second. Routes through the CEP Helper - UXP's "
            + "Markers.createAddMarkerAction is stubbed in 26.2.2.",
        input_schema: {
            type: "object",
            properties: {
                atSec:       { type: "number" },
                label:       { type: "string" },
                markerType:  { type: "string",
                    enum: ["Comment","Chapter","Segmentation","WebLink"] },
                comments:    { type: "string" },
                durationSec: { type: "number" }
            },
            required: ["atSec"]
        }
    },
    {
        name: "apply_color_grade",
        description: "Apply a named cinematic color preset to one V1 clip "
            + "or to every clip on V1. Routes through the CEP Helper: "
            + "ensures Lumetri Color is on the clip (QE DOM), then sets "
            + "the preset's parameter targets via ExtendScript. Built-in "
            + "presets cover the most-requested looks. If you need a "
            + "custom grade, call set_lumetri_params instead. "
            + "intensity (0.0-2.0, default 1.0) linearly scales every "
            + "preset param away from neutral - 0 = no grade, 1 = full "
            + "preset, 2 = double-strength.",
        input_schema: {
            type: "object",
            properties: {
                preset: { type: "string",
                    enum: ["teal_orange", "warm_golden_hour",
                           "moody_noir", "bright_punchy", "muted_filmic",
                           "cool_cyberpunk", "neutral_reset"],
                    description: "Built-in preset name." },
                trackIndex:          { type: "integer",
                    description: "0 = V1. Required unless applyToAllV1." },
                currentStartSeconds: { type: "number",
                    description: "Required unless applyToAllV1." },
                applyToAllV1:        { type: "boolean",
                    description: "If true, grade every clip on V1. "
                        + "Ignores trackIndex/currentStartSeconds." },
                intensity: { type: "number",
                    description: "Linear strength scaler, 0..2. "
                        + "Default 1.0 = preset as designed." }
            },
            required: ["preset"]
        }
    },
    {
        name: "set_lumetri_params",
        description: "Set arbitrary Lumetri Color parameter values on a "
            + "V1 clip. Use this for custom grades the built-in presets "
            + "don't cover. Ensures Lumetri Color is applied first "
            + "(idempotent). params is a flat map of Lumetri property "
            + "names to numeric values. Common names: Temperature "
            + "(-100..100), Tint (-100..100), Exposure (-5..5), Contrast "
            + "(-100..100), Highlights (-100..100), Shadows (-100..100), "
            + "Whites (-100..100), Blacks (-100..100), Saturation "
            + "(0..200, 100=default), Vibrance (-100..100), Sharpen "
            + "(0..100), Faded Film (0..100). Returns which params "
            + "landed and which were skipped (with reasons).",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "number" },
                params: { type: "object",
                    description: "Flat map of Lumetri property name -> "
                        + "numeric value. e.g. "
                        + "{ \"Temperature\": 15, \"Saturation\": 115 }",
                    additionalProperties: { type: "number" } }
            },
            required: ["currentStartSeconds", "params"]
        }
    },
    {
        name: "list_lumetri_params",
        description: "List every Lumetri Color parameter on a V1 clip "
            + "with its current numeric value. Use this to inspect a "
            + "clip's grade or to discover the exact displayName of a "
            + "property before calling set_lumetri_params.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "number" }
            },
            required: ["currentStartSeconds"]
        }
    },
    {
        name: "analyze_frame_for_grade",
        description: "Export a still frame from the active sequence (at "
            + "atSec, or the current playhead if omitted) and load it "
            + "into the conversation as an image you can see. Use this "
            + "to study a clip's actual colors before suggesting a "
            + "grade - lighting, dominant hue, exposure, contrast, "
            + "skin tones. After looking at the frame, call "
            + "set_lumetri_params (or apply_color_grade) with the "
            + "parameter targets you'd recommend.",
        input_schema: {
            type: "object",
            properties: {
                atSec: { type: "number",
                    description: "Timeline second to sample. Omit to use "
                        + "the current playhead position." }
            }
        }
    },
    {
        name: "finish",
        description: "Call this when the requested edit is complete. "
            + "Pass a 1-3 sentence summary of what changed.",
        input_schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"]
        }
    }
];

// Built-in color presets. Each value is the absolute Lumetri Color
// parameter target (NOT a delta) for the preset at intensity=1.0. The
// agent applies these in two passes: 1) ensure Lumetri Color is on the
// clip via QE DOM; 2) setValue on each named property. Intensity scales
// every value linearly toward the neutral default for that param
// (Saturation neutral = 100, Vibrance/Exposure/etc neutral = 0).
const COLOR_PRESETS = {
    teal_orange: {
        Temperature: 10,   Tint: 0,
        Exposure: 0.1,     Contrast: 12,
        Highlights: -8,    Shadows: -12,
        Whites: 8,         Blacks: -10,
        Saturation: 112,   Vibrance: 10
    },
    warm_golden_hour: {
        Temperature: 30,   Tint: 6,
        Exposure: 0.25,    Contrast: 5,
        Highlights: -10,   Shadows: 12,
        Whites: 5,         Blacks: -5,
        Saturation: 108,   Vibrance: 15
    },
    moody_noir: {
        Temperature: -8,   Tint: 0,
        Exposure: -0.2,    Contrast: 30,
        Highlights: -15,   Shadows: -30,
        Whites: -5,        Blacks: -40,
        Saturation: 45,    Vibrance: -10
    },
    bright_punchy: {
        Temperature: 5,    Tint: 0,
        Exposure: 0.4,     Contrast: 25,
        Highlights: 5,     Shadows: 10,
        Whites: 20,        Blacks: -5,
        Saturation: 120,   Vibrance: 25
    },
    muted_filmic: {
        Temperature: 3,    Tint: 2,
        Exposure: 0,       Contrast: -8,
        Highlights: -5,    Shadows: 15,
        Whites: -5,        Blacks: 8,
        Saturation: 75,    Vibrance: -5,
        "Faded Film": 25
    },
    cool_cyberpunk: {
        Temperature: -25,  Tint: 12,
        Exposure: -0.1,    Contrast: 22,
        Highlights: 5,     Shadows: -25,
        Whites: 10,        Blacks: -20,
        Saturation: 120,   Vibrance: 20
    },
    neutral_reset: {
        Temperature: 0,    Tint: 0,
        Exposure: 0,       Contrast: 0,
        Highlights: 0,     Shadows: 0,
        Whites: 0,         Blacks: 0,
        Saturation: 100,   Vibrance: 0
    }
};

// Neutral baseline for each Lumetri param (used by intensity scaling).
// Saturation defaults to 100; everything else neutralizes to 0.
function neutralFor(paramName) {
    return paramName === "Saturation" ? 100 : 0;
}

function scalePreset(preset, intensity) {
    const out = {};
    const k = (typeof intensity === "number" && isFinite(intensity))
        ? intensity : 1.0;
    for (const name of Object.keys(preset)) {
        const target = preset[name];
        if (typeof target !== "number") { out[name] = target; continue; }
        const base = neutralFor(name);
        out[name] = base + (target - base) * k;
    }
    return out;
}

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
        "- COLOR GRADING via the CEP Helper:",
        "    apply_color_grade  - one of seven built-in cinematic presets",
        "                         (teal_orange, warm_golden_hour, moody_",
        "                         noir, bright_punchy, muted_filmic, cool_",
        "                         cyberpunk, neutral_reset). Pass intensity",
        "                         0..2 to scale strength (default 1.0).",
        "                         Set applyToAllV1:true to grade every V1",
        "                         clip in one call.",
        "    set_lumetri_params - custom Lumetri values when no preset",
        "                         fits. Common params: Temperature, Tint,",
        "                         Exposure, Contrast, Highlights, Shadows,",
        "                         Whites, Blacks, Saturation, Vibrance.",
        "    list_lumetri_params - inspect current Lumetri values on a",
        "                         clip (or discover exact property names).",
        "    analyze_frame_for_grade - export a frame and view it. After",
        "                         seeing the pixels, recommend specific",
        "                         Lumetri targets and call set_lumetri_",
        "                         params yourself. Best workflow for",
        "                         'analyze this clip and grade it'.",
        "  Color tools route through the CEP Helper (apply-effect-by-name",
        "  is QE-DOM-only, no UXP path). Helper must be open. apply_lumetri",
        "  is idempotent so re-grading the same clip just updates values.",
        "- When the goal is achieved (or proven impossible), call finish with",
        "  a short summary.",
        "",
        seqLine
    ].join("\n");
}

// ---- API call ----

async function callClaude(apiKey, model, messages, system) {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
            model, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages
        })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error("Anthropic API " + res.status + ": " + text);
    }
    return await res.json();
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
    const transcripts = globalThis.PremBotTranscripts;

    // Wire transcript tools into the dispatcher table. They live in a
    // separate module so we keep one place per concern.
    // CEP helper bridge - lets us reach ExtendScript for the broken-
    // in-26.2.2 UXP factories. The helper panel must be open.
    const helper = globalThis.PremBotHelper;
    const helperHandlers = helper ? {
        helper_status: () => helper.isAvailable(),
        trim_v1_clip: ({ trackIndex, currentStartSeconds, field, newSec }) =>
            resolveTrim(trackIndex, currentStartSeconds, field, newSec, helper),
        split_at_seconds: ({ atSec }) =>
            helper.call("split_clip", { atSec }),
        insert_from_bin: ({ projectItemName, atSec, trackIndex }) =>
            helper.call("insert_clip_from_bin",
                { projectItemName, atSec: atSec || 0,
                  trackIndex: trackIndex || 0 }),
        add_marker_at: ({ atSec, label, markerType, comments, durationSec }) =>
            helper.call("add_marker", { atSec, label,
                markerType: markerType || "Comment",
                comments, durationSec }),
        apply_color_grade: (input) => applyColorGrade(input, helper),
        set_lumetri_params: ({ trackIndex, currentStartSeconds, params }) =>
            setLumetriParamsOnClip(trackIndex || 0, currentStartSeconds,
                params, helper),
        list_lumetri_params: ({ trackIndex, currentStartSeconds }) =>
            helper.call("list_lumetri_params",
                { trackIndex: trackIndex || 0, currentStartSeconds }),
        analyze_frame_for_grade: async ({ atSec }) => {
            const res = await helper.call("export_frame_b64",
                typeof atSec === "number" ? { atSec } : {});
            if (!res || res.ok === false) return res;
            // Mark this result for image-content-block packaging in the
            // tool_result. The loop below picks this up and converts it
            // to Anthropic's image-block format instead of a JSON string.
            return {
                ok: true,
                __imageContent: {
                    mediaType: res.mediaType || "image/jpeg",
                    base64: res.base64,
                    text: "Exported frame at "
                        + (typeof res.atSec === "number"
                            ? res.atSec + "s" : "playhead")
                        + " (" + res.byteLength + " bytes)"
                }
            };
        }
    } : {};

    // Apply Lumetri Color + a preset's param targets, optionally across
    // every V1 clip. Each clip is graded in its own helper call so a
    // failure on one clip doesn't poison the rest.
    async function applyColorGrade(input, h) {
        const preset = COLOR_PRESETS[input.preset];
        if (!preset) {
            return { ok: false, error: "UNKNOWN_PRESET",
                preset: input.preset,
                available: Object.keys(COLOR_PRESETS) };
        }
        const params = scalePreset(preset,
            typeof input.intensity === "number" ? input.intensity : 1.0);
        const targets = [];
        if (input.applyToAllV1) {
            const list = await primitives.list_timeline_clips();
            for (const c of list.video) {
                if (c.trackIndex === 0) targets.push(c.startSeconds);
            }
            if (targets.length === 0) {
                return { ok: false, error: "NO_V1_CLIPS",
                    message: "V1 is empty - nothing to grade." };
            }
        } else {
            if (typeof input.currentStartSeconds !== "number") {
                return { ok: false, error: "MISSING_TARGET",
                    message: "Provide currentStartSeconds or set "
                        + "applyToAllV1:true." };
            }
            targets.push(input.currentStartSeconds);
        }
        const ti = input.trackIndex || 0;
        const results = [];
        for (const startSec of targets) {
            const apply = await h.call("apply_lumetri",
                { trackIndex: ti, currentStartSeconds: startSec });
            if (!apply.ok) { results.push({ startSec, apply }); continue; }
            const set = await h.call("set_lumetri_params",
                { trackIndex: ti, currentStartSeconds: startSec, params });
            results.push({ startSec, apply, set });
        }
        const failed = results.filter((r) =>
            !r.apply.ok || (r.set && !r.set.ok));
        return {
            ok: failed.length === 0,
            preset: input.preset,
            intensity: typeof input.intensity === "number" ? input.intensity : 1.0,
            paramTargets: params,
            clipsGraded: results.length - failed.length,
            clipsFailed: failed.length,
            results
        };
    }

    async function setLumetriParamsOnClip(trackIndex, startSec, params, h) {
        const apply = await h.call("apply_lumetri",
            { trackIndex, currentStartSeconds: startSec });
        if (!apply.ok) return { ok: false, stage: "apply_lumetri",
            error: apply };
        const set = await h.call("set_lumetri_params",
            { trackIndex, currentStartSeconds: startSec, params });
        return { ok: !!set.ok, stage: "set", apply, set };
    }

    // Trim takes currentStartSeconds (the UXP-friendly addressing) and
    // translates to clipIndex by listing V1 first, since ExtendScript
    // works by index.
    async function resolveTrim(trackIndex, currentStartSeconds, field, newSec, h) {
        const list = await globalThis.PremBotPrimitives.list_timeline_clips();
        const arr = (trackIndex === 0 || !trackIndex)
            ? list.video : list.video;
        const target = arr.find((c) => c.trackIndex === (trackIndex || 0)
            && Math.abs(c.startSeconds - currentStartSeconds) < 0.05);
        if (!target) {
            return { ok: false, error: "CLIP_NOT_FOUND",
                message: "No V" + ((trackIndex || 0) + 1) + " clip at "
                    + currentStartSeconds + "s" };
        }
        return h.call("trim_clip", {
            kind: "video",
            trackIndex: trackIndex || 0,
            clipIndex: target.clipIndex,
            field: field || "end",
            newSec
        });
    }

    const transcriptHandlers = transcripts ? {
        check_media_file: ({ filePath }) =>
            transcripts.checkMediaFile(filePath),
        transcribe_media_file: ({ filePath, language }) =>
            transcripts.transcribeMediaFile(filePath, { openaiKey, language }),
        search_transcripts: ({ query, maxResults }) =>
            transcripts.searchTranscripts(query, { maxResults }),
        get_clip_transcript: ({ filePathOrName }) =>
            transcripts.getClipTranscript(filePathOrName) || { found: false },
        list_cached_transcripts: () => transcripts.listCachedTranscripts(),
        save_transcript_srt: ({ filePathOrName, outputPath }) =>
            transcripts.saveTranscriptAsSRT(filePathOrName, outputPath),
        push_transcript_to_premiere: ({ filePathOrName, clipNameInBin,
                                        speakerName }) =>
            transcripts.pushTranscriptToPremiere(filePathOrName,
                clipNameInBin, { speakerName }),
        transcribe_v1_clips: ({ mediaFolder: folderArg }) =>
            transcripts.transcribeV1Clips(folderArg || mediaFolder,
                { openaiKey })
    } : {};

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
        const resp = await callClaude(apiKey, model, messages, system);
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
                const fn = primitives[block.name]
                    || transcriptHandlers[block.name]
                    || helperHandlers[block.name];
                if (typeof fn !== "function") {
                    throw new Error("Unknown tool: " + block.name);
                }
                const result = await fn(block.input);
                if (result && result.__imageContent) {
                    // Image tool result: send a content-block array so
                    // Claude can actually see the pixels. Log without
                    // the base64 payload to keep the on-screen log
                    // readable.
                    const img = result.__imageContent;
                    log({ kind: "tool_result", turn, name: block.name,
                        result: { ok: true,
                            image: { mediaType: img.mediaType,
                                bytes: img.base64 ? img.base64.length : 0 },
                            text: img.text } });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: [
                            { type: "text",
                              text: img.text || "Frame image attached." },
                            { type: "image",
                              source: { type: "base64",
                                  media_type: img.mediaType || "image/jpeg",
                                  data: img.base64 } }
                        ]
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

globalThis.PremBotAgent = { runAgent, TOOLS };
