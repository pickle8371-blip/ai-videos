import { useEffect, useState } from 'react';
import { Clapperboard, FolderOpen, ImagePlay, LayoutTemplate, Plus, RotateCcw, Scissors, Sparkles, Trash2, HardDrive, PlugZap, CheckCircle2, AlertTriangle, Copy, Download } from 'lucide-react';
import type { ProjectSummary } from '../../../shared/project';
import { api, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { EngineInline } from '../components/LocalEngine';
import { useProject } from '../store/project';
import { deleteProject, downloadBundle, errMsg, newProject, openProject } from '../lib/actions';
import { Empty, Notice, formatBytes, timeAgo, StatusBadge } from '../components/ui';

export function Home() {
  const system = useApp((s) => s.system);
  const providers = useApp((s) => s.providers);
  const jobs = useApp((s) => s.jobs);
  const assets = useApp((s) => s.assets);
  const templates = useApp((s) => s.templates);
  const setDialog = useApp((s) => s.setDialog);
  const setWs = useApp((s) => s.setWorkspace);
  const current = useProject((s) => s.project);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.projects().then(setProjects).catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
  }, []);
  const recovery = (projects ?? []).filter((p) => p.hasRecovery && p.recoveryAt && p.recoveryAt > p.savedAt);
  const recentGens = jobs.filter((j) => ['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image'].includes(j.task)).slice(0, 6);
  const aiProviders = providers.filter((p) => p.isAI);
  const last = projects?.[0];


  return (
    <div className="workspace">
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Welcome to Voidcraft.Video</h1>
            <p>Generate, storyboard, edit and export AI video — all in one workspace.</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setDialog({ kind: 'open-project' })}>
              <FolderOpen size={14} /> Open
            </button>
            <button className="btn primary" onClick={() => setDialog({ kind: 'new-project' })}>
              <Plus size={14} /> New project
            </button>
          </div>
        </div>

        {system && !system.ffmpeg.available && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="err">
              <strong>FFmpeg not found.</strong> Editing exports, previews, thumbnails and the local renderer need FFmpeg. {system.ffmpeg.error} On Windows: <span className="mono">winget install Gyan.FFmpeg</span>, then restart Voidcraft.
            </Notice>
          </div>
        )}
        {system && (system.localAi.state !== 'ready' || system.localAi.modelsInstalled === 0) ? (
          <div style={{ marginBottom: 16 }}>
            <EngineInline />
          </div>
        ) : null}
        {recovery.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="warn">
              <div className="col" style={{ gap: 6 }}>
                <strong>Unsaved work can be recovered</strong>
                {recovery.map((p) => (
                  <div key={p.id} className="row">
                    <span className="grow">
                      {p.name} — changes from {timeAgo(p.recoveryAt)}
                    </span>
                    <button className="btn sm" onClick={() => void openProject(p.id)}>
                      <RotateCcw size={13} /> Recover
                    </button>
                    <button className="btn sm ghost" onClick={() => void api.discardRecovery(p.id).then(load)}>
                      Discard
                    </button>
                  </div>
                ))}
              </div>
            </Notice>
          </div>
        )}

        <div className="hero">
          <button className="action-card" onClick={() => setDialog({ kind: 'new-project' })}>
            <div className="ic">
              <Plus size={16} />
            </div>
            <h3>New project</h3>
            <span className="small muted">Blank canvas or a template — 16:9, 9:16 or 1:1.</span>
          </button>
          <button className="action-card" onClick={() => setWs('generate')}>
            <div className="ic">
              <Clapperboard size={16} />
            </div>
            <h3>Generate video</h3>
            <span className="small muted">Text to video with camera, style and motion controls.</span>
          </button>
          <button className="action-card" onClick={() => setWs('image-to-video')}>
            <div className="ic">
              <ImagePlay size={16} />
            </div>
            <h3>Image to video</h3>
            <span className="small muted">Animate a still while preserving its look.</span>
          </button>
          <button className="action-card" onClick={() => (current ? setWs('editor') : last ? void openProject(last.id) : setDialog({ kind: 'new-project' }))}>
            <div className="ic">
              <Scissors size={16} />
            </div>
            <h3>Continue editing</h3>
            <span className="small muted ellipsis">{current ? current.name : last ? last.name : 'No projects yet'}</span>
          </button>
        </div>

        <div className="home-cols">
          <div className="col" style={{ gap: 20 }}>
            <section className="col">
              <div className="row between">
                <h2>Recent projects</h2>
                <button className="btn sm ghost" onClick={() => setDialog({ kind: 'open-project' })}>
                  All projects
                </button>
              </div>
              {error && <Notice kind="err">{error}</Notice>}
              <div className="card">
                {projects && projects.length === 0 && (
                  <Empty icon={<Sparkles size={28} />} title="No projects yet" action={
                    <div className="row">
                      <button className="btn primary" onClick={() => setDialog({ kind: 'new-project' })}>Create a project</button>
                      <button className="btn" onClick={() => setWs('generate')}>Generate a video</button>
                    </div>
                  }>
                    Start by generating a clip on your own computer, or create a project to storyboard and edit.
                  </Empty>
                )}
                {(projects ?? []).slice(0, 8).map((p) => (
                  <div key={p.id} className="list-row">
                    <div className="project-thumb" style={p.thumbnailAssetId ? { backgroundImage: `url(/media/${p.thumbnailAssetId}/thumb.jpg)` } : undefined}>
                      {!p.thumbnailAssetId && <FolderOpen size={16} />}
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="ellipsis" style={{ color: 'var(--text-0)', fontWeight: 550 }}>{p.name}</div>
                      <div className="tiny muted">
                        {p.aspectRatio} · {p.clipCount} clips · {p.shotCount} shots · edited {timeAgo(p.updatedAt)}
                      </div>
                    </div>
                    {current?.id === p.id && <span className="badge accent">open</span>}
                    <button className="btn sm" onClick={() => void openProject(p.id)}>
                      Open
                    </button>
                    <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${p.name}`} onClick={() => void api.duplicateProject(p.id).then(load).catch((e) => useApp.getState().toast('err', errMsg(e)))}>
                      <Copy size={13} />
                    </button>
                    <button className="icon-btn" title="Export bundle" aria-label={`Export ${p.name}`} onClick={() => downloadBundle(p.id)}>
                      <Download size={13} />
                    </button>
                    <button className="icon-btn" title="Delete" aria-label={`Delete ${p.name}`} onClick={async () => (await deleteProject(p.id, p.name)) && void load()}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="col">
              <div className="row between">
                <h2>Recent generations</h2>
                <button className="btn sm ghost" onClick={() => setWs('history')}>
                  History
                </button>
              </div>
              {recentGens.length === 0 ? (
                <div className="card">
                  <div className="empty small">Nothing generated yet.</div>
                </div>
              ) : (
                <div className="media-grid sm">
                  {recentGens.map((j) => {
                    const a = assets.find((x) => x.id === j.outputAssetIds[0]);
                    return (
                      <div key={j.id} className="media-card" onClick={() => setWs('history')}>
                        <div className="media-thumb" style={a && thumbUrl(a) ? { backgroundImage: `url(${thumbUrl(a)})` } : undefined}>
                          <span className="corner">
                            <StatusBadge status={j.status} />
                          </span>
                        </div>
                        <div className="media-meta">
                          <span className="name ellipsis">{String((j.params as { prompt?: string }).prompt ?? j.task)}</span>
                          <span className="tiny muted">{j.providerId} · {timeAgo(j.createdAt)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="col">
              <div className="row between">
                <h2>Templates</h2>
                <button className="btn sm ghost" onClick={() => setWs('templates')}>
                  <LayoutTemplate size={13} /> Browse
                </button>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                {templates.slice(0, 6).map((t) => (
                  <button key={t.id} className="chip" onClick={() => void newProject({ name: t.name, templateId: t.id })}>
                    {t.name} · {t.aspectRatio}
                  </button>
                ))}
              </div>
            </section>
          </div>

          <aside className="col" style={{ gap: 16 }}>
            <div className="card pad col">
              <div className="row">
                <PlugZap size={15} />
                <h3>Local AI</h3>
              </div>
              <div className="row small">
                {system?.localAi.state === 'ready' ? <CheckCircle2 size={13} color="var(--ok)" /> : <AlertTriangle size={13} color="var(--warn)" />}
                <span className="grow">{system?.localAi.message ?? 'Checking…'}</span>
              </div>
              <div className="tiny muted">{system?.localAi.modelsInstalled ?? 0} model(s) downloaded · no API keys needed</div>
              {aiProviders.filter((p) => p.id !== 'local-ai' && p.configured).map((p) => (
                <div key={p.id} className="row small">
                  <CheckCircle2 size={13} color="var(--ok)" />
                  <span className="grow">{p.name} (cloud)</span>
                  <span className="tiny muted">{p.usage.jobs} jobs</span>
                </div>
              ))}
              <button className="btn sm" onClick={() => setWs('settings')}>
                Manage models
              </button>
            </div>
            <div className="card pad col">
              <div className="row">
                <HardDrive size={15} />
                <h3>Storage</h3>
              </div>
              <dl className="kv">
                <dt>Media</dt>
                <dd>{formatBytes(system?.storage.assetsBytes)}</dd>
                <dt>Exports</dt>
                <dd>{formatBytes(system?.storage.exportsBytes)}</dd>
                <dt>Free disk</dt>
                <dd>{formatBytes(system?.storage.freeBytes)}</dd>
                <dt>FFmpeg</dt>
                <dd>{system?.ffmpeg.available ? system.ffmpeg.version?.replace(/^ffmpeg version /, '').split(' ')[0] : <span style={{ color: 'var(--err)' }}>missing</span>}</dd>
              </dl>
              <div className="tiny dim mono" style={{ wordBreak: 'break-all' }}>{system?.dataDir}</div>
            </div>
            <div className="card pad col">
              <h3>Getting started</h3>
              <ol className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <li>Install the Local AI engine and download a model (Settings → Local AI) — one time.</li>
                <li>Write a prompt in the AI Video Generator, or turn an idea into shots in AI Storyboard.</li>
                <li>Create characters and environments to keep shots consistent.</li>
                <li>Arrange clips on the timeline, add titles, music, subtitles and effects.</li>
                <li>Export an MP4 — every export is validated before it is reported as done.</li>
              </ol>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
