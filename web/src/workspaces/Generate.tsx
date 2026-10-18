import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { BookmarkPlus, Clapperboard, ImagePlay, Library, ListPlus, Loader2, RefreshCw, Repeat2, Square, Wand2, X, Sparkles, Columns2 } from 'lucide-react';
import type { GenerationParams, JobRecord, JobTask, ModelInfo } from '../../../shared/api';
import type { AspectRatio, Camera } from '../../../shared/project';
import { LIGHTING_STYLES, SAMPLE_PROMPTS, VISUAL_STYLES, composePrompt } from '../../../shared/prompt';
import { api, mediaUrl, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { addAssetsToTimeline, ensureProject, errMsg, submitJob } from '../lib/actions';
import { AssetSlot, CameraControls, DEFAULT_CAMERA, ModelPicker, modelsFor } from '../components/pickers';
import { EngineInline } from '../components/LocalEngine';
import { ASSET_DRAG_TYPE } from '../components/Timeline';
import { Check, Empty, Field, Notice, Progress, ProvenanceBadge, Select, Seg, Slider, StatusBadge, formatDuration, timeAgo } from '../components/ui';

export type GenMode = 'generate' | 'image-to-video' | 'video-to-video';
const TASK: Record<GenMode, JobTask> = { generate: 'text-to-video', 'image-to-video': 'image-to-video', 'video-to-video': 'video-to-video' };
const TITLE: Record<GenMode, string> = { generate: 'Text to video', 'image-to-video': 'Image to video', 'video-to-video': 'Video to video' };

interface GenForm {
  providerId: string;
  modelId: string;
  prompt: string;
  negativePrompt: string;
  duration: number;
  aspectRatio: AspectRatio;
  resolution: string;
  fps: number;
  style: string;
  lighting: string;
  complexity: 'simple' | 'moderate' | 'complex';
  motionIntensity: number;
  camera: Camera;
  seed: number | null;
  variations: number;
  startImageAssetId: string | null;
  endImageAssetId: string | null;
  subjectMotion: string;
  environmentMotion: string;
  preserveReference: boolean;
  sourceVideoAssetId: string | null;
  strength: number;
  referenceAssetIds: string[];
  characterIds: string[];
  environmentId: string | null;
  selectedJobId: string | null;
  quality: 'fast' | 'standard' | 'high';
}

const blank = (): GenForm => ({
  providerId: '',
  modelId: '',
  prompt: '',
  negativePrompt: '',
  duration: 5,
  aspectRatio: '16:9',
  resolution: '720p',
  fps: 24,
  style: 'Cinematic realism',
  lighting: 'None',
  complexity: 'moderate',
  motionIntensity: 0.5,
  camera: DEFAULT_CAMERA,
  seed: null,
  variations: 1,
  startImageAssetId: null,
  endImageAssetId: null,
  subjectMotion: '',
  environmentMotion: '',
  preserveReference: true,
  sourceVideoAssetId: null,
  strength: 0.5,
  referenceAssetIds: [],
  characterIds: [],
  environmentId: null,
  selectedJobId: null,
  quality: 'standard',
});

interface GenStore {
  forms: Record<GenMode, GenForm>;
  set: (mode: GenMode, patch: Partial<GenForm>) => void;
}

export const useGen = create<GenStore>((set) => ({
  forms: { generate: blank(), 'image-to-video': blank(), 'video-to-video': blank() },
  set: (mode, patch) => set((s) => ({ forms: { ...s.forms, [mode]: { ...s.forms[mode], ...patch } } })),
}));

/** Modes whose model was chosen automatically (not by the user), so a better choice may replace it later. */
const autoPicked = new Set<GenMode>();

function useForm(mode: GenMode) {
  const form = useGen((s) => s.forms[mode]);
  const set = useGen((s) => s.set);
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  // Pick a default model: settings default if it supports the task, else a ready local model, else the recommended one.
  useEffect(() => {
    if (!providers.length) return;
    const all = modelsFor(providers, TASK[mode]);
    const ready = all.filter((o) => o.model.available !== false && o.provider.configured && o.provider.enabled);
    if (form.providerId) {
      // Keep the current choice unless it was automatic and became usable models appeared since
      // (e.g. the engine check finished after the page loaded).
      const current = ready.some((o) => o.provider.id === form.providerId && o.model.id === form.modelId);
      if (!autoPicked.has(mode) || current || !ready.length) return;
    }
    const local = all.filter((o) => o.provider.id === 'local-ai');
    const pref = ready.find((o) => o.provider.id === settings?.defaults.videoProviderId && o.model.id === settings?.defaults.videoModelId);
    // Prefer a ready local model; otherwise select the recommended local model so its setup card shows.
    const choice =
      pref ??
      ready.find((o) => o.provider.id === 'local-ai' && o.model.local?.recommended) ??
      ready.find((o) => o.provider.id === 'local-ai') ??
      ready[0] ??
      local.find((o) => o.model.local?.recommended) ??
      local[0];
    if (!choice || (choice.provider.id === form.providerId && choice.model.id === form.modelId)) return;
    autoPicked.add(mode);
    set(mode, { providerId: choice.provider.id, modelId: choice.model.id, ...(form.providerId ? {} : { aspectRatio: settings?.defaults.aspectRatio ?? '16:9' }) });
  }, [providers, form.providerId, form.modelId, mode, set, settings]);
  const model: ModelInfo | undefined = providers.find((p) => p.id === form.providerId)?.models.find((m) => m.id === form.modelId);
  const provider = providers.find((p) => p.id === form.providerId);
  return {
    form,
    patch: (p: Partial<GenForm>) => {
      if ('modelId' in p || 'providerId' in p) autoPicked.delete(mode);
      set(mode, p);
    },
    model,
    provider,
  };
}

function buildParams(mode: GenMode, form: GenForm, model: ModelInfo | undefined): GenerationParams {
  const caps = model?.capabilities ?? {};
  const p: GenerationParams = {
    prompt: form.prompt.trim(),
    negativePrompt: caps.negativePrompt ? form.negativePrompt.trim() || undefined : undefined,
    duration: form.duration,
    aspectRatio: form.aspectRatio,
    resolution: form.resolution,
    fps: caps.fps ? form.fps : undefined,
    seed: caps.seed ? form.seed : null,
    variations: form.variations,
    quality: caps.qualityPresets ? form.quality : undefined,
    style: form.style,
    lighting: form.lighting,
    complexity: form.complexity,
    motionIntensity: form.motionIntensity,
    camera: form.camera,
    characterIds: form.characterIds,
    environmentId: form.environmentId,
    referenceAssetIds: form.referenceAssetIds,
  };
  if (mode === 'image-to-video') {
    Object.assign(p, { startImageAssetId: form.startImageAssetId, endImageAssetId: caps.endFrame ? form.endImageAssetId : null, subjectMotion: form.subjectMotion, environmentMotion: form.environmentMotion, preserveReference: form.preserveReference });
  }
  if (mode === 'video-to-video') Object.assign(p, { sourceVideoAssetId: form.sourceVideoAssetId, strength: form.strength });
  return p;
}

/* ===================================================================== center */

export function GenerateCenter({ mode }: { mode: GenMode }) {
  const { form, patch, model, provider } = useForm(mode);
  const jobs = useApp((s) => s.jobs);
  const assets = useApp((s) => s.assets);
  const project = useProject((s) => s.project);
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [compare, setCompare] = useState(true);
  const task = TASK[mode];
  const myJobs = useMemo(() => jobs.filter((j) => j.task === task && (!project || j.projectId === project.id || !j.projectId)).slice(0, 40), [jobs, task, project]);
  const selected = myJobs.find((j) => j.id === form.selectedJobId) ?? myJobs[0];
  const output = selected?.outputAssetIds[0] ? assets.find((a) => a.id === selected.outputAssetIds[0]) : undefined;
  const llmProviders = providers.filter((p) => p.categories.includes('llm') && p.configured && p.enabled);
  const [llm, setLlm] = useState<string>('');
  useEffect(() => {
    if (llm) return;
    const def = settings?.defaults.llmProviderId;
    setLlm(llmProviders.find((p) => p.id === def)?.id ?? llmProviders.find((p) => p.isAI)?.id ?? 'offline-templates');
  }, [llmProviders, settings, llm]);

  const missing: string[] = [];
  if (!model) missing.push('choose a model');
  else if (model.available === false) missing.push(model.local ? 'finish the local AI setup' : 'configure this model');
  if (mode !== 'image-to-video' && !form.prompt.trim()) missing.push('write a prompt');
  if (mode === 'image-to-video' && !form.startImageAssetId) missing.push('choose a start image');
  if (mode === 'video-to-video' && !form.sourceVideoAssetId) missing.push('choose source footage');

  const generate = async () => {
    if (!model || !provider) return;
    setBusy(true);
    const p = await ensureProject();
    const created = await submitJob({ task, providerId: provider.id, modelId: model.id, params: buildParams(mode, form, model) as unknown as Record<string, unknown>, projectId: p?.id ?? null });
    setBusy(false);
    if (created?.length) patch({ selectedJobId: created[0].id });
  };

  const enhance = async () => {
    if (!form.prompt.trim()) return;
    setEnhancing(true);
    try {
      const r = await api.ai<{ prompt: string; negativePrompt: string; notes: string }>('enhance-prompt', llm, { prompt: form.prompt, style: form.style, kind: task });
      patch({ prompt: r.result.prompt.slice(0, 4000), negativePrompt: model?.capabilities.negativePrompt && !form.negativePrompt ? r.result.negativePrompt : form.negativePrompt });
      useApp.getState().toast(r.isAI ? 'ok' : 'info', r.isAI ? `Prompt enhanced by ${r.providerId}. ${r.result.notes}` : r.result.notes);
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setEnhancing(false);
    }
  };

  const savePrompt = async () => {
    if (!form.prompt.trim()) return;
    try {
      await api.savePrompt({ title: form.prompt.slice(0, 60), prompt: form.prompt, negative: form.negativePrompt, tags: [task] });
      useApp.getState().toast('ok', 'Prompt saved to the library');
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    }
  };

  const preview = model ? composePrompt({ prompt: form.prompt || '…', style: form.style, lighting: form.lighting, camera: model.capabilities.camera === 'none' ? undefined : form.camera, motionIntensity: form.motionIntensity, complexity: form.complexity, subjectMotion: mode === 'image-to-video' ? form.subjectMotion : undefined, environmentMotion: mode === 'image-to-video' ? form.environmentMotion : undefined, preserveReference: mode === 'image-to-video' && form.preserveReference }) : '';
  const source = mode === 'image-to-video' ? assets.find((a) => a.id === (selected?.params as GenerationParams | undefined)?.startImageAssetId) : mode === 'video-to-video' ? assets.find((a) => a.id === (selected?.params as GenerationParams | undefined)?.sourceVideoAssetId) : undefined;

  return (
    <div className="gen-layout">
      <div className="panel-header">
        {mode === 'generate' ? <Clapperboard size={15} /> : mode === 'image-to-video' ? <ImagePlay size={15} /> : <Repeat2 size={15} />}
        {TITLE[mode]}
        <div className="grow" />
        {provider?.id === 'local-ai' && <span className="badge accent">Runs on this computer · no API</span>}
        {(source || mode !== 'generate') && output && (
          <button className={`btn sm${compare ? ' active' : ''}`} onClick={() => setCompare(!compare)}>
            <Columns2 size={13} /> Compare
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)', padding: 12, overflow: 'auto' }}>
        {!selected ? (
          <Empty icon={<Sparkles size={32} />} title={`Describe the ${mode === 'image-to-video' ? 'motion' : mode === 'video-to-video' ? 'transformation' : 'video'} you want`}>
            <div className="col" style={{ marginTop: 8 }}>
              {SAMPLE_PROMPTS.filter((s) => (mode === 'image-to-video' ? s.kind === 'image-to-video' : s.kind === 'text-to-video')).map((s) => (
                <button key={s.title} className="btn sm ghost" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', height: 'auto', padding: 6, textAlign: 'left' }} onClick={() => patch({ prompt: s.prompt })}>
                  <strong style={{ marginRight: 6 }}>{s.title}:</strong> <span className="muted">{s.prompt.slice(0, 110)}…</span>
                </button>
              ))}
            </div>
          </Empty>
        ) : selected.status === 'succeeded' && output ? (
          <div className="col" style={{ width: '100%', maxWidth: 1100, alignItems: 'stretch', flex: 1, minHeight: 0 }}>
            {compare && source ? (
              <div className="compare" style={{ flex: 1, minHeight: 120 }}>
                <div>
                  {source.type === 'image' ? <img src={mediaUrl(source)} alt="Source" /> : <video src={mediaUrl(source)} controls muted loop />}
                  <span className="badge tag">Source</span>
                </div>
                <div>
                  <video src={mediaUrl(output)} controls autoPlay loop />
                  <span className="badge accent tag">Result</span>
                </div>
              </div>
            ) : (
              <video key={output.id} src={mediaUrl(output)} poster={thumbUrl(output) ?? undefined} controls autoPlay muted loop style={{ width: '100%', flex: 1, minHeight: 120, objectFit: 'contain', background: '#000', borderRadius: 8 }} />
            )}
            <div className="row wrap">
              <ProvenanceBadge ai={output.provenance.aiGenerated} generator={output.provenance.generator} />
              <span className="small muted">
                {output.width}×{output.height} · {formatDuration(output.duration)} · {selected.providerId}/{selected.modelId} · {timeAgo(selected.finishedAt)}
              </span>
              <div className="grow" />
              <button className="btn sm" draggable onDragStart={(e) => e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(output))} onClick={() => addAssetsToTimeline([output])}>
                <ListPlus size={13} /> Add to timeline
              </button>
              <button className="btn sm" onClick={() => useApp.getState().setWorkspace('assets')}>
                <Library size={13} /> Library
              </button>
              <button className="btn sm" onClick={() => void api.retryJob(selected.id).then((js) => { js.forEach(useApp.getState().upsertJob); patch({ selectedJobId: js[0]?.id ?? null }); }).catch((e) => useApp.getState().toast('err', errMsg(e)))}>
                <RefreshCw size={13} /> Regenerate
              </button>
            </div>
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Prompt sent to the model</summary>
              <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{(selected.params as GenerationParams).compiledPrompt ?? (selected.params as GenerationParams).prompt}</p>
            </details>
          </div>
        ) : (
          <JobStatusCard job={selected} />
        )}
      </div>
      <div className="results-strip" aria-label="Recent results">
        {myJobs.length === 0 && <span className="small dim" style={{ alignSelf: 'center' }}>Results appear here.</span>}
        {myJobs.map((j) => {
          const a = assets.find((x) => x.id === j.outputAssetIds[0]);
          return (
            <button
              key={j.id}
              className={`result-tile${selected?.id === j.id ? ' selected' : ''}`}
              style={a && thumbUrl(a) ? { backgroundImage: `url(${thumbUrl(a)})` } : undefined}
              onClick={() => patch({ selectedJobId: j.id })}
              draggable={Boolean(a)}
              onDragStart={(e) => a && e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(a))}
              title={(j.params as GenerationParams).prompt}
            >
              {!a && j.status !== 'failed' && j.status !== 'canceled' && <Loader2 size={16} className="spin" style={{ color: 'var(--lavender)' }} />}
              <span className="state">
                {j.status === 'succeeded' ? (a?.provenance.aiGenerated ? 'AI' : 'Not AI') : j.status}
                {j.progress !== null && j.status === 'running' ? ` ${Math.round(j.progress * 100)}%` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <div className="prompt-box">
        <div className="row">
          <label htmlFor="gen-prompt" className="small muted grow">
            {mode === 'image-to-video' ? 'Motion prompt' : mode === 'video-to-video' ? 'Transformation prompt' : 'Prompt'}
          </label>
          <span className="tiny dim">{form.prompt.length}/4000</span>
        </div>
        <textarea
          id="gen-prompt"
          className="textarea"
          placeholder={mode === 'image-to-video' ? 'Describe how the image should move: subject motion, environment, camera…' : mode === 'video-to-video' ? 'Describe the new style or environment, e.g. “hand-painted watercolor animation”…' : 'Describe the shot: subject, action, setting, lighting, mood…'}
          value={form.prompt}
          maxLength={4000}
          onChange={(e) => patch({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !missing.length) void generate();
          }}
        />
        {model?.capabilities.negativePrompt ? (
          <input className="input" placeholder="Negative prompt (what to avoid)" value={form.negativePrompt} maxLength={4000} onChange={(e) => patch({ negativePrompt: e.target.value })} />
        ) : (
          model && <div className="tiny dim">{model.name} does not accept a negative prompt.</div>
        )}
        {model && form.prompt && <div className="tiny dim ellipsis" title={preview}>Sent as: {preview}</div>}
        <div className="row wrap">
          <select className="select" style={{ width: 'auto', minHeight: 28 }} aria-label="Prompt assistant" value={llm} onChange={(e) => setLlm(e.target.value)}>
            {llmProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.isAI ? p.name : 'Offline templates (not AI)'}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!form.prompt.trim() || enhancing} onClick={() => void enhance()} title="Rewrite the prompt to be more specific and cinematic">
            {enhancing ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Enhance prompt
          </button>
          <button className="btn sm ghost" disabled={!form.prompt.trim()} onClick={() => void savePrompt()}>
            <BookmarkPlus size={13} /> Save prompt
          </button>
          <div className="grow" />
          {missing.length > 0 && <span className="tiny muted">To generate: {missing.join(', ')}</span>}
          {selected && ['queued', 'submitting', 'running', 'downloading'].includes(selected.status) && (
            <button className="btn danger" onClick={() => void api.cancelJob(selected.id).then(useApp.getState().upsertJob).catch((e) => useApp.getState().toast('err', errMsg(e)))}>
              <Square size={12} /> Cancel
            </button>
          )}
          <button className="btn primary lg" disabled={missing.length > 0 || busy} onClick={() => void generate()} title="Ctrl+Enter">
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} Generate{form.variations > 1 ? ` ×${form.variations}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export function JobStatusCard({ job }: { job: JobRecord }) {
  const running = ['queued', 'submitting', 'running', 'downloading'].includes(job.status);
  return (
    <div className="card pad col" style={{ width: 'min(520px, 100%)' }}>
      <div className="row between">
        <strong style={{ color: 'var(--text-0)' }}>{job.providerId} · {job.modelId}</strong>
        <StatusBadge status={job.status} />
      </div>
      <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{(job.params as GenerationParams).prompt?.slice(0, 300)}</div>
      {running && (
        <>
          <Progress value={job.progress} />
          <div className="row between tiny muted">
            <span>{job.message ?? job.status}</span>
            <span>started {timeAgo(job.startedAt ?? job.createdAt)}</span>
          </div>
          <div className="tiny dim">Generation time depends on the provider; you can keep working — results are saved to the library automatically.</div>
        </>
      )}
      {job.status === 'failed' && <Notice kind="err">{job.error}</Notice>}
      {job.status === 'canceled' && <Notice kind="warn">{job.message ?? 'Canceled'}</Notice>}
      {(job.status === 'failed' || job.status === 'canceled') && (
        <div className="row">
          <button className="btn sm primary" onClick={() => void api.retryJob(job.id).then((js) => js.forEach(useApp.getState().upsertJob)).catch((e) => useApp.getState().toast('err', errMsg(e)))}>
            <RefreshCw size={13} /> Retry with same settings
          </button>
        </div>
      )}
      {running && (
        <button className="btn sm danger" style={{ alignSelf: 'flex-start' }} onClick={() => void api.cancelJob(job.id).then(useApp.getState().upsertJob)}>
          <X size={13} /> Cancel generation
        </button>
      )}
    </div>
  );
}

/* ===================================================================== params */

export function GenerateParams({ mode }: { mode: GenMode }) {
  const { form, patch, model, provider } = useForm(mode);
  const project = useProject((s) => s.project);
  const caps = model?.capabilities ?? {};
  const durations = caps.durations;
  const durOptions = Array.isArray(durations) ? durations : durations ? Array.from({ length: Math.floor((durations.max - durations.min) / (durations.step ?? 1)) + 1 }, (_, i) => durations.min + i * (durations.step ?? 1)) : [5];
  const aspects: AspectRatio[] = caps.aspectRatios?.length ? caps.aspectRatios : ['16:9', '9:16', '1:1'];
  useEffect(() => {
    // Snap form values onto what the selected model supports.
    if (!model) return;
    const p: Partial<GenForm> = {};
    if (!durOptions.includes(form.duration)) p.duration = durOptions.reduce((b, v) => (Math.abs(v - form.duration) < Math.abs(b - form.duration) ? v : b), durOptions[0]);
    if (caps.aspectRatios?.length && !caps.aspectRatios.includes(form.aspectRatio)) p.aspectRatio = caps.aspectRatios[0];
    if (caps.resolutions?.length && !caps.resolutions.includes(form.resolution)) p.resolution = caps.resolutions[caps.resolutions.length - 1];
    if (caps.fps?.length && !caps.fps.includes(form.fps)) p.fps = caps.fps[0];
    if (!caps.maxVariations && form.variations > 4) p.variations = 1;
    if (Object.keys(p).length) patch(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id]);
  const na = (supported: boolean | undefined) => (supported ? undefined : `Not supported by ${model?.name ?? 'this model'}`);

  return (
    <div className="panel">
      <div className="panel-header">Generation settings</div>
      <div className="panel-body">
        <div className="section">
          <h4>Model</h4>
          {(!model || model.providerId === 'local-ai') && <EngineInline modelId={model?.id} />}
          <ModelPicker task={TASK[mode]} providerId={form.providerId} modelId={form.modelId} onChange={(providerId, modelId) => patch({ providerId, modelId })} />
          {provider && provider.limitations.length > 0 && (
            <details>
              <summary className="tiny muted" style={{ cursor: 'pointer' }}>Limitations & usage</summary>
              <ul className="tiny muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {provider.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {mode === 'image-to-video' && (
          <div className="section">
            <h4>Input image</h4>
            <AssetSlot label="Start frame" allow={['image']} assetId={form.startImageAssetId} onChange={(id) => patch({ startImageAssetId: id })} emptyLabel="Drop a PNG/JPG/WebP or click to choose" />
            <div title={na(caps.endFrame)} style={{ opacity: caps.endFrame ? 1 : 0.5, pointerEvents: caps.endFrame ? 'auto' : 'none' }}>
              <AssetSlot label={`End frame${caps.endFrame ? ' (optional)' : ' — not supported'}`} allow={['image']} assetId={form.endImageAssetId} onChange={(id) => patch({ endImageAssetId: id })} />
            </div>
            <Field label="Subject movement">
              <input className="input" placeholder="e.g. turns slowly toward the camera" value={form.subjectMotion} onChange={(e) => patch({ subjectMotion: e.target.value })} />
            </Field>
            <Field label="Environmental animation">
              <input className="input" placeholder="e.g. hair and cloak moving in the wind" value={form.environmentMotion} onChange={(e) => patch({ environmentMotion: e.target.value })} />
            </Field>
            <Check checked={form.preserveReference} onChange={(v) => patch({ preserveReference: v })} label="Preserve face, costume, colours and proportions" />
          </div>
        )}
        {mode === 'video-to-video' && (
          <div className="section">
            <h4>Source footage</h4>
            <AssetSlot label="Source video" allow={['video']} assetId={form.sourceVideoAssetId} onChange={(id) => patch({ sourceVideoAssetId: id })} />
            <Field label="Transformation strength" hint={na(caps.strength)}>
              <Slider label="Strength" value={form.strength} min={0} max={1} disabled={!caps.strength} onChange={(v) => patch({ strength: v })} />
            </Field>
            <div className="tiny muted">The local model restyles the first ~2 seconds of the source (16 frames at 8 fps); audio is not carried over. Lower strength keeps more of the original.</div>
          </div>
        )}
        <div className="section">
          <h4>Format</h4>
          {caps.qualityPresets && (
            <Field label="Quality" hint="More diffusion steps = better detail, proportionally slower.">
              <Seg value={form.quality} onChange={(v) => patch({ quality: v })} options={[{ value: 'fast', label: 'Fast' }, { value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]} />
            </Field>
          )}
          <Field label="Duration">
            <Seg value={form.duration} onChange={(v) => patch({ duration: v })} options={durOptions.slice(0, 12).map((d) => ({ value: d, label: `${d}s` }))} />
          </Field>
          <Field label="Aspect ratio">
            <Seg value={form.aspectRatio} onChange={(v) => patch({ aspectRatio: v })} options={(['16:9', '9:16', '1:1', '4:3', '21:9'] as AspectRatio[]).map((a) => ({ value: a, label: a, disabled: !aspects.includes(a), title: aspects.includes(a) ? undefined : na(false) }))} />
          </Field>
          <div className="grid2">
            <Field label="Resolution">
              <Select value={form.resolution} onChange={(v) => patch({ resolution: v })} disabled={!caps.resolutions?.length} options={(caps.resolutions?.length ? caps.resolutions : ['Model default']).map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="Frame rate" hint={na(Boolean(caps.fps?.length))}>
              <Select value={String(form.fps)} disabled={!caps.fps?.length} onChange={(v) => patch({ fps: Number(v) })} options={(caps.fps?.length ? caps.fps : [form.fps]).map((f) => ({ value: String(f), label: `${f} fps` }))} />
            </Field>
          </div>
        </div>
        <div className="section">
          <h4>Look</h4>
          <div className="grid2">
            <Field label="Visual style">
              <Select value={form.style} onChange={(v) => patch({ style: v })} options={VISUAL_STYLES.map((s) => ({ value: s, label: s }))} />
            </Field>
            <Field label="Lighting">
              <Select value={form.lighting} onChange={(v) => patch({ lighting: v })} options={LIGHTING_STYLES.map((s) => ({ value: s, label: s }))} />
            </Field>
          </div>
          <Field label="Scene complexity">
            <Seg value={form.complexity} onChange={(v) => patch({ complexity: v })} options={[{ value: 'simple', label: 'Simple' }, { value: 'moderate', label: 'Moderate' }, { value: 'complex', label: 'Complex' }]} />
          </Field>
          <Field label="Motion intensity">
            <Slider label="Motion intensity" value={form.motionIntensity} min={0} max={1} onChange={(v) => patch({ motionIntensity: v })} />
          </Field>
        </div>
        <div className="section">
          <h4>Camera</h4>
          <CameraControls camera={form.camera} onChange={(camera) => patch({ camera })} support={caps.camera} />
        </div>
        {project && (project.characters.length > 0 || project.environments.length > 0) && (
          <div className="section">
            <h4>Characters & scene</h4>
            {project.characters.length > 0 && (
              <Field label="Characters" hint="Their stored appearance is added to the prompt. Consistency across shots is not guaranteed — review results in Character Studio.">
                <div className="row wrap" style={{ gap: 6 }}>
                  {project.characters.map((c) => (
                    <button key={c.id} className={`chip${form.characterIds.includes(c.id) ? ' on' : ''}`} onClick={() => patch({ characterIds: form.characterIds.includes(c.id) ? form.characterIds.filter((x) => x !== c.id) : [...form.characterIds, c.id] })}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {project.environments.length > 0 && (
              <Field label="Environment">
                <Select value={form.environmentId ?? ''} onChange={(v) => patch({ environmentId: v || null })} options={[{ value: '', label: 'None' }, ...project.environments.map((e) => ({ value: e.id, label: e.name }))]} />
              </Field>
            )}
          </div>
        )}
        <div className="section">
          <h4>Reference images</h4>
          {caps.maxReferenceImages ? (
            <>
              {form.referenceAssetIds.map((id, i) => (
                <AssetSlot key={id} label={`Reference ${i + 1}`} allow={['image']} assetId={id} onChange={(v) => patch({ referenceAssetIds: v ? form.referenceAssetIds.map((x, j) => (j === i ? v : x)) : form.referenceAssetIds.filter((_, j) => j !== i) })} />
              ))}
              {form.referenceAssetIds.length < caps.maxReferenceImages && (
                <AssetSlot label="Add reference" allow={['image']} assetId={null} onChange={(v) => v && patch({ referenceAssetIds: [...form.referenceAssetIds, v] })} />
              )}
            </>
          ) : (
            <div className="tiny muted">
              {model?.name ?? 'This model'} does not accept reference images. Character and environment descriptions are added to the prompt instead{mode === 'image-to-video' ? '; the start frame is the visual reference' : ''}.
            </div>
          )}
        </div>
        <div className="section">
          <h4>Advanced</h4>
          <div className="grid2">
            <Field label="Seed" hint={na(caps.seed) ?? 'Empty = random'}>
              <input className="input" type="number" disabled={!caps.seed} placeholder="random" value={form.seed ?? ''} onChange={(e) => patch({ seed: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })} />
            </Field>
            <Field label="Variations" hint="Each variation is a separate job.">
              <Select value={String(form.variations)} onChange={(v) => patch({ variations: Number(v) })} options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}
