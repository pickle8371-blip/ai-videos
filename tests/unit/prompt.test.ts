import { describe, expect, it } from 'vitest';
import { cameraToText, composePrompt } from '../../shared/prompt';

describe('prompt composition', () => {
  it('appends camera, style, lighting and references in plain language', () => {
    const text = composePrompt({
      prompt: 'A samurai walks through rain',
      style: 'Film noir',
      lighting: 'Moonlight',
      camera: { move: 'slowPushIn', framing: 'closeUp', speed: 0.2, intensity: 0.5, subjectFocus: 'his eyes', direction: 'auto' },
      motionIntensity: 0.1,
      characters: [{ id: 'c', name: 'Kaito', description: '', appearance: 'lean ronin', face: '', body: '', clothing: 'black armor', accessories: '', palette: [], referenceAssetIds: [], approvedAssetIds: [], rejectedAssetIds: [], notes: '', createdAt: '' }],
      environment: { id: 'e', name: 'Village', category: 'historical', description: 'empty Edo village', lighting: '', atmosphere: 'fog', palette: [], referenceAssetIds: [], notes: '', createdAt: '' },
      preserveReference: true,
    });
    expect(text).toContain('A samurai walks through rain');
    expect(text).toContain('Kaito: lean ronin; black armor');
    expect(text).toContain('Setting — Village: empty Edo village; fog');
    expect(text).toContain('close-up');
    expect(text).toContain('close-up, slow cinematic push-in');
    expect(text).not.toMatch(/slow slow/);
    expect(text).toContain('focus on his eyes');
    expect(text).toContain('Style: Film noir');
    expect(text).toContain('Lighting: Moonlight');
    expect(text).toContain('minimal motion');
    expect(text).toContain('consistent with the reference image');
  });

  it('prefixes camera speed for moves without an inherent pace', () => {
    expect(cameraToText({ move: 'panLeft', framing: 'auto', speed: 0.9, intensity: 0.5, subjectFocus: '', direction: 'left' })).toBe('fast camera pans left');
  });

  it('omits "None" choices and empty camera direction', () => {
    const text = composePrompt({ prompt: 'x', style: 'None', lighting: 'None' });
    expect(text).toBe('x');
    expect(cameraToText({ move: 'static', framing: 'wide', speed: 0.5, intensity: 0.5, subjectFocus: '', direction: 'auto' })).toBe('wide shot');
  });
});
