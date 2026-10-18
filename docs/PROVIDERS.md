# Providers

Voidcraft talks to AI services through small adapters in `server/providers/`. Each adapter
implements the same interface (`server/providers/types.ts`):

```ts
interface Provider {
  info: { id, name, isAI, categories, credentialFields, supportsCancel, limitations, docsUrl };
  models(settings, config): ModelInfo[];          // capability discovery for the UI
  testConnection?(ctx): Promise<{ ok, message }>;
  submit?(job, model, ctx): Promise<{ providerJobId, state?, immediate? }>;
  poll?(job, model, ctx): Promise<PollResult>;    // running | succeeded(outputs) | failed | canceled
  cancel?(job, model, ctx): Promise<void>;
  llm?(request, ctx): Promise<string>;            // language-model providers
}
```

The job manager (`server/jobs/manager.ts`) owns everything else: capability validation, prompt
composition (camera, style, lighting, characters and environments become plain-language prompt
text unless a model has native controls), concurrency, polling, retries on transient errors
(429 / 5xx / network, honouring `Retry-After`), timeouts, cancellation, result download,
ffprobe validation of results, provenance, usage counters and recovery after restarts.

## Capability-aware UI

Every `ModelInfo` declares what it supports — durations, aspect ratios, resolutions, frame rates,
negative prompt, seed, variations, end frame, reference images, camera handling (`native`,
`prompt` or `none`), input transport (`data-uri`, `public-url`, `upload`). The generator disables
controls a model does not support and snaps values to supported ones; the server re-validates
everything.

## Built-in adapters

### Local test renderer (`local-test`) — not AI
FFmpeg placeholder clips so the pipeline can be exercised without keys. Text-to-video renders an
animated gradient with the prompt text; image-to-video applies Ken Burns motion that follows the
chosen camera move; video-to-video applies a filter restyle. Every frame carries a
"NOT AI GENERATED" label and assets record `provenance.aiGenerated = false`.

### Local FFmpeg tools (`local-tools`) — not AI
Frame interpolation (`minterpolate`), upscaling (Lanczos + unsharp), aspect reframing (crop around
a focus point), image enhancement (denoise/sharpen/tone), frame extraction, audio extraction and
scene-cut detection.

### Offline templates (`offline-templates`) — not AI
Deterministic rules for prompt expansion, shot lists, scene continuation, shot and transition
suggestions. Always labelled as non-AI in the UI.

### Replicate (`replicate`) — `REPLICATE_API_TOKEN`
API: `POST /v1/models/{owner}/{name}/predictions`, `GET /v1/predictions/{id}`,
`POST /v1/predictions/{id}/cancel`. Built-in catalog:

| Model | Tasks | Notes |
| --- | --- | --- |
| `google/veo-3` | text→video, image→video | 8 s, 16:9 / 9:16, 720p/1080p, audio |
| `bytedance/seedance-1-pro` | text→video, image→video | 5/10 s, 480p/1080p, many ratios |
| `minimax/video-01` | text→video, image→video | fixed 6 s 720p |
| `kwaivgi/kling-v2.1` | image→video | 5/10 s, optional end frame (pro mode) |
| `black-forest-labs/flux-schnell` | text→image | storyboard frames |

Images are sent as data URIs (downscaled to ≤ ~7 MB). Replicate bills per second or per output.

### fal.ai (`fal`) — `FAL_KEY`
Queue API: `POST https://queue.fal.run/{model}` returns `status_url`, `response_url`,
`cancel_url`, which the adapter uses verbatim (it refuses URLs outside fal's domains).
Catalog: Kling 2.1 Master (t2v, i2v), MiniMax Hailuo-02, Veo 3, FLUX schnell.

### Luma AI (`luma`) — `LUMA_API_KEY`
`POST /dream-machine/v1/generations` (Ray 2, Ray Flash 2) and `/generations/image` (Photon).
Luma downloads keyframe images by URL, so **image-to-video is only offered when
`VOIDCRAFT_PUBLIC_URL` is set** to an address Luma can reach (e.g. a tunnel to your machine).

### Runway (`runway`) — `RUNWAYML_API_SECRET`
`POST /v1/image_to_video` with `X-Runway-Version: 2024-11-06`, `GET /v1/tasks/{id}`,
`DELETE /v1/tasks/{id}`. Gen-4 Turbo requires a start image (sent as a data URI ≤ ~5 MB).

### OpenAI (`openai`) — `OPENAI_API_KEY`
- **Sora 2 / Sora 2 Pro**: `POST /v1/videos` (multipart), poll `GET /v1/videos/{id}`, download
  `GET /v1/videos/{id}/content`. The reference image is resized/cropped to the output size.
  The API does not cancel jobs; canceling only stops tracking (the UI says so).
- **GPT Image 1**: `POST /v1/images/generations`.
- **TTS** (`gpt-4o-mini-tts`): `POST /v1/audio/speech`. Disclose AI voices to listeners.
- **Whisper**: `POST /v1/audio/transcriptions` with `verbose_json`; audio is compressed to mono MP3
  first (25 MB request limit).
- **Chat** for text tools: `POST /v1/chat/completions` with a JSON schema; model from
  `OPENAI_CHAT_MODEL` / the "Chat model" field (default `gpt-4.1-mini`).

### Google Gemini API (`google`) — `GEMINI_API_KEY`
Veo 3 / Veo 3 Fast via `models/{model}:predictLongRunning` and operation polling. Results are
downloaded with the API key header (only sent to `generativelanguage.googleapis.com`). Safety-filter
blocks are reported as failures with the filter reason.

### Anthropic (`anthropic`) — `ANTHROPIC_API_KEY`
Claude (`claude-opus-5-5`) via the official `@anthropic-ai/sdk` for prompt enhancement, shot
lists, continuation and suggestions, using structured JSON output. If a safety classifier declines
a request, the server-side fallback (`fallbacks: "default"`) retries on Anthropic's recommended
model; a final refusal is shown to the user as a clear error.

### ElevenLabs (`elevenlabs`) — `ELEVENLABS_API_KEY`
`POST /v1/text-to-speech/{voice_id}`. Default premade voices are listed; any voice ID from your
account can be pasted. Only use voices you have rights to.

## Custom models (Replicate & fal)

Settings → Providers → Replicate/fal → **Add custom model** registers any model with:

- **id** — `owner/name` or `owner/name:version` (Replicate) or the fal endpoint id;
- **tasks** — which workspaces offer it (`text-to-video`, `image-to-video`, `video-to-video`,
  `text-to-image`, `tool`);
- **input template** — JSON with placeholders: `{{prompt}}`, `{{negative_prompt}}`, `{{image}}`,
  `{{end_image}}`, `{{video}}`, `{{audio}}`, `{{duration}}`, `{{aspect_ratio}}`, `{{seed}}`,
  `{{text}}`. Empty placeholders are dropped. Images become data URIs; video and audio become
  public URLs and therefore need `VOIDCRAFT_PUBLIC_URL`.

Examples (check each model page for the exact input names):

```json
{ "image": "{{image}}" }                                  // background removal (task: tool)
{ "video": "{{video}}", "prompt": "{{prompt}}", "strength": 0.6 }   // video-to-video
{ "face": "{{video}}", "audio": "{{audio}}" }             // lip-sync (task: tool)
```

Custom tool models can be run from **AI Tools → Background & object removal…**.

## Adding a new provider

1. Create `server/providers/<name>.ts` exporting a `Provider`.
2. Add it to `ALL_PROVIDERS` in `server/providers/registry.ts`.
3. Use `request`/`requestJson` from `http.ts` (timeouts, retries, error extraction) and
   `requireCred(ctx.creds, …)`; never log headers or bodies containing credentials.
4. Add mocked tests in `tests/unit/providers.test.ts`.

## Verifying a provider (manual, uses your account)

Automated tests never call paid APIs. To verify a real integration:

1. Add the key in Settings and press **Test connection** (where the provider offers one).
2. Generate the shortest, lowest-resolution clip the model allows.
3. Check **Generation History**: the job should move through *submitting → running → downloading →
   succeeded*, and the result's provenance should name the provider and model.
4. Cancel a second job mid-way to check cancellation (if supported).

## Security notes

- Credentials live only on the server (`data/secrets.json`, AES-256-GCM). The API returns
  masked hints; tests assert keys never appear in API responses.
- Known secret values and common key patterns are redacted from logs.
- The server binds to `127.0.0.1`, rejects foreign `Host` headers (DNS rebinding) and
  cross-origin writes (CSRF).
- Uploads are identified by magic bytes, decoded with ffprobe and size-limited per type.
