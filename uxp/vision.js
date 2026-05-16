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

    // Extend a sparse beat grid to cover the full song duration using
    // the detector's locked-in BPM. Librosa's DP beat tracker stops
    // emitting beats when it loses tempo confidence (e.g. guitar
    // solos where the drum pattern shifts or spectral content
    // changes), even when drums are present. If we trust the locked
    // tempo for the part it DID find, we can extrapolate forward at
    // the same period to fill the rest. Confirmed on the Beastie
    // Boys "No Sleep Till Brooklyn" track where librosa nailed
    // 0-167s with 0.935 confidence then emitted nothing for the
    // remaining 80s of guitar-solo-over-drums.
    function extendBeatGrid(beats, durationSec, bpm) {
        if (!beats || beats.length === 0) return beats || [];
        if (!bpm || bpm <= 0) return beats;
        const period = 60.0 / bpm;
        const last   = beats[beats.length - 1];
        if (durationSec - last < period * 1.5) return beats;
        const extended = beats.slice();
        let t = last + period;
        while (t < durationSec) {
            extended.push(+t.toFixed(4));
            t += period;
        }
        return extended;
    }

    //   low  energy -> longer takes (~4s @ 120 BPM with 8 beats)
    //   med  energy -> musical phrase (~2s @ 120 BPM with 4 beats)
    //   high energy -> tight cuts    (~1s @ 120 BPM with 2 beats)
    const DEFAULT_BPC = { low: 8, med: 4, high: 2 };

    function beatsPerChunkFor(tag, override) {
        if (override && override[tag] != null) return override[tag];
        return DEFAULT_BPC[tag] != null ? DEFAULT_BPC[tag] : 4;
    }

    // Snap a second value to the sequence frame grid. All chunk
    // boundaries and source windows go through this so that every
    // placed clip's trimmed length is an exact integer number of
    // frames. With ripple-on-empty placement that is the whole ball
    // game: equal in/out widths => the running timeline end lands
    // exactly on the next chunk's beat => no gaps, and crucially no
    // sub-frame "millisecond sliver" of the previous clip poking out
    // (the old code rounded inPoint and outPoint independently with
    // toFixed(3), so their difference drifted by up to a frame).
    function frameSnap(sec, fps) {
        if (!fps || fps <= 0) return sec;
        return Math.round(sec * fps) / fps;
    }

    function secToTC(sec) {
        sec = Math.max(0, sec || 0);
        const m  = Math.floor(sec / 60);
        const s  = Math.floor(sec % 60);
        const ms = Math.round((sec - Math.floor(sec)) * 1000);
        const p2 = (n) => (n < 10 ? "0" + n : "" + n);
        const p3 = (n) => (n < 10 ? "00" + n
                                  : n < 100 ? "0" + n : "" + n);
        return p2(m) + ":" + p2(s) + "." + p3(ms);
    }

    // Inverse of MOOD_ENERGY: given a section energy, the mood words
    // a fill clip should ideally read as. Used only for the human-
    // facing gap shot list, never for automatic selection.
    function moodHintForEnergy(energy) {
        if (energy == null) return "any";
        if (energy >= 0.66) return "energetic / uplifting";
        if (energy <= 0.33) return "calm / dreamy";
        return "neutral";
    }

    // For a clip being placed for the (usageCount + 1)-th time with a
    // chunk of duration chunkDur, return an in/out window into the
    // source clip. The window is ALWAYS exactly chunkDur wide (snapped
    // to the frame grid) so the placed clip exactly fills its beat
    // slot - unless the clip is physically too short, in which case
    // the whole clip is used and the unfilled remainder is reported
    // honestly as deficitSec rather than silently substituted.
    //   - First use: window centered on bestFrameSec (the editorial
    //     peak the VLM picked). This is the strongest moment, so it
    //     gets shown first.
    //   - Subsequent uses: rotate through equal-sized non-overlapping
    //     windows. Phase = usageCount mod #windows so the same clip
    //     never plays the same frames back-to-back. The in point is
    //     clamped so a FULL-width window always fits (the old code
    //     let the last rotation window run short, which produced a
    //     scattered gap every time a clip got reused near its end).
    function pickWindow(clip, chunkDur, usageCount, fps) {
        fps = fps && fps > 0 ? fps : 24;
        const wF = Math.max(1, Math.round(chunkDur * fps)); // slot frames
        const D  = clip.durationSec || 0;

        if (D <= 0) {
            // Source length unknown (offline / missing metadata). We
            // can't guarantee a full window; flag it for the report.
            return { inPoint: 0, outPoint: wF / fps,
                     deficitSec: 0, durationUnknown: true };
        }

        const dF = Math.max(0, Math.round(D * fps));   // clip frames
        if (wF >= dF) {
            // Clip is shorter than (or equal to) the slot. Use all of
            // it; the rest is an honest gap, not a guess.
            return { inPoint: 0, outPoint: dF / fps,
                     deficitSec: +((wF - dF) / fps).toFixed(4),
                     durationUnknown: false };
        }

        let inF;
        if (usageCount === 0) {
            const center = (clip.bestFrameSec != null
                            ? clip.bestFrameSec : D / 2);
            inF = Math.round((center - chunkDur / 2) * fps);
        } else {
            const numWin = Math.max(1, Math.floor(dF / wF));
            inF = (usageCount % numWin) * wF;
        }
        if (inF < 0) inF = 0;
        if (inF + wF > dF) inF = dF - wF;   // keep full width inside

        return { inPoint: inF / fps, outPoint: (inF + wF) / fps,
                 deficitSec: 0, durationUnknown: false };
    }

    // Build the human-facing recommendation for a slot a clip could
    // not fill. This is the "iron sharpens iron" channel: it never
    // changes the timeline, it tells the editor exactly what's
    // missing and - where the cut wants impact more than footage -
    // pushes back instead of just asking for another clip.
    function buildGapRecommendation(section, best, win, atSec,
                                    slotSec) {
        const energy = section.energy != null ? section.energy : null;
        const clip   = best && best.clip;
        const rec = {
            atSec:    +atSec.toFixed(3),
            timecode: secToTC(atSec),
            slotSec:  +slotSec.toFixed(3),
            shortBySec: win.durationUnknown
                        ? null : +win.deficitSec.toFixed(3),
            want: {
                sectionTag:    section.tag,
                sectionEnergy: energy != null
                               ? +energy.toFixed(3) : null,
                targetMood:    moodHintForEnergy(energy),
                minDurationSec: +slotSec.toFixed(3)
            },
            tried: clip ? {
                clipName:        clip.name,
                clipDurationSec: clip.durationSec != null
                                 ? +clip.durationSec.toFixed(3) : null,
                clipEnergy:      clip.energy,
                clipMood:        clip.mood,
                sceneType:       clip.sceneType
            } : null,
            reason: win.durationUnknown
                ? ("Source duration unknown (clip offline or missing "
                   + "metadata) - could not guarantee a full-slot "
                   + "window. Re-link the clip and re-arrange.")
                : ("Best-scoring candidate is "
                   + (+win.deficitSec.toFixed(3)) + "s short of the "
                   + (+slotSec.toFixed(3)) + "s slot; no clip in the "
                   + "pool could fill it."),
            creativeNote: null
        };
        if (energy != null && energy >= 0.6) {
            rec.creativeNote = "High-energy beat (" + energy.toFixed(2)
                + "). Filler often dilutes the hit here - consider a "
                + "hard cut, holding the previous shot through the "
                + "beat, or a whip-pan/flash instead of sourcing a "
                + "clip just to fill the slot.";
        } else if (energy != null && energy < 0.35) {
            rec.creativeNote = "Calm passage (" + energy.toFixed(2)
                + "). A slow, lingering take or a held frame reads "
                + "better here than a hard-to-find short clip - low "
                + "energy wants longer takes.";
        }
        return rec;
    }

    // Score a candidate clip for a given section + neighboring context.
    // Mirrors v1 scoring but adds a reuse penalty so unused clips
    // outrank already-used ones unless the energy/variety advantage
    // overwhelms the penalty. With small candidate pools and long
    // songs, reuse is unavoidable - this just controls how aggressively
    // we cycle.
    function scoreCandidate(clip, sectionTag, sectionEnergy,
                            lastEmbedding, usageCount, weights) {
        const clipEnergy = (clip.energy != null ? clip.energy : 0.5);
        const eScore = 1 - Math.abs(clipEnergy - sectionEnergy);
        const mScore = moodScore(clip.mood, sectionTag);
        let vScore = 1.0;
        if (lastEmbedding && clip.embedding) {
            vScore = 1 - cosineSim(clip.embedding, lastEmbedding);
        }
        const reusePenalty = usageCount * (weights.reusePenalty || 0.5);
        const total = weights.energyW * eScore
                    + weights.moodW    * mScore
                    + weights.varietyW * vScore
                    - reusePenalty;
        return {
            total,
            breakdown: {
                energyScore:  +eScore.toFixed(3),
                moodScore:    +mScore.toFixed(3),
                varietyScore: +vScore.toFixed(3),
                reusePenalty: +reusePenalty.toFixed(3)
            }
        };
    }

    // Build a beat-aware arrangement. Each section gets divided into
    // chunks of N beats (N depends on section energy); each chunk gets
    // its own clip + window. Clips can be reused, but a reuse penalty
    // in the scorer biases the picker toward unused clips first, then
    // cycles through windows of reused clips so they never repeat the
    // same frames back-to-back.
    //
    // Beat alignment: chunk boundaries snap to detected beats from
    // PremBotAudio.detectBeats. Sections that contain fewer than 2
    // beats fall back to one-clip-per-section (matches v1 behavior).
    function buildArrangement(sections, analyzed, beats, opts) {
        opts = opts || {};
        const weights = {
            energyW:       (opts.energyMatchWeight != null
                            ? opts.energyMatchWeight : 1.0),
            moodW:         (opts.moodWeight        != null
                            ? opts.moodWeight        : 0.5),
            varietyW:      (opts.varietyWeight     != null
                            ? opts.varietyWeight     : 0.5),
            reusePenalty:  (opts.reusePenalty      != null
                            ? opts.reusePenalty      : 0.5)
        };
        const bpcOverride = opts.beatsPerChunk || null;
        const minChunkSec = opts.minChunkSec || 0.4;
        const fps = opts.fps && opts.fps > 0 ? opts.fps : 24;

        const usage = new Map();      // clip.name -> use count
        const usageCount = (n) => usage.get(n) || 0;
        const bumpUsage = (n) =>
            usage.set(n, (usage.get(n) || 0) + 1);

        const arrangement = [];
        let lastEmbedding = null;
        let chunkIdx = 0;

        for (const section of sections) {
            // Beats falling inside this section. Section boundaries
            // are inclusive on the start, exclusive on the end (the
            // next section picks up the boundary beat).
            const sb = beats.filter(
                (t) => t >= section.startSec && t < section.endSec);

            // If we don't have at least 2 beats, treat the whole
            // section as one chunk (matches v1 behavior). This is the
            // right fallback for short sections (<5s) and for songs
            // where beat detection missed coverage.
            if (sb.length < 2) {
                const s0  = frameSnap(section.startSec, fps);
                const s1  = frameSnap(section.endSec, fps);
                const dur = s1 - s0;
                const best = pickBest(analyzed, section, lastEmbedding,
                                       weights, usageCount);
                if (!best) continue;
                const win = pickWindow(best.clip, dur,
                                        usageCount(best.clip.name), fps);
                arrangement.push(emitChunk(chunkIdx++, section, 0,
                    s0, s1, best, win, "section_fallback", fps));
                bumpUsage(best.clip.name);
                lastEmbedding = best.clip.embedding;
                continue;
            }

            // Add the section-end as a virtual final beat so the last
            // chunk in this section terminates cleanly.
            sb.push(section.endSec);

            const bpc = beatsPerChunkFor(section.tag, bpcOverride);

            let pos = 0;
            let beatInSection = 0;
            while (pos < sb.length - 1) {
                const endIdx = Math.min(pos + bpc, sb.length - 1);
                const chunkStart = frameSnap(sb[pos], fps);
                const chunkEnd   = frameSnap(sb[endIdx], fps);
                let chunkDur   = chunkEnd - chunkStart;

                // Skip chunks that are pathologically short - happens
                // when beat detection found two beats almost on top
                // of each other.
                if (chunkDur < minChunkSec) {
                    pos = endIdx;
                    continue;
                }

                const best = pickBest(analyzed, section, lastEmbedding,
                                       weights, usageCount);
                if (!best) break;
                const useCount = usageCount(best.clip.name);
                const win = pickWindow(best.clip, chunkDur, useCount,
                                        fps);
                arrangement.push(emitChunk(chunkIdx++, section,
                    beatInSection, chunkStart, chunkEnd,
                    best, win, "beat_chunk", fps));
                bumpUsage(best.clip.name);
                lastEmbedding = best.clip.embedding;

                pos = endIdx;
                beatInSection++;
            }
        }

        return arrangement;
    }

    function pickBest(analyzed, section, lastEmbedding, weights,
                      usageCount) {
        let bestClip = null;
        let bestTotal = -Infinity;
        let bestBreakdown = null;
        for (const clip of analyzed) {
            const r = scoreCandidate(clip, section.tag, section.energy,
                lastEmbedding, usageCount(clip.name), weights);
            if (r.total > bestTotal) {
                bestTotal = r.total;
                bestClip = clip;
                bestBreakdown = r.breakdown;
            }
        }
        return bestClip ? {
            clip: bestClip,
            score: bestTotal,
            breakdown: bestBreakdown
        } : null;
    }

    function emitChunk(chunkIdx, section, beatInSection, startSec,
                       endSec, best, win, source, fps) {
        const sQ = frameSnap(startSec, fps);
        const eQ = frameSnap(endSec, fps);
        const slotSec = eQ - sQ;
        const placed  = win.outPoint - win.inPoint;
        const deficit = win.deficitSec || 0;
        const rec = (deficit > 0 || win.durationUnknown)
            ? buildGapRecommendation(section, best, win, sQ, slotSec)
            : null;
        return {
            chunkIndex: chunkIdx,
            sectionIndex: section.index,
            sectionStartSec: section.startSec,
            sectionEndSec:   section.endSec,
            sectionTag:      section.tag,
            sectionEnergy:   section.energy,
            beatInSection,
            startSec:        +sQ.toFixed(4),
            endSec:          +eQ.toFixed(4),
            durationSec:     +slotSec.toFixed(4),
            clipName:        best.clip.name,
            filePath:        best.clip.filePath,
            inPointSec:      +win.inPoint.toFixed(4),
            outPointSec:     +win.outPoint.toFixed(4),
            placedDurationSec: +placed.toFixed(4),
            deficitSec:      +deficit.toFixed(4),
            sourceWindowExact: !win.durationUnknown && deficit === 0,
            recommendation:  rec,
            sourceDurationSec: best.clip.durationSec != null
                               ? +best.clip.durationSec.toFixed(3)
                               : null,
            clipEnergy:      best.clip.energy,
            clipMood:        best.clip.mood,
            sceneType:       best.clip.sceneType,
            bestFrameSec:    best.clip.bestFrameSec,
            score:           +best.score.toFixed(3),
            scoreBreakdown:  best.breakdown,
            sourceTag:       source
        };
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
    // Returns a PROPOSAL only - no timeline mutation. Committed to
    // V1 by the panel's one-click Apply button (ui.js ->
    // applyArrangement), NOT by the agent looping placement tools.
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

        // 7. Beat grid. Re-use cached beats if caller passes them,
        // otherwise call detect_beats on the original music (NOT the
        // drums stem - librosa beat tracking is tuned for full mixes).
        let beats = (input.beats && input.beats.length)
                    ? input.beats.slice() : null;
        let beatsSource = beats ? "explicit" : null;
        let detectedBpm = input.bpm || 0;
        if (!beats) {
            const bres = await audio.detectBeats({
                clipName:    input.musicClipName,
                filePath:    input.musicFilePath,
                mediaFolder: input.mediaFolder,
                maxBeats:    input.maxBeats || 2048,
                bpmHint:     input.bpmHint || 0
            });
            if (bres && bres.ok && Array.isArray(bres.beats)) {
                beats = bres.beats.slice();
                beatsSource = bres.engineUsed || "auto";
                if (bres.bpm) detectedBpm = bres.bpm;
            } else {
                beats = [];
                beatsSource = "failed";
            }
        }
        beats.sort((a, b) => a - b);

        // Backstop for librosa DP tracker drop-outs (guitar solos,
        // breakdowns, tempo-shifted sections). Extend the grid from
        // the last detected beat to song duration using the locked-
        // in BPM. Opt out via extendBeats: false if you want to see
        // exactly what the detector emitted with no synthesis.
        const detectedBeatCount = beats.length;
        if (input.extendBeats !== false && beats.length > 0
                && detectedBpm > 0) {
            beats = extendBeatGrid(beats, curve.duration, detectedBpm);
        }
        const synthesizedBeatCount = beats.length - detectedBeatCount;

        // 7b. Sequence frame rate, for the duration contract: chunk
        // boundaries and source windows snap to this grid so every
        // placed clip is an exact integer number of frames (no
        // slivers, no sub-frame gaps). Falls back to input.fps then
        // 24 if no active sequence answers.
        let fpsUsed = input.fps && input.fps > 0 ? input.fps : 24;
        let fpsSource = input.fps ? "input" : "default";
        try {
            const fr = await helper.call("get_sequence_fps", {});
            if (fr && fr.ok && fr.fps > 0) {
                fpsUsed = fr.fps;
                fpsSource = "sequence";
            }
        } catch (e) {}

        // 8. Build beat-aware arrangement. Each section gets divided
        // into N-beat chunks; clips can reuse but rotate windows.
        const arrangement = buildArrangement(sections, analyzed, beats, {
            energyMatchWeight: input.energyMatchWeight,
            moodWeight:        input.moodWeight,
            varietyWeight:     input.varietyWeight,
            reusePenalty:      input.reusePenalty,
            beatsPerChunk:     input.beatsPerChunk,
            minChunkSec:       input.minChunkSec,
            fps:               fpsUsed
        });

        // Honest gap shot list: every slot a clip could not fill,
        // with what to look for and (where the cut wants impact more
        // than footage) creative pushback. Never auto-substituted.
        const gapRecommendations = arrangement
            .filter((c) => c.recommendation)
            .map((c) => Object.assign(
                { chunkIndex: c.chunkIndex }, c.recommendation));
        const deficitTotalSec = +arrangement
            .reduce((s, c) => s + (c.deficitSec || 0), 0).toFixed(3);

        const placedNames = new Set(arrangement.map((a) => a.clipName));
        const unusedClips = analyzed
            .filter((c) => !placedNames.has(c.name))
            .map((c) => c.name);

        // Per-clip placement counts so the caller can see at a glance
        // how heavily each clip got reused.
        const placementCounts = {};
        for (const a of arrangement) {
            placementCounts[a.clipName] =
                (placementCounts[a.clipName] || 0) + 1;
        }

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
            beatCount:        beats.length,
            detectedBeatCount,
            synthesizedBeatCount,
            detectedBpm:      detectedBpm || null,
            beatsSource,
            chunkCount:       arrangement.length,
            arrangement,
            fpsUsed,
            fpsSource,
            gapCount:         gapRecommendations.length,
            deficitTotalSec,
            gapRecommendations,
            placementCounts,
            unusedClips,
            candidatesAnalyzed: analyzed.length,
            candidateSource,
            cacheHits,
            analyzeErrors:    analyzeErrors.length ? analyzeErrors
                                                    : undefined
        };
    }

    // ---- Phase B2: energy-aware, handle-safe transition post-pass --
    //
    // Runs AFTER all chunks are placed. Walks adjacent placed pairs
    // and classifies each cut by the skill v0.2 tiered decision tree,
    // then calls the B1 add_transition primitive (which does the
    // handle measurement + autoDegrade). The policy lives here; the
    // mechanism + honest per-cut measurement lives in add_transition.
    //
    // Tiers (per cut between outgoing A and incoming B):
    //   1. Both high energy           -> HARD CUT (impact, no trans)
    //   2. Major energy drop          -> SINGLE-SIDED dip (no handle
    //                                    needed, always lands)
    //   3. Gentle section boundary    -> TWO-SIDED dissolve (auto-
    //                                    degrades if handles short)
    //   4. Calm held passage          -> TWO-SIDED dissolve
    //   5. Otherwise (mid, in-section)-> HARD CUT (don't over-trans)
    // Plus optional intro fade-in and outro fade-out (single-sided).
    //
    // Every cut's ACTUAL outcome (from add_transition: two_sided /
    // single_sided / single_sided_degraded / hard_cut) is collected
    // so the caller can report exactly what landed - the honesty the
    // skill requires for batch transition tools to be safe.
    async function runTransitionPostPass(sorted, placed, offset,
                                         trackIndex, cfg) {
        const prims = globalThis.PremBotPrimitives;
        if (!prims || typeof prims.add_transition !== "function") {
            return { ok: false, error: "NO_TRANSITION_PRIMITIVE",
                note: "add_transition unavailable - B1 not loaded" };
        }
        const HIGH = cfg.highEnergyThresh;
        const LOW  = cfg.lowEnergyThresh;
        const DROP = cfg.energyDropThresh;
        const durS = cfg.durationSec;
        const dissolveQ = cfg.dissolveQuery;
        const dipQ      = cfg.dipQuery;

        // chunkIndex -> timeline start of the successfully placed clip.
        const startByChunk = {};
        for (const p of placed) startByChunk[p.chunkIndex] = p.atSec;
        const isPlaced = (c) => c
            && startByChunk[c.chunkIndex] != null;

        const cuts = [];
        const tally = { hard_cut: 0, single_sided_dip: 0,
            two_sided_dissolve: 0, intro_fade: 0, outro_fade: 0,
            degraded: 0, failed: 0, skipped_unplaced: 0 };

        const callTrans = async (atSec, position, query,
                                 forceSingle, handleHintSec) => {
            try {
                const args = {
                    trackIndex,
                    currentStartSeconds: atSec,
                    query,
                    position,
                    durationSec: durS,
                    forceSingleSided: !!forceSingle,
                    autoDegrade: true
                };
                // Authoritative handle from arrangement metadata -
                // bypasses the live ClipProjectItem probe entirely.
                if (handleHintSec != null) {
                    if (position === "end")
                        args.tailHandleSec = handleHintSec;
                    else
                        args.leadHandleSec = handleHintSec;
                }
                return await prims.add_transition(args);
            } catch (e) {
                return { ok: false, error: "ADD_TRANSITION_THREW",
                    message: (e && e.message) || String(e) };
            }
        };

        // Intro fade-in on the first placed chunk's START.
        if (cfg.introFade) {
            const first = sorted.find(isPlaced);
            if (first) {
                const r = await callTrans(startByChunk[first.chunkIndex],
                    "start", dipQ, true);
                tally.intro_fade++;
                if (r && r.ok === false) tally.failed++;
                cuts.push({ kind: "intro_fade",
                    chunkIndex: first.chunkIndex,
                    atSec: startByChunk[first.chunkIndex],
                    result: r });
            }
        }

        for (let i = 0; i < sorted.length - 1; i++) {
            const A = sorted[i];
            const B = sorted[i + 1];
            if (!isPlaced(A) || !isPlaced(B)) {
                tally.skipped_unplaced++;
                continue;
            }
            const eA = A.sectionEnergy != null ? A.sectionEnergy : 0.5;
            const eB = B.sectionEnergy != null ? B.sectionEnergy : 0.5;
            const boundary = A.sectionIndex !== B.sectionIndex;
            const drop = eA - eB;
            const atEnd = startByChunk[A.chunkIndex];

            // A two-sided dissolve at this cut needs handle on BOTH
            // adjoining sides: A's tail (source beyond its out) and
            // B's lead (source before its in). The binding constraint
            // is the smaller. Computed from arrangement metadata, so
            // it's exact and probe-independent. null if either chunk
            // lacks sourceDurationSec (older arrangement) -> let the
            // live probe try.
            let bindingHandle = null;
            const aTail = (A.sourceDurationSec != null
                           && A.outPointSec != null)
                ? A.sourceDurationSec - A.outPointSec : null;
            const bLead = (B.inPointSec != null) ? B.inPointSec : null;
            if (aTail != null && bLead != null)
                bindingHandle = +Math.max(0,
                    Math.min(aTail, bLead)).toFixed(3);

            let tier, query, forceSingle = false, doIt = true;
            if (eA >= HIGH && eB >= HIGH) {
                tier = "hard_cut"; doIt = false;       // impact
            } else if (drop >= DROP || (boundary && drop > 0.05)) {
                tier = "single_sided_dip";             // punctuate drop
                query = dipQ; forceSingle = true;
            } else if (boundary) {
                tier = "two_sided_dissolve";           // gentle bndry
                query = dissolveQ;
            } else if (eA < LOW && eB < LOW) {
                tier = "two_sided_dissolve";           // calm passage
                query = dissolveQ;
            } else {
                tier = "hard_cut"; doIt = false;       // mid, in-sec
            }

            let result = null;
            if (doIt) {
                result = await callTrans(atEnd, "end", query,
                    forceSingle, bindingHandle);
                if (result && result.ok === false) {
                    tally.failed++;
                } else if (result
                        && result.applied === "single_sided_degraded") {
                    tally.degraded++;
                    tally[tier === "single_sided_dip"
                        ? "single_sided_dip" : "two_sided_dissolve"]++;
                } else {
                    tally[tier]++;
                }
            } else {
                tally.hard_cut++;
            }

            cuts.push({
                kind: tier,
                cutAfterChunk: A.chunkIndex,
                atSec: atEnd,
                sectionBoundary: boundary,
                energyFrom: +eA.toFixed(3),
                energyTo: +eB.toFixed(3),
                energyDrop: +drop.toFixed(3),
                bindingHandleSec: bindingHandle,
                transitioned: doIt,
                result
            });
        }

        // Outro fade-out on the last placed chunk's END.
        if (cfg.outroFade) {
            let last = null;
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (isPlaced(sorted[i])) { last = sorted[i]; break; }
            }
            if (last) {
                const r = await callTrans(startByChunk[last.chunkIndex],
                    "end", dipQ, true);
                tally.outro_fade++;
                if (r && r.ok === false) tally.failed++;
                cuts.push({ kind: "outro_fade",
                    chunkIndex: last.chunkIndex,
                    atSec: startByChunk[last.chunkIndex],
                    result: r });
            }
        }

        return {
            ok: tally.failed === 0,
            scheme: "energy_aware",
            durationSec: durS,
            thresholds: { high: HIGH, low: LOW, drop: DROP },
            cutCount: cuts.length,
            tally,
            cuts
        };
    }

    // Apply an arrangement produced by autoArrangeClips. Iterates
    // each chunk and places it on V1 with its source in/out window
    // pre-baked via insert_clip_from_bin's sourceIn/sourceOut params.
    // Clears V1 first by default - insertClip is a ripple insert, so
    // any existing V1 content would shift on each call and produce
    // garbage. Music tracks above V1's matched audio (A2+) stay
    // untouched.
    async function applyArrangement(input) {
        input = input || {};
        const helper = globalThis.PremBotHelper;
        if (!helper) {
            return { ok: false, error: "NO_HELPER" };
        }
        const arrangement = input.arrangement;
        if (!Array.isArray(arrangement) || arrangement.length === 0) {
            return { ok: false, error: "EMPTY_ARRANGEMENT" };
        }
        const trackIndex = input.trackIndex || 0;
        const offset     = input.timelineOffsetSec || 0;
        const clearFirst = input.clearV1First !== false;
        const onProgress = typeof input.onProgress === "function"
                           ? input.onProgress : null;

        // Opt-in gap filler: a color matte (or any clip) the caller
        // pre-placed in the project bin. When a chunk's clip can't
        // fill its slot we ripple-insert this item trimmed to exactly
        // the shortfall, keeping the timeline contiguous and beat-
        // locked. If the name is absent or not in the bin the gap
        // stays an honest, reported hole (shipped behavior) - no
        // matte synthesis, no hard failure. A neutral slug is a
        // visible "your call here" marker, not a creative swap.
        const gapFillerName = input.gapFillerClipName || null;

        // Sort by startSec so ripple-on-empty-track produces the
        // right timing. The arrangement should already be in order
        // but defending against caller permutations is cheap.
        const sorted = arrangement.slice().sort(
            (a, b) => (a.startSec || 0) - (b.startSec || 0));

        let clearResult = null;
        if (clearFirst) {
            clearResult = await helper.call("clear_video_track",
                { trackIndex });
            if (clearResult && clearResult.ok === false) {
                return { ok: false, error: "CLEAR_FAILED",
                    clearResult };
            }
        }

        const placed = [];
        const errors = [];
        const fillersPlaced = [];
        const fillerErrors  = [];
        for (let i = 0; i < sorted.length; i++) {
            const chunk = sorted[i];
            if (onProgress) {
                try { onProgress({ index: i, total: sorted.length,
                    chunk }); } catch (e) {}
            }
            const res = await helper.call("insert_clip_from_bin", {
                projectItemName: chunk.clipName,
                atSec:           (chunk.startSec || 0) + offset,
                trackIndex,
                sourceIn:        chunk.inPointSec,
                sourceOut:       chunk.outPointSec
            });
            if (res && res.ok) {
                placed.push({ chunkIndex: chunk.chunkIndex,
                    atSec: (chunk.startSec || 0) + offset,
                    clipName: chunk.clipName });

                // Short clip -> fill the exact remainder with the
                // trimmed bin filler so the next chunk still lands on
                // its beat. Failures here never abort: the gap simply
                // stays honest and reported.
                if (gapFillerName && (chunk.deficitSec || 0) > 0) {
                    const fillStart = (chunk.startSec || 0) + offset
                        + (chunk.placedDurationSec || 0);
                    const fres = await helper.call(
                        "insert_clip_from_bin", {
                            projectItemName: gapFillerName,
                            atSec:           fillStart,
                            trackIndex,
                            sourceIn:        0,
                            sourceOut:       chunk.deficitSec
                        });
                    if (fres && fres.ok) {
                        fillersPlaced.push({
                            chunkIndex:  chunk.chunkIndex,
                            atSec:       +fillStart.toFixed(4),
                            durationSec: chunk.deficitSec });
                    } else {
                        fillerErrors.push({
                            chunkIndex: chunk.chunkIndex,
                            error: fres && (fres.error || "UNKNOWN"),
                            detail: fres });
                    }
                }
            } else {
                errors.push({ chunkIndex: chunk.chunkIndex,
                    clipName: chunk.clipName,
                    error: res && (res.error || "UNKNOWN"),
                    detail: res });
                // Don't abort - placing a partial timeline is more
                // useful than rolling back to empty. The caller can
                // see which chunks failed and re-run apply on just
                // those.
            }
        }

        // Phase B2: energy-aware transition post-pass. Default ON -
        // the full scheme is the deliverable. Opt out with
        // transitionScheme:"none". Never aborts the apply: a placed
        // timeline with no transitions is still useful, so post-pass
        // failures are reported, not fatal.
        let transitions;
        const scheme = input.transitionScheme || "energy_aware";
        if (scheme !== "none" && placed.length >= 1) {
            const cfg = {
                durationSec:     input.transitionDurationSec || 0.5,
                highEnergyThresh: input.highEnergyThresh != null
                                  ? input.highEnergyThresh : 0.6,
                lowEnergyThresh:  input.lowEnergyThresh != null
                                  ? input.lowEnergyThresh : 0.35,
                energyDropThresh: input.energyDropThresh != null
                                  ? input.energyDropThresh : 0.2,
                dissolveQuery:   input.dissolveQuery || "cross dissolve",
                dipQuery:        input.dipQuery || "dip to black",
                introFade:       input.introFade !== false,
                outroFade:       input.outroFade !== false
            };
            try {
                transitions = await runTransitionPostPass(
                    sorted, placed, offset, trackIndex, cfg);
            } catch (e) {
                transitions = { ok: false,
                    error: "POST_PASS_THREW",
                    message: (e && e.message) || String(e) };
            }
        }

        // Surface the honest gap shot list through the apply step so
        // the panel can show it next to the placed timeline. Gaps are
        // real (Premiere leaves them since the next chunk's beat is
        // past the short clip's end) - not papered over.
        const filledChunks = new Set(
            fillersPlaced.map((f) => f.chunkIndex));
        const gaps = sorted
            .filter((c) => c.recommendation)
            .map((c) => ({
                chunkIndex:  c.chunkIndex,
                atSec:       +((c.startSec || 0) + offset).toFixed(3),
                deficitSec:  c.deficitSec || 0,
                filled:      filledChunks.has(c.chunkIndex),
                recommendation: c.recommendation
            }));

        return {
            ok: errors.length === 0,
            placed:           placed.length,
            failed:           errors.length,
            totalChunks:      sorted.length,
            gapCount:         gaps.length,
            gaps:             gaps.length ? gaps : undefined,
            gapFillerName:    gapFillerName || undefined,
            gapsFilled:       fillersPlaced.length,
            fillersPlaced:    fillersPlaced.length
                              ? fillersPlaced : undefined,
            fillerErrors:     fillerErrors.length
                              ? fillerErrors : undefined,
            trackIndex,
            timelineOffsetSec: offset,
            clearedV1:        clearFirst,
            clearResult:      clearFirst ? clearResult : undefined,
            errors:           errors.length ? errors : undefined,
            transitions
        };
    }

    globalThis.PremBotVision = {
        analyzeClip,
        autoArrangeClips,
        applyArrangement,
        resolveClipSource
    };
})();
