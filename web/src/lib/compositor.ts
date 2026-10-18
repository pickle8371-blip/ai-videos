/**
 * In-browser live preview of the timeline.
 *
 * Video/image clips are drawn onto a canvas with their transform, opacity,
 * fades, transitions and keyframes; colour adjustments and some effects are
 * approximated with canvas filters. Audio comes from the media elements. The
 * export uses the FFmpeg pipeline, so the "Exact frame" button in the preview
 * shows the authoritative render.
 */
import type { Asset } from '../../../shared/api';
import type { Effect, MediaClip, Project, TextClip } from '../../../shared/project';
import { normalizeEffectParams } from '../../../shared/effects';
import { clipDuration, clipEnd, keyframeValue } from '../../../shared/timeline';
import { mediaUrl } from '../api';

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface PoolEntry {
  el: MediaEl;
  assetId: string;
  lastUsed: number;
  ready: boolean;
  failed: boolean;
}

export class Compositor {
  private pool = new Map<string, PoolEntry>();
  private grain: HTMLCanvasElement | null = null;
  /** Asset ids the browser could not decode (e.g. H.265, or H.264 in browsers without proprietary codecs). */
  readonly undecodable = new Set<string>();
  onDecodeError: ((assetId: string) => void) | null = null;
  constructor(private ctx: CanvasRenderingContext2D) {}

  dispose(): void {
    for (const e of this.pool.values()) this.release(e);
    this.pool.clear();
  }

  private release(e: PoolEntry) {
    if (e.el instanceof HTMLMediaElement) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
    }
  }

  private entry(key: string, asset: Asset, kind: 'video' | 'audio' | 'image'): PoolEntry {
    let e = this.pool.get(key);
    if (e && e.assetId === asset.id) {
      e.lastUsed = performance.now();
      return e;
    }
    if (e) this.release(e);
    let el: MediaEl;
    if (kind === 'image') {
      el = new Image();
      el.decoding = 'async';
    } else {
      el = document.createElement(kind);
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      (el as HTMLVideoElement).playsInline = true;
    }
    const entry: PoolEntry = { el, assetId: asset.id, lastUsed: performance.now(), ready: false, failed: false };
    const markReady = () => (entry.ready = true);
    const markFailed = () => {
      entry.failed = true;
      if (!this.undecodable.has(asset.id)) {
        this.undecodable.add(asset.id);
        this.onDecodeError?.(asset.id);
      }
    };
    if (el instanceof HTMLImageElement) {
      el.onload = markReady;
      el.onerror = markFailed;
    } else {
      el.addEventListener('loadeddata', markReady);
      el.addEventListener('error', markFailed);
    }
    el.src = mediaUrl(asset);
    this.pool.set(key, entry);
    return entry;
  }

  /** Drop elements unused for a while to bound memory. */
  gc(): void {
    const now = performance.now();
    for (const [k, e] of this.pool) {
      if (now - e.lastUsed > 8000) {
        this.release(e);
        this.pool.delete(k);
      }
    }
  }

  pauseAll(): void {
    for (const e of this.pool.values()) if (e.el instanceof HTMLMediaElement && !e.el.paused) e.el.pause();
  }

  /** Sync a media element to the timeline (seek when paused, play/correct drift when playing). */
  private syncMedia(el: HTMLMediaElement, localSrc: number, speed: number, playing: boolean, volume: number, muted: boolean) {
    el.muted = muted;
    el.volume = Math.max(0, Math.min(1, volume));
    if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
    const drift = Math.abs(el.currentTime - localSrc);
    if (playing) {
      if (drift > 0.3) el.currentTime = localSrc;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (drift > 0.02 && !el.seeking) el.currentTime = localSrc;
    }
  }

  render(project: Project, assets: Map<string, Asset>, t: number, playing: boolean, opts: { scale: number }): void {
    const ctx = this.ctx;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = project.settings.background;
    ctx.fillRect(0, 0, W, H);
    const activeKeys = new Set<string>();
    const anySolo = project.timeline.tracks.some((tr) => tr.kind === 'audio' && tr.solo);

    // Video tracks, bottom to top.
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'video') continue;
      const clips = (track.clips.filter((c) => c.kind === 'media') as MediaClip[]).sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        const asset = assets.get(clip.assetId);
        if (!asset || asset.type === 'audio') continue;
        const start = clip.start;
        const end = clipEnd(clip);
        // Preload upcoming clips slightly ahead.
        if (t < start - 1.5 || t >= end) continue;
        const key = clip.id;
        const e = this.entry(key, asset, asset.type === 'image' ? 'image' : 'video');
        activeKeys.add(key);
        const local = Math.max(0, t - start);
        const srcT = clip.in + local * clip.speed;
        if (e.el instanceof HTMLVideoElement) {
          const audible = t >= start && !track.muted && !clip.muted && asset.hasAudio && !anySolo && !track.hidden;
          const vol = clip.volume * track.volume * fadeGain(clip, local);
          if (t < start) {
            if (Math.abs(e.el.currentTime - clip.in) > 0.05 && !e.el.seeking) e.el.currentTime = clip.in;
            if (!e.el.paused) e.el.pause();
            continue;
          }
          this.syncMedia(e.el, srcT, clip.speed, playing, vol, !audible);
        } else if (t < start) continue;
        if (track.hidden || !e.ready) continue;
        if (!(e.el instanceof HTMLAudioElement)) this.drawClip(clip, e.el, local, W, H, project);
      }
    }

    // Titles.
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'text' || track.hidden) continue;
      for (const c of track.clips) if (c.kind === 'text' && t >= c.start && t < clipEnd(c)) this.drawText(c, t, W, H, project.settings.height);
    }

    // Master effects (approximate).
    this.applyEffects(project.timeline.masterEffects, 0, 0, W, H, t);

    // Subtitles.
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'subtitle' || track.hidden || !track.burnIn) continue;
      for (const cue of track.cues) {
        if (t >= cue.start && t < cue.end) {
          const style: TextClip['style'] = { fontSize: Math.round(project.settings.height * 0.045), color: '#ffffff', x: 0.5, y: 0.88, bold: false, box: true, boxColor: '#000000', boxOpacity: 0.55, shadow: false };
          this.drawTextBlock(cue.text, style, 1, W, H, project.settings.height);
        }
      }
    }

    // Audio tracks.
    for (const track of project.timeline.tracks) {
      if (track.kind !== 'audio') continue;
      for (const c of track.clips) {
        if (c.kind !== 'media') continue;
        const asset = assets.get(c.assetId);
        if (!asset || asset.type === 'image' || !asset.hasAudio) continue;
        const end = clipEnd(c);
        if (t < c.start - 1.5 || t >= end) continue;
        const key = c.id;
        const e = this.entry(key, asset, 'audio');
        activeKeys.add(key);
        const el = e.el as HTMLMediaElement;
        if (t < c.start) {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - c.in) > 0.05 && !el.seeking) el.currentTime = c.in;
          continue;
        }
        const local = t - c.start;
        const muted = track.muted || c.muted || (anySolo && !track.solo);
        this.syncMedia(el, c.in + local * c.speed, c.speed, playing, c.volume * track.volume * fadeGain(c, local), muted);
      }
    }

    // Pause anything that is no longer active.
    for (const [k, e] of this.pool) {
      if (!activeKeys.has(k) && e.el instanceof HTMLMediaElement && !e.el.paused) e.el.pause();
    }
    ctx.restore();
    void opts;
  }

  private drawClip(clip: MediaClip, el: HTMLVideoElement | HTMLImageElement, local: number, W: number, H: number, project: Project) {
    const ctx = this.ctx;
    const srcW = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const srcH = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!srcW || !srcH) return;
    const tf = clip.transform;
    const cr = tf.crop;
    const sx = srcW * cr.left;
    const sy = srcH * cr.top;
    const sw = srcW * (1 - cr.left - cr.right);
    const sh = srcH * (1 - cr.top - cr.bottom);
    const scale = keyframeValue(clip, 'scale', local);
    let dw: number;
    let dh: number;
    if (tf.fit === 'stretch') {
      dw = W * scale;
      dh = H * scale;
    } else {
      const k = tf.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      dw = sw * k * scale;
      dh = sh * k * scale;
    }
    const dur = clipDuration(clip);
    let opacity = keyframeValue(clip, 'opacity', local);
    let dx = (W - dw) / 2 + keyframeValue(clip, 'x', local) * W;
    let dy = (H - dh) / 2 + keyframeValue(clip, 'y', local) * H;
    const tr = clip.transitionIn;
    const trDur = tr.type === 'none' ? 0 : Math.min(tr.duration, dur);
    let dip = 1;
    if (trDur > 0 && local < trDur) {
      const prog = local / trDur;
      if (tr.type === 'dissolve') opacity *= prog;
      if (tr.type === 'dipToBlack') dip = prog;
      if (tr.type === 'slideLeft') dx += W * (1 - prog);
      if (tr.type === 'slideRight') dx -= W * (1 - prog);
      if (tr.type === 'slideUp') dy += H * (1 - prog);
      if (tr.type === 'slideDown') dy -= H * (1 - prog);
    }
    if (clip.fadeIn > 0 && local < clip.fadeIn) opacity *= local / clip.fadeIn;
    if (clip.fadeOut > 0 && local > dur - clip.fadeOut) opacity *= Math.max(0, (dur - local) / clip.fadeOut);
    const shake = clip.effects.find((e) => e.enabled && e.type === 'cameraShake');
    if (shake) {
      const p = normalizeEffectParams('cameraShake', shake.params);
      const amt = (p.amount * W) / project.settings.width;
      const f = p.frequency * 2 * Math.PI;
      dx += amt * 0.9 * Math.sin(local * f);
      dy += amt * 0.8 * Math.cos(local * f * 0.83);
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.filter = cssFilter(clip, W / project.settings.width);
    ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = 'none';
    this.applyEffects(clip.effects, dx, dy, dw, dh, local, el, [sx, sy, sw, sh]);
    if (dip < 1) {
      ctx.globalAlpha = 1 - dip;
      ctx.fillStyle = '#000';
      ctx.fillRect(dx, dy, dw, dh);
    }
    ctx.restore();
  }

  private applyEffects(effects: Effect[], x: number, y: number, w: number, h: number, t: number, src?: CanvasImageSource, srcRect?: [number, number, number, number]) {
    const ctx = this.ctx;
    for (const e of effects) {
      if (!e.enabled) continue;
      const p = normalizeEffectParams(e.type, e.params);
      ctx.save();
      switch (e.type) {
        case 'vignette': {
          const g = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.25, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, p.angle * 0.9)})`);
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
          break;
        }
        case 'letterbox': {
          const bar = Math.max(0, (h - w / p.ratio) / 2);
          ctx.fillStyle = '#000';
          ctx.fillRect(x, y, w, bar);
          ctx.fillRect(x, y + h - bar, w, bar);
          break;
        }
        case 'filmGrain': {
          ctx.globalAlpha = Math.min(0.5, p.amount / 100);
          ctx.globalCompositeOperation = 'overlay';
          ctx.drawImage(this.grainCanvas(t), x, y, w, h);
          break;
        }
        case 'fog': {
          ctx.globalAlpha = p.density * 0.35;
          ctx.fillStyle = '#c9cbd6';
          ctx.fillRect(x, y, w, h);
          break;
        }
        case 'lightLeak': {
          const cx = x + w * (0.12 + 0.25 * Math.sin(t * p.speed));
          const g = ctx.createRadialGradient(cx, y + h * 0.15, 0, cx, y + h * 0.15, Math.max(w, h) * 0.6);
          g.addColorStop(0, `rgba(255,150,60,${p.strength})`);
          g.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
          break;
        }
        case 'bloom': {
          if (src && srcRect) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = p.strength * 0.6;
            ctx.filter = `blur(${p.radius * (w / 1280)}px) brightness(1.2)`;
            ctx.drawImage(src, ...srcRect, x, y, w, h);
          }
          break;
        }
        case 'depthOfField': {
          if (src && srcRect) {
            const band = h * p.focusSize;
            ctx.filter = `blur(${p.blur * (w / 1280)}px)`;
            const [sx, sy, sw, sh] = srcRect;
            const top = (h - band) / 2;
            ctx.drawImage(src, sx, sy, sw, sh * (top / h), x, y, w, top);
            ctx.drawImage(src, sx, sy + sh * ((top + band) / h), sw, sh * (top / h), x, y + top + band, w, top);
          }
          break;
        }
        default:
          break;
      }
      ctx.restore();
    }
  }

  private grainCanvas(t: number): HTMLCanvasElement {
    if (!this.grain) {
      this.grain = document.createElement('canvas');
      this.grain.width = 256;
      this.grain.height = 144;
    }
    const g = this.grain.getContext('2d')!;
    const img = g.createImageData(256, 144);
    let seed = Math.floor(t * 24) * 9301 + 49297;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 9301 + 49297) % 233280;
      const v = (seed / 233280) * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return this.grain;
  }

  private drawText(c: TextClip, t: number, W: number, H: number, projectH: number) {
    const local = t - c.start;
    let a = 1;
    if (c.fadeIn > 0 && local < c.fadeIn) a = local / c.fadeIn;
    if (c.fadeOut > 0 && local > c.duration - c.fadeOut) a = Math.min(a, (c.duration - local) / c.fadeOut);
    this.drawTextBlock(c.text, c.style, a, W, H, projectH);
  }

  private drawTextBlock(text: string, style: TextClip['style'], alpha: number, W: number, H: number, projectH: number) {
    const ctx = this.ctx;
    const size = Math.max(6, style.fontSize * (H / projectH));
    const lines = text.split('\n');
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = `${style.bold ? 700 : 400} ${size}px "DejaVu Sans", "Segoe UI", Arial, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const lineH = size * 1.15 + 8 * (H / projectH);
    const blockH = lines.length * lineH;
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const cx = W * style.x;
    const top = H * style.y - blockH / 2;
    if (style.box) {
      const pad = size * 0.35;
      ctx.fillStyle = hexA(style.boxColor, style.boxOpacity);
      ctx.fillRect(cx - maxW / 2 - pad, top - pad, maxW + pad * 2, blockH + pad * 2);
    }
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, size / 24);
    }
    ctx.fillStyle = style.color;
    lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lineH));
    ctx.restore();
  }
}

function fadeGain(c: MediaClip, local: number): number {
  const dur = clipDuration(c);
  let g = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
  if (c.fadeOut > 0 && local > dur - c.fadeOut) g *= Math.max(0, (dur - local) / c.fadeOut);
  return g;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Approximate the clip's colour adjustments and blur with CSS canvas filters. */
export function cssFilter(clip: MediaClip, pxScale: number): string {
  const c = clip.color;
  const parts: string[] = [];
  const bright = (1 + c.brightness) * Math.pow(2, c.exposure);
  if (Math.abs(bright - 1) > 0.001) parts.push(`brightness(${bright.toFixed(3)})`);
  if (c.contrast !== 1) parts.push(`contrast(${c.contrast})`);
  let sat = c.saturation;
  const grade = clip.effects.find((e) => e.enabled && e.type === 'colorGrade');
  if (grade) sat *= normalizeEffectParams('colorGrade', grade.params).saturation;
  if (sat !== 1) parts.push(`saturate(${sat.toFixed(3)})`);
  if (c.hue !== 0) parts.push(`hue-rotate(${c.hue}deg)`);
  if (c.temperature > 0) parts.push(`sepia(${(c.temperature * 0.35).toFixed(3)})`);
  if (c.gamma !== 1) parts.push(`brightness(${Math.pow(0.5, 1 / c.gamma - 1).toFixed(3)})`);
  const blur = clip.effects.find((e) => e.enabled && e.type === 'blur');
  if (blur) parts.push(`blur(${(normalizeEffectParams('blur', blur.params).sigma * pxScale).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}
