# Local AI video generation (no API keys)

Voidcraft generates video **on your own computer** with open-weight AI video models. It uses
PyTorch and Hugging Face diffusers. No API keys are needed and nothing is sent to a cloud
service. The only network access is a one-time download of the engine and the model weights.

These are real diffusion models. Voidcraft doesn't train a model from scratch, because a
foundation video model takes thousands of GPUs. It runs published open models locally, and
after the download they are yours to use offline.

## Hardware

| Model | Tasks | Download | GPU memory | Output |
| --- | --- | --- | --- | --- |
| **Wan 2.1 T2V 1.3B** | text→video | ~29 GB | 8 GB+ (with CPU offloading; 24 GB runs fully on GPU) | 832×480, 16 fps, up to 5 s |
| **LTX-Video** | text→video, image→video | ~28 GB | 8 GB+ (12 GB+ comfortable) | 768×448, 24 fps, up to 6 s |
| **CogVideoX 2B** | text→video | ~14 GB | 4–6 GB with offloading | 720×480, 8 fps, 6 s |
| **CogVideoX 5B I2V** | image→video | ~22 GB | 6 GB+ with offloading (slow) | 720×480, 8 fps, 6 s |
| **AnimateDiff Lightning** | text→video, video→video | ~6 GB | 4 GB, or CPU | 768×432 (16:9), 8 fps, 2 s |

- **NVIDIA GPU (recommended).** Install a recent driver. RTX 20xx or newer works; RTX 30/40/50 is best.
- **Apple Silicon.** Uses the Apple GPU (MPS). It works but is slower than a comparable NVIDIA card.
- **No GPU.** Only AnimateDiff Lightning is practical, and it takes several minutes per clip.
- **Disk.** Allow ~5 GB for the engine plus each model you download. Models are stored in
  `data/models` (Hugging Face cache layout).

Voidcraft checks your GPU, recommends a model, warns when a model needs more memory than you
have, and automatically uses CPU offloading to fit smaller cards.

## Setup on Windows

1. Install **Python** if you don't have it: `winget install Python.Python.3.12`, or use python.org
   and tick "Add python.exe to PATH". Any Python 3 version works; it is only used to start the installer.
2. Double-click **`setup-ai-windows.bat`**. Alternatively, open the app and click
   **Settings → Local AI → Install engine**. Either way it:
   - installs the small `uv` package manager into `engine\.bootstrap`;
   - creates `engine\.venv` with a 64-bit Python 3.12. If your installed Python can't run PyTorch
     (too new or 32-bit), a private copy is downloaded into `engine\.python`. Your installed Python
     is not changed;
   - detects your NVIDIA GPU;
   - installs the matching CUDA build of PyTorch plus diffusers (~3–5 GB);
   - runs a self-check.
3. Start the app with `start-windows.bat`.
4. Open **Settings → Local AI** and click **Download** next to a model. The recommended model is
   marked. This is a one-time download.
5. Go to **AI Video Generator**, pick the model under *On this computer (no API)*, write a prompt
   and press **Generate**.

## Setup on macOS / Linux

```bash
python3.12 engine/setup_engine.py        # add --cpu to force the CPU build
npm start
```

Then download a model in **Settings → Local AI**.

## What happens when you press Generate

1. The server writes a request file and starts `engine/voidcraft_engine.py generate`. Only one
   generation runs at a time, so the GPU is never shared between jobs.
2. The engine loads the diffusers pipeline from `data/models` in offline mode and places it on the
   GPU, either fully or with CPU offloading depending on memory. It then runs the denoising
   steps and reports progress after each step.
3. The frames are encoded to H.264 MP4 with FFmpeg. The clip is validated with ffprobe and added
   to your library, with provenance `aiGenerated: true` and the model id and seed.

**Quality** sets the number of denoising steps: *Fast*, *Standard* or *High*. The first
generation after starting the app is slower because the model has to load.

## Typical speeds

These are rough figures for a 5 s clip at standard quality.

| Model | RTX 4090 | RTX 3060 12 GB | 8 GB laptop GPU |
| --- | --- | --- | --- |
| Wan 2.1 1.3B | ~2–4 min | ~8–12 min | ~15–25 min (offloaded) |
| LTX-Video | ~30–60 s | ~2–4 min | ~5–10 min |
| AnimateDiff Lightning (2 s) | ~5 s | ~15 s | ~30 s |

## Troubleshooting

- **"Python 3 was not found".** Install Python (`winget install Python.Python.3.12`), then reopen the terminal or app.
- **"Could not find a version that satisfies the requirement torch".** This came from older versions
  of the installer when the installed Python was too new or 32-bit. The installer now sets up its own
  64-bit Python 3.12 in `engine\.python`, so run `setup-ai-windows.bat` again. If it still fails, the
  download is blocked: allow Python through your firewall/antivirus (turn off "HTTPS scanning" while
  installing) or try another network.
- **"Could not reach huggingface.co".** A firewall, proxy or antivirus is blocking the model
  download. Allow `huggingface.co` and `*.hf.co`, or download on another network.
- **"Out of GPU memory".** Close other GPU apps (games, browsers with hardware acceleration).
  You can also pick a shorter duration or Fast quality, or use a smaller model (CogVideoX 2B or
  AnimateDiff Lightning).
- **Engine shows "error".** Run `setup-ai-windows.bat` again, or
  `engine\.venv\Scripts\python engine\voidcraft_engine.py doctor`, and read the message.
  Re-running the setup is safe.
- **Remove a model.** Use **Settings → Local AI → Delete**. To remove the engine, delete
  `engine\.venv`.

## Licences

Each model has its own licence, shown in Settings → Local AI. Wan 2.1 is Apache-2.0.
LTX-Video uses the LTXV Open Weights licence. CogVideoX 2B is Apache-2.0, and CogVideoX 5B uses
the CogVideoX licence. AnimateDiff Lightning is CreativeML Open RAIL++-M (its base model is Open RAIL-M). Check a model's
licence before using its output commercially.

## Tests

`tests/integration/localai.test.ts` drives the real engine through the HTTP API. It covers
text→video through the Wan, LTX, CogVideoX and AnimateDiff pipelines, LTX image→video,
AnimateDiff video→video, progress reporting, cancellation, download failures and validation.

CI can't download multi-GB weights, so these tests use tiny random-weight models. They are built
from the same diffusers pipeline classes and appear only when `VOIDCRAFT_ENGINE_TEST=1`. Their
output is noise; the tests check the code path, not image quality.
