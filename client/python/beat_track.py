#!/usr/bin/env python3
"""PremBot beat detector backed by librosa.

Spawned by the CEP helper (client/js/bridge.js) as a one-shot per
detect_beats call. Reads a WAV path from argv[1], writes JSON to
stdout. Stays small + dependency-light on purpose - the CEP helper
parses stdout, so anything printed elsewhere will break parsing.

Returns the same shape uxp/audio.js' built-in detector returns, so
the agent's confidence/verdict/risks gating works identically. Only
the underlying tempo + beat times come from librosa.beat.beat_track
instead of our energy-difference + autocorrelation fallback.
"""

import json
import sys
import warnings


def emit(obj):
    # stdout-only JSON. Anything on stderr is captured separately by
    # the Node parent for diagnostics.
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "MISSING_PATH",
              "message": "Usage: beat_track.py <wav_path>"})
        return 1

    src = sys.argv[1]

    # Imports inside main so the CLI surfaces a clear "library missing"
    # error instead of an opaque ImportError at module load. UXP/Node
    # passes through to the user, who needs to run pip install.
    try:
        import numpy as np
        import librosa
    except ImportError as e:
        emit({
            "ok": False,
            "error": "LIBROSA_NOT_INSTALLED",
            "message": str(e),
            "hint": "Run:  pip install librosa numpy\n"
                    "or:   python -m pip install --user librosa numpy\n"
                    "Then re-open the PremBot Helper panel in Premiere."
        })
        return 2

    try:
        warnings.filterwarnings("ignore")

        # 22050 Hz mono is librosa's default for beat tracking. Plenty
        # of resolution for tempo + onset detection; cuts decode time.
        y, sr = librosa.load(src, sr=22050, mono=True)
        duration = float(len(y)) / float(sr)

        # Onset envelope: spectral flux with median aggregation -
        # robust to wide-band noise. This is the input to the DP beat
        # tracker. We also reuse it below for beat-vs-offbeat scoring.
        onset_env = librosa.onset.onset_strength(
            y=y, sr=sr, aggregate=np.median)

        # start_bpm biases tempo estimation. librosa's default is 120,
        # which makes it pick the doubled tempo on slow music (80 BPM
        # ballads detect as 160 because 160 is "closer to 120" in
        # log-space than 80). Caller can pass a hint - 80 for ballad/
        # worship, 95 for hip-hop, 125 for dance, 140 for trance/DnB.
        start_bpm = 120.0
        if len(sys.argv) > 3:
            try:
                hint = float(sys.argv[3])
                if hint > 0:
                    start_bpm = hint
            except (ValueError, TypeError):
                pass

        tempo_raw, beat_times = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, units="time",
            start_bpm=start_bpm)
        # librosa >= 0.10 returns tempo as a 1-element ndarray; older
        # versions return a scalar. Coerce.
        if hasattr(tempo_raw, "__len__"):
            bpm = float(tempo_raw[0]) if len(tempo_raw) else 0.0
        else:
            bpm = float(tempo_raw)

        if bpm <= 0 or len(beat_times) == 0:
            emit({"ok": False, "error": "NO_BEATS",
                  "message": "librosa returned 0 beats / 0 BPM.",
                  "bpm": bpm, "beatCount": int(len(beat_times))})
            return 3

        # Beat-vs-offbeat energy ratio - same metric uxp/audio.js
        # uses for its built-in detector. We compute it here so the
        # agent's verdict logic is identical for both engines.
        hop = 512  # librosa default for onset_strength
        onset_rate = float(sr) / float(hop)
        win = max(1, int(round(0.05 * onset_rate)))  # +/- 50ms

        def max_in_window(center):
            lo = max(0, center - win)
            hi = min(len(onset_env), center + win + 1)
            if hi <= lo:
                return 0.0
            return float(onset_env[lo:hi].max())

        beat_frames = (beat_times * onset_rate).astype(int)
        beat_energies = [max_in_window(int(bf)) for bf in beat_frames]
        beat_mean = float(np.mean(beat_energies)) if beat_energies else 0.0

        off_frames = [(int(beat_frames[i]) + int(beat_frames[i + 1])) // 2
                      for i in range(len(beat_frames) - 1)]
        off_energies = [max_in_window(of) for of in off_frames]
        off_mean = float(np.mean(off_energies)) if off_energies else 1.0

        if off_mean > 0:
            beat_vs_off = beat_mean / off_mean
        else:
            beat_vs_off = 99.0 if beat_mean > 0 else 1.0

        # Confidence: dominated by beat-vs-off ratio (the metric that
        # actually answers "is the grid right"). librosa's DP beat
        # tracker is robust enough that we lean on this single signal
        # more than the JS detector does.
        c_beat = max(0.0, min(1.0, (beat_vs_off - 1.0) / 1.5))
        confidence = c_beat * 0.85 + 0.15  # min 0.15 for "we got a result"

        verdict = ("trust" if confidence >= 0.7
                   else ("preview_first" if confidence >= 0.5
                         else "do_not_commit"))

        risks = []
        if confidence < 0.5:
            risks.append("weak_lock: confidence < 0.5 - do NOT commit "
                         "to cuts without previewing first via mark_beats.")
        if beat_vs_off < 0.95:
            risks.append(
                "phase_inverted: off-beats are stronger than on-beats "
                "(ratio %.2f). librosa may have locked to the up-beat - "
                "shift beats by half a period." % beat_vs_off)
        elif beat_vs_off < 1.2:
            risks.append(
                "flat_grid: beats and off-beats nearly equal in energy "
                "(ratio %.2f). The track may lack a clear pulse." % beat_vs_off)

        max_beats = 256
        try:
            cap = int(sys.argv[2]) if len(sys.argv) > 2 else max_beats
            if cap > 0:
                max_beats = cap
        except (ValueError, TypeError):
            pass
        beats_capped = [round(float(b), 4)
                        for b in beat_times[:max_beats].tolist()]

        emit({
            "ok": True,
            "decoder": "librosa",
            "filePath": src,
            "sampleRate": int(sr),
            "durationSec": round(duration, 3),
            "bpm": round(bpm, 2),
            "periodSec": round(60.0 / bpm, 4),
            "beatCount": len(beats_capped),
            "totalBeatsInSong": int(len(beat_times)),
            "beats": beats_capped,
            "confidence": round(confidence, 3),
            "quality": {
                "beatVsOffRatio": round(beat_vs_off, 3),
                "engine": "librosa.beat.beat_track",
                "librosaVersion": getattr(librosa, "__version__", "?"),
                "startBpmUsed": start_bpm
            },
            "verdict": verdict,
            "risks": risks
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
