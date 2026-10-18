import { Diamond, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { KeyframeProperty, MediaClip, TextClip, Track } from '../../../shared/project';
import { TRANSITION_TYPES } from '../../../shared/project';
import { EFFECT_DEFS } from '../../../shared/effects';
import { removeKeyframe, setKeyframe, setTransition, updateClip } from '../../../shared/ops';
import { clipDuration, findClip, formatTimecode, keyframeValue } from '../../../shared/timeline';
import { useApp, useAsset } from '../store/app';
import { useProject, usePlayback } from '../store/project';
import { Check, Field, ProvenanceBadge, Select, Slider, formatDuration } from './ui';

const TRANSITION_LABELS: Record<string, string> = { none: 'Cut (none)', dissolve: 'Cross dissolve', dipToBlack: 'Dip to black', slideLeft: 'Slide from right', slideRight: 'Slide from left', slideUp: 'Slide up', slideDown: 'Slide down' };

export function Inspector() {
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);
  if (!project) return <div className="panel" />;
  const found = selection.clipIds.length === 1 ? findClip(project, selection.clipIds[0]) : null;
  const cueTrack = selection.cueId ? project.timeline.tracks.find((t) => t.cues.some((c) => c.id === selection.cueId)) : undefined;
  const cue = cueTrack?.cues.find((c) => c.id === selection.cueId);
  const track = selection.trackId ? project.timeline.tracks.find((t) => t.id === selection.trackId) : undefined;
  let body: ReactNode;
  let title = 'Properties';
  if (found?.clip.kind === 'media') {
    title = 'Clip';
    body = <MediaClipProps clip={found.clip} track={found.track} />;
  } else if (found?.clip.kind === 'text') {
    title = 'Title';
    body = <TextClipProps clip={found.clip} />;
  } else if (cue && cueTrack) {
    title = 'Subtitle';
    body = <CueProps trackId={cueTrack.id} cueId={cue.id} />;
  } else if (selection.clipIds.length > 1) {
    body = <div className="section small muted">{selection.clipIds.length} clips selected. Drag to move them together, or press Delete / Ctrl+D.</div>;
  } else {
    body = (
      <>
        {track && <TrackProps track={track} />}
        <div className="section">
          <h4>Project</h4>
          <dl className="kv">
            <dt>Canvas</dt>
            <dd>
              {project.settings.width}×{project.settings.height} ({project.settings.aspectRatio})
            </dd>
            <dt>Frame rate</dt>
            <dd>{project.settings.fps} fps</dd>
            <dt>Tracks</dt>
            <dd>{project.timeline.tracks.length}</dd>
            <dt>Master effects</dt>
            <dd>{project.timeline.masterEffects.filter((e) => e.enabled).map((e) => EFFECT_DEFS[e.type].label).join(', ') || 'none'}</dd>
          </dl>
          <p className="small muted" style={{ margin: 0 }}>
            Select a clip on the timeline to edit its timing, transform, colour, audio, transitions and keyframes. Drag media from the Asset Library onto a track to add it.
          </p>
        </div>
      </>
    );
  }
  return (
    <div className="panel">
      <div className="panel-header">{title}</div>
      <div className="panel-body">{body}</div>
    </div>
  );
}

function useClipEdit(clipId: string) {
  const apply = useProject((s) => s.apply);
  return (label: string, key: string, fn: (c: MediaClip | TextClip) => void) =>
    apply(label, (d) => void updateClip(d, clipId, fn as never), { coalesce: `${clipId}:${key}` });
}

function Num({ value, onChange, step = 0.01, min, max, label }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; label: string }) {
  return (
    <input
      className="input"
      type="number"
      aria-label={label}
      value={Number(value.toFixed(3))}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

function MediaClipProps({ clip, track }: { clip: MediaClip; track: Track }) {
  const asset = useAsset(clip.assetId);
  const edit = useClipEdit(clip.id);
  const apply = useProject((s) => s.apply);
  const setWs = useApp((s) => s.setWorkspace);
  const time = usePlayback((s) => s.time);
  const dur = clipDuration(clip);
  const local = time - clip.start;
  const inClip = local >= 0 && local <= dur;
  const isVisual = track.kind === 'video' && asset?.type !== 'audio';
  const srcMax = asset?.type === 'image' ? 3600 : asset?.duration ?? clip.out;
  const m = (fn: (c: MediaClip) => void) => fn as (c: MediaClip | TextClip) => void;
  const kfProps: KeyframeProperty[] = ['opacity', 'scale', 'x', 'y'];

  return (
    <>
      <div className="section">
        <div className="row between">
          <div className="ellipsis" style={{ color: 'var(--text-0)' }}>{clip.label ?? asset?.name ?? 'Missing media'}</div>
          {asset && <ProvenanceBadge ai={asset.provenance.aiGenerated} generator={asset.provenance.generator} />}
        </div>
        {!asset && <div className="small" style={{ color: 'var(--err)' }}>The media for this clip is missing from the library.</div>}
        {asset && (
          <div className="tiny muted">
            {asset.type} · {asset.width ? `${asset.width}×${asset.height} · ` : ''}source {formatDuration(asset.duration)}
            {asset.provenance.prompt ? ` · “${asset.provenance.prompt.slice(0, 80)}${asset.provenance.prompt.length > 80 ? '…' : ''}”` : ''}
          </div>
        )}
      </div>
      <div className="section">
        <h4>Timing</h4>
        <div className="grid2">
          <Field label="Start (s)">
            <Num label="Start" value={clip.start} min={0} onChange={(v) => edit('Set start', 'start', m((c) => void (c.start = v)))} />
          </Field>
          <Field label="Duration">
            <input className="input" disabled value={formatTimecode(dur, 30)} aria-label="Duration" />
          </Field>
          <Field label="In (source s)">
            <Num label="In point" value={clip.in} min={0} max={clip.out - 0.05} onChange={(v) => edit('Set in point', 'in', m((c) => void (c.in = Math.min(v, c.out - 0.05))))} />
          </Field>
          <Field label="Out (source s)">
            <Num label="Out point" value={clip.out} min={clip.in + 0.05} max={srcMax} onChange={(v) => edit('Set out point', 'out', m((c) => void (c.out = Math.max(c.in + 0.05, Math.min(srcMax, v)))))} />
          </Field>
        </div>
        <Field label={`Speed (${clip.speed}×)`}>
          <Slider label="Speed" value={clip.speed} min={0.25} max={4} step={0.05} onChange={(v) => edit('Change speed', 'speed', m((c) => void (c.speed = v)))} />
        </Field>
      </div>
      {(track.kind === 'audio' || asset?.hasAudio) && (
        <div className="section">
          <h4>Audio</h4>
          <Field label="Volume">
            <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => edit('Change volume', 'volume', m((c) => void (c.volume = v)))} />
          </Field>
          <Check checked={clip.muted} onChange={(v) => edit('Mute clip', 'muted', m((c) => void (c.muted = v)))} label="Mute clip" />
          {clip.volume > 1 && <div className="tiny muted">Boosts above 100% apply in the export; the live preview plays at 100%.</div>}
        </div>
      )}
      <div className="section">
        <h4>Fades</h4>
        <div className="grid2">
          <Field label="Fade in (s)">
            <Num label="Fade in" value={clip.fadeIn} min={0} max={Math.min(30, dur)} step={0.1} onChange={(v) => edit('Fade in', 'fadeIn', (c) => void (c.fadeIn = v))} />
          </Field>
          <Field label="Fade out (s)">
            <Num label="Fade out" value={clip.fadeOut} min={0} max={Math.min(30, dur)} step={0.1} onChange={(v) => edit('Fade out', 'fadeOut', (c) => void (c.fadeOut = v))} />
          </Field>
        </div>
      </div>
      {isVisual && (
        <>
          <div className="section">
            <h4>Transition in</h4>
            <div className="grid2">
              <Select
                label="Transition type"
                value={clip.transitionIn.type}
                onChange={(type) => apply('Set transition', (d) => setTransition(d, clip.id, { type, duration: clip.transitionIn.duration || 0.8 }))}
                options={TRANSITION_TYPES.map((t) => ({ value: t, label: TRANSITION_LABELS[t] }))}
              />
              <Num label="Transition duration" value={clip.transitionIn.duration} min={0} max={Math.min(10, dur)} step={0.1} onChange={(v) => apply('Transition duration', (d) => setTransition(d, clip.id, { type: clip.transitionIn.type, duration: v }), { coalesce: `${clip.id}:trdur` })} />
            </div>
            {clip.transitionIn.type === 'dissolve' && <div className="tiny muted">Overlap this clip with the previous one (on the same or a lower track) for a true cross-dissolve.</div>}
          </div>
          <div className="section">
            <div className="section-title">
              <h4>Transform</h4>
              <button className="icon-btn" title="Reset transform" aria-label="Reset transform" onClick={() => apply('Reset transform', (d) => void updateClip(d, clip.id, (c) => c.kind === 'media' && ((c.transform = { x: 0, y: 0, scale: 1, fit: 'contain', crop: { left: 0, top: 0, right: 0, bottom: 0 }, opacity: 1 }), (c.keyframes = {}))))}>
                <RotateCcw size={13} />
              </button>
            </div>
            <Field label="Fit">
              <Select label="Fit" value={clip.transform.fit} onChange={(v) => edit('Change fit', 'fit', m((c) => void (c.transform.fit = v)))} options={[{ value: 'contain', label: 'Fit (letterbox)' }, { value: 'cover', label: 'Fill (crop)' }, { value: 'stretch', label: 'Stretch' }]} />
            </Field>
            {(['scale', 'x', 'y', 'opacity'] as const).map((prop) => {
              const ranges = { scale: [0.1, 4], x: [-1, 1], y: [-1, 1], opacity: [0, 1] }[prop];
              const animated = (clip.keyframes[prop]?.length ?? 0) > 0;
              const value = animated && inClip ? keyframeValue(clip, prop, local) : clip.transform[prop];
              return (
                <Field key={prop} label={prop === 'x' ? 'Position X' : prop === 'y' ? 'Position Y' : prop[0].toUpperCase() + prop.slice(1)} right={animated ? <span className="badge accent">keyframed</span> : undefined}>
                  <Slider
                    label={prop}
                    value={value}
                    min={ranges[0]}
                    max={ranges[1]}
                    step={0.01}
                    onChange={(v) =>
                      animated && inClip
                        ? apply('Edit keyframe', (d) => setKeyframe(d, clip.id, prop, local, v), { coalesce: `${clip.id}:kf:${prop}` })
                        : edit(`Change ${prop}`, prop, m((c) => void (c.transform[prop] = v)))
                    }
                  />
                </Field>
              );
            })}
            <Field label="Crop (fraction removed: left / top / right / bottom)">
              <div className="grid2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                {(['left', 'top', 'right', 'bottom'] as const).map((side) => (
                  <Num key={side} label={`Crop ${side}`} value={clip.transform.crop[side]} min={0} max={0.45} step={0.01} onChange={(v) => edit('Crop', `crop-${side}`, m((c) => void (c.transform.crop[side] = v)))} />
                ))}
              </div>
            </Field>
          </div>
          <div className="section">
            <div className="section-title">
              <h4>Keyframes</h4>
              <button
                className="btn sm"
                disabled={!inClip}
                title={inClip ? 'Add keyframes for all properties at the playhead (K)' : 'Move the playhead over this clip'}
                onClick={() => apply('Add keyframes', (d) => kfProps.forEach((p) => setKeyframe(d, clip.id, p, local, keyframeValue(clip, p, local))))}
              >
                <Diamond size={12} /> Add at playhead
              </button>
            </div>
            {kfProps.every((p) => !clip.keyframes[p]?.length) ? (
              <div className="tiny muted">No keyframes. Add one at the playhead, move the playhead, then change a value to animate it.</div>
            ) : (
              kfProps.map((p) =>
                clip.keyframes[p]?.length ? (
                  <div key={p} className="col" style={{ gap: 2 }}>
                    <div className="small">{p}</div>
                    {clip.keyframes[p]!.map((k) => (
                      <div key={k.t} className="row small">
                        <button className="btn sm ghost mono" onClick={() => usePlayback.getState().setTime(clip.start + k.t)}>
                          +{k.t.toFixed(2)}s
                        </button>
                        <span className="mono grow">{k.v.toFixed(2)}</span>
                        <button className="icon-btn" aria-label="Remove keyframe" onClick={() => apply('Remove keyframe', (d) => removeKeyframe(d, clip.id, p, k.t))}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null,
              )
            )}
          </div>
          <div className="section">
            <div className="section-title">
              <h4>Color & exposure</h4>
              <button className="icon-btn" title="Reset colour" aria-label="Reset colour" onClick={() => edit('Reset colour', 'color-reset', m((c) => void (c.color = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, exposure: 0, temperature: 0 })))}>
                <RotateCcw size={13} />
              </button>
            </div>
            {(
              [
                ['exposure', 'Exposure (stops)', -3, 3],
                ['brightness', 'Brightness', -1, 1],
                ['contrast', 'Contrast', 0, 3],
                ['saturation', 'Saturation', 0, 3],
                ['gamma', 'Gamma', 0.1, 3],
                ['hue', 'Hue (°)', -180, 180],
                ['temperature', 'Temperature (cool ↔ warm)', -1, 1],
              ] as const
            ).map(([key, label, min, max]) => (
              <Field key={key} label={label}>
                <Slider label={label} value={clip.color[key]} min={min} max={max} step={key === 'hue' ? 1 : 0.01} onChange={(v) => edit(`Adjust ${key}`, `color-${key}`, m((c) => void (c.color[key] = v)))} />
              </Field>
            ))}
          </div>
          <div className="section">
            <div className="section-title">
              <h4>Effects</h4>
              <button className="btn sm" onClick={() => setWs('effects')}>
                <Sparkles size={12} /> Open effects
              </button>
            </div>
            <div className="small muted">{clip.effects.length ? clip.effects.map((e) => `${EFFECT_DEFS[e.type].label}${e.enabled ? '' : ' (off)'}`).join(', ') : 'No effects on this clip.'}</div>
          </div>
        </>
      )}
    </>
  );
}

function TextClipProps({ clip }: { clip: TextClip }) {
  const edit = useClipEdit(clip.id);
  const t = (fn: (c: TextClip) => void) => fn as (c: MediaClip | TextClip) => void;
  return (
    <>
      <div className="section">
        <Field label="Text">
          <textarea className="textarea" rows={3} value={clip.text} onChange={(e) => edit('Edit title text', 'text', t((c) => void (c.text = e.target.value.slice(0, 2000))))} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
        <div className="grid2">
          <Field label="Start (s)">
            <Num label="Start" value={clip.start} min={0} onChange={(v) => edit('Set start', 'start', t((c) => void (c.start = v)))} />
          </Field>
          <Field label="Duration (s)">
            <Num label="Duration" value={clip.duration} min={0.1} step={0.1} onChange={(v) => edit('Set duration', 'duration', t((c) => void (c.duration = v)))} />
          </Field>
          <Field label="Fade in (s)">
            <Num label="Fade in" value={clip.fadeIn} min={0} max={10} step={0.1} onChange={(v) => edit('Fade in', 'fadeIn', t((c) => void (c.fadeIn = v)))} />
          </Field>
          <Field label="Fade out (s)">
            <Num label="Fade out" value={clip.fadeOut} min={0} max={10} step={0.1} onChange={(v) => edit('Fade out', 'fadeOut', t((c) => void (c.fadeOut = v)))} />
          </Field>
        </div>
      </div>
      <div className="section">
        <h4>Style</h4>
        <Field label="Font size (px at project resolution)">
          <Slider label="Font size" value={clip.style.fontSize} min={8} max={300} step={1} onChange={(v) => edit('Font size', 'fontSize', t((c) => void (c.style.fontSize = v)))} />
        </Field>
        <div className="row">
          <Field label="Color">
            <input type="color" aria-label="Text color" value={clip.style.color} onChange={(e) => edit('Text color', 'color', t((c) => void (c.style.color = e.target.value)))} />
          </Field>
          <Check checked={clip.style.bold} onChange={(v) => edit('Bold', 'bold', t((c) => void (c.style.bold = v)))} label="Bold" />
          <Check checked={clip.style.shadow} onChange={(v) => edit('Shadow', 'shadow', t((c) => void (c.style.shadow = v)))} label="Shadow" />
        </div>
        <Field label="Horizontal position">
          <Slider label="X" value={clip.style.x} min={0} max={1} onChange={(v) => edit('Move title', 'x', t((c) => void (c.style.x = v)))} />
        </Field>
        <Field label="Vertical position">
          <Slider label="Y" value={clip.style.y} min={0} max={1} onChange={(v) => edit('Move title', 'y', t((c) => void (c.style.y = v)))} />
        </Field>
        <Check checked={clip.style.box} onChange={(v) => edit('Background box', 'box', t((c) => void (c.style.box = v)))} label="Background box" />
        {clip.style.box && (
          <div className="row">
            <input type="color" aria-label="Box color" value={clip.style.boxColor} onChange={(e) => edit('Box color', 'boxColor', t((c) => void (c.style.boxColor = e.target.value)))} />
            <div className="grow">
              <Slider label="Box opacity" value={clip.style.boxOpacity} min={0} max={1} onChange={(v) => edit('Box opacity', 'boxOpacity', t((c) => void (c.style.boxOpacity = v)))} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function CueProps({ trackId, cueId }: { trackId: string; cueId: string }) {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const cue = project.timeline.tracks.find((t) => t.id === trackId)?.cues.find((c) => c.id === cueId);
  if (!cue) return null;
  const edit = (label: string, key: string, fn: (c: NonNullable<typeof cue>) => void) =>
    apply(label, (d) => {
      const c = d.timeline.tracks.find((t) => t.id === trackId)?.cues.find((x) => x.id === cueId);
      if (c) fn(c);
    }, { coalesce: `${cueId}:${key}` });
  return (
    <div className="section">
      <Field label="Text">
        <textarea className="textarea" rows={3} value={cue.text} onChange={(e) => edit('Edit subtitle', 'text', (c) => void (c.text = e.target.value.slice(0, 1000)))} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <div className="grid2">
        <Field label="Start (s)">
          <Num label="Start" value={cue.start} min={0} onChange={(v) => edit('Subtitle start', 'start', (c) => void (c.start = Math.min(v, c.end - 0.1)))} />
        </Field>
        <Field label="End (s)">
          <Num label="End" value={cue.end} min={0} onChange={(v) => edit('Subtitle end', 'end', (c) => void (c.end = Math.max(v, c.start + 0.1)))} />
        </Field>
      </div>
    </div>
  );
}

function TrackProps({ track }: { track: Track }) {
  const apply = useProject((s) => s.apply);
  const set = (label: string, fn: (t: Track) => void) => apply(label, (d) => {
    const t = d.timeline.tracks.find((x) => x.id === track.id);
    if (t) fn(t);
  }, { coalesce: `${track.id}:${label}` });
  return (
    <div className="section">
      <h4>Track: {track.name}</h4>
      {(track.kind === 'audio' || track.kind === 'video') && (
        <Field label="Track volume">
          <Slider label="Track volume" value={track.volume} min={0} max={2} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set('Track volume', (t) => void (t.volume = v))} />
        </Field>
      )}
      {track.kind === 'subtitle' && <Check checked={track.burnIn} onChange={(v) => set('Burn-in subtitles', (t) => void (t.burnIn = v))} label="Burn subtitles into the exported video" />}
    </div>
  );
}
