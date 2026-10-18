# Voidcraft.Video

A local AI video production studio: text-to-video and image-to-video generation through
connected providers, an AI storyboard, character and scene libraries, a multitrack editor with
a live preview, an audio studio, visual effects, and FFmpeg-based export.

Voidcraft never pretends an AI model produced something it didn't. Every generated file carries
provenance; files from the built-in **local test renderer** and **FFmpeg tools** are labelled
"Not AI" on screen and in their metadata, and the local renderer burns a "NOT AI GENERATED"
label into every frame.

Workspaces: Home · AI Video Generator · Image to Video · Video to Video · AI Storyboard · Character
Studio · Scene Studio · Video Editor & Timeline · Audio Studio · Visual Effects · AI Tools · Templates ·
Asset Library · Generation History · Project Settings · Settings.

## What works out of the box

| Area | Without API keys (demo mode) | With a provider connected |
| --- | --- | --- |
| Projects | Create / open / save / save as / duplicate / rename / delete, autosave + crash recovery, templates, `.voidcraft` bundle import/export | same |
| Editor | Multitrack timeline (move, trim, split, ripple delete, duplicate, speed, volume, fades, crop/position/scale, colour, keyframes, transitions, titles, subtitles), live preview, exact-frame and preview renders, export to MP4/MOV/WebM | same |
| Generation | Local test renderer (labelled placeholder clips, Ken Burns motion on images, filter restyle) | Text-to-video, image-to-video and images via Replicate, fal.ai, Luma, Runway, OpenAI (Sora, GPT Image), Google Veo |
| Text tools | Offline template engine (labelled "not AI") for prompt expansion, shot lists, transitions | Anthropic Claude or OpenAI for prompt enhancement, storyboards, scene continuation, shot & transition suggestions |
| Audio | Import, mix, mute/solo, fades, voice-over recording, SRT import/export | Text-to-speech (OpenAI, ElevenLabs), Whisper transcription → subtitles |
| Tools | FFmpeg frame interpolation, upscaling, reframing, image enhancement, frame/audio extraction, scene-cut detection | Any custom Replicate/fal model (background removal, AI upscaling, lip-sync, video-to-video…) |

## Requirements

- **Node.js 20.10+** (22 LTS recommended)
- **FFmpeg + FFprobe** on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`). Builds with `libx264`,
  `libfreetype` (drawtext), `libvpx` and `libmp3lame` are recommended; standard distributions include them.
- A modern browser. Chrome/Edge play H.264 in the live preview; some open-source Chromium builds
  cannot — the preview then tells you, and "Exact frame" / "Render preview" still work.

## Install & run on Windows

1. Install Node.js 22 LTS from <https://nodejs.org> (or `winget install OpenJS.NodeJS.LTS`).
2. Install FFmpeg: `winget install Gyan.FFmpeg` (or download a build from <https://www.gyan.dev/ffmpeg/builds/>
   and add its `bin` folder to `PATH`). Open a **new** terminal and check `ffmpeg -version`.
3. In the project folder, double-click **`start-windows.bat`**, or in PowerShell:

   ```powershell
   npm install
   npm run build
   npm start
   ```

4. Open <http://localhost:5174>.

`start-windows.bat` installs dependencies on first run, builds the app if needed, checks for FFmpeg,
and starts the server. Data is stored in `.\data` next to the app (change with `VOIDCRAFT_DATA_DIR`).

## Install & run on macOS / Linux

```bash
# macOS: brew install node ffmpeg      Debian/Ubuntu: sudo apt install nodejs npm ffmpeg
npm install
npm run build
npm start            # http://localhost:5174
```

### Development mode

```bash
npm run dev          # API on :5174, Vite dev server with hot reload on http://localhost:5173
```

## Connecting AI providers

Open **Settings → Providers**, paste an API key and press **Save & test**. Keys are sent once to the
local server, encrypted with AES-256-GCM in `data/secrets.json` (key in `data/secret.key`, or derived
from `VOIDCRAFT_SECRET_KEY`), and never returned to the browser — the UI only shows `••••1234`.
Environment variables override stored keys:

| Provider | Variable | Used for |
| --- | --- | --- |
| Replicate | `REPLICATE_API_TOKEN` | Veo 3, Seedance, MiniMax, Kling, FLUX, custom models |
| fal.ai | `FAL_KEY` | Kling 2.1, Hailuo-02, Veo 3, FLUX, custom endpoints |
| Luma AI | `LUMA_API_KEY` | Ray 2 / Ray Flash 2 video, Photon images |
| Runway | `RUNWAYML_API_SECRET` | Gen-4 Turbo image-to-video |
| OpenAI | `OPENAI_API_KEY` (+ `OPENAI_CHAT_MODEL`) | Sora 2, GPT Image, TTS, Whisper, text tools |
| Google Gemini API | `GEMINI_API_KEY` | Veo 3 / Veo 3 Fast |
| Anthropic | `ANTHROPIC_API_KEY` | Claude for prompt/storyboard tools |
| ElevenLabs | `ELEVENLABS_API_KEY` | Text-to-speech |

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for model capabilities, limitations, costs, custom models
and the `VOIDCRAFT_PUBLIC_URL` requirement for providers that fetch inputs by URL.

## A five-minute tour

1. **Home → Open the demo project.** It is built from synthetic sample media (labelled "sample") and
   shows a storyboard, a character, an environment, a three-clip edit with transitions, titles,
   subtitles, music, SFX and a letterbox.
2. **Video Editor & Timeline.** Drag clips, trim edges, press `S` to split, `K` to keyframe, edit
   properties on the right. Press **Exact frame** to see the FFmpeg render of the current frame.
3. **AI Video Generator.** Try a sample prompt. Without keys the local test renderer produces a
   labelled placeholder; with a provider connected, choose a real model. Unsupported controls are
   disabled per model.
4. **AI Storyboard.** Describe an idea → *Propose shot list* → generate shots individually →
   *Arrange clips on timeline*.
5. **File → Export video** (`Ctrl+E`). The output is validated with ffprobe before it is reported as done.

Sample prompts live in **Templates → Saved prompts** and in the generator's empty state.

## Testing

```bash
npm test                 # unit + integration (Vitest)
npm run test:unit        # pure logic: timeline ops, schema, prompts, security, mocked provider adapters
npm run test:integration # real server + real FFmpeg; AI providers are MOCKED (no paid calls)
npm run test:e2e         # Playwright: drives the built app in Chromium
npm run typecheck
```

No test calls a paid API. Provider adapters are verified against mocked HTTP responses
(`tests/unit/providers.test.ts`) and a scripted fake provider (`tests/integration/jobs.test.ts`).
Real-model generation must be checked manually with your own keys; see docs/PROVIDERS.md → "Verifying a provider".

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOIDCRAFT_PORT` | `5174` | HTTP port |
| `VOIDCRAFT_HOST` | `127.0.0.1` | Bind address (keep loopback unless you add authentication) |
| `VOIDCRAFT_DATA_DIR` | `./data` | Projects, media, jobs, settings, encrypted secrets |
| `VOIDCRAFT_PUBLIC_URL` | – | Public base URL so providers can fetch inputs by URL (Luma keyframes, custom video/audio inputs) |
| `VOIDCRAFT_SECRET_KEY` | – | Passphrase for credential encryption (otherwise a random key file is created) |
| `VOIDCRAFT_MAX_VIDEO_MB` / `_IMAGE_MB` / `_AUDIO_MB` | 2048 / 40 / 500 | Upload limits |
| `FFMPEG_PATH`, `FFPROBE_PATH` | auto-detect | FFmpeg binaries |
| `VOIDCRAFT_FONT_FILE` | auto-detect | Font for titles/subtitles |
| `VOIDCRAFT_ALLOWED_HOSTS` | – | Extra Host header values to accept (comma separated) |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, job lifecycle, render pipeline, security model
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — provider setup, models, limitations, custom models
- [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) — project JSON and `.voidcraft` bundle format

## Honest limitations

- Generation quality, speed, cost and availability depend entirely on the provider you connect.
  Provider APIs change; adapters follow the published APIs at the time of writing and are covered
  by mocked tests, not live ones.
- Character consistency across shots is assisted (descriptions, references, review tools), never guaranteed.
- The live preview approximates some effects (grain, bloom, fog…) and cannot play codecs your browser
  lacks; exports and "Exact frame" always use the FFmpeg pipeline.
- Video-to-video, background/object removal, AI upscaling, AI interpolation and lip-sync need a
  model you register as a custom Replicate/fal model; built-in FFmpeg tools are conventional processing.
- The server is designed for a single local user. Do not expose it to a network without adding authentication.
