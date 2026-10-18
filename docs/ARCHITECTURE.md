# Architecture

```
web/ (React + TypeScript + Vite)          server/ (Node + Express + TypeScript)
┌────────────────────────────────┐        ┌───────────────────────────────────────────┐
│ workspaces/  components/        │  HTTP  │ app.ts        routes, guards, errors       │
│ store/ (zustand + immer undo)   │ ─────▶ │ storage/      projects, assets, settings,  │
│ lib/compositor.ts (live preview)│  SSE   │               secrets (AES-GCM), JSON I/O  │
│ api.ts                          │ ◀───── │ jobs/         job manager (queue/poll/...) │
└────────────────────────────────┘        │ providers/    adapters + registry + http   │
            shared/ (types, Zod schema,    │ media/        ffmpeg runner, probe, render │
            timeline ops, prompt builder)  │               compiler, effects, filetype  │
                                           │ exports.ts    export/preview jobs          │
                                           │ ai.ts         text tools (LLM / offline)   │
                                           └──────────────────┬────────────────────────┘
                                             providers/localai.ts spawns (JSON lines)
                                                              ▼
                                           engine/ (Python: PyTorch + diffusers)
                                             voidcraft_engine.py doctor | download | generate
                                             models.json (catalog) · weights in data/models
```

- **engine/** is the local AI generator. `providers/localai.ts` runs one generation at a time as a
  subprocess, reads JSON-line progress events, and encodes the returned PNG frames to H.264 with
  FFmpeg. See [LOCAL_AI.md](LOCAL_AI.md).

- **shared/** is imported by both sides: the project schema (`project.ts`), timeline math
  (`timeline.ts`), editing operations (`ops.ts`), effect definitions (`effects.ts`), prompt
  composition (`prompt.ts`) and API types (`api.ts`). The same `ops.ts` functions back the UI and
  the tests.
- **Storage** is plain files under `data/` written atomically (temp file + fsync + rename, with
  retries for Windows file locks) and serialised per file. No database server is required.

## Project state & undo

The browser holds the open project in a zustand store. Every edit goes through
`apply(label, recipe)` (immer), which pushes the previous state onto the undo stack. Pointer drags
use transient updates and commit one undo step at the end; slider drags coalesce. Autosave posts
the document to the recovery slot every N seconds; Save writes `project.json`, rotates backups and
clears the slot. If the server is unreachable, a copy is kept in `localStorage`. Opening a project
offers to restore whichever recovery copy is newer than the saved file.

## Job lifecycle

```
POST /api/jobs ─▶ validate (provider enabled & configured, model supports task, assets exist,
                  values snapped to capabilities) ─▶ compose prompt ─▶ queued
queued ─▶ submitting ─(provider.submit)─▶ running ─(poll every VOIDCRAFT_POLL_MS)─▶ downloading
       ─▶ import result (magic bytes + ffprobe) ─▶ succeeded
any step ─▶ failed (message kept, parameters kept → Retry) | canceled (provider.cancel if supported)
```

- Job records are persisted on every transition and streamed to the UI over Server-Sent Events.
- Concurrency is limited (Settings → Performance). Exports and tools are jobs too.
- Transient HTTP errors retry with backoff; consecutive poll failures are tolerated up to a limit.
- A per-job timeout cancels remotely when possible and reports a clear error.
- **Recovery:** on start-up, jobs with a provider-side id resume polling; jobs interrupted before
  submission are marked failed with an explanation and can be retried.

## Render pipeline

`media/render.ts` compiles a project into one FFmpeg invocation:

1. A `color` source at the export size is the base layer.
2. Each visual clip becomes an input trimmed with `-ss/-t` (stills loop), then:
   `setpts` (speed) → `fps` → crop → fit scale → `eq`/`hue`/`exposure`/`colorbalance` →
   effect chain → shift to timeline time → alpha (opacity / keyframes via `geq`) → fades and
   transitions (`fade`, alpha fades, slide offsets) → optional animated scale → `overlay` with
   keyframed position.
3. Master effects, then titles and burned-in subtitles (`drawtext` with text files, so no escaping issues).
4. Audio: every audible clip (respecting track mute/solo/volume, clip mute/volume/fades/speed via
   `atempo`) is delayed to its position and mixed with `amix`.
5. Encoders: H.264, H.265, VP9 (WebM) or ProRes (MOV); `+faststart` for MP4/MOV.

The filtergraph is written to a script file (Windows command-line limits). Progress comes from
`-progress pipe:1`; cancellation kills the process. Outputs are validated with ffprobe
(streams, size, duration, audio) before being reported as exported. The same compiler renders
single exact frames and low-resolution previews.

The browser's live preview (`web/src/lib/compositor.ts`) draws the same timeline onto a canvas with
media elements, reproducing transforms, opacity, fades, transitions, keyframes, colour (canvas
filters), titles, subtitles and some effects. It is labelled as approximate; the export is the reference.

## Security model

- Single local user; the server binds to loopback by default.
- `Host` allow-list (DNS rebinding) and same-origin check for state-changing requests (CSRF).
- Credentials: server-only, AES-256-GCM at rest, masked in responses, redacted in logs.
- Uploads: magic-byte sniffing, ffprobe decoding, per-type size limits, sanitised names,
  asset ids validated before touching the filesystem.
- Imports: strict schema validation, whitelisted ZIP entry names, entry/size caps.
- FFmpeg is spawned without a shell; user text reaches `drawtext` only via files with
  `expansion=none`.
