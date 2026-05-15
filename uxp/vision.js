// PremBot vision module - clip-level visual analysis.
//
// Mirrors audio.js's wrapper-around-helper pattern: resolve a clip
// reference (filePath OR clipName via the project bin) to an absolute
// file path, then call the CEP helper which spawns vision_analyze.py
// for the actual VLM + CLIP work. Heavy lifting all lives in the
// Python sidecar; this file is purely a dispatch surface for the
// agent's tool-calling layer.
//
// Why a separate module from audio.js: the vision pipeline will grow
// (frame-level similarity, scene-change detection, clip clustering)
// and audio.js is already 1500 lines. Keeping vision concerns
// isolated mirrors audio/transcripts/primitives separation.

(function () {
    "use strict";

    // findAudioFileForClip works for any project-bin item regardless of
    // media type - it just looks up the bin's mediaPath. Reusing it
    // means clipName resolution stays in one place; the audio module
    // is just where it happened to land first.
    async function resolveClipSource(input) {
        if (input.filePath) {
            return { ok: true, filePath: input.filePath };
        }
        if (input.clipName) {
            const audio = globalThis.PremBotAudio;
            if (!audio || !audio.findAudioFileForClip) {
                return { ok: false, error: "AUDIO_MODULE_UNAVAILABLE",
                    message: "PremBotAudio.findAudioFileForClip not "
                        + "loaded - script order issue in index.html?" };
            }
            const found = await audio.findAudioFileForClip(
                input.clipName, input.mediaFolder);
            if (found && found.path) {
                return { ok: true, filePath: found.path,
                    resolutionSource: found.source, diag: found.diag };
            }
            const d = (found && found.diag) || {};
            const m = d.helperMatch || d.uxpMatch;
            let detail;
            if (m && !m.mediaPath) {
                detail = "Premiere project DOES list a bin item "
                    + "named \"" + m.name + "\" but its mediaPath is "
                    + "empty. The clip may be offline / unlinked. "
                    + "Right-click in Premiere > Link Media... to "
                    + "point it back at the source file.";
            } else if (m && m.mediaPath) {
                detail = "Bin item \"" + m.name + "\" points at \""
                    + m.mediaPath + "\" but that file is not readable "
                    + "(moved? renamed? on a disconnected drive?).";
            } else if (d.helperItems > 0 || d.uxpItems > 0) {
                detail = "Searched " + (d.helperItems || d.uxpItems)
                    + " project bin items but none matched the clip "
                    + "name. Check the spelling in the Project panel.";
            } else {
                detail = "Could not enumerate the project bin. Open "
                    + "a project in Premiere and retry.";
            }
            return { ok: false, error: "NO_CLIP_FOUND",
                clipName: input.clipName, message: detail, diag: d };
        }
        return { ok: false, error: "MISSING_SOURCE",
            message: "Pass filePath or clipName." };
    }

    // Top-level analyze entry. Returns the helper's response augmented
    // with the resolution path (so the agent can see how clipName ->
    // file resolved, useful for debugging "wrong clip analyzed").
    async function analyzeClip(input) {
        input = input || {};
        const src = await resolveClipSource(input);
        if (!src.ok) return src;

        const helper = globalThis.PremBotHelper;
        if (!helper) {
            return { ok: false, error: "NO_HELPER",
                message: "CEP helper not running. Vision analysis "
                    + "needs Python + transformers + open_clip via "
                    + "the helper - open the PremBot Helper panel "
                    + "in Premiere and retry." };
        }

        const r = await helper.call("analyze_clip", {
            srcPath: src.filePath,
            frameCount: input.frameCount || 6,
            device:     input.device     || "auto",
            maxDim:     input.maxDim     || 512
        });
        if (!r) return { ok: false, error: "HELPER_UNREACHABLE" };

        if (src.resolutionSource) {
            r.resolutionSource = src.resolutionSource;
        }
        if (input.clipName) r.clipName = input.clipName;
        return r;
    }

    globalThis.PremBotVision = {
        analyzeClip,
        resolveClipSource
    };
})();
