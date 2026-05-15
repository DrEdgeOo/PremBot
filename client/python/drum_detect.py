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
#   snare  - 150-1500 Hz: snare body resonance + low wire buzz.
#            Deliberately NARROWER than a "broadband transient"
#            detector would be - the snare high end overlaps the
#            hi-hat band and causes double-counts on bright kits.
#   hihat  - 5-12 kHz: cymbal/hi-hat content above where snare
#            body energy lives. Needs SR >= ~25 kHz to fit.
BANDS = {
    "kicks":  (20.0,    150.0),
    "snares": (150.0,   1500.0),
    "hihats": (5000.0, 12000.0),
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
            onset_frames = librosa.onset.onset_detect(
                onset_envelope=onset_env, sr=sr,
                units="frames", backtrack=False)
            times = librosa.frames_to_time(
                onset_frames, sr=sr).tolist()
            times = [round(float(t), 4) for t in times]
            results[stream_name] = times[:max_per_stream]
            per_stream[stream_name] = {
                "bandHz": [lo, hi],
                "count": len(results[stream_name]),
                "totalDetected": len(times),
                "meanOnsetStrength": float(np.mean(onset_env))
                    if onset_env.size else 0.0,
                "maxOnsetStrength": float(np.max(onset_env))
                    if onset_env.size else 0.0
            }

        total = sum(len(v) for v in results.values())
        # Confidence: how dense were the onsets relative to "any
        # percussive music." A 60-sec drum-bearing clip typically
        # produces >=120 onsets across all three streams (kick +
        # snare on every beat + hats on every 8th = 120 hits at
        # 120 BPM). Sparse = ambient / orchestral / non-percussive.
        expected_per_min = 120.0
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
