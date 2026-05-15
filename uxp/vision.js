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

    // ---- Arrangement: match clips to song sections -------------------

    // Mood -> implied energy level. Used to score how well a clip's
    // mood matches a section's energy bucket. Numbers are deliberately
    // soft - if the user has e.g. high-energy "calm" footage (drone
    // over ocean) the energy/embedding terms still win out.
    const MOOD_ENERGY = {
        energetic: 0.90, uplifting: 0.75, tense: 0.75,
        neutral:   0.50,
        dreamy:    0.30, calm:       0.25, melancholy: 0.20
    };
    const TAG_ENERGY = { low: 0.20, med: 0.50, high: 0.85 };

    function moodScore(mood, sectionTag) {
        if (!mood) return 0.5;
        const m = MOOD_ENERGY[mood];
        const t = TAG_ENERGY[sectionTag];
        if (m == null || t == null) return 0.5;
        return 1 - Math.abs(m - t);
    }

    // Cosine similarity on already-L2-normalized vectors == dot product.
    // CLIP embeddings come back normalized from the pipeline so we skip
    // the renormalization step.
    function cosineSim(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;
    }

    function isLikelyVideo(name) {
        return /\.(mp4|mov|m4v|mkv|webm|avi|mxf)$/i.test(name || "");
    }

    // Build the proposed arrangement greedily, walking sections in
    // time order and picking the highest-scoring unused clip per
    // section. Trade-off: greedy can miss globally-better assignments
    // (Hungarian would solve that), but for typical 5-20 clip music-
    // video edits greedy + variety penalty is good enough and stays
    // explainable - the score breakdown in the response shows WHY
    // each clip landed where it did.
    function buildArrangement(sections, analyzed, opts) {
        opts = opts || {};
        const energyW  = (opts.energyMatchWeight != null
                          ? opts.energyMatchWeight : 1.0);
        const moodW    = (opts.moodWeight        != null
                          ? opts.moodWeight        : 0.5);
        const varietyW = (opts.varietyWeight     != null
                          ? opts.varietyWeight     : 0.5);

        const used = new Set();
        const arrangement = [];
        let lastEmbedding = null;

        for (const section of sections) {
            let best = null, bestScore = -Infinity, bestBreakdown = null;
            for (const clip of analyzed) {
                if (used.has(clip.name)) continue;
                const clipEnergy = (clip.energy != null
                                    ? clip.energy : 0.5);
                const eScore = 1 - Math.abs(clipEnergy - section.energy);
                const mScore = moodScore(clip.mood, section.tag);
                let vScore = 1.0;
                if (lastEmbedding && clip.embedding) {
                    vScore = 1 - cosineSim(clip.embedding, lastEmbedding);
                }
                const total = energyW * eScore
                            + moodW    * mScore
                            + varietyW * vScore;
                if (total > bestScore) {
                    bestScore = total;
                    best = clip;
                    bestBreakdown = {
                        energyScore:  +eScore.toFixed(3),
                        moodScore:    +mScore.toFixed(3),
                        varietyScore: +vScore.toFixed(3)
                    };
                }
            }
            if (!best) break;
            used.add(best.name);
            lastEmbedding = best.embedding;

            // Default trim window: full clip duration, centered on
            // bestFrameSec when present, clamped to clip bounds.
            const clipDur = best.durationSec || 0;
            const sectionDur = section.endSec - section.startSec;
            const desired = Math.min(clipDur, sectionDur);
            const center = (best.bestFrameSec != null
                            ? best.bestFrameSec : clipDur / 2);
            let inPoint  = Math.max(0, center - desired / 2);
            let outPoint = inPoint + desired;
            if (outPoint > clipDur) {
                outPoint = clipDur;
                inPoint = Math.max(0, outPoint - desired);
            }

            arrangement.push({
                sectionIndex: section.index,
                sectionStartSec: section.startSec,
                sectionEndSec:   section.endSec,
                sectionTag:      section.tag,
                sectionEnergy:   section.energy,
                clipName:        best.name,
                filePath:        best.filePath,
                inPointSec:      +inPoint.toFixed(3),
                outPointSec:     +outPoint.toFixed(3),
                clipEnergy:      best.energy,
                clipMood:        best.mood,
                sceneType:       best.sceneType,
                bestFrameSec:    best.bestFrameSec,
                score:           +bestScore.toFixed(3),
                scoreBreakdown:  bestBreakdown
            });
        }

        return arrangement;
    }

    // Top-level arrangement orchestrator.
    //
    //   musicClipName | musicFilePath  -> the song (mp3 / wav / mov)
    //   candidateClipNames?            -> explicit list; default: all
    //                                     video clips in project bin
    //   targetSectionCount? (ignored;
    //     segmentation is energy-driven, not fixed-N)
    //   energyMatchWeight, moodWeight, varietyWeight: scoring knobs
    //
    // Returns a PROPOSAL only - no timeline mutation. The agent can
    // apply it via insert_from_bin / cut_to_beats / align_v1_to_beats.
    async function autoArrangeClips(input) {
        input = input || {};
        const audio  = globalThis.PremBotAudio;
        const helper = globalThis.PremBotHelper;
        if (!helper) {
            return { ok: false, error: "NO_HELPER",
                message: "CEP helper not running." };
        }
        if (!audio) {
            return { ok: false, error: "AUDIO_MODULE_UNAVAILABLE" };
        }

        // 1. Music source resolution. Reuse separateStems' input
        // contract (filePath OR clipName).
        const stemArgs = {
            filePath:    input.musicFilePath,
            clipName:    input.musicClipName,
            mediaFolder: input.mediaFolder
        };
        if (!stemArgs.filePath && !stemArgs.clipName) {
            return { ok: false, error: "MISSING_MUSIC",
                message: "Pass musicFilePath or musicClipName." };
        }

        // 2. Stem separation. Drums stem is our intensity signal.
        const stems = await audio.separateStems(stemArgs);
        if (!stems || stems.ok === false || !stems.stems
                || !stems.stems.drums) {
            return { ok: false, error: "STEM_SEPARATION_FAILED",
                message: "Could not isolate the drums stem from the "
                    + "music track.",
                stemsResult: stems };
        }

        // 3. Energy curve from the drums WAV.
        let curve;
        try {
            curve = await audio.computeEnergyCurve(stems.stems.drums, {
                windowSec:    input.windowSec    || 1.0,
                smoothWindow: input.smoothWindow || 3
            });
        } catch (e) {
            return { ok: false, error: "ENERGY_CURVE_FAILED",
                message: e && (e.message || String(e)),
                stemsPath: stems.stems.drums };
        }

        // 4. Segment into variable-length sections.
        const sections = audio.segmentByEnergy(curve, {
            lowThresh:     input.lowThresh     || 0.33,
            highThresh:    input.highThresh    || 0.66,
            minSectionSec: input.minSectionSec || 4.0
        });
        if (sections.length === 0) {
            return { ok: false, error: "NO_SECTIONS",
                message: "Energy curve produced no sections - is the "
                    + "drums stem silent?",
                durationSec: curve.duration };
        }

        // 5. Candidate clips. Default: video files in the project bin.
        // Audio files (mp3/wav/m4a) excluded by extension.
        let candidates = (input.candidateClipNames || []).slice();
        let candidateSource = "explicit";
        if (candidates.length === 0) {
            const listed = await helper.call("list_project_clips", {});
            if (listed && listed.clips) {
                candidates = listed.clips
                    .filter((c) => isLikelyVideo(c.name))
                    .map((c) => c.name);
                candidateSource = "project_bin";
            }
        }
        if (candidates.length === 0) {
            return { ok: false, error: "NO_CANDIDATES",
                message: "Could not find any video clips in the "
                    + "project bin. Pass candidateClipNames "
                    + "explicitly, or import clips first." };
        }

        // 6. Analyze each candidate. Cache hits make repeat calls
        // nearly free. analyze_clip already serializes through the
        // single daemon, so concurrent calls here wouldn't actually
        // run in parallel - just await each in order.
        const analyzed = [];
        const analyzeErrors = [];
        let cacheHits = 0;
        for (const name of candidates) {
            const r = await analyzeClip({ clipName: name,
                mediaFolder: input.mediaFolder });
            if (r && r.ok) {
                if (r.cached) cacheHits++;
                analyzed.push({ name, ...r });
            } else {
                analyzeErrors.push({ clipName: name,
                    error: r && (r.error || "UNKNOWN") });
            }
        }
        if (analyzed.length === 0) {
            return { ok: false, error: "ALL_ANALYSES_FAILED",
                analyzeErrors };
        }

        // 7. Score + greedily assign clips to sections.
        const arrangement = buildArrangement(sections, analyzed, {
            energyMatchWeight: input.energyMatchWeight,
            moodWeight:        input.moodWeight,
            varietyWeight:     input.varietyWeight
        });

        const placed = new Set(arrangement.map((a) => a.clipName));
        const unusedClips = analyzed
            .filter((c) => !placed.has(c.name))
            .map((c) => c.name);

        return {
            ok: true,
            musicFilePath:    stems.basename
                              ? null
                              : input.musicFilePath || null,
            musicClipName:    input.musicClipName || null,
            stemsPath:        stems.stems.drums,
            durationSec:      +curve.duration.toFixed(3),
            sectionCount:     sections.length,
            sections,
            arrangement,
            unusedClips,
            candidatesAnalyzed: analyzed.length,
            candidateSource,
            cacheHits,
            analyzeErrors:    analyzeErrors.length ? analyzeErrors
                                                    : undefined
        };
    }

    globalThis.PremBotVision = {
        analyzeClip,
        autoArrangeClips,
        resolveClipSource
    };
})();
