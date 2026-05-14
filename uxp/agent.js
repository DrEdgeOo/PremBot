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
            + "values identifying clips on the SAME track.",
        input_schema: {
            type: "object",
            properties: {
                trackIndex:          { type: "integer" },
                currentStartSeconds: { type: "array",
                                       items: { type: "number" } }
            },
            required: ["trackIndex", "currentStartSeconds"]
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
        "- Always begin by calling list_timeline_clips to see the current state.",
        "- Address clips by (trackIndex, currentStartSeconds). The start time",
        "  is stable across reorders within a single batch; do not address by",
        "  clipIndex.",
        "- For reorder operations (e.g. \"reverse\", \"sort\"), put every move",
        "  in ONE call to move_clips. The batch is applied atomically, so",
        "  start times don't shift between moves. Do NOT issue many",
        "  single-clip moves in sequence - that causes cascading position",
        "  changes and wrong results.",
        "- The only way to put a new clip on the timeline is clone_clip_to_time,",
        "  which duplicates an existing on-timeline clip. Direct insertion from",
        "  the bin is NOT supported in this Premiere build. If the user wants",
        "  a clip that is not yet on the timeline, ask them to drag it in first.",
        "- Trimming (changing a clip's in/out or end time) is NOT supported.",
        "  Tell the user this honestly if they ask for trims.",
        "- When the goal is achieved, call finish with a short summary.",
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
    const { apiKey, model, userPrompt, log, signal } = opts;
    if (!apiKey) throw new Error("Set your Anthropic API key in Settings.");
    const primitives = globalThis.PremBotPrimitives;
    if (!primitives) throw new Error("PremBot primitives not loaded.");

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
                const fn = primitives[block.name];
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
