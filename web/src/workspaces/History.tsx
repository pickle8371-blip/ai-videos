import { useMemo, useState } from 'react';
import { History as HistoryIcon, RefreshCw, Square, Trash2, ListPlus, Copy } from 'lucide-react';
import type { GenerationParams, JobRecord } from '../../../shared/api';
import { api, mediaUrl, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { addAssetsToTimeline, errMsg } from '../lib/actions';
import { useGen } from './Generate';
import { Empty, Progress, Select, StatusBadge, formatDuration, timeAgo } from '../components/ui';

export function History() {
  const jobs = useApp((s) => s.jobs);
  const assets = useApp((s) => s.assets);
  const project = useProject((s) => s.project);
  const setWs = useApp((s) => s.setWorkspace);
  const [status, setStatus] = useState('all');
  const [task, setTask] = useState('all');
  const [scope, setScope] = useState<'all' | 'project'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(
    () =>
      jobs
        .filter((j) => status === 'all' || (status === 'active' ? ['queued', 'submitting', 'running', 'downloading'].includes(j.status) : j.status === status))
        .filter((j) => task === 'all' || j.task === task)
        .filter((j) => scope === 'all' || (project && j.projectId === project.id)),
    [jobs, status, task, scope, project],
  );
  const act = (p: Promise<JobRecord | JobRecord[]>) =>
    p
      .then((r) => (Array.isArray(r) ? r : [r]).forEach(useApp.getState().upsertJob))
      .catch((e) => useApp.getState().toast('err', errMsg(e)));
  const reuse = (j: JobRecord) => {
    const p = j.params as GenerationParams;
    const mode = j.task === 'image-to-video' ? 'image-to-video' : j.task === 'video-to-video' ? 'video-to-video' : 'generate';
    useGen.getState().set(mode, {
      prompt: p.prompt ?? '',
      negativePrompt: p.negativePrompt ?? '',
      providerId: j.providerId,
      modelId: j.modelId,
      ...(p.duration ? { duration: p.duration } : {}),
      ...(p.aspectRatio ? { aspectRatio: p.aspectRatio } : {}),
      ...(p.camera ? { camera: p.camera } : {}),
      ...(p.startImageAssetId !== undefined ? { startImageAssetId: p.startImageAssetId } : {}),
      ...(p.sourceVideoAssetId !== undefined ? { sourceVideoAssetId: p.sourceVideoAssetId } : {}),
    });
    setWs(mode);
  };

  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="page-header">
          <div>
            <h1>Generation History</h1>
            <p>Every generation, transcription, tool run and export, with its real status from the provider or render pipeline.</p>
          </div>
          <div className="row">
            <Select label="Status" value={status} onChange={setStatus} options={['all', 'active', 'succeeded', 'failed', 'canceled'].map((v) => ({ value: v, label: v }))} />
            <Select label="Type" value={task} onChange={setTask} options={['all', 'text-to-video', 'image-to-video', 'video-to-video', 'text-to-image', 'text-to-speech', 'transcribe', 'tool', 'export'].map((v) => ({ value: v, label: v }))} />
            {project && <Select label="Scope" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All projects' }, { value: 'project', label: 'Current project' }]} />}
            <button className="btn" onClick={() => void useApp.getState().refreshJobs()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="card">
            <Empty icon={<HistoryIcon size={30} />} title="No jobs yet" />
          </div>
        ) : (
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Result</th>
                  <th>Request</th>
                  <th style={{ width: 160 }}>Provider / model</th>
                  <th style={{ width: 170 }}>Status</th>
                  <th style={{ width: 110 }}>Created</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {list.map((j) => {
                  const p = j.params as GenerationParams & { settings?: { width: number; height: number } };
                  const out = assets.filter((a) => j.outputAssetIds.includes(a.id));
                  const active = ['queued', 'submitting', 'running', 'downloading'].includes(j.status);
                  return (
                    <tr key={j.id} onClick={() => setOpen(open === j.id ? null : j.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        {out[0] && thumbUrl(out[0]) ? <div className="project-thumb" style={{ backgroundImage: `url(${thumbUrl(out[0])})` }} /> : <div className="project-thumb" />}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <span className="badge">{j.task}</span>
                          {j.retryOf && <span className="badge">retry</span>}
                          {(j.params as { preview?: boolean }).preview && <span className="badge">preview</span>}
                        </div>
                        <div className="small" style={{ marginTop: 4, display: '-webkit-box', WebkitLineClamp: open === j.id ? 20 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {j.task === 'export' ? `${(j.params as unknown as { projectName: string }).projectName} → ${p.settings?.width}×${p.settings?.height}` : p.prompt || p.text || (j.params as { sourceAssetId?: string }).sourceAssetId || '—'}
                        </div>
                        {open === j.id && (
                          <div className="col" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                            {p.compiledPrompt && <div className="tiny muted">Sent prompt: {p.compiledPrompt}</div>}
                            {out.map((a) => (
                              <div key={a.id} className="row">
                                {a.type === 'video' ? <video src={mediaUrl(a)} controls style={{ width: 320, borderRadius: 6, background: '#000' }} /> : a.type === 'image' ? <img src={mediaUrl(a)} alt="" style={{ width: 200, borderRadius: 6 }} /> : <audio src={mediaUrl(a)} controls />}
                                <div className="col tiny muted">
                                  <span>{a.name}</span>
                                  <span>{a.width ? `${a.width}×${a.height} · ` : ''}{formatDuration(a.duration)}</span>
                                  <span>{a.provenance.aiGenerated ? `AI generated by ${a.provenance.generator}` : a.provenance.generator}</span>
                                </div>
                              </div>
                            ))}
                            {j.result && j.task === 'export' && <div className="tiny mono">{String((j.result as { file?: string }).file ?? '')}</div>}
                            {j.result && j.task === 'transcribe' && <div className="small">{String((j.result as { text?: string }).text ?? '')}</div>}
                            <div className="tiny dim mono">job {j.id} · provider job {j.providerJobId ?? '—'} · attempt {j.attempts}</div>
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {j.providerId}
                        <div className="tiny muted">{j.modelId}</div>
                      </td>
                      <td>
                        <StatusBadge status={j.status} />
                        {active && (
                          <div style={{ marginTop: 6 }}>
                            <Progress value={j.progress} />
                            <div className="tiny muted" style={{ marginTop: 2 }}>{j.message}</div>
                          </div>
                        )}
                        {j.status === 'failed' && <div className="tiny" style={{ color: 'var(--err)', marginTop: 4 }}>{j.error}</div>}
                        {j.status === 'canceled' && j.message && <div className="tiny muted">{j.message}</div>}
                      </td>
                      <td className="small muted">{timeAgo(j.createdAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          {active && (
                            <button className="icon-btn" title="Cancel" aria-label="Cancel job" onClick={() => act(api.cancelJob(j.id))}>
                              <Square size={13} />
                            </button>
                          )}
                          {!active && (
                            <button className="icon-btn" title="Retry with the same settings" aria-label="Retry job" onClick={() => act(api.retryJob(j.id))}>
                              <RefreshCw size={13} />
                            </button>
                          )}
                          {['text-to-video', 'image-to-video', 'video-to-video'].includes(j.task) && (
                            <button className="icon-btn" title="Reuse settings in the generator" aria-label="Reuse settings" onClick={() => reuse(j)}>
                              <Copy size={13} />
                            </button>
                          )}
                          {out.length > 0 && project && j.task !== 'transcribe' && (
                            <button className="icon-btn" title="Add result to timeline" aria-label="Add to timeline" onClick={() => addAssetsToTimeline(out)}>
                              <ListPlus size={13} />
                            </button>
                          )}
                          {!active && (
                            <button
                              className="icon-btn"
                              title="Remove from history (files stay in the library)"
                              aria-label="Remove job"
                              onClick={() => void api.deleteJob(j.id).then(() => useApp.setState((s) => ({ jobs: s.jobs.filter((x) => x.id !== j.id) }))).catch((e) => useApp.getState().toast('err', errMsg(e)))}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
