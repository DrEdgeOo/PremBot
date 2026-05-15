// PremBot audio module: levels / fades / ducking + beat detection.
//
// Two largely-independent concerns share this file:
//
//   1. Level operations (set gain, fade in/out, duck under dialog) -
//      route through the CEP helper to ExtendScript, which writes
//      Volume->Level on the audio TrackItem. UXP has no DOM path for
//      writing audio levels in this Premiere build.
//
//   2. Beat detection - pure UXP. Reads a music file off disk
//      (file:// localFileSystem like transcripts.js), decodes via
//      OfflineAudioContext.decodeAudioData when UXP provides it, or
//      via the built-in WAV parser as a guaranteed fallback. Onset
//      detection is energy-difference (no FFT needed for music with
//      clear percussion). BPM via autocorrelation of the onset
//      envelope, beats via phase-locked grid search.
//
// Exposes globalThis.PremBotAudio used by uxp/agent.js.

(function () {
    const uxp = require("uxp");
    const fs  = uxp.storage.localFileSystem;
    const formats = uxp.storage.formats;

    // ---- Filesystem helpers (mirror transcripts.js conventions) ----

    function fileUrlFromPath(p) {
        let s = String(p).replace(/\\/g, "/");
        if (/^[a-zA-Z]:\//.test(s)) s = "/" + s;
        else if (!s.startsWith("/")) s = "/" + s;
        return "file://" + s;
    }
    function basename(p) {
        const m = String(p).replace(/\\/g, "/").split("/");
        return m[m.length - 1] || p;
    }
    function extOf(p) {
        return (basename(p).split(".").pop() || "").toLowerCase();
    }

    async function readFileBytes(filePath) {
        const url = fileUrlFromPath(filePath);
        const entry = await fs.getEntryWithUrl(url);
        const data  = await entry.read({ format: formats.binary });
        // entry.read returns an ArrayBuffer in binary format.
        return data;
    }

    // ---- WAV decoder ------------------------------------------------
    //
    // Parses canonical RIFF WAVE (PCM 8/16/24/32-bit and IEEE float
    // 32-bit). Skips unknown chunks (LIST, fact, bext, ...). Returns
    // { sampleRate, channels, samples: Float32Array (mono mix), duration }.

    function decodeWav(arrayBuffer) {
        const dv = new DataView(arrayBuffer);
        if (dv.byteLength < 44) {
            throw new Error("WAV too short (" + dv.byteLength + " bytes)");
        }
        const tag = (off) => String.fromCharCode(
            dv.getUint8(off), dv.getUint8(off+1),
            dv.getUint8(off+2), dv.getUint8(off+3));
        if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
            throw new Error("Not a RIFF/WAVE file (tag=" + tag(0)
                + "/" + tag(8) + ")");
        }

        let off = 12;
        let fmt = null;
        let dataOff = -1, dataLen = 0;
        while (off + 8 <= dv.byteLength) {
            const id   = tag(off);
            const size = dv.getUint32(off + 4, true);
            if (id === "fmt ") {
                fmt = {
                    audioFormat:   dv.getUint16(off + 8,  true),
                    channels:      dv.getUint16(off + 10, true),
                    sampleRate:    dv.getUint32(off + 12, true),
                    bitsPerSample: dv.getUint16(off + 22, true)
                };
            } else if (id === "data") {
                dataOff = off + 8;
                dataLen = size;
                break;
            }
            // Chunks are word-aligned: pad to even length.
            off += 8 + size + (size & 1);
        }
        if (!fmt) throw new Error("WAV: no fmt chunk");
        if (dataOff < 0) throw new Error("WAV: no data chunk");

        const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
        const bytesPerSample = bitsPerSample / 8;
        const frameSize = bytesPerSample * channels;
        const numFrames = Math.floor(dataLen / frameSize);
        const samples = new Float32Array(numFrames);

        // Decode + downmix to mono in one pass. Sample formats:
        //   audioFormat 1 = PCM (8/16/24/32-bit)
        //   audioFormat 3 = IEEE float (32-bit)
        //   audioFormat 0xFFFE = WAVE_FORMAT_EXTENSIBLE (use subformat)
        // For extensible we trust bitsPerSample + audioFormat heuristics.
        for (let f = 0; f < numFrames; f++) {
            let mix = 0;
            for (let c = 0; c < channels; c++) {
                const p = dataOff + f * frameSize + c * bytesPerSample;
                let v;
                if (audioFormat === 3 && bitsPerSample === 32) {
                    v = dv.getFloat32(p, true);
                } else if (bitsPerSample === 16) {
                    v = dv.getInt16(p, true) / 32768;
                } else if (bitsPerSample === 24) {
                    const b0 = dv.getUint8(p);
                    const b1 = dv.getUint8(p + 1);
                    const b2 = dv.getInt8(p + 2);
                    v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
                } else if (bitsPerSample === 32) {
                    v = dv.getInt32(p, true) / 2147483648;
                } else if (bitsPerSample === 8) {
                    // 8-bit PCM is unsigned in WAV.
                    v = (dv.getUint8(p) - 128) / 128;
                } else {
                    throw new Error("Unsupported bitsPerSample: " + bitsPerSample);
                }
                mix += v;
            }
            samples[f] = mix / channels;
        }
        return {
            sampleRate, channels,
            samples,
            duration: numFrames / sampleRate,
            format: audioFormat === 3 ? "ieee_float" : "pcm",
            bitsPerSample
        };
    }

    // ---- Native decode path (any codec UXP/Premiere knows) ---------
    //
    // Modern UXP runtimes expose Web Audio's OfflineAudioContext, which
    // routes through the host's codec stack (MP3, AAC/M4A, WAV, FLAC).
    // We try this first; if the constructor is missing, the caller
    // falls back to decodeWav() for .wav inputs.

    async function tryNativeDecode(arrayBuffer) {
        // OfflineAudioContext is the safe choice: it doesn't open any
        // audio output, just decodes to PCM buffers in-memory. Some
        // environments expose webkitOfflineAudioContext only.
        const Ctor = (typeof OfflineAudioContext !== "undefined")
            ? OfflineAudioContext
            : (typeof webkitOfflineAudioContext !== "undefined")
                ? webkitOfflineAudioContext : null;
        if (!Ctor) {
            const err = new Error("OfflineAudioContext unavailable in UXP");
            err.code = "NO_NATIVE_DECODER";
            throw err;
        }
        // 1 channel, 1 sample, 44100Hz placeholder context - we only
        // need decodeAudioData which doesn't care about ctx config.
        const ctx = new Ctor(1, 1, 44100);
        const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const numFrames = buf.length;
        const samples = new Float32Array(numFrames);
        // Downmix to mono.
        for (let c = 0; c < buf.numberOfChannels; c++) {
            const ch = buf.getChannelData(c);
            for (let i = 0; i < numFrames; i++) samples[i] += ch[i];
        }
        if (buf.numberOfChannels > 1) {
            const k = 1 / buf.numberOfChannels;
            for (let i = 0; i < numFrames; i++) samples[i] *= k;
        }
        return {
            sampleRate: buf.sampleRate, channels: buf.numberOfChannels,
            samples, duration: buf.duration,
            format: "native_decode",
            bitsPerSample: 32
        };
    }

    // Decode any supported file. Tries native first (handles MP3, M4A,
    // WAV, AAC, FLAC - whatever the host has codecs for). Falls back to
    // the built-in WAV parser for .wav so beat detection still works
    // when OfflineAudioContext isn't exposed.
    async function decodeAudioFile(filePath) {
        const buf = await readFileBytes(filePath);
        let nativeErr = null;
        try {
            const r = await tryNativeDecode(buf);
            return { decoder: "native", ...r };
        } catch (e) {
            nativeErr = e && (e.message || String(e));
        }
        if (extOf(filePath) === "wav") {
            const r = decodeWav(buf);
            return { decoder: "builtin_wav", ...r, nativeErr };
        }
        // No fallback for compressed formats. Surface the ffmpeg hint -
        // matches the convention transcripts.js uses for >25MB files.
        const stem = filePath.replace(/\.[^.\\/]+$/, "");
        const wavOut = stem + ".wav";
        const e = new Error("Cannot decode " + basename(filePath)
            + ". UXP's OfflineAudioContext is unavailable on this build "
            + "(" + nativeErr + ") and only .wav has a built-in fallback. "
            + "Extract a WAV with ffmpeg:\n"
            + "  ffmpeg -i \"" + filePath + "\" -ac 1 -ar 22050 \""
            + wavOut + "\"\n"
            + "then retry with that path.");
        e.code = "NO_DECODER";
        e.suggestedWavPath = wavOut;
        throw e;
    }

    // ---- Beat detection ---------------------------------------------
    //
    // Energy-onset detector with autocorrelation BPM estimate and
    // phase-locked grid beat extraction. Good for music with a clear
    // percussive pulse - which is everything music videos / trailers /
    // viral edits use. Stems with strong sub-bass kick + snare track
    // get >95% beat accuracy; ambient / drone tracks degrade.

    const ONSET_RATE_HZ = 100; // 10ms hop - one onset value per 10ms

    // Compute frame-energy difference (positive only) as the onset
    // function. We sub-sample to 22.05kHz internally so total memory
    // stays under a couple MB even for full songs.
    function computeOnsetFunction(samples, sampleRate) {
        const hop = Math.max(1, Math.floor(sampleRate / ONSET_RATE_HZ));
        const numFrames = Math.floor(samples.length / hop);
        // RMS per hop window.
        const energy = new Float32Array(numFrames);
        for (let f = 0; f < numFrames; f++) {
            const s = f * hop;
            const e = Math.min(s + hop, samples.length);
            let sum = 0;
            for (let i = s; i < e; i++) sum += samples[i] * samples[i];
            energy[f] = Math.sqrt(sum / (e - s));
        }
        // Take log-compressed positive differences. Log compression
        // makes percussion onsets stand out over sustained mids.
        const onset = new Float32Array(numFrames);
        for (let f = 1; f < numFrames; f++) {
            const a = Math.log(1 + energy[f] * 1000);
            const b = Math.log(1 + energy[f - 1] * 1000);
            const d = a - b;
            if (d > 0) onset[f] = d;
        }
        // Subtract a local moving average so we get a near-zero baseline.
        const winSize = Math.max(1, Math.round(ONSET_RATE_HZ * 0.5));
        const smoothed = new Float32Array(numFrames);
        let running = 0;
        for (let f = 0; f < numFrames; f++) {
            running += onset[f];
            if (f >= winSize) running -= onset[f - winSize];
            const avg = running / Math.min(f + 1, winSize);
            smoothed[f] = Math.max(0, onset[f] - avg);
        }
        return { onset: smoothed, energy, hop, onsetRate: ONSET_RATE_HZ };
    }

    // Autocorrelate the onset function across plausible beat lags.
    // bpmMin/bpmMax restrict the search; we also score double/half tempos
    // and pick the harmonically-grounded peak rather than the first one,
    // since pure autocorrelation often favors the half-tempo at slow
    // hop rates.
    function estimateBpm(onset, onsetRate, bpmMin, bpmMax) {
        bpmMin = bpmMin || 70;
        bpmMax = bpmMax || 180;
        const minLag = Math.max(1, Math.floor(60 * onsetRate / bpmMax));
        const maxLag = Math.floor(60 * onsetRate / bpmMin);
        const corr = new Float32Array(maxLag - minLag + 1);
        for (let lag = minLag; lag <= maxLag; lag++) {
            let sum = 0;
            const n = onset.length - lag;
            for (let i = 0; i < n; i++) sum += onset[i] * onset[i + lag];
            corr[lag - minLag] = sum / Math.max(1, n);
        }
        // Find the strongest peak, then double-check that lag/2 isn't
        // a stronger candidate (which would mean we locked onto the
        // half-tempo). Within ±5% lag for the harmonic check.
        let bestIdx = 0, bestVal = -1;
        for (let i = 0; i < corr.length; i++) {
            if (corr[i] > bestVal) { bestVal = corr[i]; bestIdx = i; }
        }
        const bestLag = bestIdx + minLag;
        let chosenLag = bestLag;
        const halfLag = Math.round(bestLag / 2);
        if (halfLag >= minLag) {
            const halfIdx = halfLag - minLag;
            if (halfIdx >= 0 && halfIdx < corr.length
                && corr[halfIdx] > bestVal * 0.85) {
                // Half-tempo correlates almost as well -> the real beat
                // is faster. Prefer the faster (more cuts!) interpretation
                // for music-video editing.
                chosenLag = halfLag;
            }
        }
        return {
            bpm: 60 * onsetRate / chosenLag,
            lag: chosenLag,
            originalLag: bestLag,
            score: bestVal
        };
    }

    // Given onset function + chosen lag (beat period in frames), find
    // the phase offset whose grid of beats best aligns with onset peaks.
    function pickBeats(onset, onsetRate, lagFrames, totalDurationSec) {
        const beatFrames = lagFrames;
        const search = Math.max(1, Math.round(beatFrames));
        let bestPhase = 0, bestScore = -1;
        for (let phase = 0; phase < search; phase++) {
            let score = 0;
            for (let t = phase; t < onset.length; t += beatFrames) {
                const ft = Math.round(t);
                // ±2 frame tolerance window: peaks rarely land exactly
                // on the beat grid in real recordings.
                let local = 0;
                for (let d = -2; d <= 2; d++) {
                    const idx = ft + d;
                    if (idx >= 0 && idx < onset.length
                        && onset[idx] > local) local = onset[idx];
                }
                score += local;
            }
            if (score > bestScore) { bestScore = score; bestPhase = phase; }
        }
        // Extrapolate to full song duration if onset shorter than audio
        // (we cap onset analysis at 60s by default to stay fast).
        const beats = [];
        const periodSec = beatFrames / onsetRate;
        let t = bestPhase / onsetRate;
        while (t < totalDurationSec) {
            beats.push(+t.toFixed(4));
            t += periodSec;
        }
        return { beats, phase: bestPhase, periodSec };
    }

    // High-level: file → beats + BPM. analyzeSec caps the audio we
    // analyze for BPM estimation (default 60s); beats are then
    // extrapolated across the full duration via the locked phase.
    async function detectBeatsForFile(opts) {
        opts = opts || {};
        const filePath = opts.filePath;
        if (!filePath) {
            return { ok: false, error: "MISSING_FILE_PATH" };
        }
        let decoded;
        try {
            decoded = await decodeAudioFile(filePath);
        } catch (e) {
            return { ok: false, error: e.code || "DECODE_FAILED",
                message: e.message || String(e),
                suggestedWavPath: e.suggestedWavPath };
        }
        const analyzeSec = (typeof opts.analyzeSec === "number"
            && opts.analyzeSec > 0) ? opts.analyzeSec : 60;
        const analyzeFrames = Math.min(decoded.samples.length,
            Math.floor(analyzeSec * decoded.sampleRate));
        const slice = decoded.samples.subarray(0, analyzeFrames);

        const ons = computeOnsetFunction(slice, decoded.sampleRate);
        const bpmMin = opts.bpmMin || 70;
        const bpmMax = opts.bpmMax || 180;
        const tempo = estimateBpm(ons.onset, ons.onsetRate, bpmMin, bpmMax);
        const picked = pickBeats(ons.onset, ons.onsetRate, tempo.lag,
            decoded.duration);

        // Optional cap on beat count returned (large songs at 140 BPM
        // for 4 minutes = ~560 beats; agent context blows up otherwise).
        const maxBeats = opts.maxBeats || 256;
        const beats = picked.beats.length > maxBeats
            ? picked.beats.slice(0, maxBeats) : picked.beats;
        return {
            ok: true,
            filePath,
            decoder: decoded.decoder,
            sampleRate: decoded.sampleRate,
            channels: decoded.channels,
            durationSec: +decoded.duration.toFixed(3),
            analyzedSec: +(analyzeFrames / decoded.sampleRate).toFixed(2),
            bpm: +tempo.bpm.toFixed(2),
            periodSec: +picked.periodSec.toFixed(4),
            beatCount: beats.length,
            totalBeatsInSong: picked.beats.length,
            beats
        };
    }

    // Resolve a clip's audio file via the same convention transcripts.js
    // uses: media folder + several extension/suffix candidates. Returns
    // the first file that exists OR null.
    async function findAudioFileForClip(clipName, mediaFolder) {
        if (!clipName || !mediaFolder) return null;
        const stem = String(clipName).replace(/\.[^.\\/]+$/, "");
        const candidates = [
            stem + "_audio.wav", stem + ".wav",
            stem + "_audio.mp3", stem + ".mp3",
            stem + "_audio.m4a", stem + ".m4a"
        ];
        const sep = mediaFolder.indexOf("\\") >= 0 ? "\\" : "/";
        for (const c of candidates) {
            const path = mediaFolder.replace(/[\\/]+$/, "") + sep + c;
            try {
                const url = fileUrlFromPath(path);
                const entry = await fs.getEntryWithUrl(url);
                if (entry && entry.isFile) return path;
            } catch (e) {}
        }
        return null;
    }

    // ---- Level operations (helper-routed) ---------------------------
    //
    // All level writes go through the CEP helper because UXP can't
    // touch the Volume->Level property. The helper resolves the clip
    // by (trackIndex, currentStartSeconds) just like the Lumetri tools.

    function helperOrError() {
        const helper = globalThis.PremBotHelper;
        if (!helper) {
            return { ok: false, error: "HELPER_NOT_LOADED",
                message: "PremBotHelper not on globalThis - check load order." };
        }
        return helper;
    }

    async function setAudioGain(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        return helper.call("set_audio_gain", {
            trackIndex: input.trackIndex || 0,
            currentStartSeconds: input.currentStartSeconds,
            dB: input.dB
        });
    }

    async function setAudioGainBatch(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        const ti = input.trackIndex || 0;
        const out = [];
        let ok = 0, fail = 0;
        for (const g of (input.gains || [])) {
            const r = await helper.call("set_audio_gain", {
                trackIndex: ti,
                currentStartSeconds: g.currentStartSeconds,
                dB: g.dB
            });
            if (r.ok) ok++; else fail++;
            out.push({ currentStartSeconds: g.currentStartSeconds,
                dB: g.dB, ok: !!r.ok,
                error: r.ok ? undefined : (r.error || "FAIL") });
        }
        return { ok: fail === 0, count: out.length, okCount: ok,
            failCount: fail, results: out };
    }

    async function addAudioFade(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        return helper.call("add_audio_fade", {
            trackIndex: input.trackIndex || 0,
            currentStartSeconds: input.currentStartSeconds,
            side: input.side || "in",
            durationSec: input.durationSec || 1.0
        });
    }

    async function clearAudioKeyframes(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        return helper.call("clear_audio_keyframes", {
            trackIndex: input.trackIndex || 0,
            currentStartSeconds: input.currentStartSeconds
        });
    }

    async function setAudioKeyframes(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        return helper.call("set_audio_keyframes", {
            trackIndex: input.trackIndex || 0,
            currentStartSeconds: input.currentStartSeconds,
            keyframes: input.keyframes || [],
            clearFirst: input.clearFirst !== false
        });
    }

    // ---- Ducking: transcript-driven, A2 under V1 dialog -------------
    //
    // The CEP helper sets keyframes at absolute sequence seconds. For a
    // music clip starting at musicClipStart on A<ducktrack+1>, we need
    // each speech segment that overlaps the music clip's timeline range
    // to map to: ramp DOWN before segment start, hold at duckDb, ramp
    // UP after segment end.
    //
    // Speech segments come from V1's cached transcripts. For each V1
    // clip we read its segments (timeline seconds = clip.start + seg.start).

    async function duckMusicUnderDialog(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        const primitives = globalThis.PremBotPrimitives;
        const transcripts = globalThis.PremBotTranscripts;
        if (!primitives || !transcripts) {
            return { ok: false, error: "MODULES_NOT_LOADED" };
        }
        const musicTrackIndex = (typeof input.musicTrackIndex === "number")
            ? input.musicTrackIndex : 1;     // A2 by default
        const dialogTrackIndex = (typeof input.dialogTrackIndex === "number")
            ? input.dialogTrackIndex : 0;    // V1 by default
        const duckDb = (typeof input.duckDb === "number")
            ? input.duckDb : -12;
        const transitionSec = (typeof input.transitionSec === "number")
            ? input.transitionSec : 0.25;
        const padSec = (typeof input.padSec === "number")
            ? input.padSec : 0.15;
        // Music level outside speech. Caller can pin it (e.g. -3 dB
        // for a "loud music, ducked even lower" cinematic feel) or
        // leave undefined to let us auto-read current levels per clip.
        const baseDbExplicit = (typeof input.baseDb === "number")
            ? input.baseDb : null;

        const list = await primitives.list_timeline_clips();
        const vClips = (list.video || []).filter((c) =>
            c.trackIndex === dialogTrackIndex);
        const aClips = (list.audio || []).filter((c) =>
            c.trackIndex === musicTrackIndex);

        if (aClips.length === 0) {
            return { ok: false, error: "NO_MUSIC_CLIPS",
                message: "A" + (musicTrackIndex + 1) + " is empty - "
                    + "nothing to duck." };
        }

        // Build speech intervals in TIMELINE seconds by mapping each
        // V1 clip's transcript segments (which are in source time, but
        // since extracts are aligned 1:1 with the clip in this codebase
        // we treat them as start-relative).
        const speech = [];
        let missingTranscripts = 0;
        for (const v of vClips) {
            const tx = transcripts.getClipTranscript(v.name);
            if (!tx) { missingTranscripts++; continue; }
            for (const seg of (tx.segments || [])) {
                speech.push({
                    startSec: v.startSeconds + seg.startSec,
                    endSec:   v.startSeconds + seg.endSec
                });
            }
        }
        if (speech.length === 0) {
            return { ok: false, error: "NO_SPEECH_INTERVALS",
                message: "Found 0 transcript segments on V"
                    + (dialogTrackIndex + 1) + ". Call transcribe_v1_clips "
                    + "first.",
                missingTranscripts,
                v1ClipsTotal: vClips.length };
        }

        // Merge overlapping / near-touching speech (gap < 2 * transition)
        // so adjacent words don't get bumpy ducking.
        speech.sort((a, b) => a.startSec - b.startSec);
        const merged = [];
        const minGap = 2 * transitionSec + padSec;
        for (const s of speech) {
            const last = merged[merged.length - 1];
            if (last && s.startSec - last.endSec < minGap) {
                last.endSec = Math.max(last.endSec, s.endSec);
            } else {
                merged.push({ startSec: s.startSec, endSec: s.endSec });
            }
        }

        // Read existing levels so we can preserve user gain-staging
        // when baseDb is not explicitly pinned. Time-varying clips
        // (already keyframed) have null dB - we still overwrite them
        // (re-runnable spec), but log the original value for the report.
        let audioLevels = null;
        if (baseDbExplicit == null) {
            const lvl = await helper.call("list_audio_clips", {});
            if (lvl && lvl.ok) audioLevels = lvl.clips || [];
        }

        function baseDbForClip(m) {
            if (baseDbExplicit != null) return baseDbExplicit;
            if (!audioLevels) return 0;
            const hit = audioLevels.find((c) =>
                c.trackIndex === musicTrackIndex
                && Math.abs(c.startSeconds - m.startSeconds) < 0.05);
            return (hit && typeof hit.dB === "number") ? hit.dB : 0;
        }

        // Per music clip: emit keyframes covering only the segments that
        // overlap its timeline range.
        const perClipReports = [];
        for (const m of aClips) {
            const overlapping = merged.filter((s) =>
                s.endSec > m.startSeconds && s.startSec < m.endSeconds);
            if (overlapping.length === 0) {
                perClipReports.push({ currentStartSeconds: m.startSeconds,
                    skipped: "NO_DIALOG_OVERLAP" });
                continue;
            }
            const baseDb = baseDbForClip(m);
            const kfs = [];
            // Baseline anchor at the clip start (base level).
            kfs.push({ atSec: m.startSeconds + 0.01, dB: baseDb });
            for (const s of overlapping) {
                const downStart = Math.max(m.startSeconds + 0.02,
                    s.startSec - padSec - transitionSec);
                const downEnd   = Math.max(downStart + 0.001,
                    s.startSec - padSec);
                const upStart   = Math.min(m.endSeconds - 0.05,
                    s.endSec + padSec);
                const upEnd     = Math.min(m.endSeconds - 0.02,
                    upStart + transitionSec);
                kfs.push({ atSec: downStart, dB: baseDb });
                kfs.push({ atSec: downEnd,   dB: duckDb });
                kfs.push({ atSec: upStart,   dB: duckDb });
                kfs.push({ atSec: upEnd,     dB: baseDb });
            }
            // Final anchor at the clip end (base level).
            kfs.push({ atSec: m.endSeconds - 0.01, dB: baseDb });

            const r = await helper.call("set_audio_keyframes", {
                trackIndex: musicTrackIndex,
                currentStartSeconds: m.startSeconds,
                keyframes: kfs,
                clearFirst: true
            });
            perClipReports.push({
                currentStartSeconds: m.startSeconds,
                clipName: m.name,
                baseDb: baseDb,
                speechIntervals: overlapping.length,
                keyframes: kfs.length,
                ok: !!r.ok,
                error: r.ok ? undefined : (r.error || "FAIL")
            });
        }
        return {
            ok: perClipReports.every((r) => r.ok || r.skipped),
            musicTrackIndex, dialogTrackIndex,
            duckDb, transitionSec, padSec,
            speechIntervals: merged.length,
            musicClips: perClipReports.length,
            results: perClipReports
        };
    }

    // ---- Beat-driven editing wrappers --------------------------------

    async function resolveBeatSource(input) {
        if (input.filePath) return { ok: true, filePath: input.filePath };
        if (input.clipName) {
            const folder = input.mediaFolder;
            if (!folder) {
                return { ok: false, error: "MISSING_MEDIA_FOLDER",
                    message: "Pass mediaFolder OR set it in Settings." };
            }
            const path = await findAudioFileForClip(input.clipName, folder);
            if (!path) {
                return { ok: false, error: "NO_AUDIO_FOUND",
                    message: "No <" + input.clipName + ">_audio.{wav,mp3,m4a} "
                        + "found in " + folder + "." };
            }
            return { ok: true, filePath: path };
        }
        return { ok: false, error: "MISSING_SOURCE",
            message: "Pass filePath or clipName." };
    }

    async function detectBeats(input) {
        input = input || {};
        const src = await resolveBeatSource(input);
        if (!src.ok) return src;
        return detectBeatsForFile({
            filePath: src.filePath,
            analyzeSec: input.analyzeSec,
            maxBeats: input.maxBeats,
            bpmMin: input.bpmMin, bpmMax: input.bpmMax
        });
    }

    // Offset all detected beats by addSec so they align with where the
    // music sits on the timeline. detect_beats produces times relative
    // to the audio FILE; the timeline offset depends on where the music
    // clip starts and any inPoint.
    function shiftBeats(beats, addSec) {
        return beats.map((b) => +(b + addSec).toFixed(4));
    }

    // Cut V1 at every beat. beats are in TIMELINE seconds. Skips any
    // beat that falls within minIntervalSec of the previous cut to
    // prevent micro-clips.
    async function cutToBeats(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        const beats = (input.beats || []).slice().sort((a, b) => a - b);
        if (beats.length === 0) return { ok: false, error: "NO_BEATS" };
        const minInterval = (typeof input.minIntervalSec === "number")
            ? input.minIntervalSec : 0.2;
        const maxCuts = input.maxCuts || 64;
        const cuts = [];
        let last = -Infinity;
        for (const b of beats) {
            if (b - last < minInterval) continue;
            cuts.push(b);
            last = b;
            if (cuts.length >= maxCuts) break;
        }
        const results = [];
        for (const atSec of cuts) {
            const r = await helper.call("split_clip", { atSec });
            results.push({ atSec, ok: !!r.ok,
                error: r.ok ? undefined : (r.error || r.message || "FAIL") });
        }
        return { ok: true, requested: beats.length,
            applied: cuts.length, results };
    }

    // Drop a marker at every beat. Useful for visual reference before
    // committing to cuts.
    async function markBeats(input) {
        const helper = helperOrError();
        if (helper.ok === false) return helper;
        const beats = input.beats || [];
        const label = input.label || "beat";
        const max = input.maxMarkers || 256;
        const results = [];
        for (let i = 0; i < Math.min(beats.length, max); i++) {
            const r = await helper.call("add_marker", {
                atSec: beats[i],
                label: label + " " + (i + 1),
                markerType: "Comment"
            });
            results.push({ atSec: beats[i], ok: !!r.ok,
                error: r.ok ? undefined : (r.error || "FAIL") });
        }
        return { ok: results.every((r) => r.ok),
            count: results.length, results };
    }

    // Align existing V1 clips to a beat grid. Clips slide forward to
    // the next beat at or after their current start (move_clips is
    // forward-only on this Premiere build). Uses move_clips for the
    // atomic batch behavior.
    async function alignV1ToBeats(input) {
        const primitives = globalThis.PremBotPrimitives;
        if (!primitives) return { ok: false, error: "PRIMITIVES_NOT_LOADED" };
        const beats = (input.beats || []).slice().sort((a, b) => a - b);
        if (beats.length === 0) return { ok: false, error: "NO_BEATS" };
        const trackIndex = input.trackIndex || 0;
        const list = await primitives.list_timeline_clips();
        const clips = (list.video || [])
            .filter((c) => c.trackIndex === trackIndex)
            .sort((a, b) => a.startSeconds - b.startSeconds);
        if (clips.length === 0) {
            return { ok: false, error: "NO_CLIPS_ON_TRACK" };
        }
        // Walk clips and assign each to the next beat after the previous
        // clip's new end (so we don't push two clips onto the same beat
        // and create overlap).
        const moves = [];
        let nextStart = beats[0];
        for (const c of clips) {
            // Find next beat >= max(currentStart, nextStart).
            const target = Math.max(c.startSeconds, nextStart);
            const beat = beats.find((b) => b >= target - 0.005);
            if (typeof beat !== "number") break;
            const dur = c.endSeconds - c.startSeconds;
            if (Math.abs(beat - c.startSeconds) > 0.02) {
                moves.push({
                    currentStartSeconds: c.startSeconds,
                    newStartSeconds: beat
                });
            }
            nextStart = beat + dur;
        }
        if (moves.length === 0) {
            return { ok: true, moves: 0,
                note: "All V1 clips already align to a beat." };
        }
        const r = await primitives.move_clips({ trackIndex, moves });
        return { ok: !!r.ok, plannedMoves: moves.length,
            moveResult: r };
    }

    // ---- Public surface ---------------------------------------------

    globalThis.PremBotAudio = {
        // Decoders / beat detection
        decodeAudioFile,
        detectBeats,
        shiftBeats,
        findAudioFileForClip,

        // Level operations
        setAudioGain, setAudioGainBatch,
        addAudioFade,
        clearAudioKeyframes, setAudioKeyframes,

        // Composite
        duckMusicUnderDialog,
        cutToBeats, markBeats, alignV1ToBeats
    };
})();
