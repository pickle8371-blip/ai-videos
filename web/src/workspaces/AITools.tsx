import { useState, type ReactNode } from 'react';
import { Wand2, Loader2, Scissors, ListOrdered, Crop, Gauge, ImageUp, ImagePlus, Film, Music, Sparkles, Eraser, LayoutGrid, Shuffle, Captions, Expand } from 'lucide-react';
import type { JobRecord } from '../../../shared/api';
import { TRANSITION_TYPES, type Transition } from '../../../shared/project';
import { setTransition, splitAt } from '../../../shared/ops';
import { clipDuration, clipEnd } from '../../../shared/timeline';
import { api, mediaUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { addAssetsToTimeline, errMsg, submitJob } from '../lib/actions';
import { AssetSlot, ModelPicker, modelsFor } from '../components/pickers';
import { Field, Notice, Select, Seg } from '../components/ui';
import { JobStatusCard } from './Generate';

function ToolCard({ icon, title, kind, children }: { icon: ReactNode; title: string; kind: 'local' | 'ai' | 'llm' | 'integration'; children: ReactNode }) {
  const badge = kind === 'local' ? <span className="badge warn">FFmpeg · not AI</span> : kind === 'ai' ? <span className="badge accent">AI provider</span> : kind === 'llm' ? <span className="badge accent">Language model / offline</span> : <span className="badge">Requires integration</span>;
  return (
    <div className="card pad col">
      <div className="row">
        <div className="ic" style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--lavender)' }}>{icon}</div>
        <h3 className="grow">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function useToolJob() {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useApp((s) => s.jobs.find((j) => j.id === jobId));
  const run = async (modelId: string, params: Record<string, unknown>) => {
    const js = await submitJob({ task: 'tool', providerId: 'local-tools', modelId, params, projectId: useProject.getState().project?.id ?? null });
    if (js) setJobId(js[0].id);
  };
  return { job, run };
}

function ToolResult({ job }: { job: JobRecord | undefined }) {
  const assets = useApp((s) => s.assets);
  if (!job) return null;
  if (job.status !== 'succeeded') return <JobStatusCard job={job} />;
  const out = assets.filter((a) => job.outputAssetIds.includes(a.id));
  return (
    <div className="col">
      {out.map((a) => (
        <div key={a.id} className="row">
          {a.type === 'video' ? <video src={mediaUrl(a)} controls style={{ width: 220, borderRadius: 6, background: '#000' }} /> : a.type === 'image' ? <img src={mediaUrl(a)} alt={a.name} style={{ width: 160, borderRadius: 6 }} /> : <audio src={mediaUrl(a)} controls />}
          <div className="col grow" style={{ gap: 4 }}>
            <span className="small">{a.name}</span>
            <span className="tiny muted">{a.width ? `${a.width}×${a.height}` : ''} saved to the library</span>
            {useProject.getState().project && (
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => addAssetsToTimeline([a])}>
                Add to timeline
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AITools() {
  const project = useProject((s) => s.project);
  const apply = useProject((s) => s.apply);
  const assets = useApp((s) => s.assets);
  const providers = useApp((s) => s.providers);
  const setWs = useApp((s) => s.setWorkspace);
  const llmProviders = providers.filter((p) => p.categories.includes('llm') && p.configured && p.enabled);
  const [llm, setLlm] = useState(llmProviders.find((p) => p.isAI)?.id ?? 'offline-templates');

  const interp = useToolJob();
  const [interpSrc, setInterpSrc] = useState<string | null>(null);
  const [interpFps, setInterpFps] = useState(60);
  const up = useToolJob();
  const [upSrc, setUpSrc] = useState<string | null>(null);
  const [upFactor, setUpFactor] = useState(2);
  const reframe = useToolJob();
  const [rfSrc, setRfSrc] = useState<string | null>(null);
  const [rfRatio, setRfRatio] = useState('9:16');
  const [rfFocus, setRfFocus] = useState(0.5);
  const enh = useToolJob();
  const [enhSrc, setEnhSrc] = useState<string | null>(null);
  const frame = useToolJob();
  const [frSrc, setFrSrc] = useState<string | null>(null);
  const [frTime, setFrTime] = useState(0);
  const scenes = useToolJob();
  const [scSrc, setScSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shotIdeas, setShotIdeas] = useState<Array<{ title: string; prompt: string }> | null>(null);
  const [shotPrompt, setShotPrompt] = useState('');
  const [transitionPlan, setTransitionPlan] = useState<Array<{ clipId: string; type: Transition['type']; duration: number; reason: string }> | null>(null);

  const sceneCuts = (scenes.job?.result as { cuts?: number[]; sourceAssetId?: string } | null) ?? null;
  const applyCuts = () => {
    if (!project || !sceneCuts?.cuts?.length) return;
    const src = sceneCuts.sourceAssetId;
    let n = 0;
    apply('Split at detected scenes', (d) => {
      for (const t of d.timeline.tracks)
        for (const c of [...t.clips])
          if (c.kind === 'media' && c.assetId === src)
            for (const cut of sceneCuts.cuts!) {
              const at = c.start + (cut - c.in) / c.speed;
              if (at > c.start && at < clipEnd(c)) n += splitAt(d, at, [c.id]).length;
            }
    });
    useApp.getState().toast(n ? 'ok' : 'info', n ? `Split timeline clips at ${n} detected cut(s)` : 'Place the analysed video on the timeline first');
  };

  const suggestTransitions = async () => {
    if (!project) return;
    const v1 = project.timeline.tracks.find((t) => t.kind === 'video' && t.clips.length > 1);
    if (!v1) return useApp.getState().toast('info', 'Need at least two clips on a video track');
    const clips = [...v1.clips].sort((a, b) => a.start - b.start).map((c) => ({ id: c.id, label: c.kind === 'media' ? c.label ?? 'clip' : c.text, duration: clipDuration(c), description: c.kind === 'media' ? assets.find((a) => a.id === c.assetId)?.provenance.prompt ?? undefined : undefined }));
    setBusy('transitions');
    try {
      const r = await api.ai<{ transitions: Array<{ clipId: string; type: Transition['type']; duration: number; reason: string }> }>('suggest-transitions', llm, { clips });
      setTransitionPlan(r.result.transitions.filter((t) => TRANSITION_TYPES.includes(t.type)));
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setBusy(null);
    }
  };

  const organize = () => {
    if (!project) return;
    apply('Organize clips', (d) => {
      for (const t of d.timeline.tracks) {
        if (t.kind !== 'video' && t.kind !== 'audio') continue;
        const sorted = [...t.clips].sort((a, b) => a.start - b.start);
        let cursor = 0;
        for (const c of sorted) {
          const overlapAllowed = c.kind === 'media' && c.transitionIn.type === 'dissolve' ? Math.min(c.transitionIn.duration, clipDuration(c)) : 0;
          c.start = Math.max(0, cursor - overlapAllowed);
          cursor = c.start + clipDuration(c);
        }
        t.clips = sorted;
      }
    });
    useApp.getState().toast('ok', 'Closed gaps and ordered clips on every track (dissolves keep their overlap)');
  };

  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 1300 }}>
        <div className="page-header">
          <div>
            <h1>AI Tools</h1>
            <p>Each tool states how it runs: a connected AI model, a language model (or the labelled offline template engine), or conventional FFmpeg processing.</p>
          </div>
          <Field label="Language model for text tools">
            <select className="select" value={llm} onChange={(e) => setLlm(e.target.value)}>
              {llmProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.isAI ? p.name : 'Offline templates (not AI)'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="media-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          <ToolCard icon={<Wand2 size={15} />} title="Prompt improvement" kind="llm">
            <div className="small muted">Rewrites prompts with concrete subject, lighting, lens and camera language. Available inside every generator (“Enhance prompt”).</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setWs('generate')}>Open generator</button>
          </ToolCard>
          <ToolCard icon={<LayoutGrid size={15} />} title="Prompt-to-storyboard & scene continuation" kind="llm">
            <div className="small muted">Turns an idea into a shot list with camera, lighting and duration, and proposes follow-up shots.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project} onClick={() => setWs('storyboard')}>Open storyboard</button>
          </ToolCard>
          <ToolCard icon={<Sparkles size={15} />} title="Automatic shot suggestions" kind="llm">
            <textarea className="textarea" rows={2} placeholder="Describe a moment…" value={shotPrompt} onChange={(e) => setShotPrompt(e.target.value)} />
            <button
              className="btn sm"
              style={{ alignSelf: 'flex-start' }}
              disabled={!shotPrompt.trim() || busy === 'shots'}
              onClick={async () => {
                setBusy('shots');
                try {
                  const r = await api.ai<{ suggestions: Array<{ title: string; prompt: string }> }>('suggest-shots', llm, { prompt: shotPrompt });
                  setShotIdeas(r.result.suggestions);
                } catch (err) {
                  useApp.getState().toast('err', errMsg(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'shots' ? <Loader2 size={13} className="spin" /> : null} Suggest coverage
            </button>
            {shotIdeas?.map((s) => (
              <div key={s.title} className="small">
                <strong>{s.title}:</strong> <span className="muted">{s.prompt}</span>
              </div>
            ))}
          </ToolCard>
          <ToolCard icon={<Shuffle size={15} />} title="Suggested transitions" kind="llm">
            <div className="small muted">Proposes a transition into each clip on the first multi-clip video track. Review before applying.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project || busy === 'transitions'} onClick={() => void suggestTransitions()}>
              {busy === 'transitions' ? <Loader2 size={13} className="spin" /> : null} Suggest transitions
            </button>
            {transitionPlan && (
              <>
                {transitionPlan.map((t) => (
                  <div key={t.clipId} className="tiny">
                    <span className="badge">{t.type}{t.duration ? ` ${t.duration}s` : ''}</span> <span className="muted">{t.reason}</span>
                  </div>
                ))}
                <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} onClick={() => { apply('Apply suggested transitions', (d) => transitionPlan.forEach((t) => setTransition(d, t.clipId, { type: t.type, duration: t.duration }))); setTransitionPlan(null); useApp.getState().toast('ok', 'Transitions applied'); }}>
                  Apply all
                </button>
              </>
            )}
          </ToolCard>
          <ToolCard icon={<ListOrdered size={15} />} title="Automatic clip organisation" kind="local">
            <div className="small muted">Closes gaps and orders clips on each track; combine with scene detection to split long takes.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project} onClick={organize}>Organise timeline</button>
          </ToolCard>
          <ToolCard icon={<Scissors size={15} />} title="Scene cut detection" kind="local">
            <AssetSlot label="Video" allow={['video']} assetId={scSrc} onChange={setScSrc} />
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!scSrc} onClick={() => void scenes.run('scene-detect', { sourceAssetId: scSrc })}>Detect cuts</button>
            {scenes.job && scenes.job.status !== 'succeeded' && <JobStatusCard job={scenes.job} />}
            {sceneCuts?.cuts && (
              <div className="col">
                <div className="small">{sceneCuts.cuts.length} cut(s): <span className="mono">{sceneCuts.cuts.map((c) => c.toFixed(2)).join(', ') || 'none'}</span></div>
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project || !sceneCuts.cuts.length} onClick={applyCuts}>Split timeline clips at cuts</button>
              </div>
            )}
          </ToolCard>
          <ToolCard icon={<Gauge size={15} />} title="Frame interpolation" kind="local">
            <AssetSlot label="Video" allow={['video']} assetId={interpSrc} onChange={setInterpSrc} />
            <Field label="Target frame rate">
              <Seg value={interpFps} onChange={setInterpFps} options={[30, 48, 60, 120].map((v) => ({ value: v, label: `${v}` }))} />
            </Field>
            <div className="tiny muted">Motion-compensated interpolation (FFmpeg minterpolate). Slower than real time; quality varies with motion. For AI interpolation, register a model as a custom provider.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!interpSrc} onClick={() => void interp.run('interpolate', { sourceAssetId: interpSrc, targetFps: interpFps })}>Interpolate</button>
            <ToolResult job={interp.job} />
          </ToolCard>
          <ToolCard icon={<Expand size={15} />} title="Upscaling" kind="local">
            <AssetSlot label="Video or image" allow={['video', 'image']} assetId={upSrc} onChange={setUpSrc} />
            <Field label="Scale factor">
              <Seg value={upFactor} onChange={setUpFactor} options={[1.5, 2, 3, 4].map((v) => ({ value: v, label: `${v}×` }))} />
            </Field>
            <div className="tiny muted">Lanczos resampling with sharpening. It does not add real detail; AI super-resolution requires a connected model (e.g. a Real-ESRGAN model on Replicate as a custom model).</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!upSrc} onClick={() => void up.run('upscale', { sourceAssetId: upSrc, factor: upFactor })}>Upscale</button>
            <ToolResult job={up.job} />
          </ToolCard>
          <ToolCard icon={<Crop size={15} />} title="Aspect-ratio reframing" kind="local">
            <AssetSlot label="Video or image" allow={['video', 'image']} assetId={rfSrc} onChange={setRfSrc} />
            <div className="grid2">
              <Field label="Target ratio">
                <Select value={rfRatio} onChange={setRfRatio} options={['9:16', '1:1', '4:5', '16:9', '21:9'].map((v) => ({ value: v, label: v }))} />
              </Field>
              <Field label={`Horizontal focus (${Math.round(rfFocus * 100)}%)`}>
                <input type="range" min={0} max={1} step={0.01} value={rfFocus} onChange={(e) => setRfFocus(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
              </Field>
            </div>
            <div className="tiny muted">Static crop around the chosen focus point (no subject tracking).</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!rfSrc} onClick={() => void reframe.run('reframe', { sourceAssetId: rfSrc, aspectRatio: rfRatio, focusX: rfFocus })}>Reframe</button>
            <ToolResult job={reframe.job} />
          </ToolCard>
          <ToolCard icon={<ImageUp size={15} />} title="Image enhancement" kind="local">
            <AssetSlot label="Image" allow={['image']} assetId={enhSrc} onChange={setEnhSrc} />
            <div className="tiny muted">Denoise, sharpen and gentle tone adjustment.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!enhSrc} onClick={() => void enh.run('enhance-image', { sourceAssetId: enhSrc })}>Enhance</button>
            <ToolResult job={enh.job} />
          </ToolCard>
          <ToolCard icon={<ImagePlus size={15} />} title="Extract frame (for image-to-video or references)" kind="local">
            <AssetSlot label="Video" allow={['video']} assetId={frSrc} onChange={setFrSrc} />
            <Field label="Time (s)">
              <input className="input" type="number" min={0} step={0.1} value={frTime} onChange={(e) => setFrTime(Math.max(0, Number(e.target.value)))} />
            </Field>
            <div className="tiny muted">Use the last frame of a clip as the start image of the next shot to extend a scene.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!frSrc} onClick={() => void frame.run('extract-frame', { sourceAssetId: frSrc, time: frTime })}>Extract</button>
            <ToolResult job={frame.job} />
          </ToolCard>
          <ToolCard icon={<Captions size={15} />} title="Transcription & subtitle generation" kind="ai">
            <div className="small muted">Speech-to-text with a connected model (OpenAI Whisper), mapped onto timeline clips as subtitle cues.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project} onClick={() => setWs('audio')}>Open Audio Studio</button>
          </ToolCard>
          <ToolCard icon={<Film size={15} />} title="Scene extension" kind="ai">
            <div className="small muted">Extract the last frame of a clip, then run image-to-video with a continuation prompt. Works with any connected image-to-video model.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setWs('image-to-video')}>Open image to video</button>
          </ToolCard>
          <ToolCard icon={<Eraser size={15} />} title="Background & object removal, AI upscaling, AI interpolation" kind="integration">
            <Notice>
              These require a specialised model. Register one as a <strong>custom model</strong> under Settings → Cloud providers → Replicate / fal with an input template (for example <span className="mono">{'{"image": "{{image}}"}'}</span> or <span className="mono">{'{"video": "{{video}}"}'}</span>) and task “tool”. Video inputs need <span className="mono">VOIDCRAFT_PUBLIC_URL</span>. See docs/PROVIDERS.md.
            </Notice>
            <CustomToolRunner />
          </ToolCard>
          <ToolCard icon={<Music size={15} />} title="Voice generation" kind="ai">
            <div className="small muted">Text-to-speech with OpenAI or ElevenLabs, placed directly on the dialogue track.</div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!project} onClick={() => setWs('audio')}>Open Audio Studio</button>
          </ToolCard>
        </div>
      </div>
    </div>
  );
}

/** Runs a user-registered custom model (task "tool") on Replicate or fal. */
function CustomToolRunner() {
  const providers = useApp((s) => s.providers);
  const setWs = useApp((s) => s.setWorkspace);
  const options = modelsFor(providers, 'tool').filter((o) => o.provider.id !== 'local-tools');
  const [model, setModel] = useState({ providerId: '', modelId: '' });
  const [src, setSrc] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useApp((s) => s.jobs.find((j) => j.id === jobId));
  if (!options.length)
    return (
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setWs('settings')}>
        Add a custom model
      </button>
    );
  return (
    <div className="col">
      <ModelPicker task="tool" providerId={model.providerId} modelId={model.modelId} onChange={(providerId, modelId) => setModel({ providerId, modelId })} />
      <AssetSlot label="Input image or video" allow={['image', 'video']} assetId={src} onChange={setSrc} />
      <input className="input" placeholder="Optional prompt ({{prompt}})" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <button
        className="btn sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={!model.providerId || !src}
        onClick={async () => {
          const a = useApp.getState().assets.find((x) => x.id === src);
          const js = await submitJob({
            task: 'tool',
            providerId: model.providerId,
            modelId: model.modelId,
            params: { prompt, sourceAssetId: src, ...(a?.type === 'video' ? { sourceVideoAssetId: src } : { startImageAssetId: src }) },
            projectId: useProject.getState().project?.id ?? null,
          });
          if (js) setJobId(js[0].id);
        }}
      >
        Run model
      </button>
      <ToolResult job={job} />
    </div>
  );
}
