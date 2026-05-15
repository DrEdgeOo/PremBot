#!/usr/bin/env python3
"""PremBot clip visual analyzer.

Spawned by client/js/bridge.js as a one-shot per analyze_clip call.
Reads argv, writes JSON to stdout. stdout is locked to JSON only;
everything torch / transformers / open_clip print (download
progress, deprecation warnings, etc.) goes to stderr where the
helper logs it diagnostically.

Pipeline:
  1. argv parse: src, outDir, basename, frameCount, modelDir,
     visionModel, visionFallback, clipVisionModel, device, maxDim
  2. Fast-path: if outDir/analysis.json exists, emit & exit
     (warm calls return in tens of ms with no torch import)
  3. ffprobe -> duration
  4. ffmpeg -> N uniformly-spaced JPEGs in outDir/frames/
  5. Numeric (NumPy): motion via frame deltas, dominantColors via
     k-means in RGB. No VLM tokens spent on either.
  6. Qwen2.5-VL -> structured JSON for mood / energy / sceneType /
     hasPeople / bestFrame. On refusal or unparseable output,
     retry with abliterated fallback model.
  7. open_clip ViT-H/14 -> 1024-d avg-pooled embedding for future
     similarity / clustering tools.
  8. Write outDir/analysis.json, emit on stdout.
"""

import json
import os
import sys
import time
import subprocess


# stdout is sacred - any non-JSON byte corrupts the helper's parse.
# torch / transformers / huggingface_hub all print download progress
# and deprecation warnings via plain print(); redirect them.
_JSON_STDOUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _JSON_STDOUT.write(json.dumps(obj))
    _JSON_STDOUT.flush()


# Candidate subdirs under PREMBOT_MODEL_DIR. ComfyUI's default layout
# splits weights across these folders; we probe each one before
# treating the spec as an HF repo id.
MODEL_SUBDIRS = ("", "checkpoints", "diffusion_models", "vlm", "LLM",
                 "text_encoders", "clip_vision", "unet")


# Schema sent to the VLM. Kept tight so the model has to make discrete
# choices that downstream tools can switch on. Free-form nuance lives
# in the *Notes fields.
MOOD_OPTIONS = ("energetic", "calm", "melancholy", "tense",
                "uplifting", "dreamy", "neutral")
SCENE_OPTIONS = ("interior", "exterior_day", "exterior_night",
                 "closeup", "wide", "crowd", "nature", "urban", "other")


VLM_PROMPT = (
    "You are analyzing {n} frames sampled from a {duration:.1f}s video "
    "clip. The frames are at timestamps: {timestamps_str}.\n\n"
    "Return ONLY a JSON object matching this exact schema. No prose, "
    "no markdown, no code fences. JSON booleans are lowercase "
    "true/false:\n"
    "{{\n"
    '  "energy": <number 0..1, editorial intensity / on-screen activity>,\n'
    '  "mood": <one of: {mood_opts}>,\n'
    '  "moodNotes": <short string under 20 words>,\n'
    '  "sceneType": <one of: {scene_opts}>,\n'
    '  "hasPeople": <boolean>,\n'
    '  "personCount": <integer, your best estimate of the max people '
    'visible in any single frame>,\n'
    '  "bestFrameIndex": <integer 0..{n_minus_1}, the strongest single '
    'editorial moment>,\n'
    '  "bestFrameReason": <short string under 20 words>\n'
    "}}\n"
)


def get_duration(src):
    """ffprobe a media file for duration in seconds. Returns float or
    None on failure. 30s timeout is generous; ffprobe on a corrupt
    file usually fails inside 1s but slow network drives can be slower.
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration", "-of",
             "default=noprint_wrappers=1:nokey=1", src],
            capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and r.stdout.strip():
            return float(r.stdout.strip())
    except Exception:
        pass
    return None


def pick_timestamps(duration, n):
    """N timestamps evenly spaced inside [2%, 98%] of the clip. The
    margin dodges fade-ins / fade-outs that would otherwise dominate
    the energy/motion read on short b-roll."""
    if n <= 0 or duration <= 0:
        return []
    start = duration * 0.02
    end = duration * 0.98
    if end <= start:
        return [duration / 2.0]
    if n == 1:
        return [(start + end) / 2.0]
    step = (end - start) / (n - 1)
    return [start + step * i for i in range(n)]


def extract_frames(src, frames_dir, timestamps, max_dim):
    """One ffmpeg subprocess per timestamp. -ss BEFORE -i seeks fast
    (input-side seek, keyframe-accurate enough for thumbnails). scale
    keeps aspect ratio, capping the long edge at max_dim. -q:v 3 is
    a high-quality JPEG (lower=better; 2-3 is visually lossless).
    Returns list of frame paths in timestamp order.
    """
    os.makedirs(frames_dir, exist_ok=True)
    paths = []
    for i, t in enumerate(timestamps):
        out = os.path.join(frames_dir, "frame_{:03d}.jpg".format(i))
        if os.path.exists(out):
            paths.append(out)
            continue
        try:
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-ss", "{:.3f}".format(t), "-i", src,
                 "-frames:v", "1",
                 "-vf", "scale='min({},iw)':-2".format(max_dim),
                 "-q:v", "3", out],
                capture_output=True, text=True, timeout=30)
            if r.returncode == 0 and os.path.exists(out):
                paths.append(out)
        except Exception:
            pass
    return paths


def compute_motion(frame_arrays):
    """Mean per-pixel absolute diff between adjacent frames, normalized
    to ~[0,1]. The /32.0 calibration treats ~12.5% pixel change as
    'high motion' - tunable, but in practice talking-heads land near
    0.05 and concert / sports footage clears 0.6."""
    import numpy as np
    if len(frame_arrays) < 2:
        return 0.0
    diffs = []
    for i in range(len(frame_arrays) - 1):
        a, b = frame_arrays[i], frame_arrays[i + 1]
        if a.shape != b.shape:
            continue
        diffs.append(float(
            np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()))
    if not diffs:
        return 0.0
    return max(0.0, min(1.0, (sum(diffs) / len(diffs)) / 32.0))


def compute_dominant_colors(frame_arrays, k=3):
    """K-means on downsampled-and-stacked frame pixels. 64x64 per frame
    is plenty for color statistics and keeps kmeans2 under 50 ms even
    with 8 frames. Returns hex strings ordered by cluster size desc."""
    import numpy as np
    from scipy.cluster.vq import kmeans2
    from PIL import Image

    samples = []
    for f in frame_arrays:
        img = Image.fromarray(f).resize((64, 64))
        samples.append(np.array(img).reshape(-1, 3))
    pixels = np.concatenate(samples, axis=0).astype(np.float64)
    try:
        centers, labels = kmeans2(pixels, k, minit="++", seed=42)
        counts = np.bincount(labels, minlength=k)
        order = np.argsort(-counts)
        result = []
        for idx in order:
            c = centers[idx].clip(0, 255).astype(int)
            result.append("#" + "".join(
                "{:02x}".format(int(v)) for v in c))
        return result
    except Exception:
        return []


def resolve_model_path(spec, model_dir):
    """Three resolution strategies, in order:
      1. Absolute path that exists -> use verbatim.
      2. Filename + PREMBOT_MODEL_DIR -> probe known ComfyUI subdirs.
      3. Otherwise -> pass through as an HF repo id (e.g.
         "Qwen/Qwen2.5-VL-7B-Instruct"). transformers handles the
         download from there.
    Returns None if spec is empty/None."""
    if not spec:
        return None
    if os.path.isabs(spec) and os.path.exists(spec):
        return spec
    if model_dir:
        for sub in MODEL_SUBDIRS:
            cand = os.path.join(model_dir, sub, spec)
            if os.path.exists(cand):
                return cand
    return spec


def parse_vlm_json(raw_text):
    """Pull the first {...} object out of free-form VLM output. Handles
    accidental markdown code fences and stray prose before/after. Returns
    a dict on success, None on failure."""
    t = raw_text.strip()
    # Strip leading code fence if present.
    if t.startswith("```"):
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        if t.endswith("```"):
            t = t[:-3]
        t = t.strip()
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(t[start:end + 1])
    except json.JSONDecodeError:
        return None


REFUSAL_PHRASES = (
    "i cannot", "i can't", "i'm unable", "i am unable",
    "i'm sorry", "i am sorry", "as an ai", "not appropriate",
    "cannot analyze", "can't analyze", "cannot provide",
    "i won't", "i will not")


def is_refusal(raw_text):
    """Heuristic: short response containing classic refusal phrasing.
    Used to decide whether to retry on the abliterated fallback model."""
    low = raw_text.lower()
    if any(p in low for p in REFUSAL_PHRASES):
        return True
    return False


def load_qwen_vl(model_spec, device):
    """Load Qwen2.5-VL processor + model at 4-bit (~5 GB VRAM). Accepts
    an HF repo id OR an absolute path to a folder containing
    config.json + tokenizer + weights. Single-file .safetensors (e.g.
    ComfyUI FP8 dumps) need a paired config and are not supported in
    this first cut - the loader raises a clear error pointing the user
    at the workaround."""
    from transformers import (
        Qwen2_5_VLForConditionalGeneration, AutoProcessor,
        BitsAndBytesConfig)
    import torch

    if model_spec and os.path.isfile(model_spec):
        raise RuntimeError(
            "Single-file weights not supported yet: " + model_spec
            + "\nThe FP8 scaled .safetensors files from ComfyUI need "
            "their paired config.json + processor to load via "
            "transformers. Workarounds:\n"
            "  - Point PREMBOT_VISION_MODEL at the HF repo id "
            "(e.g. Qwen/Qwen2.5-VL-7B-Instruct) and let transformers "
            "auto-download + 4-bit quantize (~5 GB VRAM, ~16 GB disk "
            "in the HF cache).\n"
            "  - OR drop the .safetensors next to a downloaded "
            "config.json/tokenizer in a folder and point the env var "
            "at the folder.\n"
            "Single-file FP8 loading is on the roadmap.")

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4")

    # device_map="auto" on a single GPU just puts everything on cuda:0;
    # on CPU it falls back gracefully. trust_remote_code is NOT needed
    # for Qwen2.5-VL (built into modern transformers).
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        model_spec, quantization_config=bnb,
        device_map=device if device != "auto" else "auto",
        torch_dtype="auto")
    processor = AutoProcessor.from_pretrained(model_spec)
    return model, processor


def run_qwen_inference(model, processor, frame_paths, frames_used,
                       duration):
    """Build a Qwen chat message with N images + the schema prompt,
    decode max_new_tokens=512 (more than enough for the schema),
    return the raw text. do_sample=False makes the structured output
    reproducible across runs."""
    import torch
    from PIL import Image

    n = len(frame_paths)
    timestamps_str = ", ".join("{:.2f}s".format(t) for t in frames_used)
    prompt_text = VLM_PROMPT.format(
        n=n, n_minus_1=max(0, n - 1), duration=duration,
        timestamps_str=timestamps_str,
        mood_opts=", ".join(MOOD_OPTIONS),
        scene_opts=", ".join(SCENE_OPTIONS))

    images = [Image.open(p).convert("RGB") for p in frame_paths]
    messages = [{"role": "user", "content": (
        [{"type": "image", "image": img} for img in images]
        + [{"type": "text", "text": prompt_text}]
    )}]

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=images, padding=True,
                       return_tensors="pt").to(model.device)

    with torch.no_grad():
        out_ids = model.generate(
            **inputs, max_new_tokens=512,
            do_sample=False, temperature=0.0)
    out_text = processor.batch_decode(
        out_ids[:, inputs.input_ids.shape[1]:],
        skip_special_tokens=True)[0]
    return out_text


def free_vram():
    """Drop refs + flush CUDA caching allocator. Called between model
    swaps so primary -> fallback doesn't OOM."""
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def run_vlm_with_fallback(frame_paths, frames_used, duration,
                          primary, fallback, model_dir, device):
    """Try primary; on refusal or unparseable JSON, retry on fallback.
    Returns (parsed_dict, model_used_label, quality_tag).

    quality_tag values:
      - "primary"        - primary returned parseable JSON
      - "fallback"       - primary refused/garbled, fallback parsed
      - "unparseable"    - even fallback didn't yield JSON
      - "no_model_loaded"- both load attempts failed (e.g. no transformers,
                           OOM, bad model spec)
    """
    attempts = [(primary, "primary"), (fallback, "fallback")]
    last_raw = ""
    for spec_raw, tag in attempts:
        if not spec_raw:
            continue
        spec = resolve_model_path(spec_raw, model_dir)
        try:
            model, processor = load_qwen_vl(spec, device)
        except Exception as e:
            last_raw = "MODEL_LOAD_FAILED ({}): {}".format(tag, e)
            free_vram()
            continue
        try:
            raw = run_qwen_inference(model, processor, frame_paths,
                                     frames_used, duration)
        except Exception as e:
            last_raw = "INFERENCE_FAILED ({}): {}".format(tag, e)
            del model, processor
            free_vram()
            continue
        finally:
            try:
                del model, processor
            except Exception:
                pass
            free_vram()

        last_raw = raw
        parsed = parse_vlm_json(raw)
        if parsed:
            # Bake derived fields off bestFrameIndex so downstream
            # tools don't have to recompute timestamps. Window =
            # 10% of clip duration (min 0.5s) centered on best frame.
            idx = parsed.get("bestFrameIndex")
            if isinstance(idx, int) and 0 <= idx < len(frames_used):
                center = frames_used[idx]
                window = max(0.5, duration * 0.1)
                parsed["bestFrameSec"] = round(center, 3)
                parsed["suggestedInPointSec"] = round(
                    max(0.0, center - window / 2.0), 3)
                parsed["suggestedOutPointSec"] = round(
                    min(duration, center + window / 2.0), 3)
            return parsed, os.path.basename(str(spec)), tag

        # Couldn't parse JSON. If it looks like a refusal AND we have
        # a fallback to try, keep going; otherwise stop with the raw
        # text preserved for the caller.
        if tag == "primary" and is_refusal(raw):
            continue
        # No JSON, no refusal heuristic match -> still try fallback
        # (model may have rambled instead of obeying the schema).
        if tag == "primary":
            continue

    # Reached after exhausting both attempts.
    return ({"vlmRawText": last_raw[:500]} if last_raw else {}), \
        "none", \
        ("unparseable" if last_raw else "no_model_loaded")


def run_clip_embedding(frame_paths, clip_vision_model, model_dir,
                       device):
    """Encode each frame with OpenCLIP ViT-H/14, L2-normalize, average,
    re-normalize. Returns (embedding_list, dim, model_tag). On any
    failure returns (None, 0, '<failure-tag>')."""
    try:
        import open_clip
    except ImportError:
        return None, 0, "open_clip_not_installed"

    import torch
    from PIL import Image
    import numpy as np

    arch = "ViT-H-14"
    local_path = (resolve_model_path(clip_vision_model, model_dir)
                  if clip_vision_model else None)

    try:
        if local_path and os.path.isfile(local_path):
            # Build arch with no pretrained weights, then load the
            # user's local checkpoint. ComfyUI's clip_vision_h is
            # typically just the visual tower; try strict first then
            # fall back to non-strict load on model.visual.
            model, _, preprocess = open_clip.create_model_and_transforms(
                arch, pretrained=None)
            try:
                from safetensors.torch import load_file
                sd = load_file(local_path)
            except Exception:
                sd = torch.load(local_path, map_location="cpu")
            try:
                model.load_state_dict(sd, strict=True)
                load_mode = "strict"
            except Exception:
                # Try loading into the visual tower only - this is the
                # shape ComfyUI ships clip_vision_h as.
                try:
                    model.visual.load_state_dict(sd, strict=False)
                    load_mode = "visual_only"
                except Exception:
                    model.load_state_dict(sd, strict=False)
                    load_mode = "non_strict"
            model_tag = "clip_vision_h(local," + load_mode + ")"
        else:
            model, _, preprocess = open_clip.create_model_and_transforms(
                arch, pretrained="laion2b_s32b_b79k")
            model_tag = "open_clip:ViT-H-14:laion2b_s32b_b79k"
    except Exception as e:
        return None, 0, "clip_load_failed:" + str(e)[:120]

    model = model.to(device).eval()

    embeds = []
    try:
        with torch.no_grad():
            for p in frame_paths:
                img = preprocess(Image.open(p).convert("RGB"))
                img = img.unsqueeze(0).to(device)
                e = model.encode_image(img)
                e = e / (e.norm(dim=-1, keepdim=True) + 1e-8)
                embeds.append(e.squeeze(0).cpu().float().numpy())
    except Exception as e:
        return None, 0, "clip_inference_failed:" + str(e)[:120]
    finally:
        del model
        free_vram()

    if not embeds:
        return None, 0, "clip_no_frames"

    avg = np.mean(np.stack(embeds, axis=0), axis=0)
    avg = avg / (np.linalg.norm(avg) + 1e-8)
    return avg.tolist(), int(avg.shape[0]), model_tag


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

    if not os.path.exists(src):
        emit({"ok": False, "error": "SRC_NOT_FOUND", "srcPath": src})
        return 1

    os.makedirs(out_dir, exist_ok=True)
    analysis_path = os.path.join(out_dir, "analysis.json")
    frames_dir = os.path.join(out_dir, "frames")

    # Fast cache path. We trust the bridge.js cache-key construction
    # (src hash + mtime + frameCount + model-env hash) to invalidate
    # correctly, so a present analysis.json is always reusable.
    if os.path.exists(analysis_path):
        try:
            with open(analysis_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            cached["cached"] = True
            cached["ok"] = True
            emit(cached)
            return 0
        except Exception:
            # Corrupted cache file - fall through and regenerate.
            pass

    duration = get_duration(src)
    if duration is None or duration <= 0:
        emit({"ok": False, "error": "FFPROBE_FAILED",
              "message": "ffprobe could not read duration. Is ffmpeg "
                         "on PATH and is the file readable? Path: "
                         + src})
        return 2

    frames_used = pick_timestamps(duration, frame_count)
    frame_paths = extract_frames(src, frames_dir, frames_used, max_dim)
    if not frame_paths:
        emit({"ok": False, "error": "FRAME_EXTRACT_FAILED",
              "message": "ffmpeg produced no frames. Likely a codec "
                         "the system ffmpeg can't decode, or the "
                         "source is shorter than expected. Path: "
                         + src,
              "durationSec": duration,
              "framesAttempted": len(frames_used)})
        return 3

    # Heavy imports gated past cache + frame extract. Cache hits and
    # ffmpeg-only failures stay <100ms because torch never loads.
    import traceback
    try:
        import numpy as np
        from PIL import Image
    except ImportError as e:
        emit({"ok": False, "error": "PYTHON_DEPS_MISSING",
              "module": "numpy/PIL",
              "message": str(e),
              "interpreter": sys.executable,
              "traceback": traceback.format_exc(),
              "hint": "Install the analyzer's deps into THIS "
                      "interpreter:\n  \"" + sys.executable + "\" -m "
                      "pip install numpy pillow scipy transformers "
                      "accelerate bitsandbytes open_clip_torch "
                      "safetensors"})
        return 4

    try:
        import torch  # noqa: F401  (used inside helpers)
    except ImportError as e:
        emit({"ok": False, "error": "TORCH_NOT_INSTALLED",
              "message": str(e),
              "interpreter": sys.executable,
              "hint": "Install torch into THIS interpreter first:\n"
                      "  \"" + sys.executable + "\" -m pip install "
                      "torch --index-url "
                      "https://download.pytorch.org/whl/cu121\n"
                      "Then: \"" + sys.executable + "\" -m pip "
                      "install transformers accelerate bitsandbytes "
                      "open_clip_torch safetensors scipy pillow"})
        return 4

    # Numeric pass - cheap, runs even if VLM or CLIP fall over.
    try:
        frame_arrays = [
            np.array(Image.open(p).convert("RGB")) for p in frame_paths
        ]
    except Exception as e:
        emit({"ok": False, "error": "FRAME_DECODE_FAILED",
              "message": str(e),
              "traceback": traceback.format_exc()})
        return 5

    motion = compute_motion(frame_arrays)
    try:
        dominant_colors = compute_dominant_colors(frame_arrays, k=3)
    except Exception:
        dominant_colors = []

    # Free the in-memory frame arrays before loading the VLM - 6 frames
    # at 512x288 is ~2.6 MB but stack across the rest of the pipeline
    # and it adds up. The VLM re-reads frames from disk anyway.
    del frame_arrays

    # Resolve device once for both models.
    import torch
    if device_arg == "auto" or not device_arg:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = device_arg
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"

    # VLM pass.
    t_vlm = time.time()
    try:
        vlm_parsed, vlm_model_used, vlm_quality = run_vlm_with_fallback(
            frame_paths, frames_used, duration,
            vision_model, vision_fallback, model_dir, device)
    except Exception as e:
        vlm_parsed, vlm_model_used, vlm_quality = (
            {"vlmException": str(e)[:300]}, "none", "exception")
    vlm_time = time.time() - t_vlm

    # CLIP embedding pass.
    t_clip = time.time()
    try:
        embedding, embedding_dim, embedding_model = run_clip_embedding(
            frame_paths, clip_vision_model, model_dir, device)
    except Exception as e:
        embedding, embedding_dim, embedding_model = (
            None, 0, "clip_exception:" + str(e)[:120])
    clip_time = time.time() - t_clip

    model_tag = vlm_model_used + "+" + (embedding_model or "no_embed")

    result = {
        "ok": True,
        "filePath": src,
        "basename": basename,
        "durationSec": round(duration, 3),
        "frameCount": len(frame_paths),
        "framesUsedSec": [round(t, 3) for t in frames_used],
        "modelTag": model_tag,

        # VLM-judged fields (may be None if VLM failed).
        "energy": vlm_parsed.get("energy"),
        "mood": vlm_parsed.get("mood"),
        "moodNotes": vlm_parsed.get("moodNotes"),
        "sceneType": vlm_parsed.get("sceneType"),
        "hasPeople": vlm_parsed.get("hasPeople"),
        "personCount": vlm_parsed.get("personCount"),
        "bestFrameIndex": vlm_parsed.get("bestFrameIndex"),
        "bestFrameSec": vlm_parsed.get("bestFrameSec"),
        "bestFrameReason": vlm_parsed.get("bestFrameReason"),
        "suggestedInPointSec": vlm_parsed.get("suggestedInPointSec"),
        "suggestedOutPointSec": vlm_parsed.get("suggestedOutPointSec"),

        # Numeric fields (always populated).
        "motion": round(motion, 3),
        "dominantColors": dominant_colors,

        # Embedding for downstream similarity / clustering.
        "embedding": embedding,
        "embeddingDim": embedding_dim,
        "embeddingModel": embedding_model,

        # Diagnostics.
        "analysisQuality": vlm_quality,
        "visionModelUsed": vlm_model_used,
        "vlmTimeSec": round(vlm_time, 2),
        "clipTimeSec": round(clip_time, 2),
        "device": device,
        "cached": False,
        "pythonExe": sys.executable,
        "torchVersion": torch.__version__,
        "cudaAvailable": bool(torch.cuda.is_available()),
    }

    # If the VLM didn't parse, surface the raw text so the caller can
    # see WHY (refusal vs. rambling vs. exception).
    if "vlmRawText" in vlm_parsed:
        result["vlmRawText"] = vlm_parsed["vlmRawText"]
    if "vlmException" in vlm_parsed:
        result["vlmException"] = vlm_parsed["vlmException"]

    try:
        with open(analysis_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
    except Exception as e:
        result["cacheWriteWarning"] = str(e)

    emit(result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as e:
        import traceback
        emit({"ok": False, "error": "PYTHON_UNCAUGHT",
              "message": str(e),
              "traceback": traceback.format_exc()})
        sys.exit(99)
