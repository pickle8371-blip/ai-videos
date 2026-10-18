import { useEffect, useState } from 'react';
import { Cpu, Download, HardDrive, Loader2, RefreshCw, Trash2, Zap, CheckCircle2, AlertTriangle, Square } from 'lucide-react';
import { api, type EngineModelView } from '../api';
import { useApp } from '../store/app';
import { errMsg } from '../lib/actions';
import { Notice, Progress } from './ui';

const ACTIVE = ['queued', 'submitting', 'running', 'downloading'];

function useEngineJobs() {
  const jobs = useApp((s) => s.jobs);
  const setup = jobs.find((j) => j.task === 'engine-setup' && ACTIVE.includes(j.status));
  const lastSetup = jobs.find((j) => j.task === 'engine-setup');
  const downloads = jobs.filter((j) => j.task === 'model-download' && ACTIVE.includes(j.status));
  return { setup, lastSetup, downloads };
}

async function install(cpu: boolean) {
  try {
    useApp.getState().upsertJob(await api.installEngine(cpu));
  } catch (err) {
    useApp.getState().toast('err', errMsg(err));
  }
}

async function download(id: string) {
  try {
    useApp.getState().upsertJob(await api.downloadModel(id));
  } catch (err) {
    useApp.getState().toast('err', errMsg(err));
  }
}

/** Full Local AI management panel (Settings → Local AI). */
export function EnginePanel() {
  const engine = useApp((s) => s.engine);
  const refresh = useApp((s) => s.refreshEngine);
  const { setup, lastSetup, downloads } = useEngineJobs();
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  if (!engine) return <Progress value={null} />;
  const s = engine.status;
  const models = engine.models.filter((m) => !m.test);
  const recheck = async () => {
    setChecking(true);
    await refresh(true).catch((e) => useApp.getState().toast('err', errMsg(e)));
    setChecking(false);
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <Notice kind="accent">
        <div className="col" style={{ gap: 4 }}>
          <strong>Your own AI video generator — runs on this computer</strong>
          <span className="small">
            Voidcraft runs open-source video diffusion models (Wan 2.1, LTX-Video, CogVideoX, AnimateDiff) locally with PyTorch. No API keys, no accounts, no per-video cost. Each model downloads once from Hugging Face; after that generation works offline.
          </span>
        </div>
      </Notice>

      <div className="card pad col">
        <div className="row">
          <h3 className="grow">1. Engine</h3>
          <button className="btn sm" disabled={checking} onClick={() => void recheck()}>
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Re-check
          </button>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {s.state === 'ready' ? <CheckCircle2 size={18} color="var(--ok)" /> : <AlertTriangle size={18} color="var(--warn)" />}
          <div className="grow">
            <div style={{ color: 'var(--text-0)' }}>{s.message}</div>
            <div className="tiny muted">
              {s.state === 'ready' ? `PyTorch ${s.torch} · diffusers ${s.diffusers}${s.device === 'cpu' ? ` · ${s.cpuThreads} CPU threads` : ''}` : s.systemPython ? `Found ${s.systemPython}` : 'No suitable Python found'}
            </div>
          </div>
        </div>
        {setup ? (
          <div className="col">
            <div className="row between small">
              <span className="ellipsis grow">{setup.message ?? 'Installing…'}</span>
              <button className="btn sm danger" onClick={() => void api.cancelJob(setup.id).then(useApp.getState().upsertJob)}>
                <Square size={11} /> Cancel
              </button>
            </div>
            <Progress value={setup.progress} />
            <div className="tiny muted">Installing PyTorch and diffusers into {s.engineDir}/.venv — this downloads 2-5 GB and can take 5-20 minutes.</div>
          </div>
        ) : s.state === 'no-python' ? (
          <Notice kind="warn">
            Python 3.10-3.12 is required to run the AI models. On Windows open a terminal and run <span className="mono">winget install Python.Python.3.12</span> (or install from python.org and tick “Add python.exe to PATH”), restart Voidcraft, then click Install engine.
          </Notice>
        ) : (
          s.state !== 'ready' && (
            <div className="row wrap">
              <button className="btn primary" onClick={() => void install(false)}>
                <Zap size={14} /> Install engine
              </button>
              <button className="btn" onClick={() => void install(true)} title="Use if you have no NVIDIA GPU or the GPU install fails">
                <Cpu size={14} /> Install CPU-only engine
              </button>
              <span className="tiny muted">Detects an NVIDIA GPU automatically and installs the matching PyTorch build.</span>
            </div>
          )
        )}
        {lastSetup?.status === 'failed' && !setup && <Notice kind="err">Last installation failed: {lastSetup.error}</Notice>}
        {s.state === 'ready' && s.device === 'cpu' && (
          <Notice kind="warn">No supported GPU was detected, so models run on the CPU. AnimateDiff Lightning takes a few minutes per clip; the larger models are impractically slow without an NVIDIA GPU (8 GB+ recommended).</Notice>
        )}
      </div>

      <div className="card pad col">
        <h3>2. Models</h3>
        <div className="tiny muted">
          Stored in <span className="mono">{s.modelsDir}</span>. Recommended for this machine: <strong>{models.find((m) => m.id === engine.recommended)?.name ?? '—'}</strong>.
        </div>
        {models.map((m) => (
          <ModelRow key={m.id} m={m} recommended={m.id === engine.recommended} ready={s.state === 'ready'} job={downloads.find((d) => (d.params as { modelId?: string }).modelId === m.id)} vram={s.device === 'cuda' ? s.vramGB : null} />
        ))}
      </div>
      <div className="small muted">
        Hardware guide: NVIDIA GPU with 8 GB+ VRAM for Wan 2.1 / LTX-Video (12-24 GB is faster), 4-6 GB for CogVideoX 2B, any machine for AnimateDiff Lightning. 16 GB+ system RAM. Models are subject to their own licenses (shown per model).
      </div>
    </div>
  );
}

function ModelRow({ m, recommended, ready, job, vram }: { m: EngineModelView; recommended: boolean; ready: boolean; job?: { id: string; progress: number | null; message: string | null }; vram: number | null }) {
  const [busy, setBusy] = useState(false);
  const tooSmall = vram !== null && m.minVramGB > 0 && vram < m.minVramGB;
  return (
    <div className="list-row" style={{ alignItems: 'flex-start', padding: '10px 0' }}>
      <div className="grow col" style={{ gap: 3 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <strong style={{ color: 'var(--text-0)' }}>{m.name}</strong>
          {recommended && <span className="badge accent">recommended</span>}
          {m.installed && <span className="badge ok">downloaded</span>}
          {m.tasks.map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
          {tooSmall && <span className="badge warn">needs {m.minVramGB} GB VRAM</span>}
        </div>
        <div className="small muted">{m.notes}</div>
        <div className="tiny dim">
          ~{m.diskGB} GB download · {m.minVramGB ? `${m.minVramGB} GB+ VRAM` : 'GPU optional'} · {Object.values(m.sizes)[0]?.join('×')} · {m.durations.join('/')} s · {m.fps} fps · {m.license}
          {m.installed && ` · here: ${m.estimate}`}
        </div>
        {job && (
          <div className="col" style={{ gap: 3, marginTop: 4 }}>
            <Progress value={job.progress} />
            <div className="row between tiny muted">
              <span>{job.message ?? 'Starting download…'}</span>
              <button className="btn sm ghost" onClick={() => void api.cancelJob(job.id).then(useApp.getState().upsertJob)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {!job &&
        (m.installed ? (
          <button
            className="icon-btn"
            title="Delete downloaded weights"
            aria-label={`Delete ${m.name}`}
            disabled={busy}
            onClick={async () => {
              if (!(await useApp.getState().confirm({ title: `Delete ${m.name}?`, message: `Frees about ${m.diskGB} GB. You can download it again later.`, confirmLabel: 'Delete', danger: true }))) return;
              setBusy(true);
              try {
                const r = await api.deleteModel(m.id);
                useApp.setState({ engine: r });
                await useApp.getState().refreshProviders();
              } catch (err) {
                useApp.getState().toast('err', errMsg(err));
              }
              setBusy(false);
            }}
          >
            <Trash2 size={14} />
          </button>
        ) : (
          <button className={`btn sm${recommended ? ' primary' : ''}`} disabled={!ready} title={ready ? undefined : 'Install the engine first'} onClick={() => void download(m.id)}>
            <Download size={13} /> Download
          </button>
        ))}
    </div>
  );
}

/** Compact status card shown where generation happens, with the next step to take. */
export function EngineInline({ modelId }: { modelId?: string }) {
  const engine = useApp((s) => s.engine);
  const setWs = useApp((s) => s.setWorkspace);
  const { setup, downloads } = useEngineJobs();
  if (!engine) return null;
  const s = engine.status;
  const model = engine.models.find((m) => m.id === modelId) ?? engine.models.find((m) => m.id === engine.recommended);
  const dl = downloads.find((d) => (d.params as { modelId?: string }).modelId === model?.id);
  if (s.state === 'ready' && model?.installed) return null;
  return (
    <div className="notice accent" style={{ flexDirection: 'column', gap: 8 }}>
      <div className="row">
        <HardDrive size={15} />
        <strong className="grow">Set up local AI generation</strong>
      </div>
      {setup ? (
        <>
          <div className="tiny ellipsis">{setup.message ?? 'Installing engine…'}</div>
          <Progress value={setup.progress} />
        </>
      ) : s.state === 'no-python' ? (
        <div className="small">
          Install Python 3.12 first (<span className="mono">winget install Python.Python.3.12</span>), restart Voidcraft, then install the engine.
        </div>
      ) : s.state !== 'ready' ? (
        <>
          <div className="small">Step 1 of 2: install the AI engine (PyTorch + diffusers, one time, 2-5 GB).</div>
          <div className="row">
            <button className="btn sm primary" onClick={() => void install(false)}>
              <Zap size={13} /> Install engine
            </button>
            <button className="btn sm ghost" onClick={() => setWs('settings')}>
              Details
            </button>
          </div>
        </>
      ) : model && dl ? (
        <>
          <div className="tiny">Downloading {model.name}: {dl.message ?? '…'}</div>
          <Progress value={dl.progress} />
        </>
      ) : model ? (
        <>
          <div className="small">
            Step 2 of 2: download <strong>{model.name}</strong> (~{model.diskGB} GB, one time). {model.notes}
          </div>
          <div className="row">
            <button className="btn sm primary" onClick={() => void download(model.id)}>
              <Download size={13} /> Download model
            </button>
            <button className="btn sm ghost" onClick={() => setWs('settings')}>
              Other models
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
