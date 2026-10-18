import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Captions, Download, Headphones, ListPlus, Loader2, Mic, Square, Trash2, Upload, Volume2, VolumeX, Wand2, Plus } from 'lucide-react';
import type { Asset, JobRecord } from '../../../shared/api';
import { addAssetClip, addCue, parseSrt, replaceCues, subtitleTrack, toSrt } from '../../../shared/ops';
import { formatTimecode } from '../../../shared/timeline';
import { mediaUrl } from '../api';
import { useApp } from '../store/app';
import { useProject, usePlayback } from '../store/project';
import { submitJob } from '../lib/actions';
import { DropZone, ModelPicker, modelsFor, useUploader } from '../components/pickers';
import { Field, Notice, Select, Slider, Tabs, formatDuration } from '../components/ui';
import { JobStatusCard } from './Generate';

type Tab = 'mixer' | 'voice' | 'subtitles';

export function AudioStudio() {
  const [tab, setTab] = useState<Tab>('mixer');
  return (
    <div className="panel" style={{ background: 'var(--bg-0)' }}>
      <div className="panel-header">
        <AudioLines size={15} /> Audio Studio
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'mixer', label: 'Mixer & import' }, { value: 'voice', label: 'Voice-over & TTS' }, { value: 'subtitles', label: 'Transcription & subtitles' }]} />
      <div className="panel-body">
        {tab === 'mixer' && <Mixer />}
        {tab === 'voice' && <Voice />}
        {tab === 'subtitles' && <Subtitles />}
      </div>
    </div>
  );
}

function Mixer() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const assets = useApp((s) => s.assets);
  const audioTracks = project.timeline.tracks.filter((t) => t.kind === 'audio' || (t.kind === 'video' && t.clips.some((c) => c.kind === 'media' && assets.find((a) => a.id === c.assetId)?.hasAudio)));
  const [target, setTarget] = useState(project.timeline.tracks.find((t) => t.kind === 'audio')?.id ?? '');
  const setTrack = (id: string, label: string, fn: (t: (typeof project.timeline.tracks)[number]) => void) =>
    apply(label, (d) => {
      const t = d.timeline.tracks.find((x) => x.id === id);
      if (t) fn(t);
    }, { coalesce: `${id}:${label}` });
  const anySolo = project.timeline.tracks.some((t) => t.kind === 'audio' && t.solo);
  return (
    <div className="col" style={{ padding: 16, gap: 16 }}>
      <div className="card pad col">
        <h3>Import music, sound effects or dialogue</h3>
        <div className="row">
          <Field label="Add to track">
            <Select value={target} onChange={setTarget} options={project.timeline.tracks.filter((t) => t.kind === 'audio').map((t) => ({ value: t.id, label: `${t.name}${t.role ? ` (${t.role})` : ''}` }))} />
          </Field>
          <div className="tiny muted grow">Files are placed at the playhead. Use only audio you have the rights to.</div>
        </div>
        <DropZone
          allow={['audio']}
          multiple
          label="Drop MP3 / WAV / M4A / OGG / FLAC files"
          onAsset={(a) => {
            apply('Import audio', (d) => void addAssetClip(d, a, { trackId: target || undefined, start: usePlayback.getState().time }));
            useApp.getState().toast('ok', `Added ${a.name} at ${formatTimecode(usePlayback.getState().time, project.settings.fps)}`);
          }}
        />
      </div>
      <div className="card">
        <div className="panel-header">Mixer</div>
        {audioTracks.length === 0 && <div className="empty small">No audio yet.</div>}
        {audioTracks.map((t) => (
          <div key={t.id} className="list-row">
            <div style={{ width: 150 }}>
              <div style={{ color: 'var(--text-0)' }}>{t.name}</div>
              <div className="tiny muted">
                {t.kind === 'video' ? 'clip audio from video' : t.role ?? 'audio'} · {t.clips.length} clip(s)
              </div>
            </div>
            <button className={`icon-btn${t.muted ? ' on' : ''}`} aria-label={`${t.muted ? 'Unmute' : 'Mute'} ${t.name}`} onClick={() => setTrack(t.id, 'Toggle mute', (x) => void (x.muted = !x.muted))}>
              {t.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            {t.kind === 'audio' && (
              <button className={`icon-btn${t.solo ? ' on' : ''}`} aria-label={`Solo ${t.name}`} onClick={() => setTrack(t.id, 'Toggle solo', (x) => void (x.solo = !x.solo))}>
                <Headphones size={14} />
              </button>
            )}
            <div className="grow" style={{ opacity: t.muted || (anySolo && !t.solo) ? 0.5 : 1 }}>
              <Slider label={`${t.name} volume`} value={t.volume} min={0} max={2} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setTrack(t.id, 'Track volume', (x) => void (x.volume = v))} />
            </div>
            {t.kind === 'audio' && (
              <Select value={t.role ?? 'general'} onChange={(v) => setTrack(t.id, 'Track role', (x) => void (x.role = v))} options={(['dialogue', 'music', 'sfx', 'voiceover', 'general'] as const).map((r) => ({ value: r, label: r }))} />
            )}
          </div>
        ))}
      </div>
      <div className="small muted">Select an audio clip on the timeline to trim it, change its volume and set fade-in/out in the Properties panel. Mute/solo and volumes are applied in the exported mix.</div>
    </div>
  );
}

function Voice() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const providers = useApp((s) => s.providers);
  const jobs = useApp((s) => s.jobs);
  const assets = useApp((s) => s.assets);
  const ttsOptions = modelsFor(providers, 'text-to-speech');
  const [model, setModel] = useState({ providerId: '', modelId: '' });
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === jobId);
  const out = job?.status === 'succeeded' ? assets.find((a) => a.id === job.outputAssetIds[0]) : undefined;
  const info = ttsOptions.find((o) => o.provider.id === model.providerId && o.model.id === model.modelId);
  const voices = info?.model.capabilities.voices ?? [];
  useEffect(() => {
    if (!model.providerId) {
      const c = ttsOptions.find((o) => o.provider.configured && o.provider.enabled);
      if (c) setModel({ providerId: c.provider.id, modelId: c.model.id });
    }
  }, [ttsOptions, model.providerId]);
  useEffect(() => {
    if (voices.length && !voices.includes(voice)) setVoice(voices[0]);
  }, [voices, voice]);
  const dialogue = project.storyboard.shots.filter((s) => s.dialogue.trim());
  const dialogueTrack = project.timeline.tracks.find((t) => t.kind === 'audio' && (t.role === 'dialogue' || t.role === 'voiceover'));

  return (
    <div className="col" style={{ padding: 16, gap: 16 }}>
      <div className="card pad col">
        <h3>Text to speech</h3>
        {ttsOptions.every((o) => !o.provider.configured) && <Notice kind="warn">No text-to-speech provider is connected. Add an OpenAI or ElevenLabs API key in Settings → Providers. Generated voices must be disclosed as AI where the provider's policy requires it.</Notice>}
        <div className="grid2">
          <Field label="Voice model">
            <ModelPicker task="text-to-speech" providerId={model.providerId} modelId={model.modelId} onChange={(providerId, modelId) => setModel({ providerId, modelId })} />
          </Field>
          <Field label="Voice" hint={info?.provider.id === 'elevenlabs' ? 'Or paste a voice ID from your ElevenLabs account' : undefined}>
            {info?.provider.id === 'elevenlabs' ? (
              <input className="input" list="el-voices" value={voice} onChange={(e) => setVoice(e.target.value)} />
            ) : (
              <Select value={voice} onChange={setVoice} options={voices.map((v) => ({ value: v, label: v }))} disabled={!voices.length} />
            )}
            <datalist id="el-voices">
              {voices.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label={`Script (${text.length} characters)`}>
          <textarea className="textarea" rows={4} maxLength={5000} value={text} placeholder="Type narration or dialogue…" onChange={(e) => setText(e.target.value)} />
        </Field>
        {dialogue.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="tiny muted">From storyboard:</span>
            {dialogue.map((s) => (
              <button key={s.id} className="chip" onClick={() => setText(s.dialogue)}>
                {s.title}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          <div className="grow" />
          <button
            className="btn primary"
            disabled={!info || !text.trim() || !info.provider.configured}
            onClick={async () => {
              const js = await submitJob({ task: 'text-to-speech', providerId: model.providerId, modelId: model.modelId, params: { text, voice, prompt: text.slice(0, 200) }, projectId: project.id });
              if (js) setJobId(js[0].id);
            }}
          >
            <Wand2 size={14} /> Generate voice
          </button>
        </div>
        {job && job.status !== 'succeeded' && <JobStatusCard job={job} />}
        {out && (
          <div className="row">
            <audio src={mediaUrl(out)} controls style={{ flex: 1 }} />
            <span className="badge accent">AI voice · {job?.providerId}</span>
            <button className="btn sm" onClick={() => apply('Add voice-over', (d) => void addAssetClip(d, out, { trackId: dialogueTrack?.id, start: usePlayback.getState().time }))}>
              <ListPlus size={13} /> Add at playhead
            </button>
          </div>
        )}
      </div>
      <Recorder />
      <div className="card pad col">
        <h3>Lip-sync</h3>
        <div className="small muted">
          Lip-sync is an optional integration: register a lip-sync model as a custom Replicate or fal model (Settings → Providers → Custom models) with an input template using <span className="mono">{'{{video}}'}</span> and <span className="mono">{'{{audio}}'}</span>, and set <span className="mono">VOIDCRAFT_PUBLIC_URL</span> so the provider can fetch your media. No lip-sync model is bundled, so none runs by default.
        </div>
      </div>
    </div>
  );
}

function Recorder() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const { upload, progress } = useUploader(project.id);
  const [state, setState] = useState<'idle' | 'recording' | 'review'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  useEffect(() => {
    if (state !== 'recording') return;
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 200);
    return () => clearInterval(t);
  }, [state]);
  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setBlob(new Blob(chunks.current, { type: r.mimeType }));
        setState('review');
      };
      r.start(250);
      rec.current = r;
      setState('recording');
    } catch (err) {
      setError(`Microphone unavailable: ${(err as Error).message}. Recording needs a secure context (localhost or HTTPS) and microphone permission.`);
    }
  };
  const save = async () => {
    if (!blob) return;
    const file = new File([blob], `Voice-over ${new Date().toLocaleTimeString().replace(/:/g, '-')}.${blob.type.includes('ogg') ? 'ogg' : 'webm'}`, { type: blob.type });
    const a: Asset | null = await upload(file, ['audio'], 'recording');
    if (!a) return;
    const track = project.timeline.tracks.find((t) => t.kind === 'audio' && (t.role === 'voiceover' || t.role === 'dialogue'));
    apply('Add recording', (d) => void addAssetClip(d, a, { trackId: track?.id, start: usePlayback.getState().time }));
    useApp.getState().toast('ok', 'Recording saved and added at the playhead');
    setBlob(null);
    setState('idle');
  };
  return (
    <div className="card pad col">
      <h3>Record voice-over</h3>
      {error && <Notice kind="err">{error}</Notice>}
      <div className="row">
        {state === 'recording' ? (
          <button className="btn danger" onClick={() => rec.current?.stop()}>
            <Square size={13} /> Stop ({elapsed.toFixed(1)}s)
          </button>
        ) : (
          <button className="btn" onClick={() => void start()} disabled={progress !== null}>
            <Mic size={14} /> {state === 'review' ? 'Record again' : 'Start recording'}
          </button>
        )}
        {state === 'recording' && <span className="badge err pulse">● REC</span>}
        {url && state === 'review' && (
          <>
            <audio src={url} controls style={{ flex: 1 }} />
            <button className="btn primary" disabled={progress !== null} onClick={() => void save()}>
              {progress !== null ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} Save & add
            </button>
            <button className="icon-btn" aria-label="Discard recording" onClick={() => { setBlob(null); setState('idle'); }}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Subtitles() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const providers = useApp((s) => s.providers);
  const assets = useApp((s) => s.assets);
  const jobs = useApp((s) => s.jobs);
  const sttOptions = modelsFor(providers, 'transcribe');
  const [model, setModel] = useState({ providerId: '', modelId: '' });
  const [sourceClip, setSourceClip] = useState('');
  const [language, setLanguage] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job: JobRecord | undefined = jobs.find((j) => j.id === jobId);
  const subTrack = project.timeline.tracks.find((t) => t.kind === 'subtitle');
  const srtInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!model.providerId) {
      const c = sttOptions.find((o) => o.provider.configured && o.provider.enabled);
      if (c) setModel({ providerId: c.provider.id, modelId: c.model.id });
    }
  }, [sttOptions, model.providerId]);
  // Timeline clips with audio, so transcripts can be offset to where the clip sits.
  const clips = project.timeline.tracks.flatMap((t) =>
    t.clips
      .filter((c) => c.kind === 'media' && assets.find((a) => a.id === c.assetId)?.hasAudio)
      .map((c) => ({ track: t, clip: c as Extract<typeof c, { kind: 'media' }>, asset: assets.find((a) => a.id === (c as { assetId: string }).assetId)! })),
  );
  const chosen = clips.find((c) => c.clip.id === sourceClip);
  const segments = (job?.result as { segments?: Array<{ start: number; end: number; text: string }> } | null)?.segments ?? [];

  const useTranscript = () => {
    if (!chosen) return;
    const offset = chosen.clip.start;
    const shifted = segments
      .map((s) => ({ start: offset + (s.start - chosen.clip.in) / chosen.clip.speed, end: offset + (s.end - chosen.clip.in) / chosen.clip.speed, text: s.text }))
      .filter((s) => s.end > offset && s.start < offset + (chosen.clip.out - chosen.clip.in) / chosen.clip.speed);
    apply('Generate subtitles', (d) => replaceCues(d, shifted));
    useApp.getState().toast('ok', `Created ${shifted.length} subtitle cues`);
  };

  const download = () => {
    if (!subTrack) return;
    const blob = new Blob([toSrt(subTrack.cues)], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\w.-]+/g, '_')}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="col" style={{ padding: 16, gap: 16 }}>
      <div className="card pad col">
        <h3>Transcribe speech</h3>
        {sttOptions.every((o) => !o.provider.configured) && <Notice kind="warn">No transcription provider is connected. Add an OpenAI API key in Settings → Providers to use Whisper. You can still write subtitles manually or import an SRT file below.</Notice>}
        <div className="grid3">
          <Field label="Model">
            <ModelPicker task="transcribe" providerId={model.providerId} modelId={model.modelId} onChange={(providerId, modelId) => setModel({ providerId, modelId })} />
          </Field>
          <Field label="Clip to transcribe">
            <Select value={sourceClip} onChange={setSourceClip} options={[{ value: '', label: clips.length ? 'Choose a clip…' : 'No clips with audio' }, ...clips.map((c) => ({ value: c.clip.id, label: `${c.track.name}: ${c.clip.label ?? c.asset.name} @ ${formatTimecode(c.clip.start, project.settings.fps)}` }))]} />
          </Field>
          <Field label="Language (optional, ISO code)">
            <input className="input" placeholder="auto-detect" value={language} maxLength={5} onChange={(e) => setLanguage(e.target.value.trim())} />
          </Field>
        </div>
        <div className="row">
          <div className="grow tiny muted">The whole source file is transcribed; segments are mapped onto the clip's position, trim and speed on the timeline.</div>
          <button
            className="btn primary"
            disabled={!chosen || !model.providerId}
            onClick={async () => {
              if (!chosen) return;
              const js = await submitJob({ task: 'transcribe', providerId: model.providerId, modelId: model.modelId, params: { audioAssetId: chosen.asset.id, language: language || undefined, prompt: `Transcribe ${chosen.asset.name}` }, projectId: project.id });
              if (js) setJobId(js[0].id);
            }}
          >
            <Captions size={14} /> Transcribe
          </button>
        </div>
        {job && job.status !== 'succeeded' && <JobStatusCard job={job} />}
        {job?.status === 'succeeded' && (
          <div className="col">
            <div className="small">
              Transcript ({segments.length} segments): <span className="muted">{String((job.result as { text?: string }).text ?? '').slice(0, 400)}</span>
            </div>
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!segments.length} onClick={useTranscript}>
              Replace subtitles with transcript
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="panel-header">
          Subtitle cues
          <div className="grow" />
          <input
            ref={srtInput}
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 2 * 1024 * 1024) return useApp.getState().toast('err', 'SRT file is too large');
              const cues = parseSrt(await f.text());
              if (!cues.length) return useApp.getState().toast('err', 'No valid subtitle cues found in that file');
              apply('Import SRT', (d) => replaceCues(d, cues));
              useApp.getState().toast('ok', `Imported ${cues.length} cues`);
            }}
          />
          <button className="btn sm" onClick={() => srtInput.current?.click()}>
            <Upload size={13} /> Import SRT
          </button>
          <button className="btn sm" disabled={!subTrack?.cues.length} onClick={download}>
            <Download size={13} /> Export SRT
          </button>
          <button className="btn sm" onClick={() => apply('Add subtitle', (d) => void addCue(d, usePlayback.getState().time, usePlayback.getState().time + 2.5, 'New subtitle'))}>
            <Plus size={13} /> Add at playhead
          </button>
        </div>
        {subTrack && (
          <div style={{ padding: '8px 12px' }}>
            <label className="check">
              <input type="checkbox" checked={subTrack.burnIn} onChange={(e) => apply('Burn-in subtitles', (d) => void (subtitleTrack(d).burnIn = e.target.checked))} />
              Burn subtitles into exported video
            </label>
          </div>
        )}
        {!subTrack?.cues.length ? (
          <div className="empty small">No subtitles yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Start</th>
                <th style={{ width: 90 }}>End</th>
                <th>Text</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {subTrack.cues.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="btn sm ghost mono" onClick={() => usePlayback.getState().setTime(c.start)}>
                      {formatDuration(c.start)}
                    </button>
                  </td>
                  <td className="mono small">{formatDuration(c.end)}</td>
                  <td>
                    <input
                      className="input"
                      value={c.text}
                      onChange={(e) =>
                        apply('Edit subtitle', (d) => {
                          const cue = d.timeline.tracks.find((t) => t.id === subTrack.id)?.cues.find((x) => x.id === c.id);
                          if (cue) cue.text = e.target.value.slice(0, 1000);
                        }, { coalesce: `cue-${c.id}` })
                      }
                    />
                  </td>
                  <td>
                    <button className="icon-btn" aria-label="Delete cue" onClick={() => apply('Delete subtitle', (d) => {
                      const t = d.timeline.tracks.find((x) => x.id === subTrack.id);
                      if (t) t.cues = t.cues.filter((x) => x.id !== c.id);
                    })}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
