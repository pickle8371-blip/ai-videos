"""
Voidcraft local AI engine installer.

Creates engine/.venv, installs the right PyTorch build for this machine (CUDA for
NVIDIA GPUs, Apple MPS on macOS, CPU otherwise) and the libraries in
requirements.txt, then runs a self-check.

Usage:  python engine/setup_engine.py [--cpu] [--cuda] [--venv PATH]
Only the Python standard library is used here, so it runs on a fresh Python.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import venv

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"


def log(msg):
    print(f"[setup] {msg}", flush=True)


def venv_python(path):
    return os.path.join(path, "Scripts", "python.exe") if IS_WIN else os.path.join(path, "bin", "python")


def detect_nvidia():
    exe = shutil.which("nvidia-smi")
    if not exe and IS_WIN:
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.exists(candidate) else None
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
        line = out.stdout.strip().splitlines()[0]
        name, mem, driver = [x.strip() for x in line.split(",")]
        return {"name": name, "vram_gb": round(int(mem) / 1024, 1), "driver": driver}
    except Exception:
        return None


def run(cmd):
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(line, flush=True)
    code = proc.wait()
    if code != 0:
        raise SystemExit(f"Command failed with exit code {code}: {' '.join(cmd)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpu", action="store_true", help="install the CPU-only PyTorch build")
    ap.add_argument("--cuda", action="store_true", help="force the NVIDIA CUDA PyTorch build")
    ap.add_argument("--venv", default=os.path.join(HERE, ".venv"))
    args = ap.parse_args()

    if sys.version_info < (3, 9):
        raise SystemExit("Python 3.9 or newer is required (3.10-3.12 recommended).")
    if sys.version_info >= (3, 14):
        log("WARNING: Python 3.14+ may not have PyTorch wheels yet. Python 3.12 is recommended.")
    log(f"Python {platform.python_version()} on {platform.system()} {platform.machine()}")

    gpu = None if args.cpu else detect_nvidia()
    if gpu:
        log(f"NVIDIA GPU: {gpu['name']} ({gpu['vram_gb']} GB, driver {gpu['driver']})")
    elif IS_MAC:
        log("macOS detected: PyTorch will use the Apple GPU (MPS) when available.")
    else:
        log("No NVIDIA GPU detected: installing the CPU build. Generation will be slow; AnimateDiff Lightning is the practical model on CPU.")

    if not os.path.exists(venv_python(args.venv)):
        log(f"Creating virtual environment at {args.venv}")
        venv.EnvBuilder(with_pip=True, clear=False).create(args.venv)
    py = venv_python(args.venv)
    run([py, "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"])

    use_cuda = bool(gpu) or args.cuda
    if use_cuda and (IS_WIN or platform.system() == "Linux"):
        # RTX 50-series (Blackwell) needs CUDA 12.8 wheels; others work with 12.6.
        tag = "cu128" if gpu and "RTX 50" in gpu["name"].upper() else "cu126"
        try:
            run([py, "-m", "pip", "install", "torch", "--index-url", f"https://download.pytorch.org/whl/{tag}"])
        except SystemExit:
            if IS_WIN:
                raise
            log("CUDA index unreachable; falling back to the default PyPI build (includes CUDA on Linux).")
            run([py, "-m", "pip", "install", "torch"])
    elif platform.system() == "Linux":
        try:
            run([py, "-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"])
        except SystemExit:
            log("CPU index unreachable; falling back to the default PyPI build.")
            run([py, "-m", "pip", "install", "torch"])
    else:
        run([py, "-m", "pip", "install", "torch"])

    run([py, "-m", "pip", "install", "-r", os.path.join(HERE, "requirements.txt")])

    log("Running self-check")
    out = subprocess.run([py, os.path.join(HERE, "voidcraft_engine.py"), "doctor"], capture_output=True, text=True)
    print(out.stdout.strip(), flush=True)
    if out.returncode != 0:
        print(out.stderr[-2000:], flush=True)
        raise SystemExit("Self-check failed")
    info = json.loads(out.stdout.strip().splitlines()[-1])
    if use_cuda and not info.get("cuda"):
        log("WARNING: an NVIDIA GPU was found but PyTorch cannot use it. Update the NVIDIA driver and run setup again.")
    log("Engine ready.")


if __name__ == "__main__":
    main()
