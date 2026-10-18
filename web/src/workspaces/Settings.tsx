import { useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, Trash2, Plus, ShieldCheck, Settings as SettingsIcon, HardDrive, Keyboard, Lock, Cpu } from 'lucide-react';
import { EnginePanel } from '../components/LocalEngine';
import type { AppSettings, CustomModelDef, JobTask, ProviderInfo } from '../../../shared/api';
import { api } from '../api';
import { useApp } from '../store/app';
import { errMsg } from '../lib/actions';
import { modelsFor } from '../components/pickers';
import { Check, Field, Modal, Notice, Select, Seg, Slider, Tabs, formatBytes, timeAgo } from '../components/ui';

type Tab = 'local' | 'providers' | 'general' | 'export' | 'shortcuts' | 'privacy';

export function Settings() {
  const [tab, setTab] = useState<Tab>('local');
  const settings = useApp((s) => s.settings);
  if (!settings) return null;
  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 1100 }}>
        <div className="page-header">
          <div>
            <h1>Settings</h1>
            <p>Local AI engine and models, defaults, storage and preferences.</p>
          </div>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'local', label: <span className="row"><Cpu size={13} /> Local AI</span> },
            { value: 'providers', label: <span className="row"><Plug size={13} /> Cloud providers (optional)</span> },
            { value: 'general', label: <span className="row"><SettingsIcon size={13} /> General</span> },
            { value: 'export', label: <span className="row"><HardDrive size={13} /> Export & storage</span> },
            { value: 'shortcuts', label: <span className="row"><Keyboard size={13} /> Shortcuts</span> },
            { value: 'privacy', label: <span className="row"><Lock size={13} /> Privacy & data</span> },
          ]}
        />
        <div style={{ marginTop: 16 }}>
          {tab === 'local' && <EnginePanel />}
          {tab === 'providers' && <Providers />}
          {tab === 'general' && <General settings={settings} />}
          {tab === 'export' && <ExportStorage settings={settings} />}
          {tab === 'shortcuts' && <Shortcuts settings={settings} />}
          {tab === 'privacy' && <Privacy settings={settings} />}
        </div>
      </div>
    </div>
  );
}

async function patch(p: Record<string, unknown>) {
  try {
    useApp.getState().setSettings(await api.patchSettings(p));
  } catch (err) {
    useApp.getState().toast('err', errMsg(err));
  }
}

function Providers() {
  const providers = useApp((s) => s.providers);
  const ai = providers.filter((p) => p.isAI && p.id !== 'local-ai');
  const local = providers.filter((p) => !p.isAI);
  return (
    <div className="col" style={{ gap: 14 }}>
      <Notice kind="accent">
        <div className="col" style={{ gap: 4 }}>
          <strong>Optional — not needed for local generation</strong>
          <span className="small">Voidcraft generates video on your own computer with the Local AI engine. These hosted services are only for people who also want to use a paid cloud model. Keys are sent once to the local Voidcraft server, encrypted with AES-256-GCM and stored in the data directory. The browser only ever sees a masked hint. Environment variables (shown per field) override stored keys. Usage is billed by each provider under your own account.</span>
        </div>
      </Notice>
      {ai.map((p) => (
        <ProviderCard key={p.id} p={p} />
      ))}
      <h3 style={{ marginTop: 10 }}>Built-in (non-AI)</h3>
      {local.map((p) => (
        <ProviderCard key={p.id} p={p} />
      ))}
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderInfo }) {
  const settings = useApp((s) => s.settings)!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState(!p.isAI ? false : !p.configured);
  const [customOpen, setCustomOpen] = useState(false);
  const refresh = async () => {
    await useApp.getState().refreshProviders();
    await useApp.getState().refreshSystem();
  };
  const save = async () => {
    setBusy('save');
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
      if (!Object.keys(filled).length) return;
      await api.setCredentials(p.id, filled);
      setValues({});
      await refresh();
      useApp.getState().toast('ok', `${p.name} credentials saved`);
      const r = await api.testProvider(p.id);
      setTest(r);
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setBusy(null);
    }
  };
  const customModels = settings.providers[p.id]?.customModels ?? [];
  const supportsCustom = p.id === 'replicate' || p.id === 'fal';
  return (
    <div className="card pad col">
      <div className="row">
        <div className="col grow" style={{ gap: 2 }}>
          <div className="row">
            <h2>{p.name}</h2>
            {p.isAI ? <span className="badge accent">AI</span> : <span className="badge warn">not AI</span>}
            {p.configured ? (
              <span className="badge ok">
                <CheckCircle2 size={10} /> {p.credentialFields.length ? 'connected' : 'built in'}
              </span>
            ) : (
              <span className="badge">not connected</span>
            )}
            {!p.enabled && <span className="badge err">disabled</span>}
          </div>
          <span className="small muted">{p.description}</span>
        </div>
        <label className="check small">
          <input type="checkbox" checked={p.enabled} onChange={(e) => void patch({ providers: { [p.id]: { enabled: e.target.checked } } }).then(refresh)} />
          Enabled
        </label>
        <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Configure'}
        </button>
      </div>
      {open && (
        <div className="col" style={{ gap: 12 }}>
          {p.credentialFields.map((f) => {
            const hint = p.credentialHints[f.key];
            return (
              <Field
                key={f.key}
                label={
                  <span className="row">
                    <KeyRound size={12} /> {f.label}
                  </span>
                }
                hint={
                  hint?.source === 'env'
                    ? `Set by environment variable ${f.envVar} (${hint.hint}). Remove it from the environment to manage it here.`
                    : hint?.source === 'store'
                      ? `Stored: ${hint.hint}. Enter a new value to replace it. Env var: ${f.envVar}`
                      : `Not set. Or define ${f.envVar} before starting the server.`
                }
              >
                <input
                  className="input"
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hint?.source !== 'none' ? (f.secret ? '•••••••• (unchanged)' : hint?.hint ?? '') : f.placeholder}
                  value={values[f.key] ?? ''}
                  disabled={hint?.source === 'env'}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && void save()}
                />
              </Field>
            );
          })}
          {p.credentialFields.length > 0 && (
            <div className="row">
              <button className="btn primary" disabled={busy !== null || !Object.values(values).some((v) => v.trim())} onClick={() => void save()}>
                {busy === 'save' ? <Loader2 size={13} className="spin" /> : null} Save & test
              </button>
              <button
                className="btn"
                disabled={busy !== null || !p.configured}
                onClick={async () => {
                  setBusy('test');
                  setTest(await api.testProvider(p.id).catch((e) => ({ ok: false, message: errMsg(e) })));
                  setBusy(null);
                }}
              >
                {busy === 'test' ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Test connection
              </button>
              {Object.values(p.credentialHints).some((h) => h.source === 'store') && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!(await useApp.getState().confirm({ title: `Remove ${p.name} credentials?`, message: 'Stored keys for this provider will be deleted from the server.', confirmLabel: 'Remove', danger: true }))) return;
                    await api.clearCredentials(p.id);
                    setTest(null);
                    await refresh();
                  }}
                >
                  <Trash2 size={13} /> Remove stored key
                </button>
              )}
              <div className="grow" />
              <a className="btn ghost sm" href={p.docsUrl.startsWith('http') ? p.docsUrl : undefined} target="_blank" rel="noreferrer">
                Provider docs <ExternalLink size={12} />
              </a>
            </div>
          )}
          {test && <Notice kind={test.ok ? 'ok' : 'err'}>{test.message}</Notice>}
          <div className="grid2" style={{ alignItems: 'start' }}>
            <div className="col" style={{ gap: 4 }}>
              <h4>Models</h4>
              {p.models.length === 0 && <span className="small muted">Text model for AI tools.</span>}
              {p.models.map((m) => (
                <div key={m.id} className="small">
                  <span style={{ color: 'var(--text-0)' }}>{m.name}</span> <span className="tiny muted">({m.tasks.join(', ') || 'language model'})</span>
                  {m.custom && <span className="badge" style={{ marginLeft: 4 }}>custom</span>}
                  {m.notes && <div className="tiny dim">{m.notes}</div>}
                </div>
              ))}
            </div>
            <div className="col" style={{ gap: 4 }}>
              <h4>Limitations</h4>
              <ul className="tiny muted" style={{ margin: 0, paddingLeft: 16 }}>
                {p.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {p.isAI && (
                <>
                  <h4 style={{ marginTop: 8 }}>Usage (this installation)</h4>
                  <div className="tiny muted">
                    {p.usage.jobs} jobs · {p.usage.succeeded} succeeded · {p.usage.failed} failed · {Math.round(p.usage.secondsGenerated)}s of media · last used {timeAgo(p.usage.lastUsedAt)}
                  </div>
                </>
              )}
            </div>
          </div>
          {supportsCustom && (
            <div className="col">
              <div className="row between">
                <h4>Custom models</h4>
                <button className="btn sm" onClick={() => setCustomOpen(true)}>
                  <Plus size={12} /> Add custom model
                </button>
              </div>
              {customModels.length === 0 && <span className="tiny muted">Register any {p.name} model (e.g. a video-to-video, lip-sync, background-removal or upscaling model) with an input template.</span>}
              {customModels.map((m) => (
                <div key={m.id} className="row small">
                  <span className="mono">{m.id}</span>
                  <span className="muted grow">{m.name} · {m.tasks.join(', ')}</span>
                  <button className="icon-btn" aria-label={`Remove ${m.name}`} onClick={() => void patch({ providers: { [p.id]: { enabled: p.enabled, customModels: customModels.filter((x) => x.id !== m.id) } } }).then(refresh)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {customOpen && <CustomModelDialog provider={p} existing={customModels} onClose={() => setCustomOpen(false)} onSaved={refresh} />}
    </div>
  );
}

function CustomModelDialog({ provider, existing, onClose, onSaved }: { provider: ProviderInfo; existing: CustomModelDef[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState<JobTask[]>(['video-to-video']);
  const [template, setTemplate] = useState('{\n  "prompt": "{{prompt}}",\n  "video": "{{video}}"\n}');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(template);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Template must be a JSON object');
    } catch (err) {
      return setError(`Invalid JSON: ${(err as Error).message}`);
    }
    if (!id.trim() || !name.trim()) return setError('Model id and name are required');
    try {
      await api.patchSettings({ providers: { [provider.id]: { enabled: provider.enabled, customModels: [...existing.filter((m) => m.id !== id.trim()), { id: id.trim(), name: name.trim(), tasks, inputTemplate: parsed, notes: notes || undefined }] } } }).then(useApp.getState().setSettings);
      await onSaved();
      onClose();
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const allTasks: JobTask[] = ['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image', 'tool'];
  return (
    <Modal
      title={`Custom ${provider.name} model`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save model
          </button>
        </>
      }
    >
      {error && <Notice kind="err">{error}</Notice>}
      <Field label={provider.id === 'replicate' ? 'Model (owner/name or owner/name:version)' : 'Endpoint id (e.g. fal-ai/some-model)'}>
        <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder={provider.id === 'replicate' ? 'owner/model-name' : 'fal-ai/model/endpoint'} />
      </Field>
      <Field label="Display name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Tasks">
        <div className="row wrap" style={{ gap: 6 }}>
          {allTasks.map((t) => (
            <button key={t} className={`chip${tasks.includes(t) ? ' on' : ''}`} onClick={() => setTasks(tasks.includes(t) ? tasks.filter((x) => x !== t) : [...tasks, t])}>
              {t}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Input template (JSON)" hint="Placeholders: {{prompt}} {{negative_prompt}} {{image}} {{end_image}} {{video}} {{audio}} {{duration}} {{aspect_ratio}} {{seed}} {{text}}. Images are sent as data URIs; video/audio need VOIDCRAFT_PUBLIC_URL. Check the model's API page for exact input names.">
        <textarea className="textarea mono" rows={7} value={template} onChange={(e) => setTemplate(e.target.value)} />
      </Field>
      <Field label="Notes">
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

function General({ settings }: { settings: AppSettings }) {
  const providers = useApp((s) => s.providers);
  const videoOpts = modelsFor(providers, 'text-to-video');
  const llms = providers.filter((p) => p.categories.includes('llm'));
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad col">
        <h3>Appearance</h3>
        <div className="grid3">
          <Field label="Accent">
            <Seg value={settings.appearance.accent} onChange={(v) => void patch({ appearance: { accent: v } })} options={[{ value: 'violet', label: 'Violet' }, { value: 'lavender', label: 'Lavender' }, { value: 'indigo', label: 'Indigo' }]} />
          </Field>
          <Field label="Density">
            <Seg value={settings.appearance.density} onChange={(v) => void patch({ appearance: { density: v } })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          </Field>
          <Field label="Motion">
            <Check checked={settings.appearance.reducedMotion} onChange={(v) => void patch({ appearance: { reducedMotion: v } })} label="Reduce motion" />
          </Field>
        </div>
      </div>
      <div className="card pad col">
        <h3>Defaults</h3>
        <div className="grid2">
          <Field label="Default video model">
            <select
              className="select"
              value={`${settings.defaults.videoProviderId}::${settings.defaults.videoModelId}`}
              onChange={(e) => {
                const [videoProviderId, videoModelId] = e.target.value.split('::');
                void patch({ defaults: { videoProviderId, videoModelId } });
              }}
            >
              {videoOpts.map((o) => (
                <option key={`${o.provider.id}::${o.model.id}`} value={`${o.provider.id}::${o.model.id}`}>
                  {o.provider.name} — {o.model.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prompt & storyboard assistant">
            <Select value={settings.defaults.llmProviderId} onChange={(v) => void patch({ defaults: { llmProviderId: v } })} options={llms.map((p) => ({ value: p.id, label: p.isAI ? p.name : 'Offline templates (not AI)' }))} />
          </Field>
          <Field label="Default aspect ratio">
            <Seg value={settings.defaults.aspectRatio} onChange={(v) => void patch({ defaults: { aspectRatio: v } })} options={(['16:9', '9:16', '1:1'] as const).map((a) => ({ value: a, label: a }))} />
          </Field>
          <Field label="Default resolution">
            <Seg value={settings.defaults.resolution} onChange={(v) => void patch({ defaults: { resolution: v } })} options={[{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }]} />
          </Field>
        </div>
      </div>
      <div className="card pad col">
        <h3>Editing</h3>
        <div className="grid2">
          <Field label={`Autosave every ${settings.autosaveSeconds}s`} hint="Autosaves go to a recovery slot; use Save (Ctrl+S) to commit the project.">
            <Slider label="Autosave interval" value={settings.autosaveSeconds} min={5} max={300} step={5} onChange={(v) => void patch({ autosaveSeconds: v })} />
          </Field>
          <div className="col">
            <Check checked={settings.timeline.snapping} onChange={(v) => void patch({ timeline: { snapping: v } })} label="Snap clips to edges and playhead by default" />
            <Check checked={settings.timeline.rippleDelete} onChange={(v) => void patch({ timeline: { rippleDelete: v } })} label="Ripple delete (close gaps when deleting clips)" />
          </div>
        </div>
      </div>
      <div className="card pad col">
        <h3>Performance & jobs</h3>
        <div className="grid3">
          <Field label="Default preview resolution">
            <Seg value={settings.performance.previewScale} onChange={(v) => void patch({ performance: { previewScale: v } })} options={[{ value: 1, label: 'Full' }, { value: 0.5, label: '½' }, { value: 0.25, label: '¼' }]} />
          </Field>
          <Field label="Concurrent jobs">
            <Select value={String(settings.performance.maxConcurrentJobs)} onChange={(v) => void patch({ performance: { maxConcurrentJobs: Number(v) } })} options={['1', '2', '3', '4', '6', '8'].map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Job timeout (minutes)">
            <input className="input" type="number" min={1} max={240} value={settings.jobs.timeoutMinutes} onChange={(e) => void patch({ jobs: { timeoutMinutes: Math.min(240, Math.max(1, Number(e.target.value))) } })} />
          </Field>
        </div>
      </div>
      <div className="row">
        <button
          className="btn danger"
          onClick={async () => {
            if (!(await useApp.getState().confirm({ title: 'Reset settings?', message: 'Restore all preferences to defaults. Credentials and projects are not affected.', confirmLabel: 'Reset' }))) return;
            useApp.getState().setSettings(await api.resetSettings());
          }}
        >
          Reset preferences
        </button>
      </div>
    </div>
  );
}

function ExportStorage({ settings }: { settings: AppSettings }) {
  const system = useApp((s) => s.system);
  const [dir, setDir] = useState(settings.storage.exportDir);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad col">
        <h3>Export preferences</h3>
        <div className="grid3">
          <Field label="Default codec">
            <Select value={settings.export.codec} onChange={(v) => void patch({ export: { codec: v } })} options={[{ value: 'h264', label: 'H.264' }, { value: 'h265', label: 'H.265' }, { value: 'vp9', label: 'VP9' }, { value: 'prores', label: 'ProRes' }]} />
          </Field>
          <Field label="Default quality">
            <Select value={settings.export.quality} onChange={(v) => void patch({ export: { quality: v } })} options={['draft', 'standard', 'high', 'master'].map((v) => ({ value: v as AppSettings['export']['quality'], label: v }))} />
          </Field>
          <Field label="Audio">
            <Check checked={settings.export.includeAudio} onChange={(v) => void patch({ export: { includeAudio: v } })} label="Include audio by default" />
          </Field>
        </div>
      </div>
      <div className="card pad col">
        <h3>Storage locations</h3>
        <dl className="kv">
          <dt>Data directory</dt>
          <dd className="mono">{system?.dataDir}</dd>
          <dt>Media</dt>
          <dd>{formatBytes(system?.storage.assetsBytes)}</dd>
          <dt>Exports</dt>
          <dd>{formatBytes(system?.storage.exportsBytes)}</dd>
          <dt>Free space</dt>
          <dd>{formatBytes(system?.storage.freeBytes)}</dd>
        </dl>
        <div className="tiny muted">Change the data directory by setting VOIDCRAFT_DATA_DIR before starting the server.</div>
        <Field label="Also copy finished exports to this folder (optional, on the server machine)">
          <div className="row">
            <input className="input mono" placeholder={navigator.userAgent.includes('Windows') ? 'C:\\Users\\you\\Videos\\Voidcraft' : '/home/you/Videos/Voidcraft'} value={dir} onChange={(e) => setDir(e.target.value)} />
            <button className="btn" onClick={() => void patch({ storage: { exportDir: dir.trim() } })}>
              Save
            </button>
          </div>
        </Field>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              try {
                const r = await api.clearTemp();
                useApp.getState().toast('ok', `Cleared ${formatBytes(r.freedBytes)} of temporary files`);
              } catch (err) {
                useApp.getState().toast('err', errMsg(err));
              }
            }}
          >
            Clear temporary files
          </button>
        </div>
      </div>
      <div className="card pad col">
        <h3>Upload limits</h3>
        <dl className="kv">
          <dt>Video</dt>
          <dd>{formatBytes(system?.limits.maxVideoBytes)}</dd>
          <dt>Image</dt>
          <dd>{formatBytes(system?.limits.maxImageBytes)}</dd>
          <dt>Audio</dt>
          <dd>{formatBytes(system?.limits.maxAudioBytes)}</dd>
        </dl>
        <div className="tiny muted">Configure with VOIDCRAFT_MAX_VIDEO_MB / VOIDCRAFT_MAX_IMAGE_MB / VOIDCRAFT_MAX_AUDIO_MB.</div>
      </div>
    </div>
  );
}

function Shortcuts({ settings }: { settings: AppSettings }) {
  const labels: Record<string, string> = {
    playPause: 'Play / pause',
    split: 'Split',
    delete: 'Delete',
    duplicate: 'Duplicate',
    undo: 'Undo',
    redo: 'Redo',
    save: 'Save',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    frameBack: 'Previous frame',
    frameForward: 'Next frame',
    toStart: 'Go to start',
    toEnd: 'Go to end',
    addKeyframe: 'Add keyframe',
    togglePanels: 'Toggle timeline',
    fullscreen: 'Full-screen preview (double-click preview)',
  };
  return (
    <div className="card">
      <table className="table">
        <tbody>
          {Object.entries(labels).map(([k, l]) => (
            <tr key={k}>
              <td>{l}</td>
              <td style={{ textAlign: 'right' }}>
                <span className="kbd">{settings.shortcuts[k]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tiny muted" style={{ padding: 12 }}>Shortcuts are inactive while typing in a text field. Ctrl maps to ⌘ on macOS.</div>
    </div>
  );
}

function Privacy({ settings }: { settings: AppSettings }) {
  const jobs = useApp((s) => s.jobs);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad col">
        <h3>Privacy</h3>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Voidcraft sends no telemetry. Data leaves this machine only when you run a job on a provider you configured.</li>
          <li>Prompts and the media you select as inputs are sent to that provider and are subject to its terms and retention policy.</li>
          <li>Server logs never include API keys; known secrets are redacted.</li>
        </ul>
        <Check checked={settings.privacy.logPrompts} onChange={(v) => void patch({ privacy: { logPrompts: v } })} label="Allow prompts in server logs (for debugging)" />
      </div>
      <div className="card pad col">
        <h3>Data management</h3>
        <div className="small muted">{jobs.length} job records stored. Removing history does not delete generated files.</div>
        <div className="row">
          <button
            className="btn danger"
            onClick={async () => {
              const done = jobs.filter((j) => ['succeeded', 'failed', 'canceled'].includes(j.status));
              if (!(await useApp.getState().confirm({ title: 'Clear finished job history?', message: `Remove ${done.length} finished job records. Generated media stays in the asset library.`, confirmLabel: 'Clear history', danger: true }))) return;
              for (const j of done) await api.deleteJob(j.id).catch(() => undefined);
              await useApp.getState().refreshJobs();
            }}
          >
            Clear finished job history
          </button>
        </div>
      </div>
    </div>
  );
}
