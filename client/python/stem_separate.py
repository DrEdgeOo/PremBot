#!/usr/bin/env python3
"""PremBot stem separator backed by Demucs (htdemucs by default).

Spawned by the CEP helper (client/js/bridge.js) as a one-shot per
separate_stems call. Reads argv, writes JSON to stdout. Anything on
stderr is captured separately by Node; nothing else should hit stdout
or JSON parsing breaks.

Splits a mixed-audio file into 4 stems (vocals / drums / bass / other)
using a Demucs neural model. Caches stems to a caller-supplied out_dir
so repeated calls on the same source skip the expensive separation.
"""

import json
import os
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


# htdemucs always produces exactly these four stems, in this order.
ALL_STEMS = ("vocals", "drums", "bass", "other")


def parse_wanted(csv_arg):
    if not csv_arg or csv_arg.lower() in ("all", "*"):
        return set(ALL_STEMS)
    wanted = set(s.strip().lower()
                 for s in csv_arg.split(",") if s.strip())
    wanted &= set(ALL_STEMS)
    if not wanted:
        return set(ALL_STEMS)
    return wanted


def stem_path(out_dir, basename, stem):
    # Embed the source basename so files dragged into the Premiere bin
    # show up as e.g. "Beastie Boys - No Sleep Till Brooklyn.drums.wav"
    # instead of a generic "drums.wav" that collides across songs.
    return os.path.join(out_dir, basename + "." + stem + ".wav")


def main():
    if len(sys.argv) < 4:
        emit({"ok": False, "error": "MISSING_ARGS",
              "message": "Usage: stem_separate.py <src> <outDir> "
                         "<basename> [stems_csv] [device] [model]"})
        return 1

    src = sys.argv[1]
    out_dir = sys.argv[2]
    basename = sys.argv[3]

    if not os.path.exists(src):
        emit({"ok": False, "error": "SRC_NOT_FOUND", "srcPath": src})
        return 1

    stems_arg = sys.argv[4] if len(sys.argv) > 4 else "all"
    device_arg = sys.argv[5] if len(sys.argv) > 5 else "auto"
    model_arg = sys.argv[6] if len(sys.argv) > 6 else "htdemucs"

    wanted = parse_wanted(stems_arg)

    if not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # Fast path: every requested stem already on disk = skip the model.
    # demucs is the slow part; reuse aggressively. We check ALL_STEMS
    # presence (not just wanted) because if a previous call wrote all
    # four, we serve from cache regardless of what this call asks for.
    expected = {s: stem_path(out_dir, basename, s) for s in wanted}
    if all(os.path.exists(p) for p in expected.values()):
        emit({"ok": True, "stems": expected,
              "model": model_arg, "device": "skipped",
              "cached": True, "separationTimeSec": 0.0,
              "basename": basename})
        return 0

    # Imports inside main so the CLI surfaces a clear "missing dep"
    # error instead of an opaque ImportError at module load. The CEP
    # helper passes the message through to the user, who needs pip.
    #
    # We capture the full traceback because demucs sometimes fails its
    # OWN sub-imports (e.g. a torchaudio API change makes demucs.api
    # raise ModuleNotFoundError for an unrelated module). The bare
    # error message hides which line actually broke; the traceback
    # points right at it.
    import traceback
    try:
        import torch
        import soundfile as sf
        from demucs.api import Separator
    except ImportError as e:
        # Also report the running interpreter so the user can see
        # WHICH python they need to pip-install into - the helper
        # often picks a different one than `pip` in cmd.exe when
        # multiple Pythons are on PATH (the Microsoft Store stub,
        # conda base, py launcher, etc).
        emit({"ok": False, "error": "DEMUCS_NOT_INSTALLED",
              "message": str(e),
              "interpreter": sys.executable,
              "traceback": traceback.format_exc(),
              "hint": "demucs isn't installed (or one of its OWN "
                      "imports is broken) in THIS interpreter:\n"
                      "  " + sys.executable + "\n"
                      "Install it with the matching pip:\n"
                      "  \"" + sys.executable + "\" -m pip install "
                      "demucs soundfile\n"
                      "If that's the wrong Python, point the helper "
                      "at a different one by setting PREMBOT_PYTHON "
                      "(e.g. \"C:\\\\Path\\\\To\\\\python.exe\") in "
                      "your environment, or ensure `py -3` resolves "
                      "to the Python you want. Then reopen the "
                      "PremBot Helper panel in Premiere.\n"
                      "GPU users: install CUDA torch first:\n"
                      "  \"" + sys.executable + "\" -m pip install "
                      "torch --index-url "
                      "https://download.pytorch.org/whl/cu121"})
        return 2

    # Resolve device. "auto" picks cuda when available; explicit "cuda"
    # falls back to cpu rather than crashing if no GPU is present.
    if not device_arg or device_arg == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = device_arg
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"

    t0 = time.time()
    try:
        # First call downloads model weights (~250 MB for htdemucs)
        # into %USERPROFILE%\AppData\Local\torch\hub\. Subsequent runs
        # hit the local torch hub cache. demucs.api.Separator handles
        # all the model loading, segmenting, and overlap-add for us.
        sep = Separator(model=model_arg, device=device)
        origin, separated = sep.separate_audio_file(src)
    except Exception as e:
        emit({"ok": False, "error": "DEMUCS_SEPARATION_FAILED",
              "message": str(e),
              "device": device, "model": model_arg})
        return 3

    sample_rate = int(sep.samplerate)
    duration_sec = float(origin.shape[-1]) / float(sample_rate)
    sep_time = time.time() - t0

    out_paths = {}
    for name, tensor in separated.items():
        if name not in wanted:
            continue
        # Tensor shape: (channels, samples). soundfile expects
        # (samples, channels), so transpose. PCM_16 keeps file sizes
        # reasonable - htdemucs is trained on 44.1 kHz so 16-bit is
        # already lossy at the model output anyway.
        data = tensor.detach().cpu().numpy().T
        path = stem_path(out_dir, basename, name)
        sf.write(path, data, sample_rate, subtype="PCM_16")
        out_paths[name] = path

    emit({
        "ok": True,
        "stems": out_paths,
        "model": model_arg,
        "device": device,
        "sampleRate": sample_rate,
        "durationSec": round(duration_sec, 3),
        "separationTimeSec": round(sep_time, 2),
        "cached": False,
        "basename": basename,
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:
        emit({"ok": False, "error": "PYTHON_UNCAUGHT",
              "message": str(e)})
        sys.exit(99)
