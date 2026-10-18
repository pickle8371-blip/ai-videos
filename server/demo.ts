/**
 * Builds the demonstration project. Sample media is synthesised with FFmpeg
 * test sources and is labelled "SAMPLE" — it is not AI output.
 */
import type { Asset } from '../shared/api.js';
import { createProject, makeMediaClip, makeTextClip, newId } from '../shared/factory.js';
import { defaultEffectParams } from '../shared/effects.js';
import type { Project } from '../shared/project.js';
import type { AppContext } from './app.js';
import { detectFfmpeg, filterPath, runFfmpeg } from './media/ffmpeg.js';
import { runOffline } from './ai.js';

async function makeSample(ctx: AppContext, name: string, args: string[], ext: string, tags: string[]): Promise<Asset> {
  const out = ctx.assets.tempFile(`.${ext}`);
  await runFfmpeg([...args, out], { timeoutMs: 120_000 });
  return ctx.assets.importFile(out, `${name}.${ext}`, {
    origin: 'sample',
    name,
    tags: ['sample', ...tags],
    provenance: { aiGenerated: false, generator: 'FFmpeg test source (sample media)', note: 'Synthetic sample media for the demo project — not AI generated' },
  });
}

export async function createDemoProject(ctx: AppContext): Promise<Project> {
  const ff = detectFfmpeg();
  const font = ff.fontFile ? `fontfile=${filterPath(ff.fontFile)}` : "font='Sans'";
  const label = (text: string) => `drawtext=${font}:text='${text}':fontsize=34:fontcolor=white@0.85:x=(w-text_w)/2:y=h*0.7:box=1:boxcolor=black@0.4:boxborderw=10`;
  const W = 1280;
  const H = 720;

  const plateA = await makeSample(
    ctx,
    'Sample plate A — violet drift',
    ['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x120a24:c1=0x6d3fd1:c2=0x1b1036:n=3:speed=0.015:d=6:r=30`, '-vf', `noise=alls=8:allf=t,${label('SAMPLE PLATE A')}`, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'],
    'mp4',
    ['plate'],
  );
  const plateB = await makeSample(
    ctx,
    'Sample plate B — fractal zoom',
    ['-f', 'lavfi', '-i', `mandelbrot=s=${W}x${H}:r=30:end_scale=0.05`, '-vf', `hue=h=250:s=0.8,${label('SAMPLE PLATE B')}`, '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'],
    'mp4',
    ['plate'],
  );
  const plateC = await makeSample(
    ctx,
    'Sample plate C — cellular rain',
    ['-f', 'lavfi', '-i', `cellauto=s=320x180:rule=18:r=30,scale=${W}:${H}:flags=neighbor`, '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.15:r=48000', '-vf', `colorchannelmixer=rr=0.45:gg=0.35:bb=0.9,${label('SAMPLE PLATE C')}`, '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest'],
    'mp4',
    ['plate', 'ambience'],
  );
  const still = await makeSample(
    ctx,
    'Sample still — character card',
    ['-f', 'lavfi', '-i', `gradients=s=1024x1024:c0=0x0d0a18:c1=0x8b5cf6:x0=0:y0=1024:x1=1024:y1=0:d=1`, '-vf', `drawtext=${font}:text='SAMPLE STILL':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, '-frames:v', '1'],
    'png',
    ['still'],
  );
  const music = await makeSample(
    ctx,
    'Sample music — drone chord',
    ['-f', 'lavfi', '-i', "aevalsrc='0.12*sin(2*PI*110*t)+0.08*sin(2*PI*164.81*t)+0.06*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))':s=48000:d=16", '-af', 'afade=t=in:d=2,afade=t=out:st=13:d=3', '-c:a', 'aac', '-b:a', '160k'],
    'm4a',
    ['music'],
  );
  const sfx = await makeSample(
    ctx,
    'Sample SFX — thunder rumble',
    ['-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.6:d=3:r=48000', '-af', 'lowpass=f=300,afade=t=in:d=0.2,afade=t=out:st=1:d=2', '-c:a', 'aac'],
    'm4a',
    ['sfx'],
  );

  const p = createProject({ name: 'Demo — Samurai in the Rain (sample media)', aspectRatio: '16:9', resolution: '720p', fps: 30 });
  p.description = 'Demonstration project built from synthetic sample media. Replace the plates with generated clips once an AI video provider is connected.';
  const now = new Date().toISOString();
  p.characters.push({
    id: newId('chr'),
    name: 'Kaito',
    description: 'A weary ronin returning to his abandoned home village.',
    appearance: 'Middle-aged Japanese man, lean build, sharp eyes, short beard',
    face: 'Weathered face, thin scar across left cheek',
    body: 'Tall, lean, upright posture',
    clothing: 'Dark lacquered samurai armor with indigo cords, tattered black cloak',
    accessories: 'Katana with red-wrapped hilt, straw kasa hat',
    palette: ['#1b1b2f', '#3a3f7a', '#8b1e2d', '#c9b37e'],
    referenceAssetIds: [still.id],
    approvedAssetIds: [],
    rejectedAssetIds: [],
    notes: '',
    createdAt: now,
  });
  p.environments.push({
    id: newId('env'),
    name: 'Abandoned village',
    category: 'historical',
    description: 'Edo-period mountain village, empty wooden houses, stone streets, overgrown gardens',
    lighting: 'Paper lanterns glowing warm amber against cold blue night',
    atmosphere: 'Heavy rain, drifting fog, puddles reflecting lantern light',
    palette: ['#0f1420', '#2b3a55', '#e0a458'],
    referenceAssetIds: [],
    notes: '',
    createdAt: now,
  });
  const idea =
    'Kaito walks through the abandoned village during heavy rain. Lanterns flicker along the wet stone street. He stops at the gate of his old house. He looks at a faded family crest on the door. Thunder rolls as he steps inside.';
  const board = runOffline('storyboard', {
    idea,
    shotCount: 5,
    style: 'Cinematic realism',
    characters: [{ name: 'Kaito', description: 'ronin in dark lacquered armor and tattered cloak' }],
    environments: [{ name: 'Abandoned village', description: 'rainy Edo-period village lit by paper lanterns' }],
  }) as { shots: Array<{ title: string; description: string; prompt: string; cameraAngle: string; cameraMove: Project['storyboard']['shots'][number]['camera']['move']; framing: Project['storyboard']['shots'][number]['camera']['framing']; lighting: string; duration: number; dialogue: string; characterNames: string[] }> };
  p.storyboard = {
    idea,
    source: 'offline-template',
    shots: board.shots.map((s, i) => ({
      id: newId('sht'),
      title: s.title,
      description: s.description,
      prompt: s.prompt,
      characterIds: s.characterNames.includes('Kaito') ? [p.characters[0].id] : [],
      environmentId: p.environments[0].id,
      cameraAngle: s.cameraAngle,
      camera: { move: s.cameraMove, framing: s.framing, speed: 0.35, intensity: 0.5, subjectFocus: '', direction: 'auto' },
      lighting: s.lighting,
      dialogue: s.dialogue,
      duration: s.duration,
      status: i < 3 ? 'done' : 'draft',
      frameAssetId: null,
      videoAssetId: i === 0 ? plateA.id : i === 1 ? plateB.id : i === 2 ? plateC.id : null,
      lastJobId: null,
      review: 'unreviewed',
      error: null,
    })),
  };

  const v1 = p.timeline.tracks.find((t) => t.kind === 'video')!;
  const titles = p.timeline.tracks.find((t) => t.kind === 'text')!;
  const subs = p.timeline.tracks.find((t) => t.kind === 'subtitle')!;
  const musicTrack = p.timeline.tracks.find((t) => t.role === 'music')!;
  const sfxTrack = p.timeline.tracks.find((t) => t.role === 'sfx')!;
  const a = makeMediaClip(plateA.id, 0, 6, { label: plateA.name, fadeIn: 1 });
  a.effects.push({ id: newId('fx'), type: 'filmGrain', enabled: true, params: defaultEffectParams('filmGrain') });
  const b = makeMediaClip(plateB.id, 5, 5, { label: plateB.name, transitionIn: { type: 'dissolve', duration: 1 } });
  b.color = { ...b.color, saturation: 0.8, contrast: 1.1 };
  const c = makeMediaClip(plateC.id, 9.5, 5, { label: plateC.name, transitionIn: { type: 'dipToBlack', duration: 0.6 }, fadeOut: 1, volume: 0.6 });
  c.effects.push({ id: newId('fx'), type: 'vignette', enabled: true, params: defaultEffectParams('vignette') });
  v1.clips.push(a, b, c);
  titles.clips.push(makeTextClip('THE RETURN', 0.5, 3.5, { style: { fontSize: 84, color: '#ffffff', x: 0.5, y: 0.45, bold: true, box: false, boxColor: '#000000', boxOpacity: 0.5, shadow: true }, fadeIn: 0.8, fadeOut: 0.8 }));
  subs.cues.push({ id: newId('cue'), start: 6, end: 9, text: 'Kaito: …It has been ten years.' }, { id: newId('cue'), start: 10.5, end: 13.5, text: 'Kaito: Nothing is left.' });
  musicTrack.clips.push(makeMediaClip(music.id, 0, 14.5, { label: music.name, volume: 0.7, fadeOut: 2 }));
  sfxTrack.clips.push(makeMediaClip(sfx.id, 9.2, 3, { label: sfx.name }));
  p.timeline.masterEffects.push({ id: newId('fx'), type: 'letterbox', enabled: true, params: defaultEffectParams('letterbox') });
  p.assetIds = [plateA.id, plateB.id, plateC.id, still.id, music.id, sfx.id];
  for (const id of p.assetIds) await ctx.assets.linkProject(id, p.id);
  return ctx.projects.save(p);
}

