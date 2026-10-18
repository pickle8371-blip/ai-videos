/**
 * Timeline editing operations. Each mutates a project in place (works on immer
 * drafts or plain objects) and returns information about what changed.
 */
import type { Asset } from './api.js';
import type { Clip, EffectType, KeyframeProperty, MediaClip, Project, SubtitleCue, Track, TrackKind, Transition } from './project.js';
import { defaultEffectParams } from './effects.js';
import { makeMediaClip, makeTextClip, makeTrack, newId } from './factory.js';
import { clipDuration, clipEnd, findClip, splitClip } from './timeline.js';

export function compatibleTrackKind(asset: Pick<Asset, 'type' | 'hasAudio'>): TrackKind[] {
  if (asset.type === 'audio') return ['audio'];
  if (asset.type === 'image') return ['video'];
  return asset.hasAudio ? ['video', 'audio'] : ['video'];
}

/** End of the last clip on a track. */
export function trackTail(track: Track): number {
  return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function addAssetClip(
  p: Project,
  asset: Pick<Asset, 'id' | 'type' | 'duration' | 'hasAudio' | 'name'>,
  opts: { trackId?: string; start?: number; duration?: number } = {},
): MediaClip | null {
  const kinds = compatibleTrackKind(asset);
  let track = opts.trackId ? p.timeline.tracks.find((t) => t.id === opts.trackId) : undefined;
  if (track && !kinds.includes(track.kind)) return null;
  if (!track) track = p.timeline.tracks.find((t) => t.kind === kinds[0] && !t.locked);
  if (!track) {
    track = makeTrack(kinds[0], kinds[0] === 'video' ? `V${p.timeline.tracks.filter((t) => t.kind === 'video').length + 1}` : 'Audio');
    p.timeline.tracks.push(track);
  }
  if (track.locked) return null;
  const srcDur = asset.type === 'image' ? opts.duration ?? p.settings.stillDuration : Math.max(0.1, asset.duration ?? 5);
  const start = Math.max(0, opts.start ?? trackTail(track));
  const clip = makeMediaClip(asset.id, start, srcDur, { label: asset.name });
  track.clips.push(clip);
  if (!p.assetIds.includes(asset.id)) p.assetIds.push(asset.id);
  return clip;
}

export function addTrack(p: Project, kind: TrackKind, name?: string): Track {
  const count = p.timeline.tracks.filter((t) => t.kind === kind).length + 1;
  const label = name ?? (kind === 'video' ? `V${count}` : kind === 'audio' ? `A${count}` : kind === 'text' ? `Titles ${count}` : `Subtitles ${count}`);
  const track = makeTrack(kind, label);
  // Keep video tracks grouped (later = on top), then text, subtitle, audio.
  const order: TrackKind[] = ['video', 'text', 'subtitle', 'audio'];
  const lastIdx = p.timeline.tracks.map((t) => order.indexOf(t.kind) <= order.indexOf(kind)).lastIndexOf(true);
  p.timeline.tracks.splice(lastIdx + 1, 0, track);
  return track;
}

export function removeTrack(p: Project, trackId: string): boolean {
  const idx = p.timeline.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return false;
  p.timeline.tracks.splice(idx, 1);
  return true;
}

export function moveTrack(p: Project, trackId: string, delta: number): void {
  const idx = p.timeline.tracks.findIndex((t) => t.id === trackId);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= p.timeline.tracks.length) return;
  const [t] = p.timeline.tracks.splice(idx, 1);
  p.timeline.tracks.splice(to, 0, t);
}

/** Move a clip to a new start time and (optionally) another compatible track. */
export function moveClip(p: Project, clipId: string, start: number, toTrackId?: string): boolean {
  const found = findClip(p, clipId);
  if (!found || found.track.locked) return false;
  const { track, clip, index } = found;
  clip.start = Math.max(0, start);
  if (toTrackId && toTrackId !== track.id) {
    const dest = p.timeline.tracks.find((t) => t.id === toTrackId);
    const ok = dest && !dest.locked && (clip.kind === 'text' ? dest.kind === 'text' : dest.kind === 'video' || dest.kind === 'audio') && (clip.kind === 'text' || dest.kind === track.kind);
    if (ok && dest) {
      track.clips.splice(index, 1);
      dest.clips.push(clip);
    }
  }
  return true;
}

/**
 * Trim a clip edge to a timeline time. Left trim keeps the clip end fixed and
 * advances the source in-point; right trim moves the out-point.
 */
export function trimClip(p: Project, clipId: string, edge: 'left' | 'right', time: number, assetDuration: number | null): boolean {
  const found = findClip(p, clipId);
  if (!found || found.track.locked) return false;
  const clip = found.clip;
  const MIN = 0.1;
  if (clip.kind === 'text') {
    const end = clipEnd(clip);
    if (edge === 'left') {
      const s = Math.min(Math.max(0, time), end - MIN);
      clip.duration = end - s;
      clip.start = s;
    } else clip.duration = Math.max(MIN, time - clip.start);
    return true;
  }
  const limit = assetDuration ?? Infinity; // stills (null) can be stretched freely
  if (edge === 'left') {
    const end = clipEnd(clip);
    let newStart = Math.min(Math.max(0, time), end - MIN);
    let newIn = clip.in + (newStart - clip.start) * clip.speed;
    if (newIn < 0) {
      newStart -= newIn / clip.speed;
      newIn = 0;
    }
    if (assetDuration === null) {
      // Still image: keep in at 0 and change the display duration instead.
      clip.out = (end - newStart) * clip.speed;
      clip.in = 0;
    } else clip.in = newIn;
    clip.start = newStart;
  } else {
    const newOut = clip.in + Math.max(MIN, time - clip.start) * clip.speed;
    clip.out = Math.min(limit, newOut);
  }
  return true;
}

export function splitAt(p: Project, time: number, clipIds?: string[]): string[] {
  const created: string[] = [];
  for (const track of p.timeline.tracks) {
    if (track.locked) continue;
    const targets = track.clips.filter((c) => (clipIds ? clipIds.includes(c.id) : true) && time > c.start && time < clipEnd(c));
    for (const clip of targets) {
      const parts = splitClip(clip as Clip, time, newId(clip.kind === 'text' ? 'txt' : 'clp'));
      if (!parts) continue;
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(idx, 1, parts[0], parts[1]);
      created.push(parts[1].id);
    }
  }
  return created;
}

export function deleteClips(p: Project, clipIds: string[], ripple = false): number {
  let removed = 0;
  for (const track of p.timeline.tracks) {
    if (track.locked) continue;
    const doomed = track.clips.filter((c) => clipIds.includes(c.id));
    for (const clip of doomed) {
      const dur = clipDuration(clip);
      const start = clip.start;
      track.clips = track.clips.filter((c) => c.id !== clip.id);
      removed++;
      if (ripple) for (const c of track.clips) if (c.start >= start) c.start = Math.max(start, c.start - dur);
    }
  }
  return removed;
}

export function duplicateClips(p: Project, clipIds: string[]): string[] {
  const created: string[] = [];
  for (const track of p.timeline.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips.filter((c) => clipIds.includes(c.id))) {
      const copy = JSON.parse(JSON.stringify(clip)) as Clip;
      copy.id = newId(clip.kind === 'text' ? 'txt' : 'clp');
      copy.start = Math.max(trackTail(track), clipEnd(clip));
      if (copy.kind === 'media') copy.effects = copy.effects.map((e) => ({ ...e, id: newId('fx') }));
      track.clips.push(copy);
      created.push(copy.id);
    }
  }
  return created;
}

export function updateClip(p: Project, clipId: string, fn: (c: Clip) => void): boolean {
  const found = findClip(p, clipId);
  if (!found) return false;
  fn(found.clip);
  return true;
}

export function setTransition(p: Project, clipId: string, t: Transition): void {
  updateClip(p, clipId, (c) => {
    if (c.kind === 'media') c.transitionIn = { type: t.type, duration: t.type === 'none' ? 0 : Math.min(t.duration, clipDuration(c)) };
  });
}

export function addEffect(target: { effects: MediaClip['effects'] }, type: EffectType): string {
  const id = newId('fx');
  target.effects.push({ id, type, enabled: true, params: defaultEffectParams(type) });
  return id;
}

export function setKeyframe(p: Project, clipId: string, prop: KeyframeProperty, localT: number, value: number): void {
  updateClip(p, clipId, (c) => {
    if (c.kind !== 'media') return;
    const list = (c.keyframes[prop] ??= []);
    const existing = list.find((k) => Math.abs(k.t - localT) < 0.02);
    if (existing) existing.v = value;
    else list.push({ t: Math.max(0, localT), v: value });
    list.sort((a, b) => a.t - b.t);
  });
}

export function removeKeyframe(p: Project, clipId: string, prop: KeyframeProperty, localT: number): void {
  updateClip(p, clipId, (c) => {
    if (c.kind !== 'media' || !c.keyframes[prop]) return;
    c.keyframes[prop] = c.keyframes[prop]!.filter((k) => Math.abs(k.t - localT) >= 0.02);
    if (c.keyframes[prop]!.length === 0) delete c.keyframes[prop];
  });
}

export function addTitle(p: Project, text: string, start: number, duration = 3): string | null {
  let track = p.timeline.tracks.find((t) => t.kind === 'text' && !t.locked);
  if (!track) track = addTrack(p, 'text');
  const clip = makeTextClip(text, start, duration);
  track.clips.push(clip);
  return clip.id;
}

export function subtitleTrack(p: Project): Track {
  let track = p.timeline.tracks.find((t) => t.kind === 'subtitle');
  if (!track) track = addTrack(p, 'subtitle');
  return track;
}

export function addCue(p: Project, start: number, end: number, text: string, trackId?: string): string {
  const track = (trackId && p.timeline.tracks.find((t) => t.id === trackId && t.kind === 'subtitle')) || subtitleTrack(p);
  const cue: SubtitleCue = { id: newId('cue'), start: Math.max(0, start), end: Math.max(start + 0.2, end), text };
  track.cues.push(cue);
  track.cues.sort((a, b) => a.start - b.start);
  return cue.id;
}

export function replaceCues(p: Project, cues: Array<{ start: number; end: number; text: string }>, trackId?: string): void {
  const track = (trackId && p.timeline.tracks.find((t) => t.id === trackId && t.kind === 'subtitle')) || subtitleTrack(p);
  track.cues = cues.filter((c) => c.text.trim() && c.end > c.start).map((c) => ({ id: newId('cue'), start: c.start, end: c.end, text: c.text.trim() }));
}

/* ------------------------------------------------------------------ SRT */

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return [...cues]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function parseSrt(text: string): Array<{ start: number; end: number; text: string }> {
  const parseT = (s: string) => {
    const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  };
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, z] = lines[timeIdx].split('-->');
    const start = parseT(a);
    const end = parseT(z);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end, text: lines.slice(timeIdx + 1).join('\n').slice(0, 1000) });
  }
  return out;
}

/** Arrange storyboard shot clips sequentially on a video track. */
export function appendShotsToTimeline(p: Project, items: Array<{ asset: Pick<Asset, 'id' | 'type' | 'duration' | 'hasAudio' | 'name'>; label: string }>, trackId?: string): string[] {
  const ids: string[] = [];
  let track = trackId ? p.timeline.tracks.find((t) => t.id === trackId) : p.timeline.tracks.find((t) => t.kind === 'video' && !t.locked);
  if (!track) track = addTrack(p, 'video');
  let t = trackTail(track);
  for (const it of items) {
    const clip = addAssetClip(p, it.asset, { trackId: track.id, start: t });
    if (!clip) continue;
    clip.label = it.label;
    t = clipEnd(clip);
    ids.push(clip.id);
  }
  return ids;
}
