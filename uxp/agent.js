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
            + "to timeline seconds. Detector uses energy-onset + "
            + "autocorrelation + phase-locked grid - works well on "
            + "music with clear percussion; weak on ambient / acoustic "
            + "/ tempo-changing tracks (which is what the confidence "
            + "field is for). Decodes via OfflineAudioContext when UXP "
            + "supports it (MP3/M4A/WAV), built-in WAV fallback "
            + "otherwise; ffmpeg one-liner returned if neither works.",
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
                    description: "Cap on beats returned. Default 256." }
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

globalThis.PremBotAgent = { runAgent, TOOLS };
