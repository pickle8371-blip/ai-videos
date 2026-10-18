"""
Voidcraft local AI video engine.

Runs open-weight video diffusion models (Wan 2.1, LTX-Video, CogVideoX,
AnimateDiff) on this machine with PyTorch + diffusers. No API keys, no cloud:
weights are downloaded once from Hugging Face, then generation is offline.

Commands (each prints JSON lines on stdout):
  doctor                          environment and installed models
  download --model ID             fetch model weights (progress events)
  delete --model ID               remove downloaded weights
  generate --request FILE.json    run a generation, write PNG frames

Event lines: {"type": "status"|"progress"|"result"|"error", ...}
"""
import argparse
import json
import os
import shutil
import sys
import threading
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = {m["id"]: m for m in json.load(open(os.path.join(HERE, "models.json"), encoding="utf-8"))["models"]}


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}), flush=True)


def models_dir():
    # HF_HOME is set by the Voidcraft server to <data>/models; default to engine/models.
    return os.environ.get("HF_HOME") or os.path.join(HERE, "models")


def cache_dir():
    return os.path.join(models_dir(), "hub")


def is_installed(model):
    from huggingface_hub import snapshot_download

    for spec in model["repos"]:
        try:
            snapshot_download(spec["repo"], allow_patterns=spec.get("allow"), cache_dir=cache_dir(), local_files_only=True)
        except Exception:
            return False
    return True


def repo_path(spec):
    from huggingface_hub import snapshot_download

    return snapshot_download(spec["repo"], allow_patterns=spec.get("allow"), cache_dir=cache_dir(), local_files_only=True)


# ------------------------------------------------------------------ doctor


def cmd_doctor(_args):
    info = {"python": sys.version.split()[0], "engine": True, "modelsDir": models_dir()}
    try:
        import torch

        info["torch"] = torch.__version__
        info["cuda"] = bool(torch.cuda.is_available())
        info["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
        if info["cuda"]:
            p = torch.cuda.get_device_properties(0)
            info["gpu"] = p.name
            info["vramGB"] = round(p.total_memory / 1024**3, 1)
        info["device"] = "cuda" if info["cuda"] else "mps" if info["mps"] else "cpu"
        info["cpuThreads"] = torch.get_num_threads()
    except Exception as e:  # torch missing or broken
        info["engine"] = False
        info["error"] = f"PyTorch unavailable: {e}"
    try:
        import diffusers

        info["diffusers"] = diffusers.__version__
    except Exception as e:
        info["engine"] = False
        info["error"] = info.get("error") or f"diffusers unavailable: {e}"
    installed = {}
    if info["engine"]:
        for mid, m in CATALOG.items():
            installed[mid] = is_installed(m)
    info["installed"] = installed
    emit("doctor", **info)


# ---------------------------------------------------------------- download


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def cmd_download(args):
    from fnmatch import fnmatch
    from huggingface_hub import HfApi, snapshot_download

    model = CATALOG.get(args.model)
    if not model:
        raise SystemExit(f"Unknown model {args.model}")
    api = HfApi()
    total = 0
    for spec in model["repos"]:
        try:
            info = api.model_info(spec["repo"], files_metadata=True)
        except Exception as e:
            raise SystemExit(
                f"Could not reach huggingface.co to download {spec['repo']} ({type(e).__name__}: {e}). "
                "Check your internet connection, firewall or proxy, then try again. Downloads resume where they stopped."
            )
        for s in info.siblings or []:
            if spec.get("allow") and not any(fnmatch(s.rfilename, pat) for pat in spec["allow"]):
                continue
            total += s.size or 0
    emit("status", message=f"Downloading {model['name']} (~{total / 1024**3:.1f} GB) to {models_dir()}", totalBytes=total)
    os.makedirs(cache_dir(), exist_ok=True)
    start = dir_size(cache_dir())
    done = threading.Event()

    def report():
        while not done.wait(1.0):
            got = max(0, dir_size(cache_dir()) - start)
            emit("progress", fraction=min(0.99, got / total) if total else None, bytes=got, totalBytes=total)

    t = threading.Thread(target=report, daemon=True)
    t.start()
    try:
        for spec in model["repos"]:
            emit("status", message=f"Fetching {spec['repo']}")
            snapshot_download(spec["repo"], allow_patterns=spec.get("allow"), cache_dir=cache_dir())
    finally:
        done.set()
    emit("result", installed=is_installed(model))


def cmd_delete(args):
    model = CATALOG.get(args.model)
    if not model:
        raise SystemExit(f"Unknown model {args.model}")
    removed = 0
    for spec in model["repos"]:
        path = os.path.join(cache_dir(), "models--" + spec["repo"].replace("/", "--"))
        if os.path.isdir(path):
            removed += dir_size(path)
            shutil.rmtree(path, ignore_errors=True)
    emit("result", removedBytes=removed)


# ---------------------------------------------------------------- generate


def pick_device(torch):
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def dtypes(torch, model, device):
    """(main dtype, vae dtype) for a pipeline on a device."""
    if device == "cpu":
        return torch.float32, torch.float32
    pref = {"wan": torch.bfloat16, "ltx": torch.bfloat16, "cogvideox": torch.float16, "cogvideox-i2v": torch.bfloat16, "animatediff": torch.float16}[model["pipeline"]]
    if device == "mps" and pref == torch.bfloat16:
        pref = torch.float16
    vae = torch.float32 if model["pipeline"] == "wan" else pref
    return pref, vae


def load_pipeline(model, device, torch, task="text-to-video"):
    import diffusers

    main, vae_dtype = dtypes(torch, model, device)
    kind = model["pipeline"]
    path = repo_path(model["repos"][0])
    if kind == "wan":
        vae = diffusers.AutoencoderKLWan.from_pretrained(path, subfolder="vae", torch_dtype=vae_dtype)
        return diffusers.WanPipeline.from_pretrained(path, vae=vae, torch_dtype=main)
    if kind == "ltx":
        cls = diffusers.LTXImageToVideoPipeline if task == "image-to-video" else diffusers.LTXPipeline
        return cls.from_pretrained(path, torch_dtype=main)
    if kind == "cogvideox":
        return diffusers.CogVideoXPipeline.from_pretrained(path, torch_dtype=main)
    if kind == "cogvideox-i2v":
        return diffusers.CogVideoXImageToVideoPipeline.from_pretrained(path, torch_dtype=main)
    if kind == "animatediff":
        from safetensors.torch import load_file

        adapter_dir = repo_path(model["repos"][1])
        adapter = diffusers.MotionAdapter()
        adapter.load_state_dict(load_file(os.path.join(adapter_dir, "animatediff_lightning_4step_diffusers.safetensors"), device="cpu"))
        adapter = adapter.to(dtype=main)
        cls = diffusers.AnimateDiffVideoToVideoPipeline if task == "video-to-video" else diffusers.AnimateDiffPipeline
        pipe = cls.from_pretrained(path, motion_adapter=adapter, torch_dtype=main)
        pipe.scheduler = diffusers.EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing", beta_schedule="linear")
        return pipe
    raise ValueError(f"Unsupported pipeline {kind}")


def place(pipe, model, device, torch):
    """Move the pipeline to the device, offloading to system RAM when VRAM is short."""
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)  # the app shows its own progress
    mode = "cpu"
    if device == "cuda":
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        if vram >= model["fullVramGB"]:
            pipe.to("cuda")
            mode = "gpu"
        elif vram >= max(6, model["minVramGB"]) or model["pipeline"] == "animatediff":
            pipe.enable_model_cpu_offload()
            mode = "model-offload"
        else:
            pipe.enable_sequential_cpu_offload()
            mode = "sequential-offload"
    elif device == "mps":
        pipe.to("mps")
        mode = "mps"
    else:
        pipe.to("cpu")
    vae = getattr(pipe, "vae", None)
    if vae is not None and hasattr(vae, "enable_tiling") and model["pipeline"] != "animatediff":
        try:
            vae.enable_tiling()
        except Exception:
            pass
    if hasattr(pipe, "enable_vae_slicing") and model["pipeline"] == "animatediff":
        pipe.enable_vae_slicing()
    return mode


def frames_for(model, seconds):
    rule = model["frameRule"]
    if "fixed" in rule:
        return rule["fixed"]
    n = round(seconds * model["fps"] / rule["multiple"]) * rule["multiple"] + rule["offset"]
    return max(rule["multiple"] + rule["offset"], min(rule["max"], n))


def fit_image(path, width, height):
    from PIL import Image

    img = Image.open(path).convert("RGB")
    scale = max(width / img.width, height / img.height)
    img = img.resize((max(width, round(img.width * scale)), max(height, round(img.height * scale))), Image.LANCZOS)
    left = (img.width - width) // 2
    top = (img.height - height) // 2
    return img.crop((left, top, left + width, top + height))


def save_frames(frames, out_dir):
    import numpy as np
    from PIL import Image

    os.makedirs(out_dir, exist_ok=True)
    count = 0
    for i, f in enumerate(frames):
        if not isinstance(f, Image.Image):
            arr = np.asarray(f)
            if arr.dtype != np.uint8:
                arr = (np.clip(arr, 0, 1) * 255).round().astype(np.uint8)
            f = Image.fromarray(arr)
        f.save(os.path.join(out_dir, f"frame_{i:05d}.png"))
        count += 1
    return count


def cmd_generate(args):
    req = json.load(open(args.request, encoding="utf-8"))
    mid = req["model"]
    if mid.startswith("test-tiny-"):
        if os.environ.get("VOIDCRAFT_ENGINE_TEST") != "1":
            raise SystemExit("Test models are only available when VOIDCRAFT_ENGINE_TEST=1")
        import tiny_models

        model = tiny_models.CATALOG[mid]
    else:
        model = CATALOG.get(mid)
    if not model:
        raise SystemExit(f"Unknown model {mid}")
    task = req.get("task", "text-to-video")
    if task not in model["tasks"]:
        raise SystemExit(f"{model['name']} does not support {task}")

    import torch

    threads = os.cpu_count() or 4
    torch.set_num_threads(max(1, threads))
    device = req.get("device") or pick_device(torch)
    aspect = req.get("aspectRatio", "16:9")
    width, height = model["sizes"].get(aspect) or next(iter(model["sizes"].values()))
    num_frames = frames_for(model, float(req.get("duration", model["durations"][-1])))
    steps = int(req.get("steps") or model["steps"].get(req.get("quality", "standard"), model["steps"]["standard"]))
    guidance = float(req.get("guidance") or model["guidance"])

    emit("status", message=f"Loading {model['name']} on {device.upper()} (first load reads several GB from disk)…")
    t0 = time.time()
    if mid.startswith("test-tiny-"):
        pipe = tiny_models.build(model, torch, task)
    else:
        if not is_installed(model):
            raise SystemExit(f"{model['name']} is not downloaded. Download it in Settings → Local AI.")
        pipe = load_pipeline(model, device, torch, task)
    mode = place(pipe, model, device, torch)
    emit("status", message=f"Model loaded in {time.time() - t0:.0f}s ({mode}). Generating {num_frames} frames at {width}x{height}, {steps} steps…", width=width, height=height, frames=num_frames, steps=steps, mode=mode)

    gen = torch.Generator(device="cpu")
    seed = req.get("seed")
    seed = int(seed) if seed is not None else int.from_bytes(os.urandom(4), "little")
    gen.manual_seed(seed)

    started = time.time()

    def on_step(_pipe, step, _timestep, kwargs):
        done = step + 1
        elapsed = time.time() - started
        eta = elapsed / done * (steps - done) if done else None
        emit("progress", step=done, total=steps, fraction=min(0.97, done / steps * 0.95), etaSeconds=round(eta) if eta is not None else None)
        return kwargs

    kwargs = dict(
        prompt=req["prompt"],
        height=height,
        width=width,
        num_frames=num_frames,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=gen,
        callback_on_step_end=on_step,
        output_type="pil",
    )
    if model.get("negativePrompt") and req.get("negativePrompt"):
        kwargs["negative_prompt"] = req["negativePrompt"]
    if model["pipeline"] == "ltx":
        kwargs["frame_rate"] = model["fps"]
    if task == "image-to-video":
        if not req.get("image"):
            raise SystemExit("Image-to-video needs a start image")
        kwargs["image"] = fit_image(req["image"], width, height)
    if task == "video-to-video":
        frames_in = [fit_image(f, width, height) for f in req.get("videoFrames") or []]
        if not frames_in:
            raise SystemExit("Video-to-video needs source frames")
        del kwargs["num_frames"]
        kwargs["video"] = frames_in
        kwargs["strength"] = min(1.0, max(0.1, float(req.get("strength", 0.6))))
        kwargs["enforce_inference_steps"] = True

    result = pipe(**kwargs)
    frames = result.frames[0]
    emit("status", message="Saving frames…")
    count = save_frames(frames, req["outDir"])
    emit("result", frames=count, fps=model["fps"], width=width, height=height, seed=seed, seconds=round(time.time() - t0, 1), mode=mode, dir=req["outDir"])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doctor")
    d = sub.add_parser("download")
    d.add_argument("--model", required=True)
    x = sub.add_parser("delete")
    x.add_argument("--model", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--request", required=True)
    args = ap.parse_args()
    try:
        {"doctor": cmd_doctor, "download": cmd_download, "delete": cmd_delete, "generate": cmd_generate}[args.cmd](args)
    except SystemExit as e:
        if e.code not in (None, 0):
            emit("error", message=str(e.code))
            sys.exit(1)
    except Exception as e:  # report a readable message to the app
        msg = str(e)
        low = msg.lower()
        if "out of memory" in low or isinstance(e, MemoryError):
            msg = "Out of memory. Try a shorter duration, the Fast quality preset, a smaller model (CogVideoX 2B or AnimateDiff Lightning), or close other GPU apps. Details: " + msg
        emit("error", message=msg, trace=traceback.format_exc()[-3000:])
        sys.exit(1)


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    main()
