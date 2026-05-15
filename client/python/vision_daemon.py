#!/usr/bin/env python3
"""PremBot vision daemon - long-lived JSON-RPC analyzer.

Spawned ONCE by the CEP helper (client/js/bridge.js) when the first
analyze_clip call comes in, and kept alive for the lifetime of the
helper panel. Models load lazily on first analyze and stay resident
across subsequent calls, eliminating the ~30-60s per-call model load
penalty that the one-shot CLI (vision_analyze.py) pays.

Protocol: JSON-Lines RPC over stdin/stdout. One JSON object per line.

Request:
  {"id": "<uuid>", "method": "<method>", "params": { ... }}

Response (success):
  {"id": "<uuid>", "result": { ... }}

Response (error):
  {"id": "<uuid>", "error": {"code": "...", "message": "...",
                              "traceback": "..."}}

Notification (no id; daemon -> bridge):
  {"event": "ready" | "model_loaded" | "model_unloaded", "data": {...}}

Methods:
  ping     - health check; returns pipeline.status()
  analyze  - run full pipeline on a clip; params match vision_pipeline.
             VisionPipeline.analyze()
  unload   - free all model VRAM but keep daemon alive
  shutdown - graceful exit

Threading model:
  - Main thread reads stdin sequentially; fast methods (ping, unload,
    shutdown) run inline.
  - A single worker thread serializes analyze calls so ping stays
    responsive while a long inference is in progress.
  - An idle-watcher thread unloads models after
    PREMBOT_VISION_IDLE_MIN minutes of no requests (default 10; set
    to 0 to disable).

stdout discipline: same as stem_separate.py - _JSON_STDOUT is the
RPC channel, sys.stdout is redirected to sys.stderr so any stray
prints from torch / transformers / open_clip don't corrupt the
JSON line stream.
"""

import json
import os
import sys
import threading
import time
import traceback
from queue import Queue, Empty


# stdout lock-down + private handle. See stem_separate.py for the
# rationale - this is non-optional for correctness.
_JSON_STDOUT = sys.stdout
sys.stdout = sys.stderr

_emit_lock = threading.Lock()


def emit(obj):
    """Write a single JSON line to the RPC channel. Thread-safe."""
    with _emit_lock:
        _JSON_STDOUT.write(json.dumps(obj))
        _JSON_STDOUT.write("\n")
        _JSON_STDOUT.flush()


# Globals
_pipeline = None  # vision_pipeline.VisionPipeline | None
_pipeline_lock = threading.Lock()
_last_request_ts = time.time()
_busy = False
_analysis_queue = Queue()
_shutdown_evt = threading.Event()


def _ensure_pipeline():
    """Lazy-create the pipeline shell (no model load yet - that
    happens inside analyze() on first call)."""
    global _pipeline
    with _pipeline_lock:
        if _pipeline is None:
            from vision_pipeline import VisionPipeline
            _pipeline = VisionPipeline()
    return _pipeline


def handle_ping(params):
    p = _pipeline
    return {
        "ok": True,
        "version": "0.1",
        "pid": os.getpid(),
        "pythonExe": sys.executable,
        "busy": _busy,
        "lastRequestAgo": round(time.time() - _last_request_ts, 1),
        "pipelineInitialized": p is not None,
        "status": p.status() if p is not None else None,
    }


def handle_unload(params):
    global _pipeline
    with _pipeline_lock:
        if _pipeline is not None:
            _pipeline.unload()
            _pipeline = None
            emit({"event": "model_unloaded",
                  "data": {"reason": "explicit"}})
    return {"ok": True}


def handle_shutdown(params):
    emit({"event": "shutdown_acknowledged", "data": {}})
    _shutdown_evt.set()
    return {"ok": True}


def handle_analyze(params):
    """Heavy method. Runs on the worker thread; gates other analyzes
    via the queue."""
    global _busy, _last_request_ts
    _busy = True
    _last_request_ts = time.time()
    try:
        p = _ensure_pipeline()
        first_load = (p._vlm_model is None)
        if first_load:
            emit({"event": "model_loading", "data": {
                "spec": p.vision_model_spec}})
        result = p.analyze(params)
        if first_load:
            emit({"event": "model_loaded", "data": {
                "tag": p._vlm_tag}})
        return result
    finally:
        _busy = False
        _last_request_ts = time.time()


HANDLERS = {
    "ping": handle_ping,
    "unload": handle_unload,
    "shutdown": handle_shutdown,
    "analyze": handle_analyze,
}


def _dispatch_inline(msg):
    """Run handler synchronously, emit result. For fast methods only."""
    req_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}
    h = HANDLERS.get(method)
    if h is None:
        emit({"id": req_id, "error": {
            "code": "UNKNOWN_METHOD", "message": str(method)}})
        return
    try:
        result = h(params)
        emit({"id": req_id, "result": result})
    except Exception as e:
        emit({"id": req_id, "error": {
            "code": "HANDLER_EXCEPTION",
            "message": str(e),
            "traceback": traceback.format_exc()}})


def _analysis_worker():
    """Pull analyze requests off the queue and run them. Serializes
    so the GPU is never asked to share inference."""
    while not _shutdown_evt.is_set():
        try:
            msg = _analysis_queue.get(timeout=0.5)
        except Empty:
            continue
        if msg is None:
            return
        _dispatch_inline(msg)


def _idle_watcher():
    """Unload models after N minutes of no analyze activity. Helps
    when the user steps away - VRAM goes back to the system."""
    try:
        idle_min = float(os.environ.get("PREMBOT_VISION_IDLE_MIN",
                                        "10"))
    except ValueError:
        idle_min = 10.0
    if idle_min <= 0:
        return
    idle_sec = idle_min * 60.0
    while not _shutdown_evt.is_set():
        if _shutdown_evt.wait(30):
            return
        if _busy:
            continue
        elapsed = time.time() - _last_request_ts
        if elapsed < idle_sec:
            continue
        global _pipeline
        with _pipeline_lock:
            if _pipeline is not None and _pipeline._vlm_model is not None:
                _pipeline.unload()
                emit({"event": "model_unloaded",
                      "data": {"reason": "idle",
                               "idleSec": round(elapsed, 1)}})


def main():
    emit({"event": "ready", "data": {
        "version": "0.1",
        "pid": os.getpid(),
        "pythonExe": sys.executable,
        "idleMin": os.environ.get("PREMBOT_VISION_IDLE_MIN", "10"),
    }})

    threading.Thread(target=_analysis_worker, daemon=True).start()
    threading.Thread(target=_idle_watcher, daemon=True).start()

    # Main loop reads stdin. Fast methods run inline; analyze goes
    # to the worker queue so ping/unload stay responsive while a
    # long inference is in flight.
    for line in sys.stdin:
        if _shutdown_evt.is_set():
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            emit({"id": None, "error": {
                "code": "BAD_JSON",
                "message": str(e),
                "snippet": line[:200]}})
            continue
        method = msg.get("method")
        if method == "analyze":
            _analysis_queue.put(msg)
        else:
            _dispatch_inline(msg)

    # Graceful exit
    _analysis_queue.put(None)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        emit({"event": "fatal", "data": {
            "message": str(e),
            "traceback": traceback.format_exc()}})
        sys.exit(99)
