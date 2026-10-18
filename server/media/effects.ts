import type { Effect } from '../../shared/project.js';
import { normalizeEffectParams } from '../../shared/effects.js';

/**
 * Translate an effect into an FFmpeg filtergraph fragment.
 * Input/output are pad labels (without brackets). Returns graph statements.
 */
export function effectGraph(effect: Effect, inLabel: string, outLabel: string, uid: string, w: number, h: number): string[] {
  const p = normalizeEffectParams(effect.type, effect.params);
  const L = (s: string) => `${uid}_${s}`;
  const n = (v: number) => Number(v.toFixed(4));
  switch (effect.type) {
    case 'colorGrade':
      return [`[${inLabel}]colorbalance=rs=${n(p.shadowsR)}:bs=${n(p.shadowsB)}:rh=${n(p.highlightsR)}:bh=${n(p.highlightsB)},eq=saturation=${n(p.saturation)}[${outLabel}]`];
    case 'bloom':
      return [
        `[${inLabel}]format=gbrp,split[${L('a')}][${L('b')}]`,
        `[${L('b')}]lutrgb=r='if(gt(val,170),val,0)':g='if(gt(val,170),val,0)':b='if(gt(val,170),val,0)',gblur=sigma=${n(p.radius)}[${L('bb')}]`,
        `[${L('a')}][${L('bb')}]blend=all_mode=screen:all_opacity=${n(p.strength)},format=yuv420p[${outLabel}]`,
      ];
    case 'motionBlur':
      return [`[${inLabel}]tmix=frames=${Math.round(p.frames)}[${outLabel}]`];
    case 'depthOfField': {
      const f = n(p.focusSize);
      return [
        `[${inLabel}]split[${L('a')}][${L('b')}]`,
        `[${L('b')}]gblur=sigma=${n(p.blur)}[${L('bl')}]`,
        `[${L('a')}]crop=iw:trunc(ih*${f}/2)*2:0:trunc(ih*${n((1 - f) / 2)}/2)*2[${L('sh')}]`,
        `[${L('bl')}][${L('sh')}]overlay=0:(H-h)/2[${outLabel}]`,
      ];
    }
    case 'filmGrain':
      return [`[${inLabel}]noise=c0s=${Math.round(p.amount)}:c0f=t+u[${outLabel}]`];
    case 'vignette':
      return [`[${inLabel}]vignette=angle=${n(p.angle)}[${outLabel}]`];
    case 'glitch':
      return [
        `[${inLabel}]rgbashift=rh=${Math.round(p.amount)}:bh=${-Math.round(p.amount)}:gv=${Math.round(p.amount / 3)},noise=alls=${Math.round(p.noise)}:allf=t[${outLabel}]`,
      ];
    case 'fog':
      return [
        `[${inLabel}]split[${L('a')}][${L('b')}]`,
        `[${L('b')}]gblur=sigma=${n(p.softness)}[${L('bb')}]`,
        `[${L('a')}][${L('bb')}]blend=all_mode=lighten:all_opacity=${n(p.density)},eq=contrast=${n(1 - 0.45 * p.density)}:brightness=${n(0.12 * p.density)}[${outLabel}]`,
      ];
    case 'lightLeak': {
      const s = n(p.speed);
      // The gradient is computed at low resolution and upscaled, which keeps geq cheap.
      return [
        `[${inLabel}]format=gbrp,split[${L('a')}][${L('b')}]`,
        `[${L('b')}]scale=96:54,geq=r='clip(255*(1.2-1.9*hypot(X/W-0.12-0.25*sin(T*${s}),Y/H-0.15)),0,255)':g='clip(150*(1.1-1.9*hypot(X/W-0.12-0.25*sin(T*${s}),Y/H-0.15)),0,255)':b='clip(40*(1-2*hypot(X/W-0.1,Y/H-0.15)),0,255)'[${L('g')}]`,
        `[${L('g')}]scale=${w}:${h}[${L('gs')}]`,
        `[${L('a')}][${L('gs')}]blend=all_mode=screen:all_opacity=${n(p.strength)},format=yuv420p[${outLabel}]`,
      ];
    }
    case 'cameraShake': {
      const a = Math.round(p.amount);
      const f = n(p.frequency * 2 * Math.PI);
      return [
        `[${inLabel}]crop=iw-${2 * a}:ih-${2 * a}:'${a}+${a}*0.9*sin(t*${f})':'${a}+${a}*0.8*cos(t*${n(f * 0.83)})',scale=iw+${2 * a}:ih+${2 * a}[${outLabel}]`,
      ];
    }
    case 'blur':
      return [`[${inLabel}]gblur=sigma=${n(Math.max(0.01, p.sigma))}[${outLabel}]`];
    case 'sharpen':
      return [`[${inLabel}]unsharp=5:5:${n(p.amount)}:5:5:0[${outLabel}]`];
    case 'chromaticAberration':
      return [`[${inLabel}]rgbashift=rh=${Math.round(p.shift)}:bh=${-Math.round(p.shift)}[${outLabel}]`];
    case 'letterbox': {
      const r = n(p.ratio);
      const bar = `max(0,(ih-iw/${r})/2)`;
      return [`[${inLabel}]drawbox=x=0:y=0:w=iw:h='${bar}':color=black:t=fill,drawbox=x=0:y='ih-${bar}':w=iw:h='${bar}':color=black:t=fill[${outLabel}]`];
    }
  }
}

/** Chain a list of effects. Returns statements and the final label. */
export function effectChain(effects: Effect[], inLabel: string, uid: string, w: number, h: number): { graph: string[]; out: string } {
  let cur = inLabel;
  const graph: string[] = [];
  effects
    .filter((e) => e.enabled)
    .forEach((e, i) => {
      const out = `${uid}_fx${i}`;
      graph.push(...effectGraph(e, cur, out, `${uid}_e${i}`, w, h));
      cur = out;
    });
  return { graph, out: cur };
}
