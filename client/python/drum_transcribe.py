#!/usr/bin/env python3
"""PremBot neural drum transcriber backed by madmom.

Where drum_detect.py runs scipy bandpass + librosa onset detection
(which can't tell kick beater click from snare snap in the same
frequency band), drum_transcribe.py runs a recurrent neural network
trained on labeled drum recordings. The network outputs per-frame
probabilities for {kick, snare, hi-hat} and we peak-pick to get
clean event times.

Same JSON shape as drum_detect.py so the UXP side can swap engines
without changing the result-consumer. Caller picks which engine by
calling transcribe_drums (neural) vs detect_drums (bandpass).

Spawned by the CEP helper (client/js/bridge.js) as a one-shot. Reads
argv, writes JSON to stdout. Stays small + dependency-light - the
helper parses stdout, so anything printed elsewhere will break
parsing.
"""

import json
import os
import sys
import time


# Lock stdout to JSON-only the same way stem_separate.py does -
# madmom + its deps occasionally print warnings to stdout that would
# corrupt the JSON parse on the Node side. Capture the real stdout
# and redirect sys.stdout to stderr so emit() is the only thing that
# can write to the JSON channel.
_JSON_STDOUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _JSON_STDOUT.write(json.dumps(obj))
    _JSON_STDOUT.flush()


# Reasonable defaults for peak picking. madmom's typical drum-onset
# threshold sits around 0.5; lower = more sensitive. We expose this
# via argv so the agent can tune per track.
DEFAULT_THRESHOLD = 0.35
DEFAULT_FPS = 100  # madmom's default for drum processors


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "MISSING_PATH",
              "message": "Usage: drum_transcribe.py <audio_path> "
                         "[max_per_stream] [streams_csv] [threshold]"})
        return 1

    src = sys.argv[1]
    if not os.path.exists(src):
        emit({"ok": False, "error": "SRC_NOT_FOUND", "srcPath": src})
        return 1

    max_per_stream = 256
    if len(sys.argv) > 2:
        try:
            cap = int(sys.argv[2])
            if cap > 0:
                max_per_stream = cap
        except (ValueError, TypeError):
            pass

    # Streams subset: "all" or "kicks,snares" etc. Unlike the
    # bandpass detector this doesn't save compute (the network always
    # outputs all 3 channels), it just filters the response.
    wanted = {"kicks", "snares", "hihats"}
    if len(sys.argv) > 3:
        raw = (sys.argv[3] or "").strip().lower()
        if raw and raw != "all":
            wanted = set(s.strip() for s in raw.split(",") if s.strip())
            wanted &= {"kicks", "snares", "hihats"}
            if not wanted:
                wanted = {"kicks", "snares", "hihats"}

    threshold = DEFAULT_THRESHOLD
    if len(sys.argv) > 4:
        try:
            t = float(sys.argv[4])
            if 0.0 < t < 1.0:
                threshold = t
        except (ValueError, TypeError):
            pass

    import traceback
    try:
        import numpy as np
        # madmom 0.16.1 (last PyPI release, 2019) was built before
        # Python 3.10 and imports several abstract-base classes from
        # the top-level `collections` module. Python 3.10+ moved
        # those to `collections.abc` and removed the old names.
        # Patch them back in so madmom's module-load doesn't blow up
        # on Python 3.10+. The github HEAD doesn't fix this either
        # (madmom is unmaintained as of ~2022), so the patch is the
        # only path forward without forking madmom.
        import collections
        import collections.abc
        for _name in ("MutableSequence", "MutableMapping", "MutableSet",
                      "Mapping", "Sequence", "Iterable", "Iterator",
                      "Callable", "Container", "Hashable", "Set",
                      "Sized", "ItemsView", "KeysView", "ValuesView"):
            if (not hasattr(collections, _name)
                    and hasattr(collections.abc, _name)):
                setattr(collections, _name, getattr(collections.abc, _name))

        # Same story for NumPy: madmom 0.16.1 uses the deprecated
        # numpy scalar-type aliases (np.float, np.int, np.bool,
        # np.long, np.object, np.complex, np.str, np.unicode) that
        # NumPy 1.20 deprecated and NumPy 1.24+ removed. The user's
        # Miniconda environment is on NumPy 2.x for demucs / torch
        # compatibility, so downgrading isn't an option. Patch the
        # aliases back to their builtin equivalents - this matches
        # the behavior the aliases ALWAYS had (they were just
        # synonyms for the builtins, never specific dtypes).
        for _alias, _real in (
                ("float",   float),
                ("int",     int),
                ("bool",    bool),
                ("long",    int),
                ("object",  object),
                ("complex", complex),
                ("str",     str),
                ("unicode", str)):
            if not hasattr(np, _alias):
                setattr(np, _alias, _real)
        # NumPy 2.0 also removed np.float_, np.complex_, etc (the
        # underscore-suffixed dtype aliases). Map them to the
        # current explicit-precision dtypes.
        for _alias, _real in (
                ("float_",   "float64"),
                ("complex_", "complex128"),
                ("unicode_", "str_")):
            if not hasattr(np, _alias) and hasattr(np, _real):
                setattr(np, _alias, getattr(np, _real))

        # madmom's drum module ships RNNDrumProcessor (classic, 3
        # channels: kick/snare/hihat) and CRNNDrumProcessor (newer,
        # same 3 channels but conv+recurrent). We prefer CRNN when
        # available - higher accuracy on rock/pop - and fall back to
        # RNN if it's not in this madmom build.
        try:
            from madmom.features.drums import CRNNDrumProcessor as _DrumProc
            _drum_arch = "CRNN"
        except ImportError:
            from madmom.features.drums import RNNDrumProcessor as _DrumProc
            _drum_arch = "RNN"
        from madmom.features.onsets import OnsetPeakPickingProcessor
        import madmom
    except ImportError as e:
        emit({"ok": False, "error": "MADMOM_NOT_INSTALLED",
              "message": str(e),
              "interpreter": sys.executable,
              "traceback": traceback.format_exc(),
              "hint": "madmom isn't installed in THIS interpreter:\n"
                      "  " + sys.executable + "\n"
                      "Install it with the matching pip:\n"
                      "  \"" + sys.executable + "\" -m pip install "
                      "madmom\n"
                      "(pulls numpy, scipy, cython, mido - ~50 MB total).\n"
                      "If pip can't compile cython on Python 3.13+, try:\n"
                      "  \"" + sys.executable + "\" -m pip install "
                      "git+https://github.com/CPJKU/madmom\n"
                      "Then reopen the PremBot Helper panel in Premiere."})
        return 2

    try:
        # Run the drum-transcriber network. madmom's processors accept
        # a file path directly; they handle WAV/MP3/FLAC via internal
        # ffmpeg + soundfile fallbacks. Output is (n_frames, 3) float
        # array of per-frame onset probabilities for the 3 drums.
        t0 = time.time()
        proc = _DrumProc()
        activations = proc(src)
        net_time = time.time() - t0

        if activations.ndim != 2 or activations.shape[1] < 3:
            emit({"ok": False, "error": "UNEXPECTED_ACTIVATIONS_SHAPE",
                  "shape": list(activations.shape),
                  "message": "Expected (n_frames, 3) from drum "
                             "processor, got shape "
                             + str(activations.shape)})
            return 3

        # madmom's drum activations are channel-ordered:
        #   col 0 = kick (bass drum)
        #   col 1 = snare
        #   col 2 = hi-hat (closed + open collapsed)
        channels = {"kicks": 0, "snares": 1, "hihats": 2}
        # Standard madmom drum-onset peak-picker params: pre/post
        # max windows tuned for drum content, smoothing off so we
        # don't blur fast double-hits. fps=100 matches the network's
        # output rate.
        picker = OnsetPeakPickingProcessor(
            threshold=threshold,
            smooth=0.0,
            pre_avg=0.0,
            post_avg=0.0,
            pre_max=0.03,
            post_max=0.03,
            fps=DEFAULT_FPS)

        results = {}
        per_stream = {}
        for sname, col in channels.items():
            if sname not in wanted:
                results[sname] = []
                per_stream[sname] = {"skipped": True}
                continue
            chan_acts = activations[:, col]
            times = picker(chan_acts)
            times = [round(float(t), 4) for t in list(times)]
            results[sname] = times[:max_per_stream]
            per_stream[sname] = {
                "channel": col,
                "count": len(results[sname]),
                "totalDetected": len(times),
                "meanActivation": float(np.mean(chan_acts)),
                "maxActivation": float(np.max(chan_acts)),
                "threshold": threshold,
            }

        sr = 44100  # madmom's default working sample rate
        # madmom's drum networks operate at 100 fps; duration ~=
        # n_frames / 100. We compute it from the actual frame count
        # to stay accurate if the network rate changes.
        duration = float(activations.shape[0]) / float(DEFAULT_FPS)

        # Confidence: same semantics as drum_detect.py - density of
        # onsets per active stream per minute. Neural detection is
        # cleaner so we use a slightly higher baseline (60/min/stream
        # vs the bandpass detector's 40/min/stream) - the network
        # finds REAL hits, not transient bumps.
        total = sum(len(v) for v in results.values())
        n_active = max(1, len(wanted))
        expected_per_min = 60.0 * n_active
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
                    "empty_stream:" + sname + ": the neural drum "
                    "transcriber found 0 " + sname + " events. "
                    "The track may genuinely lack that instrument, "
                    "OR the threshold is too high for this kit - "
                    "try threshold=0.2 on a softly-mixed snare.")
        if confidence < 0.4:
            risks.append(
                "sparse_onsets: very few drum hits across all active "
                "streams ({} total in {:.1f}s = {:.0f}/min). The "
                "track may be non-percussive (ambient, orchestral, "
                "vocal-only) or the threshold is too aggressive. "
                "Try lowering threshold (default {:.2f}).".format(
                    total, duration, seen_per_min, threshold))

        emit({
            "ok": True,
            "engine": "madmom-" + _drum_arch,
            "madmomVersion": getattr(madmom, "__version__", "?"),
            "filePath": src,
            "sampleRate": sr,
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
                "engine": "madmom." + _drum_arch + "DrumProcessor",
                "frameRate": DEFAULT_FPS,
                "transcriptionTimeSec": round(net_time, 2),
                "onsetsPerMin": round(seen_per_min, 1)
            }
        })
        return 0

    except FileNotFoundError as e:
        emit({"ok": False, "error": "SRC_NOT_FOUND",
              "message": str(e)})
        return 4
    except Exception as e:
        emit({"ok": False, "error": "MADMOM_FAILED",
              "exceptionType": type(e).__name__,
              "message": str(e),
              "traceback": traceback.format_exc()})
        return 5


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:
        emit({"ok": False, "error": "PYTHON_UNCAUGHT",
              "message": str(e)})
        sys.exit(99)
