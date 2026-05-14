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
        "- Trimming (changing a clip's in/out or end time) is NOT supported.",
        "  Tell the user this honestly if they ask for trims.",
        "- remove_clips, set_clip_disabled work normally.",
        "- If a tool returns ok:false with an error field, do NOT retry with",
        "  variants of the same operation - stop and tell the user.",
        "- Transcripts: this Premiere build does not expose existing",
        "  transcripts via UXP. If the user references spoken content,",
        "  ask them for the absolute file path of the media file, then",
        "  call transcribe_media_file(filePath) - this sends the audio",
        "  to OpenAI Whisper and caches the segments. After that you can",
        "  search_transcripts(query) or get_clip_transcript(filePathOrName)",
        "  to address moments by what is said. list_cached_transcripts",
        "  shows what is already loaded so you don't re-transcribe.",
        "- TRANSCRIPT-DRIVEN EDITING (the main reason transcripts exist",
        "  in this tool): once at least one audio file is transcribed,",
        "  call find_v1_clips_matching(query). It walks V1, matches each",
        "  clip to its cached transcript by normalized basename, and",
        "  returns each matching clip's v1_currentStartSeconds. You",
        "  then feed those start times directly into move_clips,",
        "  remove_clips (with ripple:true to close gaps), or",
        "  reorder_track to act on them. Example flow:",
        "    1. transcribe_media_file for each source audio file the",
        "       user provides paths for.",
        "    2. find_v1_clips_matching(query=\"um\") -> list of",
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
    const { apiKey, openaiKey, model, userPrompt, log, signal } = opts;
    if (!apiKey) throw new Error("Set your Anthropic API key in Settings.");
    const primitives = globalThis.PremBotPrimitives;
    if (!primitives) throw new Error("PremBot primitives not loaded.");
    const transcripts = globalThis.PremBotTranscripts;

    // Wire transcript tools into the dispatcher table. They live in a
    // separate module so we keep one place per concern.
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
                clipNameInBin, { speakerName })
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
                    || transcriptHandlers[block.name];
                if (typeof fn !== "function") {
                    throw new Error("Unknown tool: " + block.name);
                }
                const result = await fn(block.input);
                log({ kind: "tool_result", turn, name: block.name, result });
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: JSON.stringify(result)
                });
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
