import { describe, expect, it } from 'vitest';
import { createProject, makeMediaClip, BUILT_IN_TEMPLATES } from '../../shared/factory';
import { validateProject, ValidationError } from '../../server/storage/projects';

describe('project format validation', () => {
  it('accepts a freshly created project', () => {
    const p = createProject({ name: 'Ok' });
    expect(validateProject(JSON.parse(JSON.stringify(p))).name).toBe('Ok');
  });

  it('fills defaults for optional sections', () => {
    const p = createProject({ name: 'Ok' }) as unknown as Record<string, unknown>;
    delete p.characters;
    delete p.storyboard;
    const v = validateProject(p);
    expect(v.characters).toEqual([]);
    expect(v.storyboard.shots).toEqual([]);
  });

  it('rejects wrong format versions and missing fields', () => {
    const p = createProject({ name: 'Bad' });
    expect(() => validateProject({ ...p, formatVersion: 2 })).toThrow(ValidationError);
    expect(() => validateProject({ ...p, name: '' })).toThrow(ValidationError);
    expect(() => validateProject('nope')).toThrow(ValidationError);
    expect(() => validateProject(null)).toThrow(ValidationError);
  });

  it('rejects structurally invalid timelines', () => {
    const p = createProject({ name: 'Bad' });
    const v1 = p.timeline.tracks.find((t) => t.kind === 'video')!;
    v1.clips.push(makeMediaClip('a', 0, 5, { in: 4, out: 2 }));
    expect(() => validateProject(p)).toThrow(/out point/);

    const q = createProject({ name: 'Dup' });
    const c = makeMediaClip('a', 0, 5);
    q.timeline.tracks.find((t) => t.kind === 'video')!.clips.push(c, { ...c });
    expect(() => validateProject(q)).toThrow(/Duplicate clip/);

    const r = createProject({ name: 'Wrong track' });
    r.timeline.tracks.find((t) => t.kind === 'text')!.clips.push(makeMediaClip('a', 0, 5));
    expect(() => validateProject(r)).toThrow(/text track/);
  });

  it('rejects out-of-range values and bad colours', () => {
    const p = createProject({ name: 'Range' });
    expect(() => validateProject({ ...p, settings: { ...p.settings, fps: 1000 } })).toThrow(ValidationError);
    expect(() => validateProject({ ...p, settings: { ...p.settings, background: 'red' } })).toThrow(ValidationError);
  });

  it('ships templates with sensible formats', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.builtIn).toBe(true);
      const p = createProject({ name: t.name, aspectRatio: t.aspectRatio, resolution: t.resolution, fps: t.fps });
      expect(() => validateProject(p)).not.toThrow();
    }
  });
});
