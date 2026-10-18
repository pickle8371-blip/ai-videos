/**
 * Timeline compiler: turns a project timeline into an FFmpeg invocation.
 *
 * Every editing operation that changes the project document (trim, split,
 * speed, volume, fades, transforms, color, effects, transitions, keyframes,
 * titles, subtitles, track mute/solo/hide) is reflected here, so the exported
 * file matches the edit.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Clip, ExportSettings, Keyframe, MediaClip, Project, TextClip, Track } from '../../shared/project.js';
import { clipDuration, clipEnd, timelineDuration } from '../../shared/timeline.js';
import { effectChain } from './effects.js';
import { detectFfmpeg, filterPath, filterScriptArgs, MediaError, probe, runFfmpeg } from './ffmpeg.js';

export interface RenderAsset {
  id: string;
  path: string;
  type: 'video' | 'image' | 'audio';
  width: number | null;
  height: number | null;
  duration: number | null;
  hasAudio: boolean;
}

export interface RenderOptions {
  width: number;
  height: number;
  fps: number;
  codec: ExportSettings['codec'];
  container: ExportSettings['container'];
  quality: ExportSettings['quality'];
  includeAudio: boolean;
  audioBitrateKbps: number;
  /** Render only [start, end) of the timeline. */
  range?: { start: number; end: number };
  /** Render a single still frame (JPEG/PNG by extension) at this time. */
  frameAt?: number;
  /** Faster encoder settings (preview renders). */
  fast?: boolean;
}

export interface CompiledRender {
  args: string[];
  scriptFile: string;
  duration: number;
  textFiles: string[];
}

const n = (v: number, d = 4) => Number(v.toFixed(d));
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Piecewise-linear expression over keyframes in variable `tv` (local clip time). */
export function keyframeExpr(frames: Keyframe[] | undefined, fallback: number, tv: string): string {
  if (!frames || frames.length === 0) return String(n(fallback));
  const k = [...frames].sort((a, b) => a.t - b.t);
  if (k.length === 1) return String(n(k[0].v));
  let expr = String(n(k[k.length - 1].v));
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    const span = Math.max(1e-4, b.t - a.t);
    expr = `if(lt(${tv},${n(b.t)}),${n(a.v)}+(${n(b.v - a.v)})*(${tv}-${n(a.t)})/${n(span)},${expr})`;
  }
  return `if(lt(${tv},${n(k[0].t)}),${n(k[0].v)},${expr})`;
}

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${n(s)}`);
  return out;
}

function hexToFfColor(hex: string, alpha = 1): string {
  return `0x${hex.replace('#', '')}@${n(alpha, 3)}`;
}

function encoderArgs(o: RenderOptions): string[] {
  const q = o.fast ? 'draft' : o.quality;
  switch (o.codec) {
    case 'h264': {
      const crf = { draft: 28, standard: 23, high: 19, master: 16 }[q];
      const preset = o.fast ? 'ultrafast' : { draft: 'veryfast', standard: 'medium', high: 'medium', master: 'slow' }[q];
      return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
    }
    case 'h265': {
      const crf = { draft: 32, standard: 28, high: 24, master: 20 }[q];
      return ['-c:v', 'libx265', '-preset', o.fast ? 'ultrafast' : 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
    }
    case 'vp9': {
      const crf = { draft: 40, standard: 34, high: 30, master: 24 }[q];
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-row-mt', '1', '-deadline', o.fast ? 'realtime' : 'good', '-cpu-used', o.fast ? '8' : '2', '-pix_fmt', 'yuv420p'];
    }
    case 'prores':
      return ['-c:v', 'prores_ks', '-profile:v', q === 'master' ? '4' : '3', '-pix_fmt', q === 'master' ? 'yuva444p10le' : 'yuv422p10le'];
  }
}

function audioEncoderArgs(o: RenderOptions): string[] {
  if (o.codec === 'vp9') return ['-c:a', 'libopus', '-b:a', `${o.audioBitrateKbps}k`];
  if (o.codec === 'prores') return ['-c:a', 'pcm_s16le'];
  return ['-c:a', 'aac', '-b:a', `${o.audioBitrateKbps}k`];
}

export function validateCodecContainer(codec: ExportSettings['codec'], container: ExportSettings['container']): string | null {
  if (codec === 'vp9' && container !== 'webm') return 'VP9 exports must use the WebM container';
  if (container === 'webm' && codec !== 'vp9') return 'WebM exports support only the VP9 codec';
  if (codec === 'prores' && container !== 'mov') return 'ProRes exports must use the MOV container';
  return null;
}

interface InputSpec {
  args: string[];
}

/**
 * Compile the project into ffmpeg arguments. Writes the filtergraph and any
 * text files into `workDir`.
 */
export async function compileRender(
  project: Project,
  assets: Map<string, RenderAsset>,
  o: RenderOptions,
  outputFile: string,
  workDir: string,
): Promise<CompiledRender> {
  const ff = detectFfmpeg();
  const W = even(o.width);
  const H = even(o.height);
  const fps = o.fps;
  const total = Math.max(0.1, timelineDuration(project.timeline));
  if (timelineDuration(project.timeline) <= 0) throw new MediaError('The timeline is empty — add clips before rendering.', 400);
  const scaleText = H / project.settings.height;

  const inputs: InputSpec[] = [];
  const graph: string[] = [];
  const textFiles: string[] = [];
  const addInput = (args: string[]) => {
    inputs.push({ args });
    return inputs.length - 1;
  };

  await fs.mkdir(workDir, { recursive: true });

  // ---- video composition --------------------------------------------------
  graph.push(`color=c=${hexToFfColor(project.settings.background)}:s=${W}x${H}:r=${fps}:d=${n(total, 3)},format=yuv420p[base]`);
  let cur = 'base';
  let seq = 0;

  const videoTracks = project.timeline.tracks.filter((t) => t.kind === 'video' && !t.hidden);
  for (const track of videoTracks) {
    const clips = [...track.clips].filter((c): c is MediaClip => c.kind === 'media').sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      const asset = assets.get(clip.assetId);
      if (!asset) throw new MediaError(`Clip "${clip.label ?? clip.id}" references a missing asset (${clip.assetId}).`, 400);
      if (asset.type === 'audio') continue;
      const dur = clipDuration(clip);
      if (dur <= 0.001) continue;
      const srcDur = clip.out - clip.in;
      const idx =
        asset.type === 'image'
          ? addInput(['-loop', '1', '-framerate', String(fps), '-t', String(n(srcDur + 0.1, 3)), '-i', asset.path])
          : addInput(['-ss', String(n(clip.in, 3)), '-t', String(n(srcDur, 3)), '-i', asset.path]);
      const uid = `c${seq++}`;
      const start = clip.start;
      const end = start + dur;
      const tf = clip.transform;

      // Source dimensions after crop.
      const srcW = asset.width ?? W;
      const srcH = asset.height ?? H;
      const cr = tf.crop;
      const cw = Math.max(2, srcW * (1 - cr.left - cr.right));
      const ch = Math.max(2, srcH * (1 - cr.top - cr.bottom));
      const hasScaleKeys = (clip.keyframes.scale?.length ?? 0) > 0;
      const s = hasScaleKeys ? 1 : tf.scale;
      let fw: number;
      let fh: number;
      if (tf.fit === 'stretch') {
        fw = W * s;
        fh = H * s;
      } else {
        const k = tf.fit === 'cover' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
        fw = cw * k * s;
        fh = ch * k * s;
      }
      fw = even(Math.min(fw, 8192));
      fh = even(Math.min(fh, 8192));

      const chain: string[] = [];
      chain.push(`setpts=(PTS-STARTPTS)/${n(clip.speed)}`);
      chain.push(`fps=${fps}`);
      if (cr.left + cr.right + cr.top + cr.bottom > 0) {
        chain.push(`crop=trunc(iw*${n(1 - cr.left - cr.right)}/2)*2:trunc(ih*${n(1 - cr.top - cr.bottom)}/2)*2:trunc(iw*${n(cr.left)}):trunc(ih*${n(cr.top)})`);
      }
      chain.push(`scale=${fw}:${fh}:flags=bicubic`, 'setsar=1', 'format=yuv420p');
      const c = clip.color;
      if (c.brightness !== 0 || c.contrast !== 1 || c.saturation !== 1 || c.gamma !== 1) {
        chain.push(`eq=brightness=${n(c.brightness)}:contrast=${n(c.contrast)}:saturation=${n(c.saturation)}:gamma=${n(c.gamma)}`);
      }
      if (c.hue !== 0) chain.push(`hue=h=${n(c.hue)}`);
      if (c.exposure !== 0) chain.push(`exposure=exposure=${n(c.exposure)}`);
      if (c.temperature !== 0) {
        const t = n(c.temperature * 0.18);
        chain.push(`colorbalance=rm=${t}:bm=${n(-t)}:rh=${n(t / 2)}:bh=${n(-t / 2)}`);
      }
      graph.push(`[${idx}:v]${chain.join(',')}[${uid}_pre]`);
      const fx = effectChain(clip.effects, `${uid}_pre`, uid, fw, fh);
      graph.push(...fx.graph);

      // Shift to timeline time, then alpha operations.
      const post: string[] = [`setpts=PTS-STARTPTS+${n(start, 4)}/TB`, 'format=yuva420p'];
      if (clip.keyframes.opacity?.length) {
        const expr = keyframeExpr(clip.keyframes.opacity, tf.opacity, `(T-${n(start)})`);
        post.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${expr},0,1)'`);
      } else if (tf.opacity < 1) {
        post.push(`colorchannelmixer=aa=${n(tf.opacity)}`);
      }
      const tr = clip.transitionIn;
      const trDur = tr.type !== 'none' ? Math.min(tr.duration, dur) : 0;
      if (trDur > 0 && tr.type === 'dissolve') post.push(`fade=t=in:st=${n(start)}:d=${n(trDur)}:alpha=1`);
      if (trDur > 0 && tr.type === 'dipToBlack') post.push(`fade=t=in:st=${n(start)}:d=${n(trDur)}`);
      if (clip.fadeIn > 0) post.push(`fade=t=in:st=${n(start)}:d=${n(Math.min(clip.fadeIn, dur))}:alpha=1`);
      if (clip.fadeOut > 0) post.push(`fade=t=out:st=${n(end - Math.min(clip.fadeOut, dur))}:d=${n(Math.min(clip.fadeOut, dur))}:alpha=1`);
      if (hasScaleKeys) {
        const expr = keyframeExpr(clip.keyframes.scale, tf.scale, `(t-${n(start)})`);
        post.push(`scale=eval=frame:w='max(2,trunc(iw*(${expr})/2)*2)':h='max(2,trunc(ih*(${expr})/2)*2)'`);
      }
      graph.push(`[${fx.out}]${post.join(',')}[${uid}_v]`);

      const lt = `(t-${n(start)})`;
      const xk = keyframeExpr(clip.keyframes.x, tf.x, lt);
      const yk = keyframeExpr(clip.keyframes.y, tf.y, lt);
      let slideX = '0';
      let slideY = '0';
      if (trDur > 0 && tr.type.startsWith('slide')) {
        const prog = `if(lt(${lt},${n(trDur)}),1-${lt}/${n(trDur)},0)`;
        if (tr.type === 'slideLeft') slideX = `W*${prog}`;
        if (tr.type === 'slideRight') slideX = `-W*${prog}`;
        if (tr.type === 'slideUp') slideY = `H*${prog}`;
        if (tr.type === 'slideDown') slideY = `-H*${prog}`;
      }
      const next = `${uid}_o`;
      graph.push(
        `[${cur}][${uid}_v]overlay=x='(W-w)/2+(${xk})*W+${slideX}':y='(H-h)/2+(${yk})*H+${slideY}':eval=frame:eof_action=pass:format=auto:enable='between(t,${n(start)},${n(end)})'[${next}]`,
      );
      cur = next;
    }
  }

  // ---- master effects (before titles so text stays readable over letterbox bars)
  const master = effectChain(project.timeline.masterEffects, cur, 'm', W, H);
  graph.push(...master.graph);
  cur = master.out;

  // ---- titles ---------------------------------------------------------------
  const fontArg = (bold: boolean) => {
    if (ff.fontFile) {
      const boldFile = bold ? ff.fontFile.replace(/DejaVuSans\.ttf$/, 'DejaVuSans-Bold.ttf').replace(/arial\.ttf$/i, 'arialbd.ttf').replace(/segoeui\.ttf$/i, 'segoeuib.ttf') : ff.fontFile;
      return `fontfile=${filterPath(boldFile)}`;
    }
    return `font='${bold ? 'Sans\\:style=Bold' : 'Sans'}'`;
  };
  const drawText = async (text: string, start: number, end: number, style: TextClip['style'], fadeIn: number, fadeOut: number, uid: string) => {
    if (!ff.drawtext) throw new MediaError('This FFmpeg build lacks the drawtext filter (needs libfreetype); titles and burned-in subtitles cannot be rendered.', 500);
    const file = path.join(workDir, `${uid}.txt`);
    await fs.writeFile(file, text.replace(/\r\n/g, '\n'), 'utf8');
    textFiles.push(file);
    const size = Math.max(6, Math.round(style.fontSize * scaleText));
    const a = `if(lt(t,${n(start + fadeIn)}),${fadeIn > 0 ? `(t-${n(start)})/${n(fadeIn)}` : '1'},if(gt(t,${n(end - fadeOut)}),${fadeOut > 0 ? `(${n(end)}-t)/${n(fadeOut)}` : '1'},1))`;
    const parts = [
      fontArg(style.bold),
      `textfile=${filterPath(file)}`,
      'expansion=none',
      `fontsize=${size}`,
      `fontcolor=${hexToFfColor(style.color)}`,
      `x='w*${n(style.x)}-text_w/2'`,
      `y='h*${n(style.y)}-text_h/2'`,
      `alpha='max(0,min(1,${a}))'`,
      `enable='between(t,${n(start)},${n(end)})'`,
      'line_spacing=8',
    ];
    if (style.box) parts.push('box=1', `boxcolor=${hexToFfColor(style.boxColor, style.boxOpacity)}`, `boxborderw=${Math.round(size * 0.35)}`);
    if (style.shadow) parts.push('shadowcolor=0x000000@0.6', `shadowx=${Math.max(1, Math.round(size / 24))}`, `shadowy=${Math.max(1, Math.round(size / 24))}`);
    const next = `${uid}_o`;
    graph.push(`[${cur}]drawtext=${parts.join(':')}[${next}]`);
    cur = next;
  };

  for (const track of project.timeline.tracks.filter((t) => t.kind === 'text' && !t.hidden)) {
    for (const clip of track.clips) {
      if (clip.kind !== 'text' || !clip.text.trim()) continue;
      await drawText(clip.text, clip.start, clipEnd(clip), clip.style, clip.fadeIn, clip.fadeOut, `t${seq++}`);
    }
  }
  for (const track of project.timeline.tracks.filter((t) => t.kind === 'subtitle' && !t.hidden && t.burnIn)) {
    const subStyle: TextClip['style'] = {
      fontSize: Math.round(project.settings.height * 0.045),
      color: '#ffffff',
      x: 0.5,
      y: 0.88,
      bold: false,
      box: true,
      boxColor: '#000000',
      boxOpacity: 0.55,
      shadow: false,
    };
    for (const cue of track.cues) {
      if (!cue.text.trim() || cue.end <= cue.start) continue;
      await drawText(cue.text, cue.start, cue.end, subStyle, 0, 0, `s${seq++}`);
    }
  }

  graph.push(`[${cur}]format=yuv420p,trim=duration=${n(total, 3)}[vout]`);

  // ---- audio mix ------------------------------------------------------------------
  const wantAudio = o.includeAudio && o.frameAt === undefined;
  let hasAudioOut = false;
  if (wantAudio) {
    const audioTracks = project.timeline.tracks.filter((t) => t.kind === 'audio' || t.kind === 'video');
    const anySolo = audioTracks.some((t) => t.kind === 'audio' && t.solo);
    const mixLabels: string[] = [];
    let aseq = 0;
    for (const track of audioTracks) {
      if (track.muted) continue;
      if (track.kind === 'audio' && anySolo && !track.solo) continue;
      if (track.kind === 'video' && (anySolo || track.hidden)) continue;
      for (const clip of track.clips as Clip[]) {
        if (clip.kind !== 'media' || clip.muted) continue;
        const asset = assets.get(clip.assetId);
        if (!asset || !asset.hasAudio || asset.type === 'image') continue;
        const dur = clipDuration(clip);
        if (dur <= 0.001) continue;
        const idx = addInput(['-ss', String(n(clip.in, 3)), '-t', String(n(clip.out - clip.in, 3)), '-i', asset.path]);
        const ach: string[] = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', ...atempoChain(clip.speed)];
        const vol = clip.volume * track.volume;
        if (Math.abs(vol - 1) > 1e-3) ach.push(`volume=${n(vol)}`);
        if (clip.fadeIn > 0) ach.push(`afade=t=in:st=0:d=${n(Math.min(clip.fadeIn, dur))}`);
        if (clip.fadeOut > 0) ach.push(`afade=t=out:st=${n(Math.max(0, dur - clip.fadeOut))}:d=${n(Math.min(clip.fadeOut, dur))}`);
        ach.push(`atrim=duration=${n(dur, 3)}`);
        const delayMs = Math.round(clip.start * 1000);
        if (delayMs > 0) ach.push(`adelay=${delayMs}:all=1`);
        const label = `a${aseq++}`;
        graph.push(`[${idx}:a]${ach.join(',')}[${label}]`);
        mixLabels.push(label);
      }
    }
    if (mixLabels.length === 1) {
      graph.push(`[${mixLabels[0]}]apad,atrim=duration=${n(total, 3)}[aout]`);
    } else if (mixLabels.length > 1) {
      graph.push(`${mixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${n(total, 3)}[aout]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(total, 3)}[aout]`);
    }
    hasAudioOut = true;
  }

  const scriptFile = path.join(workDir, 'filtergraph.txt');
  await fs.writeFile(scriptFile, graph.join(';\n'), 'utf8');

  const args: string[] = [];
  for (const i of inputs) args.push(...i.args);
  if (inputs.length === 0) {
    // ffmpeg needs at least one input; feed a null source that the graph ignores.
    args.push('-f', 'lavfi', '-t', '0.1', '-i', 'anullsrc');
  }
  args.push(...filterScriptArgs(scriptFile), '-map', '[vout]');
  if (hasAudioOut) args.push('-map', '[aout]');

  let duration = total;
  if (o.frameAt !== undefined) {
    const t = Math.min(Math.max(0, o.frameAt), Math.max(0, total - 1 / fps));
    args.push('-ss', String(n(t, 3)), '-frames:v', '1', '-update', '1', '-q:v', '3', outputFile);
    duration = t + 1 / fps;
  } else {
    if (o.range) {
      const start = Math.max(0, Math.min(o.range.start, total));
      const end = Math.max(start + 0.1, Math.min(o.range.end, total));
      args.push('-ss', String(n(start, 3)), '-t', String(n(end - start, 3)));
      duration = end;
    } else {
      args.push('-t', String(n(total, 3)));
    }
    args.push('-r', String(fps), ...encoderArgs(o));
    if (hasAudioOut) args.push(...audioEncoderArgs(o));
    if (o.container === 'mp4' || o.container === 'mov') args.push('-movflags', '+faststart');
    args.push(outputFile);
  }
  return { args, scriptFile, duration, textFiles };
}

export interface ValidationResult {
  ok: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  sizeBytes: number;
  error: string | null;
}

/** Validate an output file with ffprobe. A file only counts as exported if this passes. */
export async function validateOutput(file: string, expect: { width: number; height: number; duration: number; audio: boolean }): Promise<ValidationResult> {
  try {
    const st = await fs.stat(file);
    if (st.size < 1024) return { ok: false, duration: null, width: null, height: null, hasAudio: false, sizeBytes: st.size, error: 'Output file is empty or truncated' };
    const p = await probe(file);
    const problems: string[] = [];
    if (!p.video) problems.push('no video stream');
    if (p.video && (p.video.width !== even(expect.width) || p.video.height !== even(expect.height))) problems.push(`unexpected size ${p.video.width}x${p.video.height}`);
    if (!p.duration || Math.abs(p.duration - expect.duration) > Math.max(0.6, expect.duration * 0.05)) problems.push(`duration ${p.duration ?? 'unknown'}s, expected ~${expect.duration.toFixed(2)}s`);
    if (expect.audio && !p.audio) problems.push('missing audio stream');
    return {
      ok: problems.length === 0,
      duration: p.duration,
      width: p.video?.width ?? null,
      height: p.video?.height ?? null,
      hasAudio: Boolean(p.audio),
      sizeBytes: st.size,
      error: problems.length ? `Validation failed: ${problems.join(', ')}` : null,
    };
  } catch (err) {
    return { ok: false, duration: null, width: null, height: null, hasAudio: false, sizeBytes: 0, error: (err as Error).message };
  }
}

export async function render(
  project: Project,
  assets: Map<string, RenderAsset>,
  o: RenderOptions,
  outputFile: string,
  workDir: string,
  run: { signal?: AbortSignal; onProgress?: (f: number) => void } = {},
): Promise<CompiledRender> {
  const compiled = await compileRender(project, assets, o, outputFile, workDir);
  await runFfmpeg(compiled.args, { signal: run.signal, onProgress: run.onProgress, durationHint: o.range ? o.range.end - o.range.start : compiled.duration });
  return compiled;
}

/** Tracks referenced by audio mixing (exported for tests). */
export function audibleTracks(project: Project): Track[] {
  const anySolo = project.timeline.tracks.some((t) => t.kind === 'audio' && t.solo);
  return project.timeline.tracks.filter((t) => (t.kind === 'audio' || t.kind === 'video') && !t.muted && (!anySolo || (t.kind === 'audio' && t.solo)));
}
