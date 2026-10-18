/**
 * ElevenLabs text-to-speech — https://elevenlabs.io/docs/api-reference
 *   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128  { text, model_id }
 *   GET  /v1/voices  (voice discovery)
 */
import type { ModelInfo } from '../../shared/api.js';
import { params, requireCred } from './common.js';
import { jsonInit, request, requestJson } from './http.js';
import type { Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.elevenlabs.io/v1';
// Default "premade" voices; any voice id from your account can be entered instead.
const VOICES = ['21m00Tcm4TlvDq8ikWAM:Rachel', 'EXAVITQu4vr4xnSDxMaL:Sarah', 'ErXwobaYiN019PkySvjV:Antoni', 'TxGEqnHWrfWFTfGW9XjX:Josh', 'pNInz6obpgDQGcFmaJgB:Adam'];

const MODELS: ModelInfo[] = [
  { id: 'eleven_multilingual_v2', providerId: 'elevenlabs', name: 'Eleven Multilingual v2', tasks: ['text-to-speech'], capabilities: { voices: VOICES }, docsUrl: 'https://elevenlabs.io/docs/models' },
  { id: 'eleven_flash_v2_5', providerId: 'elevenlabs', name: 'Eleven Flash v2.5 (low latency)', tasks: ['text-to-speech'], capabilities: { voices: VOICES }, docsUrl: 'https://elevenlabs.io/docs/models' },
];

const headers = (ctx: ProviderContext) => ({ 'xi-api-key': requireCred(ctx.creds, 'apiKey', 'ElevenLabs') });

export const elevenlabsProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Natural text-to-speech voices for narration and dialogue.',
    isAI: true,
    categories: ['tts'],
    docsUrl: 'https://elevenlabs.io/docs',
    credentialFields: [{ key: 'apiKey', label: 'API key', envVar: 'ELEVENLABS_API_KEY', secret: true }],
    supportsCancel: false,
    limitations: ['Character quota depends on your ElevenLabs plan.', 'Only clone voices you have rights to; commercial use depends on your plan.'],
  },
  models: () => MODELS,
  async testConnection(ctx) {
    const r = await requestJson<{ voices?: Array<{ voice_id: string; name: string }> }>(ctx.fetch, `${API}/voices`, jsonInit('GET', headers(ctx)), { retries: 0, timeoutMs: 15_000 });
    return { ok: true, message: `Connected — ${r.voices?.length ?? 0} voices available` };
  },
  async submit(job, model, ctx) {
    const p = params(job);
    const text = (p.text ?? p.prompt ?? '').trim();
    if (!text) throw new ProviderError('Text is empty', 400);
    if (text.length > 5000) throw new ProviderError('ElevenLabs accepts up to 5000 characters per request', 400);
    const voiceId = (p.voice ?? VOICES[0]).split(':')[0];
    if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) throw new ProviderError('Invalid voice id', 400);
    const res = await request(ctx.fetch, `${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, jsonInit('POST', { ...headers(ctx), Accept: 'audio/mpeg' }, { text, model_id: model.id }), {
      signal: ctx.signal,
      retries: 1,
      timeoutMs: 180_000,
    });
    const data = new Uint8Array(await res.arrayBuffer());
    return { providerJobId: `tts_${job.id}`, immediate: { status: 'succeeded', outputs: [{ kind: 'buffer', data, name: 'voice.mp3' }] } };
  },
};
