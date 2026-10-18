import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Film, Image as ImageIcon, ListPlus, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2, Wand2, X, LayoutGrid, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Shot } from '../../../shared/project';
import { newId } from '../../../shared/factory';
import { appendShotsToTimeline } from '../../../shared/ops';
import { VISUAL_STYLES, cameraToText } from '../../../shared/prompt';
import { api, mediaUrl, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { errMsg, submitJob } from '../lib/actions';
import { AssetSlot, CameraControls, DEFAULT_CAMERA, ModelPicker, modelsFor } from '../components/pickers';
import { Empty, Field, Modal, Notice, Select, Slider, StatusBadge } from '../components/ui';

interface AiShot {
  title: string;
  description: string;
  prompt: string;
  cameraAngle: string;
  cameraMove: Shot['camera']['move'];
  framing: Shot['camera']['framing'];
  lighting: string;
  duration: number;
  dialogue: string;
  characterNames: string[];
  environmentName: string;
}

function blankShot(n: number): Shot {
  return {
    id: newId('sht'),
    title: `Shot ${n}`,
    description: '',
    prompt: '',
    characterIds: [],
    environmentId: null,
    cameraAngle: '',
    camera: DEFAULT_CAMERA,
    lighting: '',
    dialogue: '',
    duration: 5,
    status: 'draft',
    frameAssetId: null,
    videoAssetId: null,
    lastJobId: null,
    review: 'unreviewed',
    error: null,
  };
}

export function Storyboard() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const providers = useApp((s) => s.providers);
  const assets = useApp((s) => s.assets);
  const settings = useApp((s) => s.settings);
  const jobs = useApp((s) => s.jobs);
  const [idea, setIdea] = useState(project.storyboard.idea);
  const [count, setCount] = useState(6);
  const [style, setStyle] = useState('Cinematic realism');
  const [llm, setLlm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [video, setVideo] = useState({ providerId: '', modelId: '' });
  const [i2v, setI2v] = useState({ providerId: '', modelId: '' });
  const [image, setImage] = useState({ providerId: '', modelId: '' });
  const shots = project.storyboard.shots;
  const llmProviders = providers.filter((p) => p.categories.includes('llm') && p.configured && p.enabled);

  useEffect(() => setIdea(project.storyboard.idea), [project.id, project.storyboard.idea]);
  useEffect(() => {
    if (!llm && llmProviders.length) setLlm(llmProviders.find((p) => p.id === settings?.defaults.llmProviderId)?.id ?? llmProviders.find((p) => p.isAI)?.id ?? 'offline-templates');
    const pick = (task: 'text-to-video' | 'image-to-video' | 'text-to-image', cur: { providerId: string }, set: (v: { providerId: string; modelId: string }) => void) => {
      if (cur.providerId) return;
      const opts = modelsFor(providers, task).filter((o) => o.provider.configured && o.provider.enabled);
      const c = opts.find((o) => o.provider.isAI) ?? opts[0];
      if (c) set({ providerId: c.provider.id, modelId: c.model.id });
    };
    pick('text-to-video', video, setVideo);
    pick('image-to-video', i2v, setI2v);
    pick('text-to-image', image, setImage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, settings]);

  const toShot = (s: AiShot, i: number): Shot => ({
    ...blankShot(shots.length + i + 1),
    title: s.title.slice(0, 200),
    description: s.description.slice(0, 4000),
    prompt: s.prompt.slice(0, 4000),
    cameraAngle: s.cameraAngle.slice(0, 200),
    camera: { ...DEFAULT_CAMERA, move: s.cameraMove, framing: s.framing },
    lighting: s.lighting.slice(0, 500),
    duration: Math.min(60, Math.max(1, Math.round(s.duration))),
    dialogue: s.dialogue.slice(0, 2000),
    characterIds: project.characters.filter((c) => s.characterNames.some((n) => n.toLowerCase() === c.name.toLowerCase())).map((c) => c.id),
    environmentId: project.environments.find((e) => e.name.toLowerCase() === s.environmentName.toLowerCase())?.id ?? null,
  });

  const generateList = async (mode: 'replace' | 'append') => {
    if (!idea.trim()) return;
    if (mode === 'replace' && shots.some((s) => s.videoAssetId || s.frameAssetId)) {
      const ok = await useApp.getState().confirm({ title: 'Replace shot list?', message: 'Existing shots (and links to their generated clips) will be replaced. Generated files stay in the asset library. You can undo this.', confirmLabel: 'Replace shots' });
      if (!ok) return;
    }
    setBusy('list');
    try {
      const r = await api.ai<{ shots: AiShot[] }>('storyboard', llm || 'offline-templates', {
        idea,
        shotCount: count,
        style,
        characters: project.characters.map((c) => ({ name: c.name, description: [c.description, c.appearance, c.clothing].filter(Boolean).join('; ').slice(0, 600) })),
        environments: project.environments.map((e) => ({ name: e.name, description: [e.description, e.lighting, e.atmosphere].filter(Boolean).join('; ').slice(0, 600) })),
      });
      apply('Generate shot list', (d) => {
        d.storyboard.idea = idea;
        d.storyboard.source = r.isAI ? r.providerId : 'offline-template';
        const next = r.result.shots.map(toShot);
        d.storyboard.shots = mode === 'replace' ? next : [...d.storyboard.shots, ...next];
      });
      useApp.getState().toast(r.isAI ? 'ok' : 'info', r.isAI ? `${r.result.shots.length} shots proposed by ${r.providerId}` : `${r.result.shots.length} shots created with offline templates (not AI). Connect a language model for better shot lists.`);
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  const continueScene = async () => {
    if (!shots.length) return;
    setBusy('continue');
    try {
      const r = await api.ai<{ shots: AiShot[] }>('continue-scene', llm || 'offline-templates', { shots: shots.map((s) => ({ title: s.title, description: s.description || s.prompt })), count: 3 });
      apply('Continue scene', (d) => void d.storyboard.shots.push(...r.result.shots.map(toShot)));
      useApp.getState().toast('ok', `Added ${r.result.shots.length} suggested shots${r.isAI ? '' : ' (offline templates, not AI)'}`);
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  const shotParams = (s: Shot) => ({
    prompt: (s.prompt || s.description || s.title).slice(0, 4000),
    duration: s.duration,
    aspectRatio: project.settings.aspectRatio,
    camera: s.camera,
    lighting: s.lighting || 'None',
    characterIds: s.characterIds,
    environmentId: s.environmentId,
    style: style,
  });

  const genClip = async (s: Shot) => {
    const useI2v = Boolean(s.frameAssetId && i2v.providerId);
    const m = useI2v ? i2v : video;
    if (!m.providerId) return useApp.getState().toast('warn', 'Choose a video model first');
    await submitJob({
      task: useI2v ? 'image-to-video' : 'text-to-video',
      providerId: m.providerId,
      modelId: m.modelId,
      params: { ...shotParams(s), ...(useI2v ? { startImageAssetId: s.frameAssetId, preserveReference: true } : {}) },
      projectId: project.id,
      shotId: s.id,
    });
  };
  const genFrame = async (s: Shot) => {
    if (!image.providerId) return useApp.getState().toast('warn', 'Connect an image model (Replicate, fal, Luma or OpenAI) to generate storyboard frames, or upload a frame in the shot editor.');
    await submitJob({ task: 'text-to-image', providerId: image.providerId, modelId: image.modelId, params: { ...shotParams(s), variations: 1 }, projectId: project.id, shotId: s.id });
  };

  const update = (id: string, label: string, fn: (s: Shot) => void, coalesce?: string) =>
    apply(label, (d) => {
      const s = d.storyboard.shots.find((x) => x.id === id);
      if (s) fn(s);
    }, coalesce ? { coalesce } : undefined);
  const move = (id: string, to: number) =>
    apply('Reorder shots', (d) => {
      const from = d.storyboard.shots.findIndex((s) => s.id === id);
      if (from < 0 || to < 0 || to >= d.storyboard.shots.length) return;
      const [s] = d.storyboard.shots.splice(from, 1);
      d.storyboard.shots.splice(to, 0, s);
    });

  const addAllToTimeline = () => {
    const items = shots
      .filter((s) => s.videoAssetId && s.review !== 'rejected')
      .map((s, i) => ({ s, i, a: assets.find((x) => x.id === s.videoAssetId) }))
      .filter((x) => x.a);
    if (!items.length) return useApp.getState().toast('info', 'No generated shot clips yet');
    apply('Add shots to timeline', (d) => void appendShotsToTimeline(d, items.map((x) => ({ asset: x.a!, label: `${x.i + 1}. ${x.s.title}` }))));
    useApp.getState().toast('ok', `Added ${items.length} shot clip(s) to the timeline in storyboard order`);
  };

  const imageModels = modelsFor(providers, 'text-to-image').filter((o) => o.provider.configured);
  const editingShot = shots.find((s) => s.id === editing);
  const totalDur = shots.reduce((n, s) => n + s.duration, 0);

  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 1400 }}>
        <div className="page-header">
          <div>
            <h1>AI Storyboard</h1>
            <p>
              {shots.length} shots · ~{totalDur}s · shot list source: {project.storyboard.source === 'manual' ? 'manual' : project.storyboard.source === 'offline-template' ? 'offline templates (not AI)' : project.storyboard.source}
            </p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => apply('Add shot', (d) => void d.storyboard.shots.push(blankShot(d.storyboard.shots.length + 1)))}>
              <Plus size={14} /> Add shot
            </button>
            <button className="btn" disabled={!shots.length || busy !== null} onClick={() => void continueScene()}>
              {busy === 'continue' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Continue scene
            </button>
            <button className="btn primary" onClick={addAllToTimeline}>
              <ListPlus size={14} /> Arrange clips on timeline
            </button>
          </div>
        </div>

        <div className="card pad col" style={{ marginBottom: 16 }}>
          <Field label="Story or scene idea">
            <textarea className="textarea" rows={3} value={idea} maxLength={8000} placeholder="e.g. A ronin returns to his abandoned village in the rain and finds his family crest on a ruined gate…" onChange={(e) => setIdea(e.target.value)} onBlur={() => idea !== project.storyboard.idea && apply('Edit idea', (d) => void (d.storyboard.idea = idea))} />
          </Field>
          <div className="row wrap">
            <Field label="Shots">
              <input className="input" type="number" min={1} max={30} value={count} onChange={(e) => setCount(Math.min(30, Math.max(1, Number(e.target.value))))} style={{ width: 80 }} />
            </Field>
            <Field label="Style">
              <Select value={style} onChange={setStyle} options={VISUAL_STYLES.map((s) => ({ value: s, label: s }))} />
            </Field>
            <Field label="Written by">
              <select className="select" value={llm} onChange={(e) => setLlm(e.target.value)}>
                {llmProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.isAI ? p.name : 'Offline templates (not AI)'}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grow" />
            <button className="btn" disabled={!idea.trim() || busy !== null} onClick={() => void generateList('append')}>
              Append shots
            </button>
            <button className="btn primary" disabled={!idea.trim() || busy !== null} onClick={() => void generateList('replace')}>
              {busy === 'list' ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} Propose shot list
            </button>
          </div>
        </div>

        <div className="card pad" style={{ marginBottom: 16 }}>
          <div className="grid3">
            <Field label="Clip model (text to video)">
              <ModelPicker task="text-to-video" providerId={video.providerId} modelId={video.modelId} onChange={(providerId, modelId) => setVideo({ providerId, modelId })} />
            </Field>
            <Field label="Frame → clip model (image to video)" hint="Used for shots that have a storyboard frame.">
              <ModelPicker task="image-to-video" providerId={i2v.providerId} modelId={i2v.modelId} onChange={(providerId, modelId) => setI2v({ providerId, modelId })} />
            </Field>
            <Field label="Frame model (text to image)">
              {modelsFor(providers, 'text-to-image').length ? (
                <ModelPicker task="text-to-image" providerId={image.providerId} modelId={image.modelId} onChange={(providerId, modelId) => setImage({ providerId, modelId })} />
              ) : (
                <div className="tiny muted">No image model available.</div>
              )}
              {!imageModels.length && <div className="tiny muted">Connect an image provider to generate frames; you can also upload frames per shot.</div>}
            </Field>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" disabled={!image.providerId || !shots.length} onClick={() => shots.filter((s) => !s.frameAssetId).forEach((s) => void genFrame(s))}>
              <ImageIcon size={13} /> Generate missing frames
            </button>
            <button className="btn sm" disabled={!video.providerId || !shots.length} onClick={() => shots.filter((s) => !s.videoAssetId && s.status !== 'generating' && s.status !== 'queued').forEach((s) => void genClip(s))}>
              <Film size={13} /> Generate missing clips
            </button>
            <span className="tiny muted">Each shot is generated independently — regenerate any single shot without rebuilding the board.</span>
          </div>
        </div>

        {shots.length === 0 ? (
          <div className="card">
            <Empty icon={<LayoutGrid size={30} />} title="No shots yet">
              Describe your idea above and propose a shot list, or add shots manually.
            </Empty>
          </div>
        ) : (
          <div className="shot-list">
            {shots.map((s, i) => {
              const frame = assets.find((a) => a.id === s.frameAssetId);
              const clip = assets.find((a) => a.id === s.videoAssetId);
              const job = jobs.find((j) => j.id === s.lastJobId);
              const running = job && ['queued', 'submitting', 'running', 'downloading'].includes(job.status);
              return (
                <div
                  key={s.id}
                  className={`shot${dragId === s.id ? ' dragging' : ''}${overId === s.id && dragId !== s.id ? ' drop-target' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    setDragId(s.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', s.id);
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    setOverId(s.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dragId !== s.id) move(dragId, i);
                    setDragId(null);
                    setOverId(null);
                  }}
                >
                  <div className="shot-frame" style={!clip && frame && thumbUrl(frame) ? { backgroundImage: `url(${thumbUrl(frame)})` } : undefined}>
                    {clip ? <video src={mediaUrl(clip)} poster={thumbUrl(clip) ?? undefined} muted loop playsInline onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : !frame && <ImageIcon size={22} />}
                    <span className="shot-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="shot-status">
                      {running ? (
                        <span className="badge accent">
                          <Loader2 size={10} className="spin" /> {job.status}
                          {job.progress !== null ? ` ${Math.round(job.progress * 100)}%` : ''}
                        </span>
                      ) : (
                        <StatusBadge status={s.status} />
                      )}
                    </span>
                    {clip && !clip.provenance.aiGenerated && <span className="badge warn" style={{ position: 'absolute', left: 8, bottom: 8 }}>Not AI</span>}
                  </div>
                  <div className="shot-body">
                    <input
                      className="input"
                      style={{ fontWeight: 600, color: 'var(--text-0)', background: 'transparent', border: '1px solid transparent', padding: '2px 4px' }}
                      aria-label="Shot title"
                      value={s.title}
                      onChange={(e) => update(s.id, 'Rename shot', (x) => void (x.title = e.target.value.slice(0, 200)), `title-${s.id}`)}
                    />
                    <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.description || s.prompt || 'No description'}</div>
                    <div className="row wrap" style={{ gap: 4 }}>
                      <span className="badge">{s.duration}s</span>
                      {cameraToText(s.camera) && <span className="badge" title={cameraToText(s.camera)}>{cameraToText(s.camera).slice(0, 34)}</span>}
                      {s.characterIds.map((cid) => (
                        <span key={cid} className="badge accent">{project.characters.find((c) => c.id === cid)?.name ?? '?'}</span>
                      ))}
                      {s.environmentId && <span className="badge">{project.environments.find((e) => e.id === s.environmentId)?.name}</span>}
                      {s.review !== 'unreviewed' && <StatusBadge status={s.review} />}
                    </div>
                    {s.status === 'failed' && s.error && <div className="tiny" style={{ color: 'var(--err)' }}>{s.error}</div>}
                  </div>
                  <div className="shot-actions">
                    <button className="btn sm" onClick={() => setEditing(s.id)}>
                      <Pencil size={12} /> Edit
                    </button>
                    <button className="btn sm" disabled={!image.providerId || Boolean(running)} onClick={() => void genFrame(s)} title="Generate a storyboard frame">
                      <ImageIcon size={12} /> Frame
                    </button>
                    <button className="btn sm primary" disabled={Boolean(running)} onClick={() => void genClip(s)} title={s.frameAssetId ? 'Animate the frame (image to video)' : 'Generate clip (text to video)'}>
                      {s.videoAssetId ? <RefreshCw size={12} /> : <Film size={12} />} {s.videoAssetId ? 'Regenerate' : 'Generate'}
                    </button>
                    {clip && (
                      <>
                        <button className={`icon-btn${s.review === 'approved' ? ' on' : ''}`} title="Approve" aria-label="Approve shot" onClick={() => update(s.id, 'Approve shot', (x) => void (x.review = x.review === 'approved' ? 'unreviewed' : 'approved'))}>
                          <ThumbsUp size={13} />
                        </button>
                        <button className={`icon-btn${s.review === 'rejected' ? ' on' : ''}`} title="Reject" aria-label="Reject shot" onClick={() => update(s.id, 'Reject shot', (x) => void (x.review = x.review === 'rejected' ? 'unreviewed' : 'rejected'))}>
                          <ThumbsDown size={13} />
                        </button>
                      </>
                    )}
                    <div className="grow" />
                    <button className="icon-btn" aria-label="Move left" disabled={i === 0} onClick={() => move(s.id, i - 1)}>
                      <ArrowLeft size={13} />
                    </button>
                    <button className="icon-btn" aria-label="Move right" disabled={i === shots.length - 1} onClick={() => move(s.id, i + 1)}>
                      <ArrowRight size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Duplicate shot"
                      onClick={() =>
                        apply('Duplicate shot', (d) => {
                          const idx = d.storyboard.shots.findIndex((x) => x.id === s.id);
                          d.storyboard.shots.splice(idx + 1, 0, { ...JSON.parse(JSON.stringify(s)), id: newId('sht'), title: `${s.title} (copy)`, status: s.videoAssetId ? 'done' : 'draft', lastJobId: null });
                        })
                      }
                    >
                      <Copy size={13} />
                    </button>
                    <button className="icon-btn" aria-label="Delete shot" onClick={() => apply('Delete shot', (d) => void (d.storyboard.shots = d.storyboard.shots.filter((x) => x.id !== s.id)))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editingShot && <ShotEditor shot={editingShot} onClose={() => setEditing(null)} onGenerate={() => void genClip(editingShot)} />}
    </div>
  );
}

function ShotEditor({ shot, onClose, onGenerate }: { shot: Shot; onClose: () => void; onGenerate: () => void }) {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const set = (label: string, fn: (s: Shot) => void, key: string) =>
    apply(label, (d) => {
      const s = d.storyboard.shots.find((x) => x.id === shot.id);
      if (s) fn(s);
    }, { coalesce: `${shot.id}:${key}` });
  const idx = project.storyboard.shots.findIndex((s) => s.id === shot.id);
  return (
    <Modal
      title={`Shot ${idx + 1}: ${shot.title}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            <Check size={14} /> Done
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onGenerate();
              onClose();
            }}
          >
            <Film size={14} /> {shot.videoAssetId ? 'Regenerate clip' : 'Generate clip'}
          </button>
        </>
      }
    >
      {shot.status === 'failed' && shot.error && <Notice kind="err">Last generation failed: {shot.error}</Notice>}
      <div className="grid2">
        <Field label="Title">
          <input className="input" value={shot.title} onChange={(e) => set('Edit shot', (s) => void (s.title = e.target.value.slice(0, 200)), 'title')} />
        </Field>
        <Field label={`Estimated duration: ${shot.duration}s`}>
          <Slider label="Duration" value={shot.duration} min={1} max={20} step={1} onChange={(v) => set('Shot duration', (s) => void (s.duration = v), 'duration')} />
        </Field>
      </div>
      <Field label="Description">
        <textarea className="textarea" rows={2} value={shot.description} onChange={(e) => set('Edit shot', (s) => void (s.description = e.target.value.slice(0, 4000)), 'desc')} />
      </Field>
      <Field label="Visual prompt" hint="Sent to the video model together with camera, lighting, character and environment details.">
        <textarea className="textarea" rows={3} value={shot.prompt} onChange={(e) => set('Edit prompt', (s) => void (s.prompt = e.target.value.slice(0, 4000)), 'prompt')} />
      </Field>
      <div className="grid2">
        <Field label="Characters">
          <div className="row wrap" style={{ gap: 6 }}>
            {project.characters.length === 0 && <span className="tiny muted">No characters yet — create them in Character Studio.</span>}
            {project.characters.map((c) => (
              <button key={c.id} className={`chip${shot.characterIds.includes(c.id) ? ' on' : ''}`} onClick={() => set('Assign character', (s) => void (s.characterIds = s.characterIds.includes(c.id) ? s.characterIds.filter((x) => x !== c.id) : [...s.characterIds, c.id]), 'chars')}>
                {c.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Environment">
          <Select value={shot.environmentId ?? ''} onChange={(v) => set('Assign environment', (s) => void (s.environmentId = v || null), 'env')} options={[{ value: '', label: 'None' }, ...project.environments.map((e) => ({ value: e.id, label: e.name }))]} />
        </Field>
        <Field label="Camera angle">
          <input className="input" placeholder="e.g. low angle, eye level" value={shot.cameraAngle} onChange={(e) => set('Camera angle', (s) => void (s.cameraAngle = e.target.value.slice(0, 200)), 'angle')} />
        </Field>
        <Field label="Lighting">
          <input className="input" placeholder="e.g. warm lantern light, cold rain" value={shot.lighting} onChange={(e) => set('Lighting', (s) => void (s.lighting = e.target.value.slice(0, 500)), 'light')} />
        </Field>
      </div>
      <Field label="Dialogue / narration (for the audio track)">
        <textarea className="textarea" rows={2} value={shot.dialogue} onChange={(e) => set('Dialogue', (s) => void (s.dialogue = e.target.value.slice(0, 2000)), 'dialogue')} />
      </Field>
      <Field label="Camera">
        <CameraControls camera={shot.camera} onChange={(c) => set('Camera', (s) => void (s.camera = c), 'camera')} />
      </Field>
      <div className="grid2">
        <AssetSlot label="Storyboard frame (optional)" allow={['image']} assetId={shot.frameAssetId} onChange={(id) => set('Set frame', (s) => void (s.frameAssetId = id), 'frame')} />
        <AssetSlot label="Shot clip" allow={['video']} assetId={shot.videoAssetId} onChange={(id) => set('Set clip', (s) => {
          s.videoAssetId = id;
          s.status = id ? 'done' : 'draft';
        }, 'clip')} />
      </div>
      {shot.videoAssetId && (
        <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set('Clear clip', (s) => {
          s.videoAssetId = null;
          s.status = 'draft';
        }, 'clip')}>
          <X size={12} /> Unlink clip
        </button>
      )}
    </Modal>
  );
}
