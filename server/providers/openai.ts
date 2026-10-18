/**
 * OpenAI — video (Sora), images, text-to-speech, transcription and chat.
 *   Video:   POST /v1/videos (multipart: model, prompt, seconds, size, input_reference)
 *            GET  /v1/videos/{id} -> { status: queued|in_progress|completed|failed, progress, error }
 *            GET  /v1/videos/{id}/content -> MP4 bytes
 *   Images:  POST /v1/images/generations { model, prompt, size, n } -> data[].b64_json
 *   TTS:     POST /v1/audio/speech { model, voice, input, response_format }
 *   STT:     POST /v1/audio/transcriptions (multipart, response_format=verbose_json)
 *   Chat:    POST /v1/chat/completions (JSON schema response_format)
 * See https://platform.openai.com/docs/api-reference
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInfo } from '../../shared/api.js';
import type { AspectRatio } from '../../shared/project.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { params, pickAspect, pickDuration, promptOf, requireCred } from './common.js';
import { jsonInit, request, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.openai.com/v1';
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

const SIZES: Record<string, Partial<Record<AspectRatio, string>>> = {
  'sora-2': { '16:9': '1280x720', '9:16': '720x1280' },
  'sora-2-pro': { '16:9': '1792x1024', '9:16': '1024x1792' },
};

const MODELS: ModelInfo[] = [
  {
    id: 'sora-2',
    providerId: 'openai',
    name: 'Sora 2',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [4, 8, 12], aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], camera: 'prompt', audio: true, imageInput: 'upload' },
    docsUrl: 'https://platform.openai.com/docs/guides/video-generation',
    notes: 'Reference image is resized/cropped to the output size automatically.',
  },
  {
    id: 'sora-2-pro',
    providerId: 'openai',
    name: 'Sora 2 Pro',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [4, 8, 12], aspectRatios: ['16:9', '9:16'], resolutions: ['1080p'], camera: 'prompt', audio: true, imageInput: 'upload' },
    docsUrl: 'https://platform.openai.com/docs/guides/video-generation',
  },
  {
    id: 'gpt-image-1',
    providerId: 'openai',
    name: 'GPT Image 1',
    tasks: ['text-to-image'],
    capabilities: { aspectRatios: ['16:9', '9:16', '1:1'], maxVariations: 4 },
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
  },
  {
    id: 'gpt-4o-mini-tts',
    providerId: 'openai',
    name: 'GPT-4o mini TTS',
    tasks: ['text-to-speech'],
    capabilities: { voices: VOICES },
    docsUrl: 'https://platform.openai.com/docs/guides/text-to-speech',
    notes: 'OpenAI requires disclosing to listeners that the voice is AI-generated.',
  },
  {
    id: 'whisper-1',
    providerId: 'openai',
    name: 'Whisper (transcription)',
    tasks: ['transcribe'],
    capabilities: {},
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    notes: 'Files up to 25 MB; longer audio is compressed to mono MP3 first.',
  },
];

const auth = (ctx: ProviderContext) => ({ Authorization: `Bearer ${requireCred(ctx.creds, 'apiKey', 'OpenAI')}` });

async function fileBlob(file: string, type: string): Promise<Blob> {
  return new Blob([await fs.readFile(file)], { type });
}

export const openaiProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'openai',
    name: 'OpenAI',
    description: 'Sora video, GPT Image, text-to-speech, Whisper transcription and chat models for prompt/storyboard tools.',
    isAI: true,
    categories: ['video', 'image', 'tts', 'stt', 'llm'],
    docsUrl: 'https://platform.openai.com/docs',
    credentialFields: [
      { key: 'apiKey', label: 'API key', envVar: 'OPENAI_API_KEY', secret: true, placeholder: 'sk-…' },
      { key: 'chatModel', label: 'Chat model for AI tools', envVar: 'OPENAI_CHAT_MODEL', secret: false, placeholder: 'gpt-4.1-mini' },
    ],
    supportsCancel: false,
    limitations: [
      'Sora access depends on your OpenAI organisation tier.',
      'Sora jobs cannot be canceled through the API; canceling stops tracking.',
      'Transcription input is limited to 25 MB per request.',
      'TTS output must be disclosed as AI-generated per OpenAI usage policies.',
    ],
  },
  models: () => MODELS,
  async testConnection(ctx) {
    await requestJson(ctx.fetch, `${API}/models`, jsonInit('GET', auth(ctx)), { retries: 0, timeoutMs: 15_000 });
    return { ok: true, message: 'API key accepted' };
  },
  async submit(job, model, ctx) {
    const p = params(job);
    if (job.task === 'text-to-video' || job.task === 'image-to-video') {
      const aspect = pickAspect(model, p.aspectRatio);
      const size = SIZES[model.id]?.[aspect] ?? '1280x720';
      const form = new FormData();
      form.set('model', model.id);
      form.set('prompt', promptOf(job));
      form.set('seconds', String(pickDuration(model, p.duration)));
      form.set('size', size);
      if (job.task === 'image-to-video') {
        if (!p.startImageAssetId) throw new ProviderError('A start image is required', 400);
        const [w, h] = size.split('x');
        const tmp = path.join(ctx.assets.tmpDir, `sora_ref_${job.id}.png`);
        await runFfmpeg(['-i', ctx.assetPath(p.startImageAssetId), '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-frames:v', '1', tmp]);
        try {
          form.set('input_reference', await fileBlob(tmp, 'image/png'), 'reference.png');
        } finally {
          await fs.rm(tmp, { force: true });
        }
      }
      const v = await requestJson<{ id: string }>(ctx.fetch, `${API}/videos`, { method: 'POST', headers: auth(ctx), body: form }, { signal: ctx.signal, retries: 1, timeoutMs: 120_000 });
      if (!v.id) throw new ProviderError('OpenAI did not return a video id', 502);
      return { providerJobId: v.id };
    }
    if (job.task === 'text-to-image') {
      const aspect = pickAspect(model, p.aspectRatio);
      const size = aspect === '16:9' ? '1536x1024' : aspect === '9:16' ? '1024x1536' : '1024x1024';
      const r = await requestJson<{ data: Array<{ b64_json?: string; url?: string }> }>(
        ctx.fetch,
        `${API}/images/generations`,
        jsonInit('POST', auth(ctx), { model: model.id, prompt: promptOf(job), size, n: Math.min(4, p.variations ?? 1) }),
        { signal: ctx.signal, retries: 1, timeoutMs: 300_000 },
      );
      const outputs = r.data.map((d, i) =>
        d.b64_json ? { kind: 'buffer' as const, data: Buffer.from(d.b64_json, 'base64'), name: `gpt-image-${i + 1}.png` } : { kind: 'url' as const, url: d.url!, name: `gpt-image-${i + 1}.png` },
      );
      return { providerJobId: `img_${job.id}`, immediate: { status: 'succeeded', outputs } };
    }
    if (job.task === 'text-to-speech') {
      const text = (p.text ?? p.prompt ?? '').trim();
      if (!text) throw new ProviderError('Text is empty', 400);
      if (text.length > 4096) throw new ProviderError('OpenAI TTS accepts up to 4096 characters per request', 400);
      const voice = VOICES.includes(p.voice ?? '') ? p.voice! : 'alloy';
      const res = await request(ctx.fetch, `${API}/audio/speech`, jsonInit('POST', auth(ctx), { model: model.id, voice, input: text, response_format: 'mp3' }), { signal: ctx.signal, retries: 1, timeoutMs: 180_000 });
      const data = new Uint8Array(await res.arrayBuffer());
      return { providerJobId: `tts_${job.id}`, immediate: { status: 'succeeded', outputs: [{ kind: 'buffer', data, name: `voice-${voice}.mp3` }] } };
    }
    if (job.task === 'transcribe') {
      if (!p.audioAssetId) throw new ProviderError('Choose an audio or video asset to transcribe', 400);
      const tmp = path.join(ctx.assets.tmpDir, `stt_${job.id}.mp3`);
      await runFfmpeg(['-i', ctx.assetPath(p.audioAssetId), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', tmp], { signal: ctx.signal });
      try {
        const st = await fs.stat(tmp);
        if (st.size > 25 * 1024 * 1024) throw new ProviderError('Audio is too long for a single transcription request (25 MB after compression). Trim it first.', 400);
        const form = new FormData();
        form.set('model', model.id);
        form.set('response_format', 'verbose_json');
        if (p.language) form.set('language', p.language);
        form.set('file', await fileBlob(tmp, 'audio/mpeg'), 'audio.mp3');
        const r = await requestJson<{ text: string; language?: string; segments?: Array<{ start: number; end: number; text: string }> }>(
          ctx.fetch,
          `${API}/audio/transcriptions`,
          { method: 'POST', headers: auth(ctx), body: form },
          { signal: ctx.signal, retries: 1, timeoutMs: 600_000 },
        );
        const segments = (r.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
        return { providerJobId: `stt_${job.id}`, immediate: { status: 'succeeded', outputs: [], result: { text: r.text, language: r.language ?? null, segments } } };
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
    throw new ProviderError(`OpenAI adapter does not support ${job.task}`, 400);
  },
  async poll(job, model, ctx): Promise<PollResult> {
    const v = await requestJson<{ status: string; progress?: number; error?: { message?: string } }>(ctx.fetch, `${API}/videos/${encodeURIComponent(job.providerJobId!)}`, jsonInit('GET', auth(ctx)), { signal: ctx.signal });
    if (v.status === 'failed') return { status: 'failed', error: v.error?.message ?? 'Video generation failed' };
    if (v.status !== 'completed') return { status: 'running', progress: typeof v.progress === 'number' ? v.progress / 100 : null, message: v.status };
    const res = await request(ctx.fetch, `${API}/videos/${encodeURIComponent(job.providerJobId!)}/content`, { method: 'GET', headers: auth(ctx) }, { signal: ctx.signal, timeoutMs: 600_000 });
    const data = new Uint8Array(await res.arrayBuffer());
    return { status: 'succeeded', outputs: [{ kind: 'buffer', data, name: `${model.id}.mp4` }] };
  },
  async llm(req, ctx) {
    const model = ctx.creds.chatModel || 'gpt-4.1-mini';
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_completion_tokens: req.maxTokens ?? 4000,
    };
    if (req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: req.jsonSchema, strict: false } };
    const r = await requestJson<{ choices: Array<{ message: { content: string | null; refusal?: string | null } }> }>(ctx.fetch, `${API}/chat/completions`, jsonInit('POST', auth(ctx), body), {
      signal: ctx.signal,
      timeoutMs: 180_000,
    });
    const msg = r.choices?.[0]?.message;
    if (msg?.refusal) throw new ProviderError(`The model declined: ${msg.refusal}`, 422);
    if (!msg?.content) throw new ProviderError('Empty response from OpenAI', 502);
    return msg.content;
  },
};
