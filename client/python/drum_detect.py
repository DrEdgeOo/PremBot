#!/usr/bin/env python3
"""PremBot per-instrument drum detector backed by librosa + scipy.

Spawned by the CEP helper (client/js/bridge.js) as a one-shot per
detect_drums call. Reads a WAV path from argv[1], writes JSON to
stdout. Stays small + dependency-light on purpose - the CEP helper
parses stdout, so anything printed elsewhere will break parsing.

Where beat_track.py answers "where is the pulse," drum_detect.py
answers "where is each instrument" - returns kick / snare / hi-hat
onsets separately so the agent can cut on a specific stream
(snares only = backbeat editing; kicks only = four-on-the-floor;
hi-hats only = double-time energy cuts).

Detection: scipy bandpass per drum, then librosa.onset.onset_detect
on each filtered signal. Bands are tuned so a single snare hit
doesn't simultaneously fire the snare AND hi-hat streams (snare
high end is capped below the hi-hat band).
"""

import json
import sys
import warnings


def emit(obj):
    # stdout-only JSON. Anything on stderr is captured separately by
    # the Node parent for diagnostics.
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


# Frequency bands (Hz) where each drum's onset energy dominates.
#   kick   - 20-150 Hz: fundamental + first harmonic of acoustic
#            and synth kicks. Bottoms out around 20 Hz (subkicks);
#            the 150 Hz cap keeps tom hits out.
#   snare  - 1500-4000 Hz: the snare wire SNAP region, not the body.
#            We deliberately AVOID 150-1500 Hz: on heavy / mid-y
#            kicks (typical of hip-hop, classic rock, Rick Rubin
#            era production) the kick body has more energy in
#            150-1500 Hz than the snare body does, so a snare-
#            "body" detector turns into a noisy kick detector
#            (verified empirically: 96% of "snares" coincided
#            with kicks within 15ms on Beastie Boys "No Sleep
#            Till Brooklyn"). The wire snap at 1500-4000 Hz is
#            much more snare-specific - kicks rarely have
#            prominent beater click in that range.
#   hihat  - 5-12 kHz: cymbal/hi-hat content above where snare
#            snap energy lives. Needs SR >= ~25 kHz to fit.
BANDS = {
    "kicks":  (20.0,    150.0),
    "snares": (1500.0,  4000.0),
    "hihats": (5000.0, 12000.0),
}


# Minimum frames between consecutive onsets on the SAME stream.
# Hard-floor for musical plausibility: at librosa's default
# hop_length=512 over sr=44100, each frame is ~11.6 ms, so:
#   kicks  wait=10  -> ~116 ms gap (max ~516 hits/min - covers
#                      busy hip-hop kick patterns, e.g. trap-style
#                      16th-note kicks)
#   snares wait=18  -> ~209 ms gap (max ~287 hits/min - allows
#                      backbeat plus 16th-note fills, but kills
#                      ghost-note over-detection)
#   hihats wait=5   -> ~58 ms gap (max ~1034 hits/min - allows
#                      32nd-note hats at fast tempos)
# Without this, librosa's default wait=0 fires on every transient
# bump in the onset envelope including decay rebounds and ghost
# notes, producing 2-3x too many onsets for typical drum tracks.
WAIT_FRAMES = {
    "kicks":  10,
    "snares": 18,
    "hihats":  5,
}


# Per-stream minimum delta (onset-strength prominence above local
# mean). librosa's default 0.07 is tuned for melodic content and
# fires on weak transients - too permissive for drums. We use
# max(per-stream floor, 0.5 * mean_band_strength), so the floor
# kicks in on quiet bands where the dynamic scaling underflows.
#
# Empirically tuned:
#   kicks  0.15 - kick band is broad-energy (the bass guitar
#                 contributes even on a drums stem), so the mean
#                 is small (~0.1) and dynamic scaling underflows
#                 the old 0.07 floor. 0.15 cuts kick over-
#                 detection without missing real hits.
#   snares 0.15 - snap region is sparse + spiky; a higher floor
#                 prevents weak cymbal bleed from registering as
#                 snares.
#   hihats 0.10 - hats are inherently busier than kicks/snares
#                 and have moderate-strength transients; the
#                 floor mostly stays out of the way and dynamic
#                 scaling does the work.
DELTA_FLOOR = {
    "kicks":  0.15,
    "snares": 0.15,
    "hihats": 0.10,
}


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "MISSING_PATH",
              "message": "Usage: drum_detect.py <wav_path> "
                         "[max_per_stream] [streams_csv]"})
        return 1

    src = sys.argv[1]

    # Imports inside main so the CLI surfaces a clear "library missing"
    # error instead of an opaque ImportError at module load.
    try:
        import numpy as np
        import librosa
        from scipy.signal import butter, sosfiltfilt
    except ImportError as e:
        emit({
            "ok": False,
            "error": "LIBROSA_NOT_INSTALLED",
            "message": str(e),
            "hint": "Run:  pip install librosa numpy scipy\n"
                    "or:   python -m pip install --user librosa numpy scipy\n"
                    "Then re-open the PremBot Helper panel in Premiere."
        })
        return 2

    # Cap on onsets returned per stream (kicks / snares / hi-hats).
    # Truncates the tail of long files; the helper still sees the
    # full duration / counts metadata.
    max_per_stream = 256
    if len(sys.argv) > 2:
        try:
            cap = int(sys.argv[2])
            if cap > 0:
                max_per_stream = cap
        except (ValueError, TypeError):
            pass

    # Streams subset: "all" or "kicks,snares" etc. Skipping streams
    # saves one bandpass + onset_detect per skipped stream (~50ms
    # each on a 60-sec clip).
    wanted = set(BANDS.keys())
    if len(sys.argv) > 3:
        raw = (sys.argv[3] or "").strip().lower()
        if raw and raw != "all":
            wanted = set(s.strip() for s in raw.split(",") if s.strip())
            wanted &= set(BANDS.keys())
            if not wanted:
                wanted = set(BANDS.keys())

    try:
        warnings.filterwarnings("ignore")

        # 44100 Hz (not 22050 like beat_track.py) - we need headroom
        # for the 5-12 kHz hi-hat band; 22050 has Nyquist at 11025
        # which clips the top of the hi-hat band.
        sr_target = 44100
        y, sr = librosa.load(src, sr=sr_target, mono=True)
        duration = float(len(y)) / float(sr)

        def bandpass(sig, lo_hz, hi_hz, order=4):
            nyq = sr * 0.5
            lo = max(20.0, lo_hz) / nyq
            hi = min(nyq - 100.0, hi_hz) / nyq
            if hi <= lo:
                # Degenerate band (e.g. asked for hi-hats at SR < 25k).
                return sig * 0.0
            sos = butter(order, [lo, hi], btype="band", output="sos")
            return sosfiltfilt(sos, sig)

        per_stream = {}
        results = {}
        for stream_name in ("kicks", "snares", "hihats"):
            if stream_name not in wanted:
                results[stream_name] = []
                per_stream[stream_name] = {"skipped": True}
                continue
            lo, hi = BANDS[stream_name]
            y_band = bandpass(y, lo, hi)
            onset_env = librosa.onset.onset_strength(y=y_band, sr=sr)

            mean_strength = (float(np.mean(onset_env))
                             if onset_env.size else 0.0)
            max_strength = (float(np.max(onset_env))
                            if onset_env.size else 0.0)

            # delta: minimum prominence above local mean for a frame
            # to count as an onset. librosa's default (0.07) is tuned
            # for melodic content and fires on every transient bump
            # in a drum band - including ghost notes, decay rebounds,
            # and bleed from adjacent instruments. Scaling delta by
            # the band's own mean energy makes the threshold adapt
            # to the track; per-stream DELTA_FLOOR kicks in on quiet
            # bands where the dynamic scaling would underflow.
            delta = max(DELTA_FLOOR.get(stream_name, 0.07),
                        0.5 * mean_strength)

            # wait: minimum frames between consecutive onsets on this
            # stream. Per-band defaults (see WAIT_FRAMES) cap the max
            # plausible hit rate per instrument; this is the single
            # biggest lever for cleaning up over-detection.
            wait = WAIT_FRAMES.get(stream_name, 0)

            onset_frames = librosa.onset.onset_detect(
                onset_envelope=onset_env, sr=sr,
                units="frames", backtrack=False,
                delta=delta, wait=wait)
            times = librosa.frames_to_time(
                onset_frames, sr=sr).tolist()
            times = [round(float(t), 4) for t in times]
            results[stream_name] = times[:max_per_stream]
            per_stream[stream_name] = {
                "bandHz": [lo, hi],
                "count": len(results[stream_name]),
                "totalDetected": len(times),
                "meanOnsetStrength": mean_strength,
                "maxOnsetStrength": max_strength,
                "delta": round(delta, 4),
                "waitFrames": wait,
            }

        total = sum(len(v) for v in results.values())
        # Confidence: how dense were the onsets relative to "any
        # percussive music." A clean 60-sec drum-bearing clip
        # typically produces ~40 hits per active stream per minute
        # (kicks on every beat at 120 BPM = 120/min ... but most
        # tracks aren't 4-on-the-floor, so 40 is a conservative
        # lower bar). Scale the baseline by the number of active
        # streams so single-stream calls (streams="kicks") aren't
        # penalized for returning less data than all-streams calls.
        n_active = max(1, len(wanted))
        expected_per_min = 40.0 * n_active
        seen_per_min = (total / max(duration, 0.001)) * 60.0
        confidence = max(0.0, min(1.0, seen_per_min / expected_per_min))

        verdict = ("trust" if confidence >= 0.7
                   else ("preview_first" if confidence >= 0.4
                         else "do_not_commit"))

        risks = []
        for sname in ("kicks", "snares", "hihats"):
            if sname not in wanted:
                continue
            if not results[sname]:
                risks.append(
                    "empty_stream:" + sname + ": detected 0 onsets in "
                    "the " + sname + " band ({}-{} Hz). The track may "
                    "lack that instrument, OR the band tuning is wrong "
                    "for this kit. Audition the OTHER streams with "
                    "mark_beats before cutting.".format(
                        int(BANDS[sname][0]), int(BANDS[sname][1])))
        if confidence < 0.4:
            risks.append(
                "sparse_onsets: very few drum hits found across all "
                "active streams ({} total in {:.1f}s = {:.0f}/min). "
                "The track may be non-percussive (ambient, orchestral, "
                "vocal-only) or heavily compressed - do NOT commit to "
                "cuts based on these onsets.".format(
                    total, duration, seen_per_min))

        emit({
            "ok": True,
            "decoder": "librosa+scipy",
            "filePath": src,
            "sampleRate": int(sr),
            "durationSec": round(duration, 3),
            "kicks":  results["kicks"],
            "snares": results["snares"],
            "hihats": results["hihats"],
            "counts": {k: len(v) for k, v in results.items()},
            "perStream": per_stream,
            "confidence": round(confidence, 3),
            "verdict": verdict,
            "risks": risks,
            "quality": {
                "engine": "librosa.onset.onset_detect + scipy bandpass",
                "librosaVersion": getattr(librosa, "__version__", "?"),
                "onsetsPerMin": round(seen_per_min, 1)
            }
        })
        return 0

    except FileNotFoundError as e:
        emit({"ok": False, "error": "SRC_NOT_FOUND",
              "message": str(e)})
        return 4
    except Exception as e:
        emit({"ok": False, "error": "LIBROSA_FAILED",
              "exceptionType": type(e).__name__,
              "message": str(e)})
        return 5


if __name__ == "__main__":
    sys.exit(main())
