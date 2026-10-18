import { useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Sparkles, Trash2, RotateCcw } from 'lucide-react';
import type { Effect, EffectType, Project } from '../../../shared/project';
import { EFFECT_TYPES } from '../../../shared/project';
import { EFFECT_DEFS, defaultEffectParams } from '../../../shared/effects';
import { addEffect } from '../../../shared/ops';
import { findClip } from '../../../shared/timeline';
import type { Draft } from 'immer';
import { useProject } from '../store/project';
import { Field, Seg, Slider } from '../components/ui';

type Target = 'clip' | 'master';

function effectList(d: Draft<Project> | Project, target: Target, clipId: string | undefined): Effect[] | null {
  if (target === 'master') return d.timeline.masterEffects;
  if (!clipId) return null;
  const f = findClip(d as Project, clipId);
  return f && f.clip.kind === 'media' ? f.clip.effects : null;
}

export function EffectsPanel() {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const apply = useProject((s) => s.apply);
  const clipId = selection.clipIds[0];
  const found = clipId ? findClip(project, clipId) : null;
  const mediaClip = found?.clip.kind === 'media' && found.track.kind === 'video' ? found.clip : null;
  const [targetPref, setTarget] = useState<Target>('clip');
  const target: Target = mediaClip ? targetPref : 'master';
  const list = effectList(project, target, mediaClip?.id) ?? [];
  const [adding, setAdding] = useState<EffectType>('colorGrade');

  const edit = (label: string, fn: (effects: Effect[]) => void, coalesce?: string) =>
    apply(label, (d) => {
      const l = effectList(d, target, mediaClip?.id);
      if (l) fn(l as Effect[]);
    }, coalesce ? { coalesce } : undefined);

  return (
    <div className="panel">
      <div className="panel-header">
        <Sparkles size={14} /> Visual effects
      </div>
      <div className="panel-body">
        <div className="section">
          <Seg
            label="Effect target"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'clip', label: mediaClip ? `Clip: ${(mediaClip.label ?? 'selected').slice(0, 18)}` : 'Clip (select one)', disabled: !mediaClip },
              { value: 'master', label: 'Master (whole frame)' },
            ]}
          />
          <div className="tiny muted">
            {target === 'master' ? 'Master effects apply to the final composite, before titles and subtitles.' : 'Clip effects apply to this clip only, before it is composited.'} Effects are rendered by FFmpeg in previews and exports; the live canvas shows an approximation — use “Exact frame” to check.
          </div>
          <div className="row">
            <select className="select" aria-label="Effect to add" value={adding} onChange={(e) => setAdding(e.target.value as EffectType)}>
              {EFFECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EFFECT_DEFS[t].label}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={() => edit(`Add ${EFFECT_DEFS[adding].label}`, (l) => void addEffect({ effects: l }, adding))}>
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
        {list.length === 0 && <div className="empty small">No effects on the {target === 'master' ? 'master output' : 'selected clip'}.</div>}
        {list.map((fx, i) => {
          const def = EFFECT_DEFS[fx.type];
          return (
            <div key={fx.id} className="section" style={{ opacity: fx.enabled ? 1 : 0.55 }}>
              <div className="section-title">
                <div className="row">
                  <strong style={{ color: 'var(--text-0)' }}>{def.label}</strong>
                  <span className={`badge ${def.livePreview === 'exact' ? 'ok' : def.livePreview === 'approximate' ? '' : 'warn'}`} title="How closely the live canvas preview matches the render">
                    live: {def.livePreview === 'none' ? 'render only' : def.livePreview}
                  </span>
                </div>
                <div className="row" style={{ gap: 0 }}>
                  <button className="icon-btn" aria-label={fx.enabled ? 'Disable effect' : 'Enable effect'} onClick={() => edit('Toggle effect', (l) => void (l[i].enabled = !l[i].enabled))}>
                    {fx.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button className="icon-btn" aria-label="Reset effect" onClick={() => edit('Reset effect', (l) => void (l[i].params = defaultEffectParams(fx.type)))}>
                    <RotateCcw size={13} />
                  </button>
                  <button className="icon-btn" aria-label="Move effect up" disabled={i === 0} onClick={() => edit('Reorder effects', (l) => void l.splice(i - 1, 0, ...l.splice(i, 1)))}>
                    <ArrowUp size={13} />
                  </button>
                  <button className="icon-btn" aria-label="Move effect down" disabled={i === list.length - 1} onClick={() => edit('Reorder effects', (l) => void l.splice(i + 1, 0, ...l.splice(i, 1)))}>
                    <ArrowDown size={13} />
                  </button>
                  <button className="icon-btn" aria-label="Remove effect" onClick={() => edit('Remove effect', (l) => void l.splice(i, 1))}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="tiny muted">{def.description}</div>
              {def.params.map((p) => (
                <Field key={p.key} label={p.label}>
                  <Slider label={p.label} value={fx.params[p.key] ?? p.default} min={p.min} max={p.max} step={p.step} onChange={(v) => edit(`Adjust ${def.label}`, (l) => void (l[i].params = { ...l[i].params, [p.key]: v }), `${fx.id}:${p.key}`)} />
                </Field>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
