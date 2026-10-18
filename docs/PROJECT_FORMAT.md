# Project format (formatVersion 1)

A project is one JSON document. The authoritative definition is the Zod schema in
[`shared/project.ts`](../shared/project.ts); the server validates every save, autosave, import and
render request against it and also checks structure the schema can't express (unique track/clip
ids, `out > in`, clips only on compatible tracks). Invalid data is rejected with a list of issues
and is never loaded.

## On disk

```
data/
  projects/<projectId>/project.json     last explicit save
  projects/<projectId>/autosave.json    { updatedAt, project } — recovery slot, cleared on save
  projects/<projectId>/versions/*.json  previous saves (last 10)
  assets/<assetId>/source.<ext>         media (plus thumb.jpg / waveform.png)
  assets.json                           asset metadata and provenance
  jobs.json                             generation/export job records
  templates.json, saved-prompts.json, settings.json, usage.json
  secrets.json + secret.key             encrypted credentials
  exports/snapshots/*.json              project state used for each export job
```

## Top-level fields

| Field | Type | Notes |
| --- | --- | --- |
| `formatVersion` | `1` | |
| `id`, `name`, `description` | string | |
| `createdAt`, `updatedAt` | ISO string | |
| `settings` | `{ width, height, fps, aspectRatio, background, stillDuration }` | canvas |
| `timeline` | `{ tracks: Track[], masterEffects: Effect[] }` | |
| `storyboard` | `{ idea, source, shots: Shot[] }` | `source` = LLM provider id, `offline-template` or `manual` |
| `characters` | `Character[]` | appearance, face, body, clothing, accessories, palette, references, approved/rejected results |
| `environments` | `Environment[]` | category, description, lighting, atmosphere, palette, references |
| `promptHistory` | `{ id, text, negative, kind, createdAt }[]` | |
| `generationJobIds` | string[] | job records live in `jobs.json` |
| `assetIds` | string[] | media used by or produced for the project |
| `exportSettings` | `{ width, height, fps, codec, container, quality, includeAudio, audioBitrateKbps, fileName }` | |
| `templateId` | string \| null | |

## Timeline

Tracks are ordered; for video tracks, later tracks render on top.

```ts
Track = {
  id, kind: 'video' | 'audio' | 'text' | 'subtitle', name,
  role?: 'dialogue' | 'music' | 'sfx' | 'voiceover' | 'general',
  muted, solo, hidden, locked, height, volume,
  clips: Clip[],            // media clips (video/audio tracks) or text clips (text tracks)
  cues: SubtitleCue[],      // subtitle tracks
  burnIn: boolean,          // subtitle tracks: render into the export
}

MediaClip = {
  id, kind: 'media', assetId,
  start,                    // timeline seconds
  in, out,                  // source seconds (stills: 0..display duration)
  speed (0.25–4), volume (0–2), muted, fadeIn, fadeOut,
  transform: { x, y, scale, fit: 'contain'|'cover'|'stretch', crop: {left,top,right,bottom}, opacity },
  color: { brightness, contrast, saturation, gamma, hue, exposure, temperature },
  effects: Effect[],
  transitionIn: { type: 'none'|'dissolve'|'dipToBlack'|'slideLeft'|'slideRight'|'slideUp'|'slideDown', duration },
  keyframes: { opacity?, scale?, x?, y?: { t, v }[] },   // t is relative to clip start
  label?,
}
// Duration on the timeline = (out - in) / speed

TextClip = { id, kind: 'text', text, start, duration, style: { fontSize, color, x, y, bold, box, boxColor, boxOpacity, shadow }, fadeIn, fadeOut }
SubtitleCue = { id, start, end, text }
Effect = { id, type, enabled, params: Record<string, number> }   // ranges in shared/effects.ts
```

Effect types: `colorGrade`, `bloom`, `motionBlur`, `depthOfField`, `filmGrain`, `vignette`,
`glitch`, `fog`, `lightLeak`, `cameraShake`, `blur`, `sharpen`, `chromaticAberration`, `letterbox`.

## Storyboard shot

```ts
Shot = {
  id, title, description, prompt, characterIds, environmentId,
  cameraAngle, camera: { move, framing, speed, intensity, subjectFocus, direction },
  lighting, dialogue, duration,
  status: 'draft'|'queued'|'generating'|'done'|'failed',
  frameAssetId, videoAssetId, lastJobId, review: 'unreviewed'|'approved'|'rejected', error,
}
```

## `.voidcraft` bundles

A ZIP archive used by **File → Export project bundle** and **Import project**:

```
manifest.json      { format: 'voidcraft-bundle', version: 1, exportedAt, includesMedia }
project.json       the project document
assets.json        metadata for referenced assets
media/<assetId>/source.<ext>
```

On import every media file goes through the normal upload validation (magic bytes, ffprobe, size
limits) and receives a new asset id; all references are remapped. Entries with unexpected names
are ignored (no path traversal), entry counts and total extracted size are capped, and the project
is validated before it is saved. A bare `project.json` can also be imported; missing media then
shows as offline clips.
