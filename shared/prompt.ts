import type { Camera, Character, Environment } from './project.js';
import { CAMERA_MOVES, SHOT_FRAMINGS } from './project.js';

export type CameraMove = (typeof CAMERA_MOVES)[number];
export type ShotFraming = (typeof SHOT_FRAMINGS)[number];

export interface CameraPreset {
  id: string;
  label: string;
  description: string;
  camera: Partial<Camera>;
}

export const CAMERA_MOVE_TEXT: Record<CameraMove, string> = {
  static: 'locked-off static camera',
  panLeft: 'camera pans left',
  panRight: 'camera pans right',
  tiltUp: 'camera tilts up',
  tiltDown: 'camera tilts down',
  dollyIn: 'camera dollies in toward the subject',
  dollyOut: 'camera dollies out away from the subject',
  tracking: 'tracking shot following the subject',
  orbit: 'camera orbits around the subject',
  crane: 'sweeping crane movement',
  handheld: 'handheld camera with natural shake',
  slowPushIn: 'slow cinematic push-in',
  pullBackReveal: 'camera pulls back to reveal the scene',
  aerial: 'aerial drone shot',
  firstPerson: 'first-person point-of-view shot',
};

export const FRAMING_TEXT: Record<ShotFraming, string> = {
  auto: '',
  overTheShoulder: 'over-the-shoulder composition',
  wideEstablishing: 'wide establishing shot',
  wide: 'wide shot',
  medium: 'medium shot',
  closeUp: 'close-up',
  extremeCloseUp: 'extreme close-up',
};

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'static', label: 'Static', description: 'Locked-off tripod shot', camera: { move: 'static' } },
  { id: 'panLeft', label: 'Pan left', description: 'Horizontal pan to the left', camera: { move: 'panLeft', direction: 'left' } },
  { id: 'panRight', label: 'Pan right', description: 'Horizontal pan to the right', camera: { move: 'panRight', direction: 'right' } },
  { id: 'tiltUp', label: 'Tilt up', description: 'Vertical tilt upward', camera: { move: 'tiltUp', direction: 'up' } },
  { id: 'tiltDown', label: 'Tilt down', description: 'Vertical tilt downward', camera: { move: 'tiltDown', direction: 'down' } },
  { id: 'dollyIn', label: 'Dolly in', description: 'Camera travels toward subject', camera: { move: 'dollyIn', direction: 'forward' } },
  { id: 'dollyOut', label: 'Dolly out', description: 'Camera travels away', camera: { move: 'dollyOut', direction: 'backward' } },
  { id: 'tracking', label: 'Tracking', description: 'Follows the subject', camera: { move: 'tracking' } },
  { id: 'orbit', label: 'Orbit', description: 'Circles the subject', camera: { move: 'orbit', direction: 'clockwise' } },
  { id: 'crane', label: 'Crane', description: 'Rising/sweeping boom move', camera: { move: 'crane', direction: 'up' } },
  { id: 'handheld', label: 'Handheld', description: 'Documentary shake', camera: { move: 'handheld', intensity: 0.4 } },
  { id: 'slowPushIn', label: 'Slow push-in', description: 'Subtle dramatic push', camera: { move: 'slowPushIn', speed: 0.2 } },
  { id: 'pullBackReveal', label: 'Pull-back reveal', description: 'Reveal the wider scene', camera: { move: 'pullBackReveal' } },
  { id: 'aerial', label: 'Aerial', description: 'Drone flyover', camera: { move: 'aerial', framing: 'wide' } },
  { id: 'firstPerson', label: 'First person', description: 'POV perspective', camera: { move: 'firstPerson' } },
  { id: 'ots', label: 'Over the shoulder', description: 'OTS dialogue framing', camera: { move: 'static', framing: 'overTheShoulder' } },
  { id: 'establishing', label: 'Wide establishing', description: 'Sets the location', camera: { move: 'static', framing: 'wideEstablishing' } },
  { id: 'medium', label: 'Medium shot', description: 'Waist-up framing', camera: { framing: 'medium' } },
  { id: 'closeUp', label: 'Close-up', description: 'Face / detail', camera: { framing: 'closeUp' } },
  { id: 'ecu', label: 'Extreme close-up', description: 'Eyes, hands, texture', camera: { framing: 'extremeCloseUp' } },
];

export const VISUAL_STYLES = [
  'Cinematic realism',
  'Photorealistic',
  'Anime',
  '3D animation',
  'Film noir',
  'Documentary',
  'Watercolor',
  'Cyberpunk',
  'Vintage 16mm film',
  'Stop motion',
  'None',
];

export const LIGHTING_STYLES = [
  'Natural daylight',
  'Golden hour',
  'Blue hour',
  'Overcast soft light',
  'Low-key dramatic',
  'High-key bright',
  'Neon practicals',
  'Candlelight',
  'Moonlight',
  'Volumetric god rays',
  'None',
];

function speedWord(v: number): string {
  if (v < 0.25) return 'very slow';
  if (v < 0.5) return 'slow';
  if (v < 0.75) return 'moderate';
  return 'fast';
}

export function cameraToText(camera: Camera | undefined): string {
  if (!camera) return '';
  const parts: string[] = [];
  const framing = FRAMING_TEXT[camera.framing];
  if (framing) parts.push(framing);
  if (camera.move !== 'static' || camera.framing === 'auto') {
    let move = CAMERA_MOVE_TEXT[camera.move];
    if (camera.move !== 'static') move = `${speedWord(camera.speed)} ${move}`;
    parts.push(move);
  }
  if (camera.direction !== 'auto' && !['panLeft', 'panRight', 'tiltUp', 'tiltDown'].includes(camera.move)) {
    parts.push(`moving ${camera.direction}`);
  }
  if (camera.subjectFocus.trim()) parts.push(`focus on ${camera.subjectFocus.trim()}`);
  return parts.join(', ');
}

export function motionToText(intensity: number | undefined): string {
  if (intensity === undefined) return '';
  if (intensity < 0.2) return 'minimal motion';
  if (intensity < 0.45) return 'subtle motion';
  if (intensity < 0.7) return 'dynamic motion';
  return 'intense, energetic motion';
}

export interface ComposeInput {
  prompt: string;
  style?: string;
  lighting?: string;
  camera?: Camera;
  motionIntensity?: number;
  complexity?: 'simple' | 'moderate' | 'complex';
  subjectMotion?: string;
  environmentMotion?: string;
  characters?: Character[];
  environment?: Environment | null;
  preserveReference?: boolean;
}

/**
 * Compose the final text prompt. Camera, style, lighting and reference
 * descriptions are appended as plain language because most hosted video
 * models only accept a text prompt for these controls.
 */
export function composePrompt(input: ComposeInput): string {
  const segments: string[] = [input.prompt.trim()];
  for (const ch of input.characters ?? []) {
    const desc = [ch.appearance, ch.face, ch.body, ch.clothing, ch.accessories].map((s) => s.trim()).filter(Boolean).join('; ');
    if (desc) segments.push(`${ch.name}: ${desc}`);
  }
  if (input.environment) {
    const e = input.environment;
    const desc = [e.description, e.lighting, e.atmosphere].map((s) => s.trim()).filter(Boolean).join('; ');
    if (desc) segments.push(`Setting — ${e.name}: ${desc}`);
  }
  if (input.subjectMotion?.trim()) segments.push(`Subject motion: ${input.subjectMotion.trim()}`);
  if (input.environmentMotion?.trim()) segments.push(`Environment motion: ${input.environmentMotion.trim()}`);
  const cam = cameraToText(input.camera);
  if (cam) segments.push(`Camera: ${cam}`);
  const motion = motionToText(input.motionIntensity);
  if (motion) segments.push(motion);
  if (input.style && input.style !== 'None') segments.push(`Style: ${input.style}`);
  if (input.lighting && input.lighting !== 'None') segments.push(`Lighting: ${input.lighting}`);
  if (input.complexity === 'simple') segments.push('simple, uncluttered composition');
  if (input.complexity === 'complex') segments.push('rich, detailed scene with many elements');
  if (input.preserveReference) segments.push('Keep the subject, face, costume, colors and proportions consistent with the reference image');
  return segments.filter(Boolean).join('. ').replace(/\.\./g, '.');
}

export const SAMPLE_PROMPTS: Array<{ title: string; prompt: string; kind: 'text-to-video' | 'image-to-video' }> = [
  {
    title: 'Samurai in the rain',
    kind: 'text-to-video',
    prompt:
      'An armored samurai walks through an abandoned Japanese village during heavy rain. Wind moves his cloak while lanterns illuminate the wet stone streets. Slow cinematic camera movement, realistic lighting, atmospheric fog, detailed materials, dramatic composition.',
  },
  {
    title: 'Character turn',
    kind: 'image-to-video',
    prompt:
      'Make the character slowly turn toward the camera, with their hair moving naturally in the wind. Keep the original costume, face, colors, and proportions consistent. Use a slow cinematic camera push-in.',
  },
  {
    title: 'Neon alley',
    kind: 'text-to-video',
    prompt:
      'A lone courier on a motorbike glides through a narrow neon-lit alley at night, steam rising from vents, reflections on wet asphalt, signs flickering in Japanese and English.',
  },
  {
    title: 'Mountain dawn',
    kind: 'text-to-video',
    prompt: 'Sunrise over a jagged mountain range, clouds flowing through the valleys like a slow river, first light catching the snowy peaks.',
  },
  {
    title: 'Lighthouse storm',
    kind: 'text-to-video',
    prompt: 'A lighthouse on a cliff during a violent storm, huge waves crashing against the rocks, the beam sweeping through sheets of rain.',
  },
];
