"""PremBot vision pipeline - shared analysis logic.

Holds loaded models in instance state so the daemon (vision_daemon.py)
can reuse them across many analyze() calls without paying the 30-60s
model-load tax per clip. The one-shot CLI (vision_analyze.py) wraps
the same class for diagnostic use.

Module-level helpers (frame extraction, numeric analysis, JSON parsing,
refusal detection) are pure functions with no model state - they are
tested by themselves and reused both by VisionPipeline and by any
future analyzer that wants the same primitives.
"""

import json
import os
import subprocess
import time


MODEL_SUBDIRS = ("", "checkpoints", "diffusion_models", "vlm", "LLM",
                 "text_encoders", "clip_vision", "unet")


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


REFUSAL_PHRASES = (
    "i cannot", "i can't", "i'm unable", "i am unable",
    "i'm sorry", "i am sorry", "as an ai", "not appropriate",
    "cannot analyze", "can't analyze", "cannot provide",
    "i won't", "i will not")


def get_duration(src):
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
    t = raw_text.strip()
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


def is_refusal(raw_text):
    low = raw_text.lower()
    return any(p in low for p in REFUSAL_PHRASES)


def free_vram():
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _load_qwen_vl(model_spec, device):
    """Internal loader. Raises RuntimeError on single-file FP8 .safetensors
    (the ComfyUI distribution shape) - those need a paired config/processor
    and aren't supported in this first cut."""
    from transformers import (
        Qwen2_5_VLForConditionalGeneration, AutoProcessor,
        BitsAndBytesConfig)
    import torch

    if model_spec and os.path.isfile(model_spec):
        raise RuntimeError(
            "Single-file weights not supported yet: " + model_spec
            + "\nWorkarounds:\n"
            "  - Point PREMBOT_VISION_MODEL at the HF repo id "
            "(e.g. Qwen/Qwen2.5-VL-7B-Instruct) and let transformers "
            "auto-download + 4-bit quantize (~5 GB VRAM).\n"
            "  - OR drop the .safetensors next to a config.json + "
            "tokenizer in a folder and point the env var at the folder.")

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4")

    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        model_spec, quantization_config=bnb,
        device_map=device if device != "auto" else "auto",
        torch_dtype="auto")
    processor = AutoProcessor.from_pretrained(model_spec)
    return model, processor


def _run_qwen_inference(model, processor, frame_paths, frames_used,
                        duration):
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


def _load_clip_visual(clip_vision_spec, model_dir, device):
    """Load OpenCLIP ViT-H/14 plus its preprocess transform. Returns
    (model, preprocess, tag). Returns (None, None, '<failure>') on
    failure - callers should degrade gracefully."""
    try:
        import open_clip
    except ImportError:
        return None, None, "open_clip_not_installed"

    import torch

    arch = "ViT-H-14"
    local_path = (resolve_model_path(clip_vision_spec, model_dir)
                  if clip_vision_spec else None)

    try:
        if local_path and os.path.isfile(local_path):
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
                try:
                    model.visual.load_state_dict(sd, strict=False)
                    load_mode = "visual_only"
                except Exception:
                    model.load_state_dict(sd, strict=False)
                    load_mode = "non_strict"
            tag = "clip_vision_h(local," + load_mode + ")"
        else:
            model, _, preprocess = open_clip.create_model_and_transforms(
                arch, pretrained="laion2b_s32b_b79k")
            tag = "open_clip:ViT-H-14:laion2b_s32b_b79k"
    except Exception as e:
        return None, None, "clip_load_failed:" + str(e)[:120]

    model = model.to(device).eval()
    return model, preprocess, tag


def _encode_clip_frames(model, preprocess, frame_paths, device):
    """Returns (embedding_list_or_None, dim, failure_tag_or_None)."""
    import torch
    import numpy as np
    from PIL import Image

    if model is None:
        return None, 0, "no_clip_model"

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

    if not embeds:
        return None, 0, "clip_no_frames"

    avg = np.mean(np.stack(embeds, axis=0), axis=0)
    avg = avg / (np.linalg.norm(avg) + 1e-8)
    return avg.tolist(), int(avg.shape[0]), None


class VisionPipeline:
    """Reusable analysis pipeline. Holds the primary VLM and CLIP model
    as resident instance state. Fallback VLM is loaded on-demand per
    refusal (swap pattern: unload primary -> load fallback -> run ->
    unload fallback -> reload primary) because keeping both VLMs +
    CLIP resident exceeds 12 GB VRAM on the 3080 Ti class.

    Threading: a single VisionPipeline is NOT safe to call from multiple
    threads concurrently (model state is shared). The daemon serializes
    analyses via a queue + worker thread.
    """

    def __init__(self, model_dir=None, vision_model_spec=None,
                 vision_fallback_spec=None, clip_vision_spec=None,
                 device_arg="auto"):
        self.model_dir = (model_dir
                          or os.environ.get("PREMBOT_MODEL_DIR", ""))
        self.vision_model_spec = (
            vision_model_spec
            or os.environ.get("PREMBOT_VISION_MODEL",
                              "Qwen/Qwen2.5-VL-7B-Instruct"))
        self.vision_fallback_spec = (
            vision_fallback_spec
            or os.environ.get("PREMBOT_VISION_MODEL_FALLBACK", ""))
        self.clip_vision_spec = (
            clip_vision_spec
            or os.environ.get("PREMBOT_CLIP_VISION_MODEL", ""))
        self._device_arg = device_arg

        self._vlm_model = None
        self._vlm_processor = None
        self._vlm_tag = None

        self._clip_model = None
        self._clip_preprocess = None
        self._clip_tag = None

        self._device = None
        self._first_load_started = None

    def device(self):
        if self._device:
            return self._device
        import torch
        if self._device_arg in ("auto", "", None):
            d = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            d = self._device_arg
            if d == "cuda" and not torch.cuda.is_available():
                d = "cpu"
        self._device = d
        return d

    def status(self):
        return {
            "primaryLoaded": self._vlm_model is not None,
            "primaryTag": self._vlm_tag,
            "clipLoaded": self._clip_model is not None,
            "clipTag": self._clip_tag,
            "device": self._device,
            "modelDir": self.model_dir,
            "visionModelSpec": self.vision_model_spec,
            "visionFallbackSpec": self.vision_fallback_spec,
            "clipVisionSpec": self.clip_vision_spec,
        }

    def _load_primary(self):
        if self._vlm_model is not None:
            return
        spec = resolve_model_path(self.vision_model_spec, self.model_dir)
        self._vlm_model, self._vlm_processor = _load_qwen_vl(
            spec, self.device())
        self._vlm_tag = os.path.basename(str(spec))

    def _unload_primary(self):
        self._vlm_model = None
        self._vlm_processor = None
        self._vlm_tag = None
        free_vram()

    def _load_clip(self):
        if self._clip_model is not None:
            return
        self._clip_model, self._clip_preprocess, self._clip_tag = (
            _load_clip_visual(self.clip_vision_spec, self.model_dir,
                              self.device()))

    def _unload_clip(self):
        self._clip_model = None
        self._clip_preprocess = None
        self._clip_tag = None
        free_vram()

    def unload(self):
        self._unload_primary()
        self._unload_clip()

    def ensure_loaded(self):
        """Eagerly load primary VLM + CLIP. Useful for warmup pings.
        Lazy-load is the default during analyze()."""
        self._load_primary()
        self._load_clip()

    def _run_vlm(self, frame_paths, frames_used, duration):
        """Returns (parsed_dict, model_used_label, quality_tag).

        Primary is preferred and kept resident. On refusal / unparseable
        output, we swap to fallback (unload primary, load fallback, run,
        unload fallback, reload primary). The swap is expensive (~60s
        round-trip) but rare; the common path is zero swaps.
        """
        last_raw = ""

        # Primary attempt
        try:
            self._load_primary()
        except Exception as e:
            last_raw = "PRIMARY_LOAD_FAILED: {}".format(e)
            self._unload_primary()
        else:
            try:
                raw = _run_qwen_inference(
                    self._vlm_model, self._vlm_processor,
                    frame_paths, frames_used, duration)
            except Exception as e:
                last_raw = "PRIMARY_INFERENCE_FAILED: {}".format(e)
            else:
                last_raw = raw
                parsed = parse_vlm_json(raw)
                if parsed:
                    return (_augment_best_frame(parsed, frames_used,
                                                duration),
                            self._vlm_tag, "primary")
                # Couldn't parse JSON. If it doesn't look like a
                # refusal, the model probably just rambled; either way
                # try fallback if available.

        # Fallback attempt
        if self.vision_fallback_spec:
            # Free VRAM for fallback load.
            self._unload_primary()
            try:
                fb_spec = resolve_model_path(self.vision_fallback_spec,
                                             self.model_dir)
                fb_model, fb_processor = _load_qwen_vl(fb_spec,
                                                       self.device())
                fb_tag = os.path.basename(str(fb_spec))
            except Exception as e:
                last_raw += " | FALLBACK_LOAD_FAILED: {}".format(e)
                free_vram()
            else:
                try:
                    raw = _run_qwen_inference(
                        fb_model, fb_processor,
                        frame_paths, frames_used, duration)
                except Exception as e:
                    last_raw += " | FALLBACK_INFERENCE_FAILED: {}".format(
                        e)
                else:
                    parsed = parse_vlm_json(raw)
                    del fb_model, fb_processor
                    free_vram()
                    if parsed:
                        return (_augment_best_frame(parsed, frames_used,
                                                    duration),
                                fb_tag, "fallback")
                    last_raw = raw
                # Cleanup if we didn't return above
                try:
                    del fb_model, fb_processor
                except Exception:
                    pass
                free_vram()
            # Reload primary for the NEXT analyze call so it doesn't
            # pay the load cost again. If reload fails, log to last_raw
            # but don't error out the user's analyze call.
            try:
                self._load_primary()
            except Exception as e:
                last_raw += " | PRIMARY_RELOAD_FAILED: {}".format(e)

        return ({"vlmRawText": last_raw[:500]} if last_raw else {},
                "none",
                "unparseable" if last_raw else "no_model_loaded")

    def analyze(self, params):
        """Full analyze pipeline. params = {
            srcPath, outDir, basename, frameCount=6,
            device=auto, maxDim=512
        }
        Returns the full result dict (matches the schema documented
        in agent.js for analyze_clip).
        """
        import traceback

        src = params["srcPath"]
        out_dir = params["outDir"]
        basename = params.get("basename") or os.path.basename(
            os.path.splitext(src)[0])
        frame_count = int(params.get("frameCount") or 6)
        max_dim = int(params.get("maxDim") or 512)

        if not os.path.exists(src):
            return {"ok": False, "error": "SRC_NOT_FOUND",
                    "srcPath": src}

        os.makedirs(out_dir, exist_ok=True)
        analysis_path = os.path.join(out_dir, "analysis.json")
        frames_dir = os.path.join(out_dir, "frames")

        # Cache fast path (zero model touches).
        if os.path.exists(analysis_path):
            try:
                with open(analysis_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                cached["cached"] = True
                cached["ok"] = True
                return cached
            except Exception:
                pass

        duration = get_duration(src)
        if duration is None or duration <= 0:
            return {"ok": False, "error": "FFPROBE_FAILED",
                    "message": "ffprobe could not read duration. "
                               "Path: " + src}

        frames_used = pick_timestamps(duration, frame_count)
        frame_paths = extract_frames(src, frames_dir, frames_used,
                                     max_dim)
        if not frame_paths:
            return {"ok": False, "error": "FRAME_EXTRACT_FAILED",
                    "message": "ffmpeg produced no frames. "
                               "Path: " + src,
                    "durationSec": duration,
                    "framesAttempted": len(frames_used)}

        try:
            import numpy as np
            from PIL import Image
        except ImportError as e:
            return {"ok": False, "error": "PYTHON_DEPS_MISSING",
                    "module": "numpy/PIL",
                    "message": str(e),
                    "traceback": traceback.format_exc()}

        try:
            frame_arrays = [
                np.array(Image.open(p).convert("RGB"))
                for p in frame_paths
            ]
        except Exception as e:
            return {"ok": False, "error": "FRAME_DECODE_FAILED",
                    "message": str(e),
                    "traceback": traceback.format_exc()}

        motion = compute_motion(frame_arrays)
        try:
            dominant_colors = compute_dominant_colors(frame_arrays, k=3)
        except Exception:
            dominant_colors = []
        del frame_arrays

        # VLM
        t_vlm = time.time()
        try:
            vlm_parsed, vlm_tag, vlm_quality = self._run_vlm(
                frame_paths, frames_used, duration)
        except Exception as e:
            vlm_parsed, vlm_tag, vlm_quality = (
                {"vlmException": str(e)[:300]}, "none", "exception")
        vlm_time = time.time() - t_vlm

        # CLIP (lazy load, resident across calls)
        t_clip = time.time()
        try:
            self._load_clip()
            embedding, embedding_dim, fail = _encode_clip_frames(
                self._clip_model, self._clip_preprocess,
                frame_paths, self.device())
            embedding_model = (self._clip_tag if not fail
                               else (fail or self._clip_tag))
        except Exception as e:
            embedding, embedding_dim = None, 0
            embedding_model = "clip_exception:" + str(e)[:120]
        clip_time = time.time() - t_clip

        model_tag = vlm_tag + "+" + (embedding_model or "no_embed")

        import torch
        result = {
            "ok": True,
            "filePath": src,
            "basename": basename,
            "durationSec": round(duration, 3),
            "frameCount": len(frame_paths),
            "framesUsedSec": [round(t, 3) for t in frames_used],
            "modelTag": model_tag,

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
            "suggestedOutPointSec": vlm_parsed.get(
                "suggestedOutPointSec"),

            "motion": round(motion, 3),
            "dominantColors": dominant_colors,

            "embedding": embedding,
            "embeddingDim": embedding_dim,
            "embeddingModel": embedding_model,

            "analysisQuality": vlm_quality,
            "visionModelUsed": vlm_tag,
            "vlmTimeSec": round(vlm_time, 2),
            "clipTimeSec": round(clip_time, 2),
            "device": self.device(),
            "cached": False,
            "torchVersion": torch.__version__,
            "cudaAvailable": bool(torch.cuda.is_available()),
        }
        if "vlmRawText" in vlm_parsed:
            result["vlmRawText"] = vlm_parsed["vlmRawText"]
        if "vlmException" in vlm_parsed:
            result["vlmException"] = vlm_parsed["vlmException"]

        try:
            with open(analysis_path, "w", encoding="utf-8") as f:
                json.dump(result, f)
        except Exception as e:
            result["cacheWriteWarning"] = str(e)

        return result


def _augment_best_frame(parsed, frames_used, duration):
    """Bake bestFrameSec + in/out point off bestFrameIndex so downstream
    tools don't recompute timestamps. Window = 10% of clip duration,
    minimum 0.5s, centered on the picked frame."""
    idx = parsed.get("bestFrameIndex")
    if isinstance(idx, int) and 0 <= idx < len(frames_used):
        center = frames_used[idx]
        window = max(0.5, duration * 0.1)
        parsed["bestFrameSec"] = round(center, 3)
        parsed["suggestedInPointSec"] = round(
            max(0.0, center - window / 2.0), 3)
        parsed["suggestedOutPointSec"] = round(
            min(duration, center + window / 2.0), 3)
    return parsed
