import { describe, expect, it } from 'vitest';
import { createProject, makeTextClip } from '../../shared/factory';
import { addAssetClip, addCue, addTrack, deleteClips, duplicateClips, moveClip, parseSrt, removeKeyframe, setKeyframe, splitAt, toSrt, trimClip } from '../../shared/ops';
import { clipDuration, findClip, timelineDuration } from '../../shared/timeline';
import { validateProject } from '../../server/storage/projects';

const video = { id: 'ast_v', type: 'video' as const, duration: 8, hasAudio: true, name: 'Video' };
const still = { id: 'ast_i', type: 'image' as const, duration: null, hasAudio: false, name: 'Still' };
const audio = { id: 'ast_a', type: 'audio' as const, duration: 20, hasAudio: true, name: 'Music' };

function project() {
  return createProject({ name: 'Test', aspectRatio: '16:9', resolution: '720p' });
}

describe('timeline operations', () => {
  it('adds clips to compatible tracks, appending after existing clips', () => {
    const p = project();
    const a = addAssetClip(p, video)!;
    const b = addAssetClip(p, video)!;
    expect(a.start).toBe(0);
    expect(b.start).toBe(8);
    const s = addAssetClip(p, still)!;
    expect(clipDuration(s)).toBe(p.settings.stillDuration);
    const m = addAssetClip(p, audio)!;
    expect(findClip(p, m.id)!.track.kind).toBe('audio');
    // Audio cannot go on a video track.
    const v1 = p.timeline.tracks.find((t) => t.kind === 'video')!;
    expect(addAssetClip(p, audio, { trackId: v1.id })).toBeNull();
    expect(p.assetIds).toEqual(expect.arrayContaining(['ast_v', 'ast_i', 'ast_a']));
    expect(() => validateProject(p)).not.toThrow();
  });

  it('moves clips between compatible tracks only', () => {
    const p = project();
    const c = addAssetClip(p, video)!;
    const v2 = p.timeline.tracks.filter((t) => t.kind === 'video')[1];
    const audioTrack = p.timeline.tracks.find((t) => t.kind === 'audio')!;
    moveClip(p, c.id, 3, v2.id);
    expect(findClip(p, c.id)!.track.id).toBe(v2.id);
    expect(findClip(p, c.id)!.clip.start).toBe(3);
    moveClip(p, c.id, 4, audioTrack.id);
    expect(findClip(p, c.id)!.track.id).toBe(v2.id);
  });

  it('respects locked tracks', () => {
    const p = project();
    const c = addAssetClip(p, video)!;
    findClip(p, c.id)!.track.locked = true;
    expect(moveClip(p, c.id, 5)).toBe(false);
    expect(deleteClips(p, [c.id])).toBe(0);
  });

  it('trims left and right within source bounds', () => {
    const p = project();
    const c = addAssetClip(p, video, { start: 2 })!;
    trimClip(p, c.id, 'left', 4, 8);
    let cur = findClip(p, c.id)!.clip as typeof c;
    expect(cur.start).toBe(4);
    expect(cur.in).toBe(2);
    expect(cur.out).toBe(8);
    trimClip(p, c.id, 'right', 7, 8);
    cur = findClip(p, c.id)!.clip as typeof c;
    expect(cur.out).toBe(5);
    // Cannot extend past the source.
    trimClip(p, c.id, 'right', 100, 8);
    expect((findClip(p, c.id)!.clip as typeof c).out).toBe(8);
    // Cannot trim before source start.
    trimClip(p, c.id, 'left', 0, 8);
    cur = findClip(p, c.id)!.clip as typeof c;
    expect(cur.in).toBe(0);
    expect(cur.start).toBe(2);
  });

  it('stretches stills freely', () => {
    const p = project();
    const s = addAssetClip(p, still)!;
    trimClip(p, s.id, 'right', 30, null);
    expect(clipDuration(findClip(p, s.id)!.clip)).toBe(30);
  });

  it('splits at time, deletes with ripple and duplicates', () => {
    const p = project();
    const a = addAssetClip(p, video)!;
    const b = addAssetClip(p, video)!;
    const created = splitAt(p, 4, [a.id]);
    expect(created).toHaveLength(1);
    expect(timelineDuration(p.timeline)).toBe(16);
    deleteClips(p, [created[0]], true);
    expect(findClip(p, b.id)!.clip.start).toBe(4);
    const dup = duplicateClips(p, [b.id]);
    expect(findClip(p, dup[0])!.clip.start).toBe(12);
    expect(() => validateProject(p)).not.toThrow();
  });

  it('sets and removes keyframes', () => {
    const p = project();
    const c = addAssetClip(p, video)!;
    setKeyframe(p, c.id, 'opacity', 1, 0.2);
    setKeyframe(p, c.id, 'opacity', 0, 1);
    setKeyframe(p, c.id, 'opacity', 1, 0.5);
    const cur = findClip(p, c.id)!.clip as typeof c;
    expect(cur.keyframes.opacity).toEqual([
      { t: 0, v: 1 },
      { t: 1, v: 0.5 },
    ]);
    removeKeyframe(p, c.id, 'opacity', 0);
    removeKeyframe(p, c.id, 'opacity', 1);
    expect((findClip(p, c.id)!.clip as typeof c).keyframes.opacity).toBeUndefined();
  });

  it('adds tracks grouped by kind', () => {
    const p = project();
    const t = addTrack(p, 'video');
    const idx = p.timeline.tracks.findIndex((x) => x.id === t.id);
    expect(p.timeline.tracks.slice(0, idx + 1).every((x) => x.kind === 'video')).toBe(true);
  });

  it('round-trips subtitles through SRT', () => {
    const p = project();
    addCue(p, 1.5, 3.25, 'Hello');
    addCue(p, 0, 1, 'First\nline two');
    const track = p.timeline.tracks.find((t) => t.kind === 'subtitle')!;
    const srt = toSrt(track.cues);
    expect(srt).toContain('00:00:01,500 --> 00:00:03,250');
    const parsed = parseSrt(srt);
    expect(parsed).toEqual([
      { start: 0, end: 1, text: 'First\nline two' },
      { start: 1.5, end: 3.25, text: 'Hello' },
    ]);
    expect(parseSrt('garbage')).toEqual([]);
  });

  it('text clips live on text tracks', () => {
    const p = project();
    const titles = p.timeline.tracks.find((t) => t.kind === 'text')!;
    titles.clips.push(makeTextClip('A', 0, 2));
    expect(() => validateProject(p)).not.toThrow();
  });
});
