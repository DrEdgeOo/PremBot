#!/usr/bin/env python3
"""PremBot vision analyzer - one-shot CLI.

This is the legacy entry point - spawned per analyze_clip call as a
fresh Python process, pays the full model load tax (30-60s) every
time. Kept for two reasons:
  1. Diagnostic: lets the user run the same pipeline from a terminal
     to debug env / GPU / model-path issues without going through the
     CEP helper.
  2. Fallback: if vision_daemon.py fails to start for any reason, the
     CEP helper can drop back to one-shot mode automatically.

For the primary user-facing path see vision_daemon.py (long-lived
JSON-RPC server). All analysis logic lives in vision_pipeline.py;
both entry points are thin shells around VisionPipeline.analyze().
"""

import json
import os
import sys
import traceback


# stdout lock-down. See stem_separate.py for rationale.
_JSON_STDOUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _JSON_STDOUT.write(json.dumps(obj))
    _JSON_STDOUT.flush()


def main():
    if len(sys.argv) < 4:
        emit({"ok": False, "error": "MISSING_ARGS",
              "message": "Usage: vision_analyze.py <src> <outDir> "
                         "<basename> [frameCount] [modelDir] "
                         "[visionModel] [visionFallback] "
                         "[clipVisionModel] [device] [maxDim]"})
        return 1

    src = sys.argv[1]
    out_dir = sys.argv[2]
    basename = sys.argv[3]
    frame_count = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    model_dir = sys.argv[5] if len(sys.argv) > 5 else ""
    vision_model = (sys.argv[6] if len(sys.argv) > 6
                    else "Qwen/Qwen2.5-VL-7B-Instruct")
    vision_fallback = sys.argv[7] if len(sys.argv) > 7 else ""
    clip_vision_model = sys.argv[8] if len(sys.argv) > 8 else ""
    device_arg = sys.argv[9] if len(sys.argv) > 9 else "auto"
    max_dim = int(sys.argv[10]) if len(sys.argv) > 10 else 512

    try:
        from vision_pipeline import VisionPipeline
    except ImportError as e:
        emit({"ok": False, "error": "PIPELINE_IMPORT_FAILED",
              "message": str(e),
              "traceback": traceback.format_exc(),
              "hint": "vision_pipeline.py must live alongside this "
                      "script. Re-run install-windows.bat."})
        return 2

    try:
        pipeline = VisionPipeline(
            model_dir=model_dir,
            vision_model_spec=vision_model,
            vision_fallback_spec=vision_fallback,
            clip_vision_spec=clip_vision_model,
            device_arg=device_arg)
        result = pipeline.analyze({
            "srcPath": src,
            "outDir": out_dir,
            "basename": basename,
            "frameCount": frame_count,
            "maxDim": max_dim,
        })
    except Exception as e:
        emit({"ok": False, "error": "PIPELINE_EXCEPTION",
              "message": str(e),
              "traceback": traceback.format_exc(),
              "interpreter": sys.executable})
        return 3

    result.setdefault("pythonExe", sys.executable)
    emit(result)
    return 0 if result.get("ok") else 4


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:
        emit({"ok": False, "error": "PYTHON_UNCAUGHT",
              "message": str(e),
              "traceback": traceback.format_exc()})
        sys.exit(99)
