import { describe, expect, it } from 'vitest';
import { makeMediaClip, makeTextClip } from '../../shared/factory';
import { clipDuration, clipEnd, formatTimecode, interpolateKeyframes, snapTime, splitClip } from '../../shared/timeline';

describe('timeline math', () => {
  it('computes clip duration with speed', () => {
    const c = makeMediaClip('a', 2, 10, { in: 2, out: 8, speed: 2 });
    expect(clipDuration(c)).toBe(3);
    expect(clipEnd(c)).toBe(5);
  });

  it('interpolates keyframes linearly and clamps at the ends', () => {
    const k = [
      { t: 0, v: 0 },
      { t: 2, v: 1 },
    ];
    expect(interpolateKeyframes(k, -1, 9)).toBe(0);
    expect(interpolateKeyframes(k, 1, 9)).toBeCloseTo(0.5);
    expect(interpolateKeyframes(k, 5, 9)).toBe(1);
    expect(interpolateKeyframes([], 1, 9)).toBe(9);
  });

  it('splits a media clip preserving source continuity', () => {
    const c = makeMediaClip('a', 10, 6, { in: 1, out: 7, speed: 1, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 4, v: 1 }] } });
    const parts = splitClip(c, 12, 'right')!;
    expect(parts).not.toBeNull();
    const [l, r] = parts;
    expect(l.kind === 'media' && l.out).toBe(3);
    expect(r.kind === 'media' && r.in).toBe(3);
    expect(r.start).toBe(12);
    expect(clipDuration(l) + clipDuration(r)).toBeCloseTo(clipDuration(c));
    // Keyframes after the split move to the right half, re-based.
    expect(r.kind === 'media' && r.keyframes.opacity?.[0]).toEqual({ t: 2, v: 1 });
  });

  it('splits text clips and refuses to split at the edges', () => {
    const t = makeTextClip('Hi', 0, 4);
    expect(splitClip(t, 0, 'x')).toBeNull();
    expect(splitClip(t, 4, 'x')).toBeNull();
    const [a, b] = splitClip(t, 1, 'x')!;
    expect(a.kind === 'text' && a.duration).toBe(1);
    expect(b.kind === 'text' && b.duration).toBe(3);
  });

  it('snaps to nearby candidates only', () => {
    expect(snapTime(4.95, [0, 5, 10], 0.1)).toBe(5);
    expect(snapTime(4.5, [0, 5, 10], 0.1)).toBe(4.5);
  });

  it('formats timecodes', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(61.5, 30)).toBe('01:01:15');
    expect(formatTimecode(3661, 24)).toBe('01:01:01:00');
  });
});
