import type { Clip, Keyframe, KeyframeProperty, MediaClip, Project, Timeline, Track } from './project.js';

export const EPS = 1e-6;

/** Duration a clip occupies on the timeline (seconds). */
export function clipDuration(clip: Clip): number {
  if (clip.kind === 'text') return clip.duration;
  return Math.max(0, (clip.out - clip.in) / (clip.speed || 1));
}

export function clipEnd(clip: Clip): number {
  return clip.start + clipDuration(clip);
}

export function trackEnd(track: Track): number {
  let end = 0;
  for (const c of track.clips) end = Math.max(end, clipEnd(c));
  for (const q of track.cues) end = Math.max(end, q.end);
  return end;
}

export function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const t of timeline.tracks) end = Math.max(end, trackEnd(t));
  return end;
}

/** Linear keyframe interpolation. Returns `fallback` when no keyframes exist. */
export function interpolateKeyframes(frames: Keyframe[] | undefined, t: number, fallback: number): number {
  if (!frames || frames.length === 0) return fallback;
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  if (t <= sorted[0].t) return sorted[0].v;
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = b.t - a.t < EPS ? 0 : (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * k;
    }
  }
  return fallback;
}

export function keyframeValue(clip: MediaClip, prop: KeyframeProperty, localT: number): number {
  const base = prop === 'opacity' ? clip.transform.opacity : prop === 'scale' ? clip.transform.scale : prop === 'x' ? clip.transform.x : clip.transform.y;
  return interpolateKeyframes(clip.keyframes?.[prop], localT, base);
}

/** Clip active at time t on a track (topmost = last started). */
export function clipsAt(track: Track, t: number): Clip[] {
  return track.clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
}

/**
 * Split a clip at timeline time `t`. Returns [left, right] or null when `t`
 * is not strictly inside the clip. Ids for the right half come from `newId`.
 */
export function splitClip(clip: Clip, t: number, newId: string): [Clip, Clip] | null {
  const end = clipEnd(clip);
  if (t <= clip.start + 0.01 || t >= end - 0.01) return null;
  const offset = t - clip.start;
  if (clip.kind === 'text') {
    return [
      { ...clip, duration: offset, fadeOut: Math.min(clip.fadeOut, offset) },
      { ...clip, id: newId, start: t, duration: clip.duration - offset, fadeIn: 0 },
    ];
  }
  const srcSplit = clip.in + offset * clip.speed;
  const shiftKeys = (frames: Keyframe[]) => frames.filter((k) => k.t >= offset).map((k) => ({ t: k.t - offset, v: k.v }));
  const rightKeys: MediaClip['keyframes'] = {};
  const leftKeys: MediaClip['keyframes'] = {};
  for (const [prop, frames] of Object.entries(clip.keyframes ?? {}) as [KeyframeProperty, Keyframe[]][]) {
    leftKeys[prop] = frames.filter((k) => k.t <= offset);
    rightKeys[prop] = shiftKeys(frames);
  }
  return [
    { ...clip, out: srcSplit, fadeOut: 0, keyframes: leftKeys },
    { ...clip, id: newId, start: t, in: srcSplit, fadeIn: 0, transitionIn: { type: 'none', duration: 0 }, keyframes: rightKeys },
  ];
}

/** Snap a time to the nearest candidate within `threshold` seconds. */
export function snapTime(t: number, candidates: number[], threshold: number): number {
  let best = t;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export function snapCandidates(project: Project, excludeClipId?: string): number[] {
  const out: number[] = [0];
  for (const tr of project.timeline.tracks) {
    for (const c of tr.clips) {
      if (c.id === excludeClipId) continue;
      out.push(c.start, clipEnd(c));
    }
  }
  return out;
}

export function formatTimecode(t: number, fps = 30): string {
  const safe = Math.max(0, t);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const f = Math.floor((safe - Math.floor(safe)) * fps + EPS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h > 0 ? pad(h) + ':' : ''}${pad(m)}:${pad(s)}:${pad(f)}`;
}

export function findClip(project: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.timeline.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}
