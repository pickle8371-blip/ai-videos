import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Upload, Video, X, Music, Search, Move, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, ZoomIn, ZoomOut, Navigation, Orbit, Crosshair, Footprints, Plane, Eye, Hand, Square, Camera as CamIcon } from 'lucide-react';
import type { Asset, JobTask, ModelInfo, ProviderInfo } from '../../../shared/api';
import type { Camera } from '../../../shared/project';
import { CAMERA_MOVES, SHOT_FRAMINGS } from '../../../shared/project';
import { CAMERA_PRESETS, CAMERA_MOVE_TEXT, FRAMING_TEXT } from '../../../shared/prompt';
import { thumbUrl, uploadFile } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { errMsg } from '../lib/actions';
import { Field, Modal, Progress, Select, Slider, formatBytes, formatDuration } from './ui';

/* ---------------------------------------------------------- model picker */

export function modelsFor(providers: ProviderInfo[], task: JobTask): Array<{ provider: ProviderInfo; model: ModelInfo }> {
  const out: Array<{ provider: ProviderInfo; model: ModelInfo }> = [];
  for (const p of providers) for (const m of p.models) if (m.tasks.includes(task)) out.push({ provider: p, model: m });
  return out;
}

export function ModelPicker({ task, providerId, modelId, onChange }: { task: JobTask; providerId: string; modelId: string; onChange: (providerId: string, modelId: string) => void }) {
  const providers = useApp((s) => s.providers);
  const setWs = useApp((s) => s.setWorkspace);
  const options = modelsFor(providers, task);
  const current = options.find((o) => o.provider.id === providerId && o.model.id === modelId);
  return (
    <div className="col">
      <select
        className="select"
        aria-label="Model"
        value={current ? `${providerId}::${modelId}` : ''}
        onChange={(e) => {
          const [p, m] = e.target.value.split('::');
          onChange(p, m);
        }}
      >
        {!current && <option value="">Choose a model…</option>}
        {providers
          .filter((p) => options.some((o) => o.provider.id === p.id))
          .map((p) => (
            <optgroup key={p.id} label={`${p.name}${p.isAI ? '' : ' — not AI'}${p.configured ? '' : ' (not configured)'}${p.enabled ? '' : ' (disabled)'}`}>
              {options
                .filter((o) => o.provider.id === p.id)
                .map((o) => (
                  <option key={o.model.id} value={`${p.id}::${o.model.id}`} disabled={!p.configured || !p.enabled}>
                    {o.model.name}
                  </option>
                ))}
            </optgroup>
          ))}
      </select>
      {current && (
        <div className="col" style={{ gap: 4 }}>
          <div className="row wrap" style={{ gap: 4 }}>
            {current.provider.isAI ? <span className="badge accent">AI model</span> : <span className="badge warn">Not AI — test output</span>}
            {describeCaps(current.model).map((c) => (
              <span key={c} className="badge">
                {c}
              </span>
            ))}
          </div>
          {current.model.notes && <div className="tiny muted">{current.model.notes}</div>}
        </div>
      )}
      {!options.some((o) => o.provider.isAI && o.provider.configured) && (
        <div className="tiny muted">
          No AI provider is connected for this task.{' '}
          <button className="btn sm ghost" style={{ height: 20, padding: '0 4px' }} onClick={() => setWs('settings')}>
            Connect one in Settings →
          </button>
        </div>
      )}
    </div>
  );
}

function describeCaps(m: ModelInfo): string[] {
  const c = m.capabilities;
  const out: string[] = [];
  if (c.durations) out.push(Array.isArray(c.durations) ? `${c.durations.join('/')}s` : `${c.durations.min}–${c.durations.max}s`);
  if (c.resolutions?.length) out.push(c.resolutions.join('/'));
  if (c.aspectRatios?.length) out.push(c.aspectRatios.join(' '));
  if (c.audio) out.push('audio');
  if (c.camera === 'prompt') out.push('camera via prompt');
  return out;
}

/* ---------------------------------------------------------- upload/drop */

export function useUploader(projectId?: string | null) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upsert = useApp((s) => s.upsertAsset);
  const upload = async (file: File | Blob, allow?: Array<Asset['type']>, origin: 'upload' | 'recording' = 'upload'): Promise<Asset | null> => {
    setError(null);
    setProgress(0);
    try {
      const fields: Record<string, string> = { origin };
      if (allow) fields.allow = allow.join(',');
      if (projectId) fields.projectId = projectId;
      const a = await uploadFile(file, fields, (p) => setProgress(p.total ? p.loaded / p.total : null));
      upsert(a);
      if (projectId && useProject.getState().project?.id === projectId) {
        useProject.getState().apply('Import media', (d) => {
          if (!d.assetIds.includes(a.id)) d.assetIds.push(a.id);
        });
      }
      return a;
    } catch (err) {
      setError(errMsg(err));
      useApp.getState().toast('err', errMsg(err));
      return null;
    } finally {
      setProgress(null);
    }
  };
  return { upload, progress, error };
}

const ACCEPT: Record<Asset['type'], string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv',
  audio: 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac',
};

export function DropZone({ allow, onAsset, label, multiple }: { allow: Array<Asset['type']>; onAsset: (a: Asset) => void; label?: ReactNode; multiple?: boolean }) {
  const project = useProject((s) => s.project);
  const { upload, progress, error } = useUploader(project?.id);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const handle = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, multiple ? 20 : 1)) {
      const a = await upload(f, allow);
      if (a) onAsset(a);
    }
  };
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void handle(e.dataTransfer.files);
      }}
    >
      <input ref={input} type="file" hidden multiple={multiple} accept={allow.map((a) => ACCEPT[a]).join(',')} onChange={(e) => void handle(e.target.files).then(() => (e.target.value = ''))} />
      {progress !== null ? (
        <div className="col">
          <span className="small">Uploading & validating…</span>
          <Progress value={progress} />
        </div>
      ) : (
        <div className="col" style={{ alignItems: 'center', gap: 4 }}>
          <Upload size={18} />
          <span className="small">{label ?? `Drop ${allow.join(' / ')} here or click to browse`}</span>
          <span className="tiny dim">{allow.includes('image') ? 'PNG, JPG, WebP' : ''}{allow.includes('video') ? ' MP4, MOV, WebM' : ''}{allow.includes('audio') ? ' MP3, WAV, M4A, OGG' : ''}</span>
        </div>
      )}
      {error && <div className="tiny" style={{ color: 'var(--err)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/* ---------------------------------------------------------- asset picker */

export function AssetPickerModal({ allow, onPick, onClose, title }: { allow: Array<Asset['type']>; onPick: (a: Asset) => void; onClose: () => void; title?: string }) {
  const assets = useApp((s) => s.assets);
  const project = useProject((s) => s.project);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>(project ? 'project' : 'all');
  const list = useMemo(
    () =>
      assets
        .filter((a) => allow.includes(a.type) && !a.tags.includes('preview'))
        .filter((a) => (scope === 'project' && project ? a.projectIds.includes(project.id) || project.assetIds.includes(a.id) : true))
        .filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.includes(q.toLowerCase()))),
    [assets, allow, scope, project, q],
  );
  return (
    <Modal title={title ?? `Choose ${allow.join(' / ')}`} wide onClose={onClose}>
      <DropZone allow={allow} onAsset={(a) => { onPick(a); onClose(); }} />
      <div className="row">
        <div className="row grow" style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 28 }} placeholder="Search library" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {project && (
          <Select value={scope} onChange={setScope} options={[{ value: 'project', label: 'This project' }, { value: 'all', label: 'Whole library' }]} />
        )}
      </div>
      {list.length === 0 ? (
        <div className="empty small">No matching media. Upload a file above.</div>
      ) : (
        <div className="media-grid sm">
          {list.map((a) => (
            <button key={a.id} className="media-card" style={{ padding: 0, textAlign: 'left' }} onClick={() => { onPick(a); onClose(); }}>
              <div className="media-thumb" style={thumbUrl(a) ? { backgroundImage: `url(${thumbUrl(a)})` } : undefined}>
                {!thumbUrl(a) && (a.type === 'audio' ? <Music size={18} /> : <Video size={18} />)}
                {a.duration ? <span className="dur">{formatDuration(a.duration)}</span> : null}
              </div>
              <div className="media-meta">
                <span className="name ellipsis">{a.name}</span>
                <span className="tiny muted">{a.width ? `${a.width}×${a.height}` : a.type} · {formatBytes(a.sizeBytes)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function AssetSlot({ assetId, allow, onChange, label, emptyLabel }: { assetId: string | null | undefined; allow: Array<Asset['type']>; onChange: (id: string | null) => void; label: string; emptyLabel?: string }) {
  const asset = useApp((s) => s.assets.find((a) => a.id === assetId));
  const [open, setOpen] = useState(false);
  const project = useProject((s) => s.project);
  const { upload, progress } = useUploader(project?.id);
  const [over, setOver] = useState(false);
  return (
    <Field label={label}>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        style={{ padding: 6, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          const raw = e.dataTransfer.getData('application/x-voidcraft-asset');
          if (raw) {
            const a = JSON.parse(raw) as Asset;
            if (allow.includes(a.type)) onChange(a.id);
            else useApp.getState().toast('warn', `Expected ${allow.join(' or ')}`);
            return;
          }
          const f = e.dataTransfer.files?.[0];
          if (f) {
            const a = await upload(f, allow);
            if (a) onChange(a.id);
          }
        }}
        onClick={() => setOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}
      >
        <div className="project-thumb" style={asset && thumbUrl(asset) ? { backgroundImage: `url(${thumbUrl(asset)})`, width: 72, height: 44 } : { width: 72, height: 44 }}>
          {!asset && (allow.includes('image') ? <ImagePlus size={16} /> : <Video size={16} />)}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          {progress !== null ? (
            <Progress value={progress} />
          ) : asset ? (
            <>
              <div className="small ellipsis" style={{ color: 'var(--text-0)' }}>{asset.name}</div>
              <div className="tiny muted">{asset.width ? `${asset.width}×${asset.height}` : ''} {asset.duration ? `· ${formatDuration(asset.duration)}` : ''}</div>
            </>
          ) : (
            <div className="small">{emptyLabel ?? 'Drop a file, or click to choose'}</div>
          )}
        </div>
        {asset && (
          <button className="icon-btn" aria-label={`Clear ${label}`} onClick={(e) => { e.stopPropagation(); onChange(null); }}>
            <X size={14} />
          </button>
        )}
      </div>
      {open && <AssetPickerModal allow={allow} onClose={() => setOpen(false)} onPick={(a) => onChange(a.id)} title={label} />}
    </Field>
  );
}

/* ---------------------------------------------------------- camera */

const PRESET_ICONS: Record<string, typeof Move> = {
  static: Square,
  panLeft: ArrowLeft,
  panRight: ArrowRight,
  tiltUp: ArrowUp,
  tiltDown: ArrowDown,
  dollyIn: ZoomIn,
  dollyOut: ZoomOut,
  tracking: Footprints,
  orbit: Orbit,
  crane: Navigation,
  handheld: Hand,
  slowPushIn: Crosshair,
  pullBackReveal: ZoomOut,
  aerial: Plane,
  firstPerson: Eye,
  ots: CamIcon,
  establishing: Move,
  medium: CamIcon,
  closeUp: Crosshair,
  ecu: Eye,
};

export const DEFAULT_CAMERA: Camera = { move: 'static', framing: 'auto', speed: 0.4, intensity: 0.5, subjectFocus: '', direction: 'auto' };

export function CameraControls({ camera, onChange, support }: { camera: Camera; onChange: (c: Camera) => void; support?: 'prompt' | 'native' | 'none' }) {
  const isOn = (p: (typeof CAMERA_PRESETS)[number]) => Object.entries(p.camera).every(([k, v]) => camera[k as keyof Camera] === v);
  const disabled = support === 'none';
  return (
    <div className="col" style={{ opacity: disabled ? 0.5 : 1 }}>
      {support === 'prompt' && <div className="tiny muted">This model has no native camera controls — your choices are written into the prompt as camera direction.</div>}
      {disabled && <div className="tiny muted">The selected model ignores camera direction.</div>}
      <div className="camera-grid">
        {CAMERA_PRESETS.map((p) => {
          const Icon = PRESET_ICONS[p.id] ?? Move;
          return (
            <button key={p.id} type="button" className={`camera-preset${isOn(p) ? ' on' : ''}`} title={p.description} disabled={disabled} onClick={() => onChange({ ...camera, ...p.camera })}>
              <Icon size={15} />
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="grid2">
        <Field label="Movement">
          <Select label="Camera movement" value={camera.move} onChange={(v) => onChange({ ...camera, move: v })} options={CAMERA_MOVES.map((m) => ({ value: m, label: CAMERA_MOVE_TEXT[m] }))} disabled={disabled} />
        </Field>
        <Field label="Framing">
          <Select label="Framing" value={camera.framing} onChange={(v) => onChange({ ...camera, framing: v })} options={SHOT_FRAMINGS.map((m) => ({ value: m, label: FRAMING_TEXT[m] || 'Automatic' }))} disabled={disabled} />
        </Field>
      </div>
      <Field label="Camera speed">
        <Slider label="Camera speed" value={camera.speed} min={0} max={1} onChange={(v) => onChange({ ...camera, speed: v })} disabled={disabled} />
      </Field>
      <div className="grid2">
        <Field label="Direction">
          <Select
            label="Direction"
            value={camera.direction}
            onChange={(v) => onChange({ ...camera, direction: v })}
            disabled={disabled}
            options={(['auto', 'left', 'right', 'up', 'down', 'forward', 'backward', 'clockwise', 'counterclockwise'] as const).map((d) => ({ value: d, label: d }))}
          />
        </Field>
        <Field label="Subject focus">
          <input className="input" placeholder="e.g. the samurai's face" value={camera.subjectFocus} disabled={disabled} onChange={(e) => onChange({ ...camera, subjectFocus: e.target.value.slice(0, 300) })} />
        </Field>
      </div>
    </div>
  );
}
