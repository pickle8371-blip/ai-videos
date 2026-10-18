import type { EffectType } from './project.js';

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  description: string;
  params: EffectParamDef[];
  /** How faithfully the in-browser live preview reproduces the rendered result. */
  livePreview: 'exact' | 'approximate' | 'none';
}

const p = (key: string, label: string, min: number, max: number, step: number, def: number): EffectParamDef => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
});

export const EFFECT_DEFS: Record<EffectType, EffectDef> = {
  colorGrade: {
    type: 'colorGrade',
    label: 'Color grade',
    description: 'Lift/gamma/gain style grade with shadow and highlight tint.',
    params: [
      p('shadowsR', 'Shadows red', -0.5, 0.5, 0.01, 0),
      p('shadowsB', 'Shadows blue', -0.5, 0.5, 0.01, 0.08),
      p('highlightsR', 'Highlights red', -0.5, 0.5, 0.01, 0.06),
      p('highlightsB', 'Highlights blue', -0.5, 0.5, 0.01, -0.04),
      p('saturation', 'Saturation', 0, 2, 0.01, 1),
    ],
    livePreview: 'approximate',
  },
  bloom: {
    type: 'bloom',
    label: 'Bloom',
    description: 'Blurred highlights screened back over the image.',
    params: [p('radius', 'Radius', 1, 60, 1, 18), p('strength', 'Strength', 0, 1, 0.01, 0.35)],
    livePreview: 'approximate',
  },
  motionBlur: {
    type: 'motionBlur',
    label: 'Motion blur',
    description: 'Blends successive frames (temporal mix).',
    params: [p('frames', 'Frames', 2, 8, 1, 3)],
    livePreview: 'none',
  },
  depthOfField: {
    type: 'depthOfField',
    label: 'Depth of field',
    description: 'Tilt-shift approximation: blurs the frame outside a sharp centre band.',
    params: [p('blur', 'Blur', 1, 30, 1, 8), p('focusSize', 'Focus band', 0.1, 0.9, 0.01, 0.45)],
    livePreview: 'approximate',
  },
  filmGrain: {
    type: 'filmGrain',
    label: 'Film grain',
    description: 'Animated luma noise.',
    params: [p('amount', 'Amount', 0, 60, 1, 14)],
    livePreview: 'approximate',
  },
  vignette: {
    type: 'vignette',
    label: 'Vignette',
    description: 'Darkens the frame edges.',
    params: [p('angle', 'Strength', 0.1, 1.5, 0.01, 0.6)],
    livePreview: 'approximate',
  },
  glitch: {
    type: 'glitch',
    label: 'Glitch',
    description: 'RGB channel offsets with noise bursts.',
    params: [p('amount', 'Amount', 1, 40, 1, 10), p('noise', 'Noise', 0, 80, 1, 25)],
    livePreview: 'none',
  },
  fog: {
    type: 'fog',
    label: 'Fog overlay',
    description: 'Lifts blacks and adds a soft diffuse haze.',
    params: [p('density', 'Density', 0, 1, 0.01, 0.35), p('softness', 'Softness', 1, 40, 1, 12)],
    livePreview: 'approximate',
  },
  lightLeak: {
    type: 'lightLeak',
    label: 'Light leak',
    description: 'Warm animated gradient screened over the frame.',
    params: [p('strength', 'Strength', 0, 1, 0.01, 0.35), p('speed', 'Speed', 0, 2, 0.01, 0.4)],
    livePreview: 'approximate',
  },
  cameraShake: {
    type: 'cameraShake',
    label: 'Camera shake',
    description: 'Procedural handheld shake (crop + offset).',
    params: [p('amount', 'Amount (px)', 1, 60, 1, 12), p('frequency', 'Frequency', 0.2, 8, 0.1, 2)],
    livePreview: 'approximate',
  },
  blur: {
    type: 'blur',
    label: 'Blur',
    description: 'Gaussian blur.',
    params: [p('sigma', 'Sigma', 0, 40, 0.5, 4)],
    livePreview: 'exact',
  },
  sharpen: {
    type: 'sharpen',
    label: 'Sharpen',
    description: 'Unsharp mask.',
    params: [p('amount', 'Amount', 0, 3, 0.05, 0.8)],
    livePreview: 'none',
  },
  chromaticAberration: {
    type: 'chromaticAberration',
    label: 'Chromatic aberration',
    description: 'Offsets red and blue channels horizontally.',
    params: [p('shift', 'Shift (px)', 1, 30, 1, 4)],
    livePreview: 'none',
  },
  letterbox: {
    type: 'letterbox',
    label: 'Cinematic letterbox',
    description: 'Black bars to a target aspect ratio.',
    params: [p('ratio', 'Target ratio', 1.5, 3, 0.01, 2.39)],
    livePreview: 'exact',
  },
};

export function defaultEffectParams(type: EffectType): Record<string, number> {
  return Object.fromEntries(EFFECT_DEFS[type].params.map((d) => [d.key, d.default]));
}

/** Clamp effect params to their documented ranges, filling defaults. */
export function normalizeEffectParams(type: EffectType, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of EFFECT_DEFS[type].params) {
    const v = params[d.key];
    out[d.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.default;
  }
  return out;
}
