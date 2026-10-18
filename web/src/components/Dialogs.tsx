import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Trash2 } from 'lucide-react';
import type { ExportSettings, ProjectSummary } from '../../../shared/project';
import { dimensionsFor } from '../../../shared/factory';
import { timelineDuration } from '../../../shared/timeline';
import { api, mediaUrl, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { deleteProject, errMsg, importProjectFile, newProject, openProject, saveProjectAs } from '../lib/actions';
import { Field, Modal, Notice, Progress, Select, Seg, Check, formatBytes, formatDuration, timeAgo } from './ui';

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const close = () => setDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'new-project':
      return <NewProjectDialog onClose={close} />;
    case 'open-project':
      return <OpenProjectDialog onClose={close} />;
    case 'export':
      return <ExportDialog onClose={close} />;
    case 'save-as':
      return <SaveAsDialog onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'about':
      return (
        <Modal title="About Voidcraft.Video" onClose={close}>
          <p style={{ margin: 0 }}>Voidcraft.Video is a local AI video production studio: generation through connected providers, storyboards, character and scene libraries, and a multitrack editor rendered with FFmpeg.</p>
          <p className="muted small" style={{ margin: 0 }}>
            Results are only labelled AI-generated when a connected AI model produced them. The local test renderer and FFmpeg tools are always marked “Not AI”.
          </p>
        </Modal>
      );
    case 'confirm':
      return (
        <Modal
          title={dialog.title}
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} onClick={dialog.onConfirm}>
                {dialog.confirmLabel}
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{dialog.message}</p>
        </Modal>
      );
  }
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const templates = useApp((s) => s.templates);
  const [name, setName] = useState('Untitled project');
  const [aspect, setAspect] = useState<string>(settings?.defaults.aspectRatio ?? '16:9');
  const [res, setRes] = useState<string>(settings?.defaults.resolution ?? '1080p');
  const [fps, setFps] = useState(30);
  const [tpl, setTpl] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const chosen = templates.find((t) => t.id === tpl);
  const create = async () => {
    setBusy(true);
    const p = await newProject({ name: name.trim() || 'Untitled project', aspectRatio: chosen ? undefined : aspect, resolution: chosen ? undefined : res, fps: chosen ? undefined : fps, templateId: tpl || null });
    setBusy(false);
    if (p) onClose();
  };
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      <Field label="Project name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} maxLength={200} />
      </Field>
      <Field label="Template">
        <select className="select" value={tpl} onChange={(e) => setTpl(e.target.value)}>
          <option value="">Blank project</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} — {t.aspectRatio} {t.resolution} {t.fps}fps{t.builtIn ? '' : ' (saved)'}
            </option>
          ))}
        </select>
      </Field>
      {chosen ? (
        <Notice>{chosen.description || 'Saved template'}</Notice>
      ) : (
        <>
          <Field label="Aspect ratio">
            <Seg value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1', '4:3', '21:9'].map((a) => ({ value: a, label: a }))} />
          </Field>
          <div className="grid2">
            <Field label="Resolution">
              <Select value={res} onChange={setRes} options={[{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '4k', label: '4K UHD' }]} />
            </Field>
            <Field label="Frame rate">
              <Select value={String(fps)} onChange={(v) => setFps(Number(v))} options={['24', '25', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))} />
            </Field>
          </div>
          <div className="small muted">
            Canvas: {dimensionsFor(aspect as never, res as never).join(' × ')} px
          </div>
        </>
      )}
    </Modal>
  );
}

function OpenProjectDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const load = () => api.projects().then(setList).catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
  }, []);
  const filtered = (list ?? []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal
      title="Open project"
      wide
      onClose={onClose}
      footer={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".voidcraft,.json,application/json,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                onClose();
                void importProjectFile(f);
              }
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <FileUp size={14} /> Import .voidcraft / JSON…
          </button>
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <input className="input" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <Notice kind="err">{error}</Notice>}
      {!list && !error && <Progress value={null} />}
      {list && filtered.length === 0 && <div className="empty small">No projects found.</div>}
      <div className="card">
        {filtered.map((p) => (
          <div key={p.id} className="list-row">
            <div className="project-thumb" style={p.thumbnailAssetId ? { backgroundImage: `url(/media/${p.thumbnailAssetId}/thumb.jpg)` } : undefined}>
              {!p.thumbnailAssetId && <FolderOpen size={16} />}
            </div>
            <div className="grow">
              <div style={{ color: 'var(--text-0)' }}>{p.name}</div>
              <div className="tiny muted">
                {p.aspectRatio} · {p.clipCount} clips · {p.shotCount} shots · edited {timeAgo(p.updatedAt)}
                {p.hasRecovery && <span className="badge warn" style={{ marginLeft: 6 }}>unsaved changes recoverable</span>}
              </div>
            </div>
            <button className="btn sm primary" onClick={async () => (await openProject(p.id)) && onClose()}>
              Open
            </button>
            <button className="icon-btn" aria-label={`Delete ${p.name}`} onClick={async () => (await deleteProject(p.id, p.name)) && void load()}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SaveAsDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const [name, setName] = useState(project ? `${project.name} copy` : '');
  const submit = async () => (await saveProjectAs(name.trim() || 'Untitled')) && onClose();
  return (
    <Modal
      title="Save project as"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            Save copy
          </button>
        </>
      }
    >
      <Field label="New project name" hint="Creates a new project from the current state (including unsaved edits) and opens it.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
    </Modal>
  );
}

const PRESETS: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: '1080l', label: '1080p landscape', w: 1920, h: 1080 },
  { id: '1080p', label: '1080p portrait', w: 1080, h: 1920 },
  { id: '1080s', label: '1080 square', w: 1080, h: 1080 },
  { id: '720l', label: '720p landscape', w: 1280, h: 720 },
  { id: '4k', label: '4K UHD landscape', w: 3840, h: 2160 },
  { id: '4kp', label: '4K portrait', w: 2160, h: 3840 },
];

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const assets = useApp((s) => s.assets);
  const jobs = useApp((s) => s.jobs);
  const system = useApp((s) => s.system);
  const [s, setS] = useState<ExportSettings | null>(project ? { ...project.exportSettings, width: project.settings.width, height: project.settings.height, fps: project.settings.fps } : null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === jobId);
  const duration = project ? timelineDuration(project.timeline) : 0;
  const maxSource = useMemo(() => {
    if (!project) return 0;
    let m = 0;
    for (const t of project.timeline.tracks) for (const c of t.clips) if (c.kind === 'media') m = Math.max(m, assets.find((a) => a.id === c.assetId)?.height ?? 0);
    return m;
  }, [project, assets]);
  if (!project || !s) return null;
  const set = (patch: Partial<ExportSettings>) => setS({ ...s, ...patch });
  const projectRatio = project.settings.width / project.settings.height;
  const outRatio = s.width / s.height;
  const output = job?.outputAssetIds[0] ? assets.find((a) => a.id === job.outputAssetIds[0]) : undefined;
  const result = job?.result as { file?: string; copiedTo?: string | null; validation?: { duration: number; width: number; height: number; sizeBytes: number; hasAudio: boolean } } | null | undefined;

  const start = async () => {
    setError(null);
    try {
      useProject.getState().apply('Export settings', (d) => {
        d.exportSettings = s;
      });
      const j = await api.startExport(useProject.getState().project!, s);
      useApp.getState().upsertJob(j);
      setJobId(j.id);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const containerFor = (codec: ExportSettings['codec']): ExportSettings['container'] => (codec === 'vp9' ? 'webm' : codec === 'prores' ? 'mov' : s.container === 'mov' ? 'mov' : 'mp4');

  return (
    <Modal
      title="Export video"
      onClose={onClose}
      wide
      footer={
        job && !['failed', 'canceled'].includes(job.status) ? (
          <>
            {job.status !== 'succeeded' && (
              <button className="btn danger" onClick={() => void api.cancelJob(job.id).then(useApp.getState().upsertJob)}>
                Cancel export
              </button>
            )}
            <button className="btn" onClick={onClose}>
              {job.status === 'succeeded' ? 'Done' : 'Hide (keeps running)'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!system?.ffmpeg.available || duration <= 0} onClick={() => void start()}>
              <Download size={14} /> {job ? 'Export again' : 'Export'}
            </button>
          </>
        )
      }
    >
      {!system?.ffmpeg.available && <Notice kind="err">FFmpeg was not found on the server, so exporting is unavailable. {system?.ffmpeg.error}</Notice>}
      {duration <= 0 && <Notice kind="warn">The timeline is empty. Add clips before exporting.</Notice>}
      {error && <Notice kind="err">{error}</Notice>}
      {job?.status === 'failed' && <Notice kind="err">Export failed: {job.error}</Notice>}
      {job?.status === 'canceled' && <Notice kind="warn">Export canceled.</Notice>}
      {job && !['failed', 'canceled', 'succeeded'].includes(job.status) && (
        <div className="col">
          <div className="row between small">
            <span>{job.message ?? job.status}</span>
            <span className="mono">{job.progress !== null ? `${Math.round(job.progress * 100)}%` : ''}</span>
          </div>
          <Progress value={job.progress} />
        </div>
      )}
      {job?.status === 'succeeded' && (
        <Notice kind="ok">
          <div className="col" style={{ gap: 4 }}>
            <strong>Export complete — file validated with ffprobe.</strong>
            {result?.validation && (
              <span className="small">
                {result.validation.width}×{result.validation.height} · {formatDuration(result.validation.duration)} · {formatBytes(result.validation.sizeBytes)} · {result.validation.hasAudio ? 'with audio' : 'no audio'}
              </span>
            )}
            <span className="mono tiny" style={{ wordBreak: 'break-all' }}>Location: {result?.file}</span>
            {result?.copiedTo && <span className="mono tiny" style={{ wordBreak: 'break-all' }}>Copied to: {result.copiedTo}</span>}
            {output && (
              <div className="row">
                <a className="btn sm" href={`${mediaUrl(output)}?download=1`}>
                  <Download size={13} /> Download
                </a>
              </div>
            )}
          </div>
        </Notice>
      )}
      {output && job?.status === 'succeeded' && <video src={mediaUrl(output)} controls style={{ width: '100%', maxHeight: 300, background: '#000', borderRadius: 6 }} poster={thumbUrl(output) ?? undefined} />}
      {(!job || ['failed', 'canceled'].includes(job.status)) && (
        <>
          <Field label="Preset">
            <div className="row wrap" style={{ gap: 6 }}>
              {PRESETS.map((p) => (
                <button key={p.id} className={`chip${s.width === p.w && s.height === p.h ? ' on' : ''}`} onClick={() => set({ width: p.w, height: p.h })}>
                  {p.label}
                </button>
              ))}
              <button className={`chip${s.width === project.settings.width && s.height === project.settings.height ? ' on' : ''}`} onClick={() => set({ width: project.settings.width, height: project.settings.height })}>
                Project ({project.settings.width}×{project.settings.height})
              </button>
            </div>
          </Field>
          <div className="grid3">
            <Field label="Width">
              <input className="input" type="number" min={64} max={7680} step={2} value={s.width} onChange={(e) => set({ width: Number(e.target.value) })} />
            </Field>
            <Field label="Height">
              <input className="input" type="number" min={64} max={4320} step={2} value={s.height} onChange={(e) => set({ height: Number(e.target.value) })} />
            </Field>
            <Field label="Frame rate">
              <Select value={String(s.fps)} onChange={(v) => set({ fps: Number(v) })} options={['23.976', '24', '25', '29.97', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))} />
            </Field>
          </div>
          <div className="grid3">
            <Field label="Codec">
              <Select
                value={s.codec}
                onChange={(v) => set({ codec: v, container: containerFor(v) })}
                options={[
                  { value: 'h264', label: 'H.264 (most compatible)' },
                  { value: 'h265', label: 'H.265 / HEVC (smaller)' },
                  { value: 'vp9', label: 'VP9 (WebM)' },
                  { value: 'prores', label: 'ProRes 422 HQ (editing)' },
                ]}
              />
            </Field>
            <Field label="Container">
              <Select
                value={s.container}
                onChange={(v) => set({ container: v })}
                options={[
                  { value: 'mp4', label: 'MP4', disabled: s.codec === 'vp9' || s.codec === 'prores' },
                  { value: 'mov', label: 'MOV', disabled: s.codec === 'vp9' },
                  { value: 'webm', label: 'WebM', disabled: s.codec !== 'vp9' },
                ]}
              />
            </Field>
            <Field label="Quality">
              <Select
                value={s.quality}
                onChange={(v) => set({ quality: v })}
                options={[
                  { value: 'draft', label: 'Draft (fast)' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'high', label: 'High' },
                  { value: 'master', label: 'Master (slow)' },
                ]}
              />
            </Field>
          </div>
          <div className="grid2">
            <Field label="File name">
              <input className="input" placeholder={project.name} value={s.fileName} onChange={(e) => set({ fileName: e.target.value })} />
            </Field>
            <Field label="Audio">
              <div className="row">
                <Check checked={s.includeAudio} onChange={(v) => set({ includeAudio: v })} label="Include audio" />
                <Select value={String(s.audioBitrateKbps)} disabled={!s.includeAudio || s.codec === 'prores'} onChange={(v) => set({ audioBitrateKbps: Number(v) })} options={['128', '192', '256', '320'].map((v) => ({ value: v, label: `${v} kbps` }))} />
              </div>
            </Field>
          </div>
          {Math.abs(projectRatio - outRatio) > 0.01 && <Notice kind="warn">The output aspect ratio differs from the project ({project.settings.aspectRatio}); the canvas will be scaled to fit and may be stretched. Use the Reframe tool or change project settings for a clean conversion.</Notice>}
          {maxSource > 0 && s.height > maxSource * 1.05 && <Notice kind="warn">Your sources are at most {maxSource}px tall; exporting at {s.height}px upscales them (no detail is added).</Notice>}
          <div className="small muted">
            Duration {formatDuration(duration)} · the file is rendered by FFmpeg on the server, validated with ffprobe, then added to the asset library.
          </div>
        </>
      )}
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const shortcuts = useApp((s) => s.settings?.shortcuts ?? {});
  const labels: Record<string, string> = {
    playPause: 'Play / pause',
    split: 'Split at playhead',
    delete: 'Delete selection',
    duplicate: 'Duplicate selection',
    undo: 'Undo',
    redo: 'Redo',
    save: 'Save project',
    zoomIn: 'Zoom timeline in',
    zoomOut: 'Zoom timeline out',
    frameBack: 'Previous frame (Shift: 1 s)',
    frameForward: 'Next frame (Shift: 1 s)',
    toStart: 'Go to start',
    toEnd: 'Go to end',
    addKeyframe: 'Add keyframe at playhead',
    togglePanels: 'Toggle timeline',
    fullscreen: 'Full-screen preview',
  };
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="table">
        <tbody>
          {Object.entries(labels).map(([k, label]) => (
            <tr key={k}>
              <td>{label}</td>
              <td style={{ textAlign: 'right' }}>
                <span className="kbd">{shortcuts[k] ?? '—'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
