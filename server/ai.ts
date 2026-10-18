/**
 * Text-assist tools (prompt enhancement, prompt-to-storyboard, scene
 * continuation, shot and transition suggestions).
 *
 * Each task runs on a connected language model (Anthropic or OpenAI), or on
 * the `offline-templates` engine, which is a deterministic rule/template system
 * and is labelled as non-AI everywhere in the UI.
 */
import { z } from 'zod';
import { CAMERA_MOVES, SHOT_FRAMINGS, TRANSITION_TYPES } from '../shared/project.js';
import type { Provider, ProviderContext } from './providers/types.js';
import { ProviderError } from './providers/types.js';

export const AI_TASKS = ['enhance-prompt', 'storyboard', 'continue-scene', 'suggest-shots', 'suggest-transitions'] as const;
export type AiTask = (typeof AI_TASKS)[number];

const ShotOut = z.object({
  title: z.string(),
  description: z.string(),
  prompt: z.string(),
  cameraAngle: z.string(),
  cameraMove: z.enum(CAMERA_MOVES),
  framing: z.enum(SHOT_FRAMINGS),
  lighting: z.string(),
  duration: z.number(),
  dialogue: z.string(),
  characterNames: z.array(z.string()),
  environmentName: z.string(),
});

export const OUTPUT_SCHEMAS = {
  'enhance-prompt': z.object({ prompt: z.string(), negativePrompt: z.string(), notes: z.string() }),
  storyboard: z.object({ shots: z.array(ShotOut) }),
  'continue-scene': z.object({ shots: z.array(ShotOut) }),
  'suggest-shots': z.object({ suggestions: z.array(z.object({ title: z.string(), prompt: z.string(), cameraMove: z.enum(CAMERA_MOVES), framing: z.enum(SHOT_FRAMINGS) })) }),
  'suggest-transitions': z.object({ transitions: z.array(z.object({ clipId: z.string(), type: z.enum(TRANSITION_TYPES), duration: z.number(), reason: z.string() })) }),
} satisfies Record<AiTask, z.ZodTypeAny>;

export const InputSchemas = {
  'enhance-prompt': z.object({ prompt: z.string().min(1).max(4000), style: z.string().max(200).optional(), kind: z.string().max(40).optional() }),
  storyboard: z.object({
    idea: z.string().min(1).max(8000),
    shotCount: z.number().int().min(1).max(30).optional(),
    style: z.string().max(200).optional(),
    characters: z.array(z.object({ name: z.string(), description: z.string() })).max(20).optional(),
    environments: z.array(z.object({ name: z.string(), description: z.string() })).max(20).optional(),
  }),
  'continue-scene': z.object({ shots: z.array(z.object({ title: z.string(), description: z.string() })).min(1).max(100), count: z.number().int().min(1).max(10).optional() }),
  'suggest-shots': z.object({ prompt: z.string().min(1).max(4000) }),
  'suggest-transitions': z.object({ clips: z.array(z.object({ id: z.string(), label: z.string(), duration: z.number(), description: z.string().optional() })).min(2).max(200) }),
} satisfies Record<AiTask, z.ZodTypeAny>;

const enumList = (xs: readonly string[]) => xs.join(', ');

/** Hand-written JSON schemas (structured outputs need additionalProperties:false + required). */
const shotJson = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'prompt', 'cameraAngle', 'cameraMove', 'framing', 'lighting', 'duration', 'dialogue', 'characterNames', 'environmentName'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    prompt: { type: 'string' },
    cameraAngle: { type: 'string' },
    cameraMove: { type: 'string', enum: [...CAMERA_MOVES] },
    framing: { type: 'string', enum: [...SHOT_FRAMINGS] },
    lighting: { type: 'string' },
    duration: { type: 'number' },
    dialogue: { type: 'string' },
    characterNames: { type: 'array', items: { type: 'string' } },
    environmentName: { type: 'string' },
  },
};

const JSON_SCHEMAS: Record<AiTask, Record<string, unknown>> = {
  'enhance-prompt': {
    type: 'object',
    additionalProperties: false,
    required: ['prompt', 'negativePrompt', 'notes'],
    properties: { prompt: { type: 'string' }, negativePrompt: { type: 'string' }, notes: { type: 'string' } },
  },
  storyboard: { type: 'object', additionalProperties: false, required: ['shots'], properties: { shots: { type: 'array', items: shotJson } } },
  'continue-scene': { type: 'object', additionalProperties: false, required: ['shots'], properties: { shots: { type: 'array', items: shotJson } } },
  'suggest-shots': {
    type: 'object',
    additionalProperties: false,
    required: ['suggestions'],
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'prompt', 'cameraMove', 'framing'],
          properties: { title: { type: 'string' }, prompt: { type: 'string' }, cameraMove: { type: 'string', enum: [...CAMERA_MOVES] }, framing: { type: 'string', enum: [...SHOT_FRAMINGS] } },
        },
      },
    },
  },
  'suggest-transitions': {
    type: 'object',
    additionalProperties: false,
    required: ['transitions'],
    properties: {
      transitions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['clipId', 'type', 'duration', 'reason'],
          properties: { clipId: { type: 'string' }, type: { type: 'string', enum: [...TRANSITION_TYPES] }, duration: { type: 'number' }, reason: { type: 'string' } },
        },
      },
    },
  },
};

const SYSTEM = `You are a film director's assistant inside Voidcraft.Video, an AI video production studio. You write prompts for text-to-video models: concrete, visual, present tense, describing subject, action, setting, lighting, lens/camera and mood in one or two dense sentences. Never mention that you are an AI. Respond only with JSON matching the requested schema.`;

function userPrompt(task: AiTask, input: Record<string, unknown>): string {
  switch (task) {
    case 'enhance-prompt':
      return `Rewrite this ${input.kind ?? 'text-to-video'} prompt to be more cinematic and specific for a video model while keeping the user's intent, subjects and any stated constraints. ${input.style ? `Target visual style: ${input.style}.` : ''}\nAlso propose a short negative prompt (artifacts to avoid) and one sentence of notes on what you changed.\n\nPrompt:\n${input.prompt}`;
    case 'storyboard':
      return `Break this idea into a shot list of ${input.shotCount ?? 'about 6'} shots for an AI-generated short film. Each shot gets a title, a one-sentence description, a self-contained video-model prompt (repeat key character/setting details in every prompt, since shots are generated independently), a camera angle, a camera move (one of: ${enumList(CAMERA_MOVES)}), a framing (one of: ${enumList(SHOT_FRAMINGS)}), lighting, a duration between 3 and 10 seconds, optional dialogue (empty string if none), the names of characters that appear, and the environment name.\n${input.style ? `Visual style: ${input.style}\n` : ''}${(input.characters as unknown[] | undefined)?.length ? `Characters: ${JSON.stringify(input.characters)}\n` : ''}${(input.environments as unknown[] | undefined)?.length ? `Environments: ${JSON.stringify(input.environments)}\n` : ''}\nIdea:\n${input.idea}`;
    case 'continue-scene':
      return `Here is the shot list so far:\n${JSON.stringify(input.shots)}\n\nPropose the next ${input.count ?? 3} shots that continue the story naturally, using the same fields as a storyboard shot (camera move one of: ${enumList(CAMERA_MOVES)}; framing one of: ${enumList(SHOT_FRAMINGS)}).`;
    case 'suggest-shots':
      return `Suggest 4 alternative shots (different camera moves and framings) that would cover this moment well. Each needs a title, a full video prompt, a camera move (one of: ${enumList(CAMERA_MOVES)}) and a framing (one of: ${enumList(SHOT_FRAMINGS)}).\n\nMoment:\n${input.prompt}`;
    case 'suggest-transitions':
      return `Suggest a transition into each clip after the first, based on pacing and continuity. Allowed types: ${enumList(TRANSITION_TYPES)} ("none" means a hard cut). Duration in seconds (0 for cuts, otherwise 0.2–2). Give a short reason.\n\nClips in order:\n${JSON.stringify(input.clips)}`;
  }
}

/* ----------------------------------------------------------- offline engine */

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

function offlineEnhance(input: { prompt: string; style?: string }): z.infer<(typeof OUTPUT_SCHEMAS)['enhance-prompt']> {
  const p = input.prompt.trim().replace(/\s+/g, ' ');
  const additions: string[] = [];
  if (!has(p, /(light|lit|glow|sun|moon|neon|lantern|candle)/)) additions.push(has(p, /night|dark/) ? 'moody low-key lighting with practical light sources' : 'soft natural light with gentle contrast');
  if (!has(p, /(camera|shot|dolly|pan|tracking|close-up|wide)/)) additions.push('smooth cinematic camera movement');
  if (!has(p, /(lens|mm|depth of field|bokeh)/)) additions.push('35mm lens, shallow depth of field');
  if (!has(p, /(detail|texture|material)/)) additions.push('rich surface detail');
  if (has(p, /rain|storm|wet/)) additions.push('rain streaks catching the light, reflections on wet surfaces');
  if (has(p, /fog|mist|smoke/)) additions.push('volumetric atmosphere');
  if (input.style && input.style !== 'None') additions.push(`${input.style.toLowerCase()} look`);
  additions.push('coherent motion, stable composition');
  return {
    prompt: `${p.replace(/[.\s]+$/, '')}. ${additions.join(', ')}.`,
    negativePrompt: 'blurry, distorted faces, extra limbs, warped hands, flickering, text, watermark, low resolution, jitter',
    notes: 'Offline template expansion (not AI): added lighting, lens, camera and quality descriptors that were missing from the prompt.',
  };
}

function guessMove(text: string): { move: (typeof CAMERA_MOVES)[number]; framing: (typeof SHOT_FRAMINGS)[number] } {
  const t = text.toLowerCase();
  if (/walk|run|chase|ride|drive|follow/.test(t)) return { move: 'tracking', framing: 'medium' };
  if (/reveal|discover|vast|horizon|city|landscape/.test(t)) return { move: 'pullBackReveal', framing: 'wide' };
  if (/face|eyes|tear|smile|whisper|look/.test(t)) return { move: 'slowPushIn', framing: 'closeUp' };
  if (/fly|above|aerial|over the/.test(t)) return { move: 'aerial', framing: 'wide' };
  if (/talk|says|asks|conversation|argue/.test(t)) return { move: 'static', framing: 'overTheShoulder' };
  if (/fight|clash|explod|crash/.test(t)) return { move: 'handheld', framing: 'medium' };
  if (/hand|detail|object|letter|key/.test(t)) return { move: 'static', framing: 'extremeCloseUp' };
  return { move: 'dollyIn', framing: 'medium' };
}

function offlineStoryboard(input: z.infer<(typeof InputSchemas)['storyboard']>): z.infer<(typeof OUTPUT_SCHEMAS)['storyboard']> {
  const sentences = input.idea
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  const target = input.shotCount ?? Math.min(8, Math.max(3, sentences.length + 1));
  const charNames = (input.characters ?? []).map((c) => c.name);
  const env = input.environments?.[0];
  const style = input.style && input.style !== 'None' ? `, ${input.style.toLowerCase()}` : '';
  const shots: z.infer<typeof ShotOut>[] = [];
  const establishingText = env ? `${env.name}: ${env.description}` : sentences[0] ?? input.idea;
  shots.push({
    title: 'Establishing shot',
    description: `Introduce the setting. ${establishingText}`.slice(0, 300),
    prompt: `Wide establishing shot of ${establishingText.replace(/[.\s]+$/, '')}, atmospheric, cinematic composition${style}`,
    cameraAngle: 'High angle',
    cameraMove: 'aerial',
    framing: 'wideEstablishing',
    lighting: 'Natural, motivated light',
    duration: 5,
    dialogue: '',
    characterNames: [],
    environmentName: env?.name ?? '',
  });
  for (let i = 0; shots.length < target; i++) {
    const s = sentences.length ? sentences[i % sentences.length] : input.idea;
    const { move, framing } = guessMove(s);
    const present = charNames.filter((n) => s.toLowerCase().includes(n.toLowerCase()));
    const charDesc = (input.characters ?? []).filter((c) => present.includes(c.name)).map((c) => `${c.name} (${c.description})`).join(', ');
    shots.push({
      title: s.split(' ').slice(0, 5).join(' ').replace(/[.,!?]+$/, ''),
      description: s,
      prompt: `${s.replace(/[.\s]+$/, '')}${charDesc ? `. Featuring ${charDesc}` : ''}${env ? `. Setting: ${env.name}` : ''}${style}, cinematic lighting, detailed`,
      cameraAngle: framing === 'closeUp' || framing === 'extremeCloseUp' ? 'Eye level' : 'Eye level, slightly low',
      cameraMove: move,
      framing,
      lighting: 'Cinematic, consistent with previous shot',
      duration: framing === 'wide' ? 6 : 4,
      dialogue: '',
      characterNames: present,
      environmentName: env?.name ?? '',
    });
    if (i > 40) break;
  }
  return { shots };
}

function offlineTransitions(input: z.infer<(typeof InputSchemas)['suggest-transitions']>): z.infer<(typeof OUTPUT_SCHEMAS)['suggest-transitions']> {
  return {
    transitions: input.clips.slice(1).map((c, i) => {
      const prev = input.clips[i];
      if (c.duration < 2 || prev.duration < 2) return { clipId: c.id, type: 'none' as const, duration: 0, reason: 'Short clips read better with hard cuts (rule-based).' };
      if (i % 4 === 3) return { clipId: c.id, type: 'dipToBlack' as const, duration: 0.8, reason: 'Periodic dip to black marks a beat change (rule-based).' };
      return { clipId: c.id, type: 'dissolve' as const, duration: 0.5, reason: 'Soft dissolve between longer shots (rule-based).' };
    }),
  };
}

function offlineSuggestShots(input: { prompt: string }): z.infer<(typeof OUTPUT_SCHEMAS)['suggest-shots']> {
  const base = input.prompt.replace(/[.\s]+$/, '');
  return {
    suggestions: [
      { title: 'Wide coverage', prompt: `${base}, wide shot showing the full environment`, cameraMove: 'static', framing: 'wide' },
      { title: 'Follow the action', prompt: `${base}, camera tracking alongside the subject`, cameraMove: 'tracking', framing: 'medium' },
      { title: 'Emotional close-up', prompt: `${base}, close-up on the subject's face, shallow depth of field`, cameraMove: 'slowPushIn', framing: 'closeUp' },
      { title: 'Reveal', prompt: `${base}, starting tight then pulling back to reveal the scene`, cameraMove: 'pullBackReveal', framing: 'wideEstablishing' },
    ],
  };
}

function offlineContinue(input: z.infer<(typeof InputSchemas)['continue-scene']>): z.infer<(typeof OUTPUT_SCHEMAS)['continue-scene']> {
  const last = input.shots[input.shots.length - 1];
  const beats = ['Reaction', 'Complication', 'Turning point', 'Aftermath', 'Quiet moment'];
  return {
    shots: Array.from({ length: input.count ?? 3 }, (_, i) => {
      const beat = beats[i % beats.length];
      const { move, framing } = guessMove(`${beat} ${last.description}`);
      return {
        title: `${beat}`,
        description: `${beat} following "${last.title}".`,
        prompt: `${beat.toLowerCase()} — continuing from: ${last.description.replace(/[.\s]+$/, '')}, consistent characters and setting, cinematic`,
        cameraAngle: 'Eye level',
        cameraMove: move,
        framing,
        lighting: 'Consistent with previous shots',
        duration: 4,
        dialogue: '',
        characterNames: [],
        environmentName: '',
      };
    }),
  };
}

export const offlineTemplatesProvider: Provider = {
  needsCredentials: false,
  info: {
    id: 'offline-templates',
    name: 'Offline templates (not AI)',
    description: 'Deterministic rules and templates for prompt expansion, shot lists and transitions. Works without any API key.',
    isAI: false,
    categories: ['llm'],
    docsUrl: 'docs/PROVIDERS.md#offline-templates',
    credentialFields: [],
    supportsCancel: false,
    limitations: ['Rule-based text expansion — no language understanding.', 'Connect Anthropic or OpenAI for genuine AI assistance.'],
  },
  models: () => [],
};

export function runOffline(task: AiTask, input: unknown): unknown {
  switch (task) {
    case 'enhance-prompt':
      return offlineEnhance(InputSchemas['enhance-prompt'].parse(input));
    case 'storyboard':
      return offlineStoryboard(InputSchemas.storyboard.parse(input));
    case 'continue-scene':
      return offlineContinue(InputSchemas['continue-scene'].parse(input));
    case 'suggest-shots':
      return offlineSuggestShots(InputSchemas['suggest-shots'].parse(input));
    case 'suggest-transitions':
      return offlineTransitions(InputSchemas['suggest-transitions'].parse(input));
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new ProviderError('The language model returned malformed JSON', 502);
  }
}

export async function runAiTask(task: AiTask, rawInput: unknown, provider: Provider, ctx: ProviderContext | null): Promise<{ result: unknown; providerId: string; isAI: boolean }> {
  const parsed = InputSchemas[task].safeParse(rawInput);
  if (!parsed.success) throw new ProviderError(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
  if (provider.info.id === 'offline-templates' || !provider.llm) {
    return { result: runOffline(task, parsed.data), providerId: 'offline-templates', isAI: false };
  }
  if (!ctx) throw new ProviderError('Provider context missing', 500);
  const text = await provider.llm({ system: SYSTEM, user: userPrompt(task, parsed.data as Record<string, unknown>), jsonSchema: JSON_SCHEMAS[task] }, ctx);
  const out = OUTPUT_SCHEMAS[task].safeParse(extractJson(text));
  if (!out.success) throw new ProviderError(`The language model's answer did not match the expected format: ${out.error.issues[0]?.message ?? ''}`, 502);
  return { result: out.data, providerId: provider.info.id, isAI: true };
}
