"""
Voidcraft local AI engine installer.

Creates engine/.venv with a Python that PyTorch supports, installs the right
PyTorch build for this machine (CUDA for NVIDIA GPUs, Apple MPS on macOS, CPU
otherwise) and the libraries in requirements.txt, then runs a self-check.

Any Python 3.8+ can run this script. The engine itself does not use that Python:
the installer uses uv (https://docs.astral.sh/uv/) to set up a private 64-bit
Python 3.12 inside engine/ when the installed Python can't run PyTorch, for
example when it is too new or 32-bit. PyTorch wheels exist only for 64-bit
Python and lag new Python releases, which otherwise makes pip fail with
"Could not find a version that satisfies the requirement torch".

Usage:  python engine/setup_engine.py [--cpu] [--cuda] [--venv PATH]
Only the Python standard library is used here, so it runs on a fresh Python.
"""
import argparse
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import urllib.request
import venv

HERE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"
ENGINE_PYTHON = "3.12"
# Python versions PyTorch publishes wheels for on every platform we target.
SUPPORTED = ((3, 10), (3, 13))
BOOT = os.path.join(HERE, ".bootstrap")
RECENT = []  # recent tool output, to explain failures


def log(msg):
    print(f"[setup] {msg}", flush=True)


def fail(msg):
    print(f"[setup] ERROR: {msg}", flush=True)
    raise SystemExit(1)


def venv_python(path):
    return os.path.join(path, "Scripts", "python.exe") if IS_WIN else os.path.join(path, "bin", "python")


def os_arch():
    """CPU architecture of the operating system, even when this Python is 32-bit on 64-bit Windows."""
    if IS_WIN:
        a = (os.environ.get("PROCESSOR_ARCHITEW6432") or os.environ.get("PROCESSOR_ARCHITECTURE") or platform.machine()).upper()
        return {"AMD64": "x86_64", "X86_64": "x86_64", "ARM64": "aarch64", "X86": "x86"}.get(a, a.lower())
    m = platform.machine().lower()
    return {"amd64": "x86_64", "arm64": "aarch64"}.get(m, m)


def describe(py):
    """(major, minor, bits) of a Python executable, or None if it does not run."""
    try:
        out = subprocess.run([py, "-c", "import sys, struct; print(sys.version_info[0], sys.version_info[1], struct.calcsize('P') * 8)"], capture_output=True, text=True, timeout=60)
        major, minor, bits = (int(x) for x in out.stdout.split())
        return major, minor, bits
    except Exception:
        return None


def torch_ready(info):
    return info is not None and info[2] == 64 and SUPPORTED[0] <= (info[0], info[1]) <= SUPPORTED[1]


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


def run(cmd, env=None):
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env, encoding="utf-8", errors="replace")
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(line, flush=True)
            RECENT.append(line)
            del RECENT[:-40]
    code = proc.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, cmd)


def details():
    """The most telling line of the last failed command (pip/uv error text), for error messages."""
    marks = ("error", "×", "╰─▶", "No solution", "not found", "Could not", "Failed", "Because")
    hits = [l.strip(" │╰─▶×") for l in RECENT if any(m.lower() in l.lower() for m in marks)]
    return f" Details: {hits[-1][:300]}" if hits else ""


def check_internet():
    """Report early, and in plain words, when the package servers can't be reached."""
    for url in ("https://pypi.org/simple/uv/", "https://download.pytorch.org/whl/"):
        try:
            urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "voidcraft-setup"}), timeout=30).close()
        except Exception as err:  # noqa: BLE001 - report whatever went wrong
            text = str(getattr(err, "reason", err))
            hint = (
                "a security product is intercepting HTTPS (antivirus 'HTTPS scanning' / 'web shield'), or the PC clock is wrong"
                if "CERTIFICATE" in text.upper() or "SSL" in text.upper()
                else "there is no internet connection, or a firewall/proxy/VPN is blocking it"
            )
            log(f"WARNING: could not reach {url} ({text}). Likely cause: {hint}. Downloads below will probably fail.")


def get_uv():
    """uv in a small bootstrap venv made with the Python running this script (any 3.8+ works)."""
    uv = os.path.join(BOOT, "Scripts", "uv.exe") if IS_WIN else os.path.join(BOOT, "bin", "uv")
    if os.path.exists(uv):
        return uv
    log("Installing the uv package manager (small, one time)")
    if os.path.exists(BOOT):
        shutil.rmtree(BOOT, ignore_errors=True)
    venv.EnvBuilder(with_pip=True).create(BOOT)
    try:
        run([venv_python(BOOT), "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "uv"])
    except subprocess.CalledProcessError:
        fail("Could not download uv from pypi.org. Check your internet connection, and that no firewall, proxy or antivirus blocks Python." + details())
    return uv


def uv_env():
    env = dict(os.environ)
    # Keep everything the engine needs inside engine/ so deleting that folder removes it all.
    env["UV_PYTHON_INSTALL_DIR"] = os.path.join(HERE, ".python")
    env["UV_CACHE_DIR"] = os.path.join(HERE, ".uv-cache")
    env["UV_HTTP_TIMEOUT"] = "300"
    env["UV_LINK_MODE"] = "copy"
    if IS_WIN:
        # Trust the Windows certificate store (works with antivirus HTTPS scanning and corporate proxies).
        env["UV_SYSTEM_CERTS"] = "1"
    return env


def python_request():
    """A uv request for a 64-bit CPython that PyTorch supports on this OS."""
    arch = os_arch()
    if IS_WIN:
        if arch == "x86":
            fail("PyTorch needs 64-bit Windows; this computer runs 32-bit Windows.")
        return f"cpython-{ENGINE_PYTHON}-windows-{arch}-none"
    if IS_LINUX:
        return f"cpython-{ENGINE_PYTHON}-linux-{arch}-gnu"
    return ENGINE_PYTHON


def make_venv(uv, path):
    py = venv_python(path)
    info = describe(py) if os.path.exists(py) else None
    if os.path.exists(path) and torch_ready(info):
        log(f"Using existing environment {path} (Python {info[0]}.{info[1]}, 64-bit)")
        return py
    if os.path.exists(path):
        why = "does not run" if info is None else f"uses Python {info[0]}.{info[1]} {info[2]}-bit, which PyTorch does not support"
        log(f"Recreating {path}: it {why}")
        shutil.rmtree(path, ignore_errors=True)
        if os.path.exists(path):
            fail(f"Could not delete {path}. Close Voidcraft and any program using it, delete the folder, and run setup again.")
    here = (sys.version_info[0], sys.version_info[1], struct.calcsize("P") * 8)
    # VOIDCRAFT_PRIVATE_PYTHON=1 always uses the private Python (also used by tests).
    if torch_ready(here) and os.environ.get("VOIDCRAFT_PRIVATE_PYTHON") != "1":
        log(f"Creating the engine environment with this Python ({platform.python_version()}, 64-bit)")
        request = sys.executable
    else:
        log(f"This Python ({platform.python_version()}, {here[2]}-bit) can't run PyTorch, so a private Python {ENGINE_PYTHON} (64-bit) is set up for the engine. Your installed Python is not changed.")
        request = python_request()
    try:
        run([uv, "venv", "--seed", "--python", request, path], env=uv_env())
    except subprocess.CalledProcessError:
        fail(
            f"Could not set up Python {ENGINE_PYTHON} for the engine (download from github.com failed). "
            f"Install Python {ENGINE_PYTHON} 64-bit yourself (Windows: winget install Python.Python.3.12, or python.org), then run setup again."
            + details()
        )
    return py


def pip_install(uv, py, args):
    run([uv, "pip", "install", "--python", py, *args], env=uv_env())


def install_torch(uv, py, gpu, force_cuda):
    use_cuda = (bool(gpu) or force_cuda) and (IS_WIN or IS_LINUX)
    if use_cuda:
        # RTX 50-series (Blackwell) needs CUDA 12.8 wheels; others work with 12.6.
        tag = "cu128" if gpu and "RTX 50" in gpu["name"].upper() else "cu126"
        try:
            pip_install(uv, py, ["torch", "--index-url", f"https://download.pytorch.org/whl/{tag}"])
            return True
        except subprocess.CalledProcessError:
            log(f"WARNING: the NVIDIA ({tag}) PyTorch build could not be installed; installing the CPU build instead. Generation will be slow.")
    attempts = [["torch", "--index-url", "https://download.pytorch.org/whl/cpu"], ["torch"]] if not IS_MAC else [["torch"]]
    for i, a in enumerate(attempts):
        try:
            pip_install(uv, py, a)
            return False
        except subprocess.CalledProcessError:
            if i + 1 < len(attempts):
                log("Retrying with the default package index (pypi.org)")
    info = describe(py)
    fail(
        "PyTorch could not be installed"
        + (f" for Python {info[0]}.{info[1]} {info[2]}-bit" if info else "")
        + ". This is almost always a blocked download: check your internet connection and allow Python through your firewall/antivirus, then run setup again."
        + details()
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpu", action="store_true", help="install the CPU-only PyTorch build")
    ap.add_argument("--cuda", action="store_true", help="force the NVIDIA CUDA PyTorch build")
    ap.add_argument("--venv", default=os.path.join(HERE, ".venv"))
    args = ap.parse_args()

    if sys.version_info < (3, 8):
        fail("Python 3.8 or newer is needed to run the installer.")
    log(f"Installer running on Python {platform.python_version()} ({struct.calcsize('P') * 8}-bit), {platform.system()} {platform.release()} {os_arch()}")

    gpu = None if args.cpu else detect_nvidia()
    if gpu:
        log(f"NVIDIA GPU: {gpu['name']} ({gpu['vram_gb']} GB, driver {gpu['driver']})")
    elif IS_MAC:
        log("macOS detected: PyTorch will use the Apple GPU (MPS) when available.")
    elif args.cpu:
        log("CPU-only install requested.")
    else:
        log("No NVIDIA GPU detected: installing the CPU build. Generation will be slow; AnimateDiff Lightning is the practical model on CPU.")

    check_internet()
    uv = get_uv()
    py = make_venv(uv, args.venv)
    log("Installing PyTorch (about 0.3 GB for CPU, 2-3 GB for NVIDIA). This can take a while.")
    cuda = install_torch(uv, py, gpu, args.cuda)
    log("Installing diffusers and the other engine libraries")
    try:
        pip_install(uv, py, ["-r", os.path.join(HERE, "requirements.txt")])
    except subprocess.CalledProcessError:
        fail("The engine libraries could not be installed. Check your internet connection and run setup again." + details())

    log("Running self-check")
    out = subprocess.run([py, os.path.join(HERE, "voidcraft_engine.py"), "doctor"], capture_output=True, text=True)
    print(out.stdout.strip(), flush=True)
    if out.returncode != 0:
        print(out.stderr[-2000:], flush=True)
        fail("Self-check failed")
    info = json.loads(out.stdout.strip().splitlines()[-1])
    if not info.get("engine"):
        fail(f"Self-check failed: {info.get('error')}")
    if cuda and not info.get("cuda"):
        log("WARNING: an NVIDIA GPU was found but PyTorch cannot use it. Update the NVIDIA driver (nvidia.com/drivers) and run setup again.")
    log("Engine ready.")


if __name__ == "__main__":
    main()
