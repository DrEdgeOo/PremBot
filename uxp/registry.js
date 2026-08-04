// Unified tool registry for PremBot (PHASE1-SPEC section 1).
//
// One entry per tool: API schema ({name, description, input_schema},
// moved verbatim from the old agent.js TOOLS array), handler, and the
// runsIn / mutating metadata the phase-1 remote surface needs.
//
// Load order (uxp/index.html): after index.js, helper-client.js,
// transcripts.js, audio.js, vision.js - and BEFORE agent.js, which
// calls PremBotRegistry.build().
//
// INVARIANT - prompt-cache safety: build().tools returns the original
// schema literals untouched. agent.js serializes them into every API
// request, and any byte-level change to that payload invalidates the
// prompt cache on the tools prefix (an expensive, silent regression).
// Change schemas only when you mean to change what the model sees;
// never let metadata leak into these objects.

(function () {

// ---- Tool schemas ----
//
// Names map 1:1 to keys in globalThis.PremBotPrimitives. Keep schemas
// minimal and unambiguous so the model doesn't have to guess.

const TOOLS = [
    {
        name: "discover_premiere_capabilities",
        description: "Probe THIS Premiere/UXP build for which advanced "
            + "editing factories actually work: video effects "
            + "(VideoFilterFactory), audio effects (AudioFilterFactory), "
            + "video transitions (TransitionFactory), and the keyframe/"
            + "motion surface. Returns catalogs (match + display names, "
            + "sampled), per-factory liveness flags "
            + "(createComponentWorks / createWorks - the real test, "
            + "since factories can exist-but-throw on 26.2.2), the "
            + "interpolation-mode enum, which VideoClipTrackItem action "
            + "factories are present, and knownGaps. Call this ONCE at "
            + "the start of any session that will add effects, "
            + "transitions, or motion/keyframes - then refer to effects "
            + "by display name while passing match names internally. "
            + "Result is cached for the session; pass refresh:true to "
            + "re-probe (e.g. after a Premiere update). Non-mutating: "
            + "building filter/transition components does not touch the "
            + "timeline.",
        input_schema: {
            type: "object",
            properties: {
                refresh: { type: "boolean",
                    description: "Force a re-probe instead of returning "
                        + "the session cache. Default false." }
            }
        }
    },
    {
        name: "list_transitions",
        description: "Return the live video-transition match-name "
            + "catalog from THIS Premiere build (152 on 26.2.2). "
            + "Match names ship WITHOUT the PR./AE. prefix on this "
            + "build (e.g. 'ADBE Cross Dissolve', 'ADBE Dip to "
            + "Black') - the opposite of video effects. Never copy "
            + "transition names from documentation; they won't "
            + "resolve. add_transition does fuzzy resolution for "
            + "you, so normally you pass a friendly query there "
            + "rather than calling this - use this only to inspect "
            + "what's available.",
        input_schema: {
            type: "object",
            properties: {
                refresh: { type: "boolean",
                    description: "Re-probe instead of session cache." }
            }
        }
    },
    {
        name: "add_transition",
        description: "Add a video transition to ONE clip edge. "
            + "Resolves a friendly query ('cross dissolve', 'dip to "
            + "black') against the live catalog - pass query, not a "
            + "hardcoded match name.\n"
            + "THE HANDLE PROBLEM (read before using on trimmed "
            + "clips): a two-sided dissolve needs source frames "
            + "beyond the clip's trim to render the overlap. Clips "
            + "trimmed tight (everything the arrangement engine "
            + "places) have no handle; the transition silently "
            + "degrades or fails. This tool MEASURES handles and, "
            + "with autoDegrade (default on), switches to a single-"
            + "sided fade when the side handle < durationSec/2. The "
            + "result reports applied: 'two_sided' | "
            + "'single_sided' | 'single_sided_degraded' | "
            + "'two_sided_no_handle' plus the measured handles - "
            + "always surface that to the user, it's the honest "
            + "outcome.\n"
            + "Single-sided fades (e.g. 'dip to black') need NO "
            + "handle and always land - prefer them at section "
            + "ends / intros / outros. Reserve two-sided dissolves "
            + "for clips you know have spare source media.\n"
            + "alignment (center/startAtCut/endAtCut) maps to an "
            + "UNVERIFIED Premiere enum per skill v0.2 - default "
            + "center; confirm visually if it matters.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0=V1 (default)." },
                currentStartSeconds: { type: "number",
                    description: "Timeline start of the target clip." },
                query: { type: "string",
                    description: "Friendly transition name, fuzzy-"
                        + "resolved against the live catalog "
                        + "(e.g. 'cross dissolve', 'dip to black', "
                        + "'film dissolve')." },
                position: { type: "string", enum: ["start", "end"],
                    description: "Which clip edge. Default 'end'." },
                durationSec: { type: "number",
                    description: "Transition length. Default 1.0." },
                forceSingleSided: { type: "boolean",
                    description: "Force a single-sided fade (no "
                        + "handle needed). Default false." },
                autoDegrade: { type: "boolean",
                    description: "If a two-sided dissolve is "
                        + "requested but the side handle is too "
                        + "short, auto-switch to single-sided. "
                        + "Default true. Set false to see the raw "
                        + "no-handle outcome." },
                alignment: { type: "string",
                    enum: ["center", "startAtCut", "endAtCut"],
                    description: "Placement vs the cut. UNVERIFIED "
                        + "enum. Default 'center'." }
            },
            required: ["currentStartSeconds", "query"]
        }
    },
    {
        name: "remove_transition",
        description: "Remove the video transition at a clip's start "
            + "or end edge.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0=V1 (default)." },
                currentStartSeconds: { type: "number" },
                position: { type: "string", enum: ["start", "end"],
                    description: "Default 'end'." }
            },
            required: ["currentStartSeconds"]
        }
    },
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
            + "projectItemName must match a bin item's name exactly. "
            + "Optional sourceIn / sourceOut trim the source side of the "
            + "clip (used by apply_arrangement to place beat-aligned "
            + "windows from a single source).",
        input_schema: {
            type: "object",
            properties: {
                projectItemName: { type: "string" },
                atSec:           { type: "number" },
                trackIndex:      { type: "integer",
                    description: "0=V1 (default)." },
                sourceIn:        { type: "number",
                    description: "Source-side in-point in seconds. "
                        + "Trims the start of the inserted clip." },
                sourceOut:       { type: "number",
                    description: "Source-side out-point in seconds. "
                        + "Trims the end of the inserted clip." }
            },
            required: ["projectItemName"]
        }
    },
    {
        name: "clear_v1",
        description: "Remove every clip from V1 (linked audio on A1 "
            + "gets removed too, since it's attached to the V-track "
            + "items). Music on other audio tracks (A2, A3, ...) is "
            + "preserved. Use before apply_arrangement when V1 already "
            + "has content you want to replace. Pass trackIndex to "
            + "clear a different video track (1=V2, etc.).",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0=V1 (default). 1=V2, etc." }
            }
        }
    },
    {
        name: "apply_arrangement",
        description: "Apply an arrangement produced by "
            + "auto_arrange_clips to the timeline. Iterates the "
            + "arrangement[] array and places each chunk on V1 with "
            + "its source in/out window. Music tracks (A2+) stay "
            + "untouched. Optionally clears V1 first.\n"
            + "Pass the arrangement[] array verbatim from "
            + "auto_arrange_clips' response. startSec on each entry "
            + "is treated as the timeline second (not song-relative) "
            + "- if the music doesn't start at timeline t=0, add "
            + "timelineOffsetSec to shift everything.",
        input_schema: {
            type: "object",
            properties: {
                arrangement: { type: "array",
                    description: "Verbatim arrangement[] from "
                        + "auto_arrange_clips. Each entry must have "
                        + "clipName, startSec, inPointSec, outPointSec." },
                clearV1First: { type: "boolean",
                    description: "If true (default), clear V1 before "
                        + "placing chunks. Set false to keep existing "
                        + "V1 content - which will RIPPLE on each "
                        + "insert and produce wrong timing." },
                timelineOffsetSec: { type: "number",
                    description: "Seconds to add to each chunk's "
                        + "startSec. Use when the music sits at a "
                        + "non-zero timeline position. Default 0." },
                trackIndex: { type: "integer",
                    description: "Video track index to place on. "
                        + "Default 0 (V1)." }
            },
            required: ["arrangement"]
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
                        + "value. Numeric for sliders (Temperature, "
                        + "Contrast, ...). Strings are accepted ONLY "
                        + "for the two LUT slots (\"Look\" and \"Input "
                        + "LUT\"), where the value is a built-in Look "
                        + "name (e.g. \"Kodak 2393 (by Adobe)\") or an "
                        + "absolute path to a .cube file. e.g. "
                        + "{ \"Temperature\": 15, \"Saturation\": 115, "
                        + "\"Look\": \"Kodak 2393 (by Adobe)\" }",
                    additionalProperties: true }
            },
            required: ["currentStartSeconds", "params"]
        }
    },
    {
        name: "set_lumetri_params_batch",
        description: "Apply per-clip Lumetri grades to many clips in "
            + "ONE call. Strongly preferred over N parallel set_"
            + "lumetri_params calls when grading more than 2-3 clips - "
            + "saves a lot of context and stays under per-minute rate "
            + "limits. Each entry in `grades` is { currentStartSeconds, "
            + "params }, same shape as set_lumetri_params. Returns a "
            + "single compact summary listing ok/applied/skipped per "
            + "clip plus aggregate counts.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0 = V1. Default 0." },
                grades: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            currentStartSeconds: { type: "number" },
                            params: { type: "object",
                                additionalProperties: true }
                        },
                        required: ["currentStartSeconds", "params"]
                    }
                }
            },
            required: ["grades"]
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
        name: "analyze_v1_frames_for_grade",
        description: "Export one frame per V1 clip (or a chosen subset) "
            + "and load every frame into the conversation at once. Use "
            + "this for per-shot color grading: study each clip's "
            + "lighting / hue / exposure, then emit a separate "
            + "set_lumetri_params call per clip with parameter targets "
            + "tailored to that shot. Each image is preceded by a text "
            + "block naming the clip and the exact currentStartSeconds "
            + "you need to pass back. Frames default to clip midpoints "
            + "(the most representative single frame). Token cost "
            + "scales with clip count; default cap is 12 frames per "
            + "call to keep the round-trip sane.",
        input_schema: {
            type: "object",
            properties: {
                currentStartSeconds: { type: "array",
                    items: { type: "number" },
                    description: "Optional filter - only sample these "
                        + "V1 clip start times. Omit for every V1 clip." },
                maxFrames: { type: "integer",
                    description: "Cap on frames returned. Default 12." },
                samplePoint: { type: "string",
                    enum: ["midpoint", "start"],
                    description: "Where to grab the frame within each "
                        + "clip's timeline range. Default midpoint." }
            }
        }
    },
    {
        name: "generate_lut",
        description: "Bake a set of Lumetri-style params into a portable "
            + ".cube 3D LUT file on disk. The .cube format works in "
            + "Premiere, DaVinci Resolve, FCP, OBS, and any tool that "
            + "reads LUTs. Default output is "
            + "<Documents>/PremBot LUTs/<name>.cube. Returns the full "
            + "path. Use this when the user wants a portable look they "
            + "can re-apply later or share, or when they ask you to "
            + "'create a LUT for X'. Param ranges are the SAME as set_"
            + "lumetri_params (Temperature/Tint -100..+100, NOT Kelvin).",
        input_schema: {
            type: "object",
            properties: {
                name:  { type: "string",
                    description: "Filename (no extension). Spaces / "
                        + "punctuation get sanitized." },
                title: { type: "string",
                    description: "Human-readable name written into the "
                        + ".cube TITLE field. Defaults to `name`." },
                params: { type: "object",
                    description: "Lumetri-style param targets. Same "
                        + "shape as set_lumetri_params input. e.g. "
                        + "{ Temperature: 12, Contrast: 20, ... }",
                    additionalProperties: { type: "number" } },
                size: { type: "integer",
                    description: "Cube size (entries per axis). "
                        + "Default 33. Use 17 for quick previews, 33 "
                        + "for standard, 65 for high-fidelity." },
                outputDir: { type: "string",
                    description: "Optional absolute output directory. "
                        + "Default is <Documents>/PremBot LUTs/." }
            },
            required: ["name", "params"]
        }
    },
    {
        name: "generate_and_apply_lut",
        description: "Generate a .cube LUT AND apply it to one or more "
            + "V1 clips in a single call. After writing the file, sets "
            + "each target clip's Lumetri 'Look' slot to the LUT path "
            + "(via set_lumetri_params). Best for 'create a look for "
            + "this content and apply it everywhere' prompts. Same "
            + "param shape as generate_lut. If applyToAllV1 is true, "
            + "the LUT is applied to every V1 clip; otherwise pass "
            + "applyToStartSeconds[].",
        input_schema: {
            type: "object",
            properties: {
                name:   { type: "string" },
                title:  { type: "string" },
                params: { type: "object",
                    additionalProperties: { type: "number" } },
                size:   { type: "integer" },
                outputDir: { type: "string" },
                applyToAllV1: { type: "boolean",
                    description: "If true, apply to every V1 clip." },
                applyToStartSeconds: { type: "array",
                    items: { type: "number" },
                    description: "Specific V1 clip start times to "
                        + "apply the LUT to. Ignored if applyToAllV1." }
            },
            required: ["name", "params"]
        }
    },
    {
        name: "apply_clip_preset",
        description: "Apply a Premiere effect preset (.prfpset) to a "
            + "V1 clip. This is the canonical way to apply a Lumetri "
            + "Look or any saved effect bundle - drag-equivalent. Pass "
            + "an absolute path to the .prfpset file. Lumetri Looks "
            + "ship as .prfpset in Premiere's install dir (Adobe Premiere "
            + "Pro\\<ver>\\Lumetri\\Looks\\...). Returns ok:true if "
            + "Premiere accepted the apply.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "number" },
                presetPath:          { type: "string",
                    description: "Absolute filesystem path to a "
                        + ".prfpset file." }
            },
            required: ["currentStartSeconds", "presetPath"]
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
        name: "list_audio_clips",
        description: "List every clip on every AUDIO track of the active "
            + "sequence with its current steady-state Volume Level in dB "
            + "(null if the clip has time-varying / keyframed volume). "
            + "Use this before any audio level operation to see what's "
            + "on the timeline and where ducking / fades already exist.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "set_audio_gain",
        description: "Set the Volume Level on ONE audio clip to a target "
            + "dB. 0 dB = unity, negative is quieter, -inf is silent. "
            + "Common targets: dialog -6 to -3 dB peaks, music bed -18 "
            + "to -12 dB. Clears any existing keyframes on the clip "
            + "(turns time-varying off). Addresses by (trackIndex, "
            + "currentStartSeconds) where trackIndex is 0-based on AUDIO "
            + "tracks (0 = A1).",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0 = A1, 1 = A2, ..." },
                currentStartSeconds: { type: "number" },
                dB: { type: "number" }
            },
            required: ["currentStartSeconds", "dB"]
        }
    },
    {
        name: "set_audio_gain_batch",
        description: "Set Volume Level dB on many audio clips in ONE "
            + "call. Strongly prefer over N parallel set_audio_gain "
            + "calls when adjusting 3+ clips (e.g. normalizing every "
            + "music clip). gains[i] = { currentStartSeconds, dB }.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0 = A1, default 0." },
                gains: {
                    type: "array",
                    items: { type: "object",
                        properties: {
                            currentStartSeconds: { type: "number" },
                            dB: { type: "number" }
                        },
                        required: ["currentStartSeconds", "dB"] }
                }
            },
            required: ["gains"]
        }
    },
    {
        name: "add_audio_fade",
        description: "Add a fade-in or fade-out to an audio clip by "
            + "keyframing Volume Level from silence to unity (or vice "
            + "versa). side='in' fades up at the clip start; side='out' "
            + "fades down at the clip end. durationSec is the fade "
            + "length (default 1.0). Anchors the inner keyframe at the "
            + "clip's current level so it works regardless of base gain.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer",
                    description: "0 = A1, default 0." },
                currentStartSeconds: { type: "number" },
                side: { type: "string", enum: ["in", "out"] },
                durationSec: { type: "number" }
            },
            required: ["currentStartSeconds", "side"]
        }
    },
    {
        name: "clear_audio_keyframes",
        description: "Remove every Volume Level keyframe on an audio "
            + "clip and reset to a static dB (default 0). Use before "
            + "re-ducking / re-fading a clip you already processed.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer" },
                currentStartSeconds: { type: "number" },
                dB: { type: "number",
                    description: "Reset value in dB. Default 0." }
            },
            required: ["currentStartSeconds"]
        }
    },
    {
        name: "set_audio_keyframes",
        description: "Write a sequence of Volume Level keyframes onto "
            + "one audio clip in ONE call. Each keyframe is { atSec, dB } "
            + "where atSec is absolute TIMELINE seconds (NOT clip-relative). "
            + "Keyframes outside the clip's [start, end] range are "
            + "clamped to the clip edges. This is the building block "
            + "for custom ducking / volume automation; for the standard "
            + "dialog-ducks-music workflow use auto_duck_music instead.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex: { type: "integer" },
                currentStartSeconds: { type: "number" },
                clearFirst: { type: "boolean",
                    description: "Clear existing keyframes before writing. "
                        + "Default true." },
                keyframes: { type: "array",
                    items: { type: "object",
                        properties: {
                            atSec: { type: "number" },
                            dB:    { type: "number" }
                        },
                        required: ["atSec", "dB"] } }
            },
            required: ["currentStartSeconds", "keyframes"]
        }
    },
    {
        name: "auto_duck_music",
        description: "Automatically duck music clips on an audio track "
            + "down to a target dB whenever dialog is present on V1. "
            + "Reads cached transcript segments from V1 (so V1 MUST be "
            + "transcribed first - call transcribe_v1_clips or check "
            + "list_cached_transcripts) and writes Volume Level "
            + "keyframes on the music track. Each ducking event is: "
            + "ramp DOWN over transitionSec before speech starts, hold "
            + "at duckDb through the speech, ramp UP after speech ends. "
            + "Adjacent speech intervals are merged so the ducking "
            + "doesn't pump on word gaps. Re-runnable: clears prior "
            + "keyframes first.\n"
            + "RESULT FIELDS the agent MUST read:\n"
            + "  confidence (0..1) + verdict - same semantics as "
            + "detect_beats. \"reconsider_approach\" means the duck "
            + "may not have produced a usable mix; surface the risks "
            + "and offer alternatives (e.g. lighter duckDb, manual "
            + "set_audio_gain, remove music entirely).\n"
            + "  characterization.speechCoveragePct - fraction of "
            + "music duration overlapping speech. >0.85 = the music "
            + "barely plays anywhere; <0.1 = ducking probably "
            + "unnecessary.\n"
            + "  characterization.shortestGapSec - smallest gap "
            + "between speech intervals. If close to transitionSec, "
            + "the music will pump.\n"
            + "  risks[] - surface verbatim. They are concrete, "
            + "measured concerns (not vibes) and the user needs to "
            + "see them.",
        input_schema: {
            type: "object",
            properties: {
                musicTrackIndex: { type: "integer",
                    description: "0 = A1, 1 = A2 (default). The track "
                        + "holding the music to be ducked." },
                dialogTrackIndex: { type: "integer",
                    description: "0 = V1 (default). Source of speech "
                        + "intervals via cached transcripts." },
                duckDb: { type: "number",
                    description: "Target Volume Level during speech, in "
                        + "dB relative to unity. Default -12." },
                transitionSec: { type: "number",
                    description: "Ramp time on each side of a speech "
                        + "interval. Default 0.25." },
                padSec: { type: "number",
                    description: "Extra lead-in / lead-out around each "
                        + "speech interval before the ramps. Default 0.15." },
                baseDb: { type: "number",
                    description: "Volume Level OUTSIDE speech (the "
                        + "non-ducked baseline). Omit to preserve each "
                        + "clip's current static level; pin a value to "
                        + "force a uniform music bed (e.g. -3 dB)." }
            }
        }
    },
    {
        name: "detect_beats",
        description: "Run beat / tempo detection on a music file and "
            + "return BPM, beat period, beat times, AND a confidence "
            + "score with characterization. RESULT FIELDS the agent "
            + "MUST read before acting:\n"
            + "  confidence (0..1) - overall lock quality.\n"
            + "  verdict - \"trust\" (>=0.7): commit to cuts directly. "
            + "\"preview_first\" (0.5..0.7): call mark_beats and ask "
            + "the user to audition before cutting. \"do_not_commit\" "
            + "(<0.5): tell the user beat detection failed, surface "
            + "the risks[] verbatim, and propose an alternative (e.g. "
            + "manual cuts at the markers + a per-clip review).\n"
            + "  quality.lockHarmonic - \"doubled\" means the detector "
            + "chose 2× the natural BPM (busier cuts). If the user "
            + "says the result feels too frantic, re-run with bpmMax "
            + "= bpm/2.\n"
            + "  risks[] - human-readable warnings to surface to the "
            + "user verbatim. Never hide them; they are why the model "
            + "is being asked to be cautious.\n"
            + "Beat times are FILE-relative seconds; shift_beats maps "
            + "to timeline seconds. Two engines, selected via the "
            + "`engine` input:\n"
            + "  - \"auto\" (default): try librosa first, fall back to "
            + "the JS detector if Python/librosa isn't installed. The "
            + "result includes engineUsed so the agent can tell which "
            + "ran. If engineUsed=\"js\" and librosaSkipped is "
            + "LIBROSA_NOT_INSTALLED or PYTHON_NOT_FOUND, mention to "
            + "the user that confidence would improve by running "
            + "'pip install librosa numpy' (or installing Python 3.8+).\n"
            + "  - \"librosa\": require librosa; surface install hint "
            + "on failure.\n"
            + "  - \"js\": skip librosa entirely (A/B comparison).\n"
            + "librosa uses spectral-flux onset + DP-based beat "
            + "tracking - the de facto standard, much more robust on "
            + "real music than the JS fallback (energy-difference + "
            + "autocorrelation). Both engines return the same shape: "
            + "bpm, beats[], confidence, verdict, risks[]. Non-WAV "
            + "inputs are auto-extracted to WAV via the CEP helper's "
            + "ffmpeg before either engine runs (cached in "
            + "%TEMP%\\PremBot-audio-cache).",
        input_schema: {
            type: "object",
            properties: {
                filePath: { type: "string",
                    description: "Absolute path to the audio file. "
                        + "Mutually exclusive with clipName." },
                clipName: { type: "string",
                    description: "Premiere clip name; we look in the "
                        + "configured media folder for <stem>_audio.{wav,"
                        + "mp3,m4a}. Mutually exclusive with filePath." },
                analyzeSec: { type: "number",
                    description: "How many seconds of audio to analyze "
                        + "for BPM estimation. Beats are then "
                        + "extrapolated across the full duration. "
                        + "Default 60." },
                bpmMin: { type: "number",
                    description: "Min plausible BPM. Default 70." },
                bpmMax: { type: "number",
                    description: "Max plausible BPM. Default 180." },
                maxBeats: { type: "integer",
                    description: "Cap on beats returned. Default 256." },
                bpmHint: { type: "number",
                    description: "Expected BPM prior (librosa only). "
                        + "librosa's default start_bpm=120 makes it "
                        + "pick the doubled tempo on slow music (an "
                        + "80 BPM ballad detects as 160 because 160 "
                        + "is 'closer to 120' in log-space than 80). "
                        + "Pass a hint near the expected tempo when "
                        + "you suspect tactus ambiguity: ~80 for "
                        + "ballad/worship/cinematic slow, ~95 for "
                        + "hip-hop, ~125 for house/dance, ~140 for "
                        + "trance/DnB. If the first run returns BPM "
                        + "≈ 2× what the user expects, retry with "
                        + "bpmHint set to the expected value." },
                engine: { type: "string",
                    enum: ["auto", "librosa", "js"],
                    description: "Beat-detection backend. 'auto' "
                        + "(default) tries librosa first, falls back to "
                        + "the JS detector. 'librosa' requires Python + "
                        + "librosa. 'js' forces the built-in fallback "
                        + "(useful for A/B comparison)." }
            }
        }
    },
    {
        name: "detect_drums",
        description: "Detect kick / snare / hi-hat onsets SEPARATELY "
            + "from a drum-bearing audio file using librosa onset "
            + "detection in three distinct frequency bands. Returns "
            + "three independent arrays of FILE-relative seconds: "
            + "kicks (20-150 Hz, sub/low), snares (1500-4000 Hz, "
            + "wire snap - NOT body, because kick body bleeds into "
            + "the body range), hihats (5-12 kHz). Use this when "
            + "the user wants to cut on a specific instrument rather "
            + "than the overall beat - examples:\n"
            + "  \"cut on every snare\" / \"backbeat edit\" -> cut_to_"
            + "beats({beats: shiftBeats(result.snares, offset)}).\n"
            + "  \"cut on every kick\" / \"four-on-the-floor edit\" "
            + "-> cut_to_beats({beats: shiftBeats(result.kicks, "
            + "offset)}).\n"
            + "  \"cut on every hi-hat\" / \"double-time energy\" "
            + "-> cut_to_beats({beats: shiftBeats(result.hihats, "
            + "offset)}).\n"
            + "Output times are FILE-relative; shift via shift_beats "
            + "before passing to mark_beats / cut_to_beats / "
            + "align_v1_to_beats.\n"
            + "RESULT FIELDS the agent MUST read before acting:\n"
            + "  counts.kicks/snares/hihats - how many of each were "
            + "found. An empty stream means the track lacks that "
            + "instrument in the expected band (or the band tuning "
            + "is wrong for this kit) - tell the user, don't guess.\n"
            + "  confidence (0..1) and verdict (\"trust\" >=0.7 / "
            + "\"preview_first\" 0.4..0.7 / \"do_not_commit\" <0.4) "
            + "- same gating semantics as detect_beats. <0.4 usually "
            + "means non-percussive music; do NOT commit to cuts.\n"
            + "  risks[] - surface verbatim. The common risk is "
            + "\"empty_stream:<name>\" (the requested instrument "
            + "wasn't in the file) - surface it and ask the user "
            + "which available stream to use.\n"
            + "Non-WAV inputs are auto-extracted via ffmpeg first "
            + "(cached, same %TEMP%\\PremBot-audio-cache the beat "
            + "tracker uses). Requires Python + librosa + scipy "
            + "(scipy is a librosa dep, so usually already there).",
        input_schema: {
            type: "object",
            properties: {
                filePath: { type: "string",
                    description: "Absolute path to the audio file. "
                        + "Mutually exclusive with clipName." },
                clipName: { type: "string",
                    description: "Premiere clip name; we look in the "
                        + "configured media folder for <stem>_audio."
                        + "{wav,mp3,m4a}. Mutually exclusive with "
                        + "filePath." },
                maxPerStream: { type: "integer",
                    description: "Cap on onsets returned per stream. "
                        + "Default 256." },
                streams: { type: "string",
                    description: "Which streams to compute. \"all\" "
                        + "(default) or a CSV subset like \"kicks\" "
                        + "or \"snares,hihats\". Skipping streams "
                        + "saves a bandpass + onset_detect per "
                        + "skipped stream (~50ms on a 60s clip)." }
            }
        }
    },
    {
        name: "separate_stems",
        description: "Split a music file into 4 isolated audio stems "
            + "using a Demucs neural model (htdemucs by default): "
            + "vocals, drums, bass, other. Returns absolute file "
            + "paths to the four WAVs. Use this when:\n"
            + "  - you need clean drums for beat / drum detection "
            + "on vocal-heavy or guitar-heavy tracks (run detect_"
            + "drums on result.stems.drums instead of the original "
            + "mix - the snare band stops picking up guitar bleed).\n"
            + "  - the user wants a trailer-style vocal-out remix, "
            + "an instrumental backing track, or an a cappella.\n"
            + "  - any creative edit that needs one element of a "
            + "song isolated (e.g. \"cut on the bassline\", "
            + "\"vocal-only intro\").\n"
            + "Performance: FIRST RUN downloads ~250 MB of model "
            + "weights and ~1.5 GB of torch dependencies. On a GPU "
            + "the actual separation runs near realtime (a 4-min "
            + "song takes ~30-60s). On CPU it's ~5-10x realtime.\n"
            + "Results are cached by source-path hash + mtime in "
            + "%TEMP%\\PremBot-audio-cache\\stems\\, so repeated "
            + "calls on the same file are instant. Stems are "
            + "stereo 44.1 kHz 16-bit WAVs named "
            + "<sourceBasename>.<stem>.wav.\n"
            + "Pass addToBin: true to also import the stem WAVs "
            + "into the active project's bin so the editor can "
            + "drag them onto tracks manually (trailer recuts, "
            + "manual mixing).",
        input_schema: {
            type: "object",
            properties: {
                filePath: { type: "string",
                    description: "Absolute path to the audio / "
                        + "video file. Mutually exclusive with "
                        + "clipName." },
                clipName: { type: "string",
                    description: "Premiere clip name; resolved "
                        + "the same way detect_beats / detect_"
                        + "drums resolve clipName. Mutually "
                        + "exclusive with filePath." },
                stems: { type: "string",
                    description: "Which stems to write to disk. "
                        + "\"all\" (default) or a CSV subset like "
                        + "\"drums\" or \"vocals,bass\". The model "
                        + "still computes all 4 internally - this "
                        + "only filters what's written." },
                device: { type: "string",
                    description: "\"auto\" (default; cuda if "
                        + "available, else cpu), \"cuda\", or "
                        + "\"cpu\". An explicit \"cuda\" with no "
                        + "GPU present silently falls back to cpu." },
                model: { type: "string",
                    description: "Demucs model. Default "
                        + "\"htdemucs\" (4-stem hybrid, fast). "
                        + "Other options: \"htdemucs_ft\" (fine-"
                        + "tuned, slower but higher quality), "
                        + "\"mdx_extra\" (best vocal isolation)." },
                addToBin: { type: "boolean",
                    description: "If true, also import the "
                        + "resulting stem WAVs into the active "
                        + "project's bin so they're draggable "
                        + "onto tracks. Default false (paths "
                        + "only)." }
            }
        }
    },
    {
        name: "analyze_clip",
        description: "Run visual analysis on a Premiere clip and return "
            + "structured semantic metadata: mood, energy, sceneType, "
            + "hasPeople, dominantColors, motion, plus a 1024-d CLIP "
            + "embedding for similarity / clustering. Use this when "
            + "you need to UNDERSTAND what's in a clip, not just cut "
            + "to its rhythm:\n"
            + "  - 'pick the best take from these 5 clips' -> "
            + "analyze each, compare bestFrameReason + energy.\n"
            + "  - 'match clips to song sections' -> analyze all V1 "
            + "clips, group by energy / mood, place high-energy clips "
            + "on chorus sections.\n"
            + "  - 'find the closeup in this batch' -> compare "
            + "sceneType across clips.\n"
            + "  - 'pick the trim that lands on the best moment' -> "
            + "use bestFrameSec + suggestedInPointSec / suggestedOut"
            + "PointSec.\n"
            + "How it works: extracts N frames (default 6) via "
            + "ffmpeg, computes motion / dominantColors numerically, "
            + "asks a local Qwen2.5-VL VLM for the semantic fields, "
            + "and pools an OpenCLIP ViT-H/14 embedding across the "
            + "frames. Refusals on the primary model fall back to an "
            + "abliterated build automatically.\n"
            + "Performance: FIRST RUN downloads ~16 GB of Qwen "
            + "weights into the HF cache and ~2.4 GB CLIP weights if "
            + "PREMBOT_CLIP_VISION_MODEL isn't set. On a GPU the "
            + "actual analysis is ~5-10s per clip (model load + 6-"
            + "frame inference). On CPU it's ~30-60s per clip.\n"
            + "Caching: results are keyed by source-path hash + "
            + "mtime + frame count + model env vars in %TEMP%\\"
            + "PremBot-vision-cache\\, so re-analysis on the same "
            + "source is instant.\n"
            + "Schema (top-level fields):\n"
            + "  energy: 0..1 number, editorial intensity\n"
            + "  motion: 0..1 number, frame-to-frame pixel delta\n"
            + "  mood: enum (energetic|calm|melancholy|tense|"
            + "uplifting|dreamy|neutral)\n"
            + "  moodNotes: short free-form string\n"
            + "  sceneType: enum (interior|exterior_day|exterior_"
            + "night|closeup|wide|crowd|nature|urban|other)\n"
            + "  hasPeople: boolean; personCount: integer\n"
            + "  dominantColors: array of 3 hex strings (k-means)\n"
            + "  bestFrameSec: timestamp of the strongest editorial "
            + "moment within the clip\n"
            + "  bestFrameReason: short string explaining the pick\n"
            + "  suggestedInPointSec / suggestedOutPointSec: a "
            + "~10%-duration window centered on bestFrameSec\n"
            + "  embedding: 1024-d normalized CLIP vector for "
            + "similarity ops\n"
            + "  analysisQuality: primary | fallback | unparseable | "
            + "no_model_loaded\n",
        input_schema: {
            type: "object",
            properties: {
                filePath: { type: "string",
                    description: "Absolute path to the video / image "
                        + "file. Mutually exclusive with clipName." },
                clipName: { type: "string",
                    description: "Premiere bin clip name; resolved "
                        + "the same way separate_stems / detect_beats "
                        + "resolve clipName. Mutually exclusive with "
                        + "filePath." },
                frameCount: { type: "integer",
                    description: "Number of frames to sample uniformly "
                        + "from the clip. Default 6. More frames "
                        + "scales VLM inference time linearly." },
                device: { type: "string",
                    description: "\"auto\" (default; cuda if "
                        + "available, else cpu), \"cuda\", or \"cpu\"." },
                maxDim: { type: "integer",
                    description: "Long-edge cap for sampled JPEG "
                        + "frames in pixels. Default 512. VLMs don't "
                        + "benefit from larger; lower this on CPU to "
                        + "speed inference." }
            }
        }
    },
    {
        name: "mark_beats",
        description: "Drop a Premiere comment marker at each beat time "
            + "on the active sequence. Use after detect_beats to "
            + "visually confirm the beat grid before committing to "
            + "cuts. Beat times must be in TIMELINE seconds; if your "
            + "music sits at offset X on the timeline, pass beats "
            + "shifted by X (or use shiftBeats first).",
        input_schema: {
            type: "object",
            properties: {
                beats: { type: "array", items: { type: "number" },
                    description: "Beat times in TIMELINE seconds." },
                label: { type: "string",
                    description: "Marker label prefix. Default 'beat'." },
                maxMarkers: { type: "integer",
                    description: "Cap on markers placed. Default 256." }
            },
            required: ["beats"]
        }
    },
    {
        name: "cut_to_beats",
        description: "Razor-cut V1 (or the active track) at every beat. "
            + "beats must be in TIMELINE seconds. Skips beats that fall "
            + "within minIntervalSec of the previous cut so you don't "
            + "create unusable micro-clips. Returns the actual cut "
            + "times so you can plan follow-up operations (e.g. "
            + "remove every other clip for a quick double-time effect).",
        input_schema: {
            type: "object",
            properties: {
                beats: { type: "array", items: { type: "number" } },
                minIntervalSec: { type: "number",
                    description: "Minimum gap between cuts. Default 0.2." },
                maxCuts: { type: "integer",
                    description: "Cap on cuts performed. Default 64." }
            },
            required: ["beats"]
        }
    },
    {
        name: "align_v1_to_beats",
        description: "Shift each V1 clip forward so its start lands on "
            + "the next beat. Clips slide forward only (this Premiere "
            + "build can't move clips backward), so put your earliest "
            + "clip at or before the first beat for a tight result. "
            + "Each clip locks to the first beat at or after the "
            + "previous clip's new end, so two clips never collide on "
            + "the same beat. Beats are TIMELINE seconds.",
        input_schema: {
            type: "object",
            properties: {
                beats: { type: "array", items: { type: "number" } },
                trackIndex: { type: "integer",
                    description: "0 = V1 (default)." }
            },
            required: ["beats"]
        }
    },
    {
        name: "shift_beats",
        description: "Offset every beat time by addSec. Convenience for "
            + "mapping FILE-relative beats (what detect_beats returns) "
            + "to TIMELINE seconds when your music clip starts at "
            + "addSec on the timeline. Just adds: beats[i] += addSec.",
        input_schema: {
            type: "object",
            properties: {
                beats:  { type: "array", items: { type: "number" } },
                addSec: { type: "number" }
            },
            required: ["beats", "addSec"]
        }
    },
    {
        name: "auto_arrange_clips",
        description: "Propose a beat-aware music-video edit. Takes a "
            + "music track, separates the drums stem via Demucs, "
            + "builds an energy curve from drum RMS, segments into "
            + "variable-length sections (low/med/high), detects beats "
            + "via librosa, divides each section into N-beat chunks "
            + "(2 beats high energy, 4 med, 8 low - tunable), analyzes "
            + "every candidate clip, and greedily places clips into "
            + "chunks scoring on energy + mood + visual variety with "
            + "a reuse penalty.\n"
            + "Clips are REUSED when the song needs more cuts than "
            + "unique clips available. On reuse, the same clip plays "
            + "DIFFERENT in/out windows - first use centers on "
            + "bestFrameSec (the VLM-picked editorial peak), "
            + "subsequent uses rotate through non-overlapping windows "
            + "so the same frames never play back-to-back.\n"
            + "RETURNS A PROPOSAL ONLY - does NOT mutate the timeline.\n"
            + "STOP after this tool returns. Do NOT call insert_from_bin "
            + "or apply_arrangement in a loop to commit the chunks - "
            + "the panel UI's 'Apply arrangement' button does that "
            + "directly without burning tokens. After this tool returns, "
            + "summarize the proposal (section count, chunk count, top "
            + "matches) and finish your turn so the user can click "
            + "Apply. Only invoke apply_arrangement yourself if the user "
            + "explicitly asks you to apply WITHOUT clicking the button.\n"
            + "Use this when: 'auto-arrange these clips to the music', "
            + "'edit this song with my footage', 'make a music video'. "
            + "DO NOT use when the user already picked clip order.\n"
            + "Performance: first run analyzes every candidate (~5-"
            + "30s each); subsequent runs hit the analyze_clip cache. "
            + "Stem separation and beat detection are also cached.\n"
            + "Response schema (top-level):\n"
            + "  sections: array of {index, startSec, endSec, energy, "
            + "tag}\n"
            + "  beatCount: total beats detected in the song\n"
            + "  beatsSource: detection engine used (librosa/js/auto)\n"
            + "  chunkCount: number of arrangement entries (cuts)\n"
            + "  arrangement: array of {chunkIndex, sectionIndex, "
            + "beatInSection, startSec, endSec, durationSec, "
            + "clipName, inPointSec, outPointSec, score, "
            + "scoreBreakdown, clipMood, clipEnergy, sceneType, "
            + "bestFrameSec, sourceTag}\n"
            + "  placementCounts: {clipName: timesUsed} - shows reuse\n"
            + "  unusedClips: clips that never got placed (excess)",
        input_schema: {
            type: "object",
            properties: {
                musicFilePath: { type: "string",
                    description: "Absolute path to the music track. "
                        + "Mutually exclusive with musicClipName." },
                musicClipName: { type: "string",
                    description: "Project-bin clip name of the music "
                        + "track (e.g. 'song.mp3'). Resolved the same "
                        + "way separate_stems resolves clipName." },
                candidateClipNames: { type: "array",
                    items: { type: "string" },
                    description: "Optional explicit list of video clip "
                        + "names from the bin. If omitted, auto-"
                        + "discovers all video files in the project "
                        + "bin (excludes audio by extension)." },
                beats: { type: "array",
                    items: { type: "number" },
                    description: "Optional pre-detected beats in "
                        + "song-relative seconds. If omitted, calls "
                        + "detect_beats internally." },
                extendBeats: { type: "boolean",
                    description: "If true (default), extrapolate the "
                        + "beat grid from the last detected beat to "
                        + "song end using the detector's locked-in "
                        + "BPM. Fixes librosa DP-tracker dropouts in "
                        + "guitar solos and breakdowns. Set false to "
                        + "see only the detector's raw output." },
                bpmHint: { type: "number",
                    description: "Optional BPM hint passed to "
                        + "detect_beats to prime tempo estimation. "
                        + "Helps when librosa locks to half- or "
                        + "double-tempo. E.g. 95 for No Sleep Till "
                        + "Brooklyn, 125 for house, 140 for DnB." },
                beatsPerChunk: { type: "object",
                    description: "Override default beats-per-chunk "
                        + "by section tag. Default {low:8, med:4, "
                        + "high:2}. E.g. {high:1} for MTV-style cut-"
                        + "on-every-beat in choruses." },
                energyMatchWeight: { type: "number",
                    description: "Score weight for clip-energy to "
                        + "section-energy match. Default 1.0." },
                moodWeight: { type: "number",
                    description: "Score weight for mood compatibility. "
                        + "Default 0.5." },
                varietyWeight: { type: "number",
                    description: "Score weight for visual variety "
                        + "(1 - cosineSim of CLIP embeddings vs the "
                        + "last placed clip). Default 0.5." },
                reusePenalty: { type: "number",
                    description: "Score deduction per prior use of a "
                        + "clip. Default 0.5. Higher = more strongly "
                        + "prefers unused clips before reusing." },
                lowThresh: { type: "number",
                    description: "Energy threshold for 'low' section "
                        + "tag. Default 0.33." },
                highThresh: { type: "number",
                    description: "Energy threshold for 'high' section "
                        + "tag. Default 0.66." },
                minSectionSec: { type: "number",
                    description: "Sections shorter than this get "
                        + "merged into the previous one. Default 4." },
                minChunkSec: { type: "number",
                    description: "Beat chunks shorter than this get "
                        + "skipped (handles detected-too-close beats). "
                        + "Default 0.4 seconds." }
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

// Per-tool metadata, keyed by tool name. Two fields, both load-bearing
// for phase 1's remote surface (CLAUDE.md "Remote access & security"):
//
// - runsIn: where the underlying work executes.
//     "uxp"    - the UXP panel process (premierepro DOM, ppro.Exporter,
//                transcripts via fetch, pure computation).
//     "helper" - ExtendScript in the CEP helper, reached via
//                helper.call().
//     "node"   - the helper's Node process (ffmpeg / Python sidecars,
//                bridge.js NODE_HANDLERS).
//   REALITY CHECK vs docs/PHASE1-SPEC.md: every handler closure in
//   build() below executes in the UXP panel process, and most
//   helper-routed handlers reshape tool names or arguments on the way
//   (e.g. trim_v1_clip lists clips in UXP, then calls /exec/trim_clip).
//   So an MCP layer canNOT generally shortcut runsIn:"helper"|"node"
//   tools straight to /exec/<name> - they still need the reverse
//   channel unless a handler is individually verified to be an exact
//   /exec pass-through. Treat runsIn as routing *input*, not proof.
//
// - mutating: whether the tool changes the project or writes user-
//   visible files (timeline, bin, or non-cache disk writes). Cache
//   writes under %TEMP%\PremBot-* do not count. Remote calls to
//   mutating tools require a confirmation gate.
const TOOL_META = {
    // Pure-UXP primitives (PremBotPrimitives)
    discover_premiere_capabilities: { runsIn: "uxp", mutating: false },
    list_transitions:           { runsIn: "uxp", mutating: false },
    add_transition:             { runsIn: "uxp", mutating: true },
    remove_transition:          { runsIn: "uxp", mutating: true },
    list_project_clips:         { runsIn: "uxp", mutating: false },
    list_timeline_clips:        { runsIn: "uxp", mutating: false },
    move_clips:                 { runsIn: "uxp", mutating: true },
    clone_clip_to_time:         { runsIn: "uxp", mutating: true },
    set_clip_disabled:          { runsIn: "uxp", mutating: true },
    remove_clips:               { runsIn: "uxp", mutating: true },
    reorder_track:              { runsIn: "uxp", mutating: true },
    find_word_positions_in_v1:  { runsIn: "uxp", mutating: false },
    add_markers_for_words:      { runsIn: "uxp", mutating: true },
    find_v1_clips_matching:     { runsIn: "uxp", mutating: false },
    // writes a .cube file to <Documents>\PremBot LUTs\
    generate_lut:               { runsIn: "uxp", mutating: true },

    // Transcripts (PremBotTranscripts; OpenAI fetch from UXP)
    check_media_file:           { runsIn: "uxp", mutating: false },
    transcribe_media_file:      { runsIn: "uxp", mutating: false },
    search_transcripts:         { runsIn: "uxp", mutating: false },
    get_clip_transcript:        { runsIn: "uxp", mutating: false },
    list_cached_transcripts:    { runsIn: "uxp", mutating: false },
    // writes .srt next to source + imports into the bin
    save_transcript_srt:        { runsIn: "uxp", mutating: true },
    push_transcript_to_premiere:{ runsIn: "uxp", mutating: true },
    transcribe_v1_clips:        { runsIn: "uxp", mutating: false },

    // Helper-routed (ExtendScript via helper.call)
    helper_status:              { runsIn: "helper", mutating: false },
    trim_v1_clip:               { runsIn: "helper", mutating: true },
    split_at_seconds:           { runsIn: "helper", mutating: true },
    insert_from_bin:            { runsIn: "helper", mutating: true },
    clear_v1:                   { runsIn: "helper", mutating: true },
    apply_arrangement:          { runsIn: "helper", mutating: true },
    add_marker_at:              { runsIn: "helper", mutating: true },
    apply_color_grade:          { runsIn: "helper", mutating: true },
    set_lumetri_params:         { runsIn: "helper", mutating: true },
    set_lumetri_params_batch:   { runsIn: "helper", mutating: true },
    list_lumetri_params:        { runsIn: "helper", mutating: false },
    apply_clip_preset:          { runsIn: "helper", mutating: true },
    // LUT is generated in UXP but the mutation (Lumetri Look) lands
    // via the helper.
    generate_and_apply_lut:     { runsIn: "helper", mutating: true },
    list_audio_clips:           { runsIn: "helper", mutating: false },
    set_audio_gain:             { runsIn: "helper", mutating: true },
    set_audio_gain_batch:       { runsIn: "helper", mutating: true },
    add_audio_fade:             { runsIn: "helper", mutating: true },
    clear_audio_keyframes:      { runsIn: "helper", mutating: true },
    set_audio_keyframes:        { runsIn: "helper", mutating: true },
    auto_duck_music:            { runsIn: "helper", mutating: true },
    mark_beats:                 { runsIn: "helper", mutating: true },
    cut_to_beats:               { runsIn: "helper", mutating: true },

    // Frame export is UXP-only on 26.2.2 (ppro.Exporter)
    analyze_frame_for_grade:    { runsIn: "uxp", mutating: false },
    analyze_v1_frames_for_grade:{ runsIn: "uxp", mutating: false },

    // Node sidecars in the helper (ffmpeg / librosa / Demucs / vision).
    // All analysis-only: results land in %TEMP% caches, not the project.
    detect_beats:               { runsIn: "node", mutating: false },
    detect_drums:               { runsIn: "node", mutating: false },
    separate_stems:             { runsIn: "node", mutating: false },
    analyze_clip:               { runsIn: "node", mutating: false },
    // returns a PROPOSAL only; apply_arrangement does the mutation
    auto_arrange_clips:         { runsIn: "node", mutating: false },

    // Pure computation / loop control in the UXP process
    shift_beats:                { runsIn: "uxp", mutating: false },
    align_v1_to_beats:          { runsIn: "uxp", mutating: true },
    // finish is special-cased by the agent loop before dispatch; it
    // has no handler here.
    finish:                     { runsIn: "uxp", mutating: false }
};

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

// Bind schemas to handlers. `ctx` carries everything the handler
// closures captured back when they lived inside runAgent():
//   primitives  - globalThis.PremBotPrimitives (required)
//   transcripts - globalThis.PremBotTranscripts (optional)
//   helper      - globalThis.PremBotHelper (optional)
//   mediaFolder - the Settings media folder (optional)
//   openaiKey   - Whisper key for transcript tools (optional)
function build(ctx) {
    if (!ctx || !ctx.primitives) {
        throw new Error("PremBotRegistry.build: ctx.primitives is required.");
    }
    const { primitives, transcripts, helper, mediaFolder, openaiKey } = ctx;

    // Wire transcript tools into the dispatcher table. They live in a
    // separate module so we keep one place per concern.
    // CEP helper bridge - lets us reach ExtendScript for the broken-
    // in-26.2.2 UXP factories. The helper panel must be open.
    const helperHandlers = helper ? {
        helper_status: () => helper.isAvailable(),
        trim_v1_clip: ({ trackIndex, currentStartSeconds, field, newSec }) =>
            resolveTrim(trackIndex, currentStartSeconds, field, newSec, helper),
        split_at_seconds: ({ atSec }) =>
            helper.call("split_clip", { atSec }),
        insert_from_bin: ({ projectItemName, atSec, trackIndex,
                            sourceIn, sourceOut }) =>
            helper.call("insert_clip_from_bin",
                { projectItemName, atSec: atSec || 0,
                  trackIndex: trackIndex || 0,
                  sourceIn, sourceOut }),
        clear_v1: ({ trackIndex } = {}) =>
            helper.call("clear_video_track",
                { trackIndex: trackIndex || 0 }),
        apply_arrangement: (input) =>
            globalThis.PremBotVision.applyArrangement({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        add_marker_at: ({ atSec, label, markerType, comments, durationSec }) =>
            helper.call("add_marker", { atSec, label,
                markerType: markerType || "Comment",
                comments, durationSec }),
        apply_color_grade: (input) => applyColorGrade(input, helper),
        set_lumetri_params: async ({ trackIndex, currentStartSeconds, params }) => {
            const r = await setLumetriParamsOnClip(trackIndex || 0,
                currentStartSeconds, params, helper);
            return compactSetLumetri(r);
        },
        set_lumetri_params_batch: async ({ trackIndex, grades }) => {
            // Apply many per-clip Lumetri grades in one tool call.
            // Each grades[i] = { currentStartSeconds, params }.
            // Returns a single compact summary instead of N verbose
            // results - saves a lot of context for AI-driven flows
            // that grade every clip on the timeline.
            const ti = trackIndex || 0;
            const out = [];
            let okCount = 0, failCount = 0;
            for (const g of (grades || [])) {
                const r = await setLumetriParamsOnClip(ti,
                    g.currentStartSeconds, g.params, helper);
                const compact = compactSetLumetri(r);
                if (compact.ok) okCount++;
                else failCount++;
                out.push({
                    currentStartSeconds: g.currentStartSeconds,
                    ok: compact.ok,
                    clipName: compact.clipName,
                    applied: compact.appliedCount,
                    skipped: compact.skippedCount,
                    error: compact.ok ? undefined : compact.error
                });
            }
            return { ok: failCount === 0,
                grades: out, okCount, failCount };
        },
        list_lumetri_params: ({ trackIndex, currentStartSeconds }) =>
            helper.call("list_lumetri_params",
                { trackIndex: trackIndex || 0, currentStartSeconds }),
        analyze_frame_for_grade: async ({ atSec }) => {
            // Route through the UXP primitive. Cap at 768px max-edge:
            // full-resolution frames are ~6k vision tokens each and
            // blow the 30k input-tokens-per-minute rate limit across a
            // multi-turn flow. 768px is plenty for color analysis.
            const res = await primitives.export_frame_at(
                { atSec, maxDim: 768 });
            if (!res || res.ok === false) return res;
            // Mark this result for image-content-block packaging in the
            // tool_result. The loop below picks this up and converts it
            // to Anthropic's image-block format instead of a JSON string.
            const at = (typeof res.atSec === "number")
                ? (Math.round(res.atSec * 100) / 100) + "s" : "playhead";
            const ctx = res.clipAtPlayhead;
            const ctxLine = ctx
                ? "V1 clip " + ctx.clipIndex + ": " + ctx.clipName
                    + " (start=" + (Math.round(ctx.startSec * 100) / 100)
                    + "s, end=" + (Math.round(ctx.endSec * 100) / 100) + "s)"
                : "no V1 clip at this time (gap)";
            return {
                ok: true,
                __imageContent: {
                    mediaType: res.mediaType || "image/jpeg",
                    base64: res.base64,
                    text: "Frame at " + at + ". " + ctxLine
                        + ". To grade THIS clip, call set_lumetri_params "
                        + "with currentStartSeconds="
                        + (ctx ? ctx.startSec : "<no-clip>") + "."
                }
            };
        },
        analyze_v1_frames_for_grade: async ({ currentStartSeconds,
                                              maxFrames, samplePoint }) => {
            // maxDim:768 keeps total vision tokens under ~10k even
            // for the full 9-frame timeline - well under the 30k/min
            // rate limit so the wrap-up turns succeed.
            const res = await primitives.export_frames_for_v1(
                { currentStartSeconds, maxFrames, samplePoint,
                  maxDim: 768 });
            if (!res || res.ok === false) return res;
            // If zero frames came back (every clip's export failed),
            // surface a regular JSON error instead of an empty image
            // content-block. Empty blocks ship as content:[] and the
            // model gets nothing to act on. Forward the first
            // underlying error so the agent (and operator) can see
            // what actually went wrong - not a generic placeholder.
            if (!res.frames || res.frames.length === 0) {
                const first = res.errors && res.errors[0];
                return { ok: false,
                    error: "FRAME_EXPORT_UNAVAILABLE",
                    message: "No frames could be exported. Falling "
                        + "back to filename / preset-based grading.",
                    errorCount: res.errorCount,
                    firstError: first ? {
                        clipIndex: first.clipIndex,
                        error: first.error,
                        message: first.message
                    } : null };
            }
            const images = res.frames.map((f) => ({
                mediaType: f.mediaType || "image/jpeg",
                base64: f.base64,
                text: "V1 clip " + f.clipIndex + ": " + f.clipName
                    + " (start=" + (Math.round(f.currentStartSeconds * 100) / 100)
                    + "s, end=" + (Math.round(f.endSeconds * 100) / 100)
                    + "s, sampled at " + (Math.round(f.atSec * 100) / 100)
                    + "s). To grade this clip, call set_lumetri_params "
                    + "with currentStartSeconds=" + f.currentStartSeconds + "."
            }));
            return { ok: true, __imageContents: images,
                count: res.count, errorCount: res.errorCount,
                errors: res.errors };
        },
        apply_clip_preset: ({ trackIndex, currentStartSeconds, presetPath }) =>
            helper.call("apply_clip_preset",
                { trackIndex: trackIndex || 0, currentStartSeconds,
                  presetPath }),

        // ---- Audio ops (helper-routed) ----
        list_audio_clips: () => helper.call("list_audio_clips", {}),
        set_audio_gain: (input) =>
            globalThis.PremBotAudio.setAudioGain(input),
        set_audio_gain_batch: (input) =>
            globalThis.PremBotAudio.setAudioGainBatch(input),
        add_audio_fade: (input) =>
            globalThis.PremBotAudio.addAudioFade(input),
        clear_audio_keyframes: (input) =>
            globalThis.PremBotAudio.clearAudioKeyframes(input),
        set_audio_keyframes: (input) =>
            globalThis.PremBotAudio.setAudioKeyframes(input),
        auto_duck_music: (input) =>
            globalThis.PremBotAudio.duckMusicUnderDialog(input),

        // ---- Beat detection / beat-driven editing ----
        detect_beats: (input) =>
            globalThis.PremBotAudio.detectBeats({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        detect_drums: (input) =>
            globalThis.PremBotAudio.detectDrums({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        separate_stems: (input) =>
            globalThis.PremBotAudio.separateStems({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        analyze_clip: (input) =>
            globalThis.PremBotVision.analyzeClip({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        auto_arrange_clips: (input) =>
            globalThis.PremBotVision.autoArrangeClips({
                ...input, mediaFolder: input.mediaFolder || mediaFolder
            }),
        mark_beats: (input) =>
            globalThis.PremBotAudio.markBeats(input),
        cut_to_beats: (input) =>
            globalThis.PremBotAudio.cutToBeats(input),
        align_v1_to_beats: (input) =>
            globalThis.PremBotAudio.alignV1ToBeats(input),
        shift_beats: ({ beats, addSec }) => ({
            ok: true, addSec,
            beats: globalThis.PremBotAudio.shiftBeats(beats || [], addSec || 0)
        }),
        generate_lut: (input) => primitives.generate_lut(input),
        generate_and_apply_lut: async (input) => {
            const lut = await primitives.generate_lut({
                name: input.name, title: input.title,
                params: input.params, size: input.size,
                outputDir: input.outputDir
            });
            if (!lut.ok) return lut;

            // Resolve target clips.
            const targets = [];
            if (input.applyToAllV1) {
                const list = await primitives.list_timeline_clips();
                for (const c of list.video) {
                    if (c.trackIndex === 0) targets.push(c.startSeconds);
                }
            } else if (input.applyToStartSeconds
                && input.applyToStartSeconds.length) {
                for (const s of input.applyToStartSeconds) targets.push(s);
            }

            // Apply via the Look slot. set_lumetri_params accepts a
            // string for Look (built-in name or .cube path).
            const ti = input.trackIndex || 0;
            const applied = [];
            for (const startSec of targets) {
                const r = await setLumetriParamsOnClip(ti, startSec,
                    { Look: lut.path }, helper);
                applied.push({ currentStartSeconds: startSec,
                    ok: !!r.ok,
                    clipName: r.set && r.set.clipName,
                    error: r.ok ? undefined :
                        ((r.error && r.error.error) || "FAIL") });
            }
            return {
                ok: true,
                lutPath: lut.path,
                lutSize: lut.size,
                appliedCount: applied.filter((a) => a.ok).length,
                failedCount: applied.filter((a) => !a.ok).length,
                applied
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

    // Compact the CEP response down to the bits the model needs to know
    // the call landed. Drops the per-param before/after array (10-11
    // entries × 9 clips was costing ~12 kB per turn and tripping the
    // rate limit). If anything was skipped, the names of skipped
    // params are kept since the model may want to retry them.
    function compactSetLumetri(r) {
        if (!r) return { ok: false, error: "NO_RESULT" };
        if (!r.ok) {
            return { ok: false, stage: r.stage,
                error: (r.error && r.error.error) || r.error || "UNKNOWN" };
        }
        const set = r.set || {};
        return {
            ok: true,
            clipName: set.clipName,
            appliedCount: set.appliedCount || 0,
            skippedCount: set.skippedCount || 0,
            skipped: (set.skipped && set.skipped.length)
                ? set.skipped.map((s) => s.name) : undefined
        };
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

    // Resolve each tool's handler with the same precedence the agent
    // loop used before the registry existed: primitives ->
    // transcriptHandlers -> helperHandlers. A handler can be undefined
    // (helper panel closed, transcripts module absent); the agent loop
    // surfaces that as the same "Unknown tool" error as before.
    const byName = {};
    const handlers = {};
    for (const t of TOOLS) {
        const meta = TOOL_META[t.name];
        if (!meta) {
            console.warn("PremBotRegistry: no TOOL_META entry for "
                + t.name + " - add runsIn/mutating before shipping it.");
        }
        const fn = primitives[t.name]
            || transcriptHandlers[t.name]
            || helperHandlers[t.name];
        byName[t.name] = {
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
            runsIn: meta ? meta.runsIn : undefined,
            mutating: meta ? meta.mutating : undefined,
            handler: fn
        };
        if (typeof fn === "function") handlers[t.name] = fn;
    }

    // `tools` is the SAME array of object literals the old agent.js
    // TOOLS const held, passed through by reference - NOT rebuilt - so
    // the serialized API payload is byte-identical to the pre-registry
    // code and the prompt cache on the tools prefix survives. Do not
    // map/copy/augment these objects; put new fields in TOOL_META.
    return { tools: TOOLS, handlers, byName };
}

globalThis.PremBotRegistry = { build };

})();
