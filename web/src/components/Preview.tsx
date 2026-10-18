import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronFirst, ChevronLast, Film, Loader2, Maximize2, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, X } from 'lucide-react';
import type { Asset } from '../../../shared/api';
import { clipEnd, formatTimecode, timelineDuration } from '../../../shared/timeline';
import { api, mediaUrl } from '../api';
import { useApp } from '../store/app';
import { useProject, usePlayback } from '../store/project';
import { Compositor } from '../lib/compositor';
import { errMsg } from '../lib/actions';
import { Seg } from './ui';

const GUIDES = [
  { id: 'none', label: 'No guides' },
  { id: 'safe', label: 'Safe areas' },
  { id: '9:16', label: '9:16 crop' },
  { id: '1:1', label: '1:1 crop' },
  { id: '4:5', label: '4:5 crop' },
  { id: '2.39', label: '2.39 scope' },
  { id: 'thirds', label: 'Thirds' },
];

export function Preview() {
  const project = useProject((s) => s.project)!;
  const assets = useApp((s) => s.assets);
  const previewScaleDefault = useApp((s) => s.settings?.performance.previewScale ?? 0.5);
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const compRef = useRef<Compositor | null>(null);
  const [scale, setScale] = useState(previewScaleDefault);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [guide, setGuide] = useState('none');
  const [loop, setLoop] = useState(false);
  const [exact, setExact] = useState<{ url: string; t: number } | null>(null);
  const [exactBusy, setExactBusy] = useState(false);
  const [previewJob, setPreviewJob] = useState<string | null>(null);
  const job = useApp((s) => s.jobs.find((j) => j.id === previewJob));
  const previewAsset = job?.status === 'succeeded' ? assets.find((a) => a.id === job.outputAssetIds[0]) : undefined;
  const [showRender, setShowRender] = useState(false);
  const [undecodable, setUndecodable] = useState<string[]>([]);

  const assetMap = useMemo(() => new Map<string, Asset>(assets.map((a) => [a.id, a])), [assets]);
  const duration = timelineDuration(project.timeline);
  const W = Math.max(2, Math.round(project.settings.width * scale));
  const H = Math.max(2, Math.round(project.settings.height * scale));

  // Fit the canvas inside the stage.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const ar = project.settings.width / project.settings.height;
      const pad = 24;
      let w = r.width - pad;
      let h = w / ar;
      if (h > r.height - pad) {
        h = r.height - pad;
        w = h * ar;
      }
      setBox({ w: Math.max(80, w), h: Math.max(45, h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.settings.width, project.settings.height]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    compRef.current = new Compositor(ctx);
    compRef.current.onDecodeError = (id) => setUndecodable((u) => (u.includes(id) ? u : [...u, id]));
    const gc = setInterval(() => compRef.current?.gc(), 4000);
    return () => {
      clearInterval(gc);
      compRef.current?.dispose();
      compRef.current = null;
    };
  }, []);

  // Playback clock.
  useEffect(() => {
    if (!playing) {
      compRef.current?.pauseAll();
      return;
    }
    let raf = 0;
    const startWall = performance.now();
    const startT = usePlayback.getState().time >= duration - 0.02 ? 0 : usePlayback.getState().time;
    const tick = () => {
      let t = startT + (performance.now() - startWall) / 1000;
      if (t >= duration) {
        if (loop && duration > 0) {
          usePlayback.getState().setTime(0);
          usePlayback.getState().setPlaying(false);
          setTimeout(() => usePlayback.getState().setPlaying(true), 0);
          return;
        }
        t = duration;
        usePlayback.getState().setTime(t);
        usePlayback.getState().setPlaying(false);
        return;
      }
      usePlayback.getState().setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, loop]);

  // Draw on every time/project change; keep redrawing briefly while paused so seeks land.
  useEffect(() => {
    const comp = compRef.current;
    if (!comp) return;
    comp.render(project, assetMap, time, playing, { scale });
    if (playing) return;
    let n = 0;
    const id = setInterval(() => {
      comp.render(project, assetMap, usePlayback.getState().time, false, { scale });
      if (++n > 12) clearInterval(id);
    }, 80);
    return () => clearInterval(id);
  }, [project, assetMap, time, playing, scale, W, H]);

  useEffect(() => setExact(null), [project, time]);

  const cuts = useMemo(() => {
    const s = new Set<number>([0]);
    for (const t of project.timeline.tracks) if (t.kind === 'video') for (const c of t.clips) {
      s.add(c.start);
      s.add(clipEnd(c));
    }
    return [...s].sort((a, b) => a - b);
  }, [project]);
  const pb = usePlayback.getState;
  const fps = project.settings.fps;

  const renderExact = async () => {
    setExactBusy(true);
    try {
      const url = await api.renderFrame(project, time, Math.min(1280, project.settings.width));
      setExact({ url, t: time });
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    } finally {
      setExactBusy(false);
    }
  };
  const renderPreview = async () => {
    try {
      const j = await api.startExport(project, project.exportSettings, { preview: true });
      useApp.getState().upsertJob(j);
      setPreviewJob(j.id);
      setShowRender(true);
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    }
  };

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <span className="small muted">Timeline preview</span>
        <span className="badge" title="Live preview approximates some effects. Use Exact frame or Render preview to see the FFmpeg output.">live · approximate</span>
        <div className="grow" />
        <select className="select" style={{ width: 120, minHeight: 24, padding: '1px 24px 1px 8px', fontSize: 12 }} aria-label="Guides" value={guide} onChange={(e) => setGuide(e.target.value)}>
          {GUIDES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        <Seg
          label="Preview resolution"
          value={scale}
          onChange={setScale}
          options={[
            { value: 1, label: 'Full' },
            { value: 0.5, label: '½' },
            { value: 0.25, label: '¼' },
          ]}
        />
        <button className="btn sm" onClick={() => void renderExact()} disabled={exactBusy || duration <= 0} title="Render this frame through the FFmpeg export pipeline">
          {exactBusy ? <Loader2 size={13} className="spin" /> : <Camera size={13} />} Exact frame
        </button>
        <button className="btn sm" onClick={() => void renderPreview()} disabled={duration <= 0 || (job && !['succeeded', 'failed', 'canceled'].includes(job.status))} title="Low-resolution render of the whole timeline with the export pipeline">
          {job && !['succeeded', 'failed', 'canceled'].includes(job.status) ? <Loader2 size={13} className="spin" /> : <Film size={13} />}
          {job && !['succeeded', 'failed', 'canceled'].includes(job.status) ? `Rendering ${Math.round((job.progress ?? 0) * 100)}%` : 'Render preview'}
        </button>
        <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => stageRef.current?.requestFullscreen?.()}>
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="preview-stage" ref={stageRef} onDoubleClick={() => (document.fullscreenElement ? document.exitFullscreen() : stageRef.current?.requestFullscreen?.())}>
        <div className="preview-canvas-wrap" style={{ width: box.w, height: box.h }}>
          <canvas ref={canvasRef} width={W} height={H} aria-label="Timeline preview" />
          {exact && (
            <>
              <img src={exact.url} alt="Exact rendered frame" style={{ position: 'absolute', inset: 0 }} />
              <span className="badge accent" style={{ position: 'absolute', top: 8, left: 8 }}>
                Exact FFmpeg frame @ {formatTimecode(exact.t, fps)}
              </span>
              <button className="icon-btn" aria-label="Close exact frame" style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)' }} onClick={() => setExact(null)}>
                <X size={14} />
              </button>
            </>
          )}
          {showRender && previewAsset && (
            <>
              <video src={mediaUrl(previewAsset)} controls autoPlay style={{ position: 'absolute', inset: 0, background: '#000' }} />
              <span className="badge accent" style={{ position: 'absolute', top: 8, left: 8 }}>
                Rendered preview ({previewAsset.width}×{previewAsset.height})
              </span>
              <button className="icon-btn" aria-label="Close rendered preview" style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)' }} onClick={() => setShowRender(false)}>
                <X size={14} />
              </button>
            </>
          )}
          <Guides guide={guide} projectW={project.settings.width} projectH={project.settings.height} />
          {duration <= 0 && (
            <div className="preview-overlay">
              <div className="small muted" style={{ textAlign: 'center', padding: 20 }}>
                The timeline is empty.
                <br />
                Drag clips from the asset library or generate a video to get started.
              </div>
            </div>
          )}
          {undecodable.length > 0 && !exact && !showRender && (
            <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
              <div className="notice warn" style={{ fontSize: 11.5 }}>
                This browser cannot decode {undecodable.length} clip(s) ({undecodable.map((id) => assetMap.get(id)?.name ?? id).slice(0, 2).join(', ')}) for live preview — usually H.264/H.265 in browsers without those codecs. Use “Exact frame” or “Render preview”; exports are unaffected.
              </div>
            </div>
          )}
          {job?.status === 'failed' && showRender && <div className="preview-overlay" style={{ color: 'var(--err)' }}>Preview render failed: {job.error}</div>}
        </div>
      </div>
      <div className="transport">
        <button className="icon-btn" aria-label="Go to start" onClick={() => pb().setTime(0)}>
          <ChevronFirst size={16} />
        </button>
        <button className="icon-btn" aria-label="Previous cut" title="Previous cut" onClick={() => pb().setTime([...cuts].reverse().find((c) => c < time - 0.01) ?? 0)}>
          <SkipBack size={15} />
        </button>
        <button className="icon-btn" aria-label="Previous frame" onClick={() => pb().setTime(time - 1 / fps)}>
          <StepBack size={15} />
        </button>
        <button className="btn icon primary" aria-label={playing ? 'Pause' : 'Play'} onClick={() => pb().setPlaying(!playing)} disabled={duration <= 0}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button className="icon-btn" aria-label="Next frame" onClick={() => pb().setTime(Math.min(duration, time + 1 / fps))}>
          <StepForward size={15} />
        </button>
        <button className="icon-btn" aria-label="Next cut" title="Next cut" onClick={() => pb().setTime(cuts.find((c) => c > time + 0.01) ?? duration)}>
          <SkipForward size={15} />
        </button>
        <button className="icon-btn" aria-label="Go to end" onClick={() => pb().setTime(duration)}>
          <ChevronLast size={16} />
        </button>
        <button className={`icon-btn${loop ? ' on' : ''}`} aria-label="Loop playback" aria-pressed={loop} onClick={() => setLoop(!loop)}>
          <Repeat size={14} />
        </button>
        <span className="timecode" style={{ marginLeft: 8 }}>
          {formatTimecode(time, fps)}
        </span>
        <span className="mono dim small">/ {formatTimecode(duration, fps)}</span>
        <input
          type="range"
          aria-label="Scrub"
          min={0}
          max={Math.max(0.01, duration)}
          step={1 / fps}
          value={Math.min(time, duration)}
          onChange={(e) => pb().setTime(Number(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
        <span className="small muted">
          {project.settings.width}×{project.settings.height} · {project.settings.fps} fps
        </span>
      </div>
    </div>
  );
}

function Guides({ guide, projectW, projectH }: { guide: string; projectW: number; projectH: number }) {
  if (guide === 'none') return null;
  if (guide === 'safe')
    return (
      <>
        <div className="guide" style={{ inset: '5%' }}>
          <span className="guide-label">action safe</span>
        </div>
        <div className="guide" style={{ inset: '10%' }}>
          <span className="guide-label">title safe</span>
        </div>
      </>
    );
  if (guide === 'thirds')
    return (
      <>
        {[33.33, 66.66].map((p) => (
          <div key={`v${p}`} className="guide" style={{ left: `${p}%`, top: 0, bottom: 0, width: 0 }} />
        ))}
        {[33.33, 66.66].map((p) => (
          <div key={`h${p}`} className="guide" style={{ top: `${p}%`, left: 0, right: 0, height: 0 }} />
        ))}
      </>
    );
  const ratio = guide === '9:16' ? 9 / 16 : guide === '1:1' ? 1 : guide === '4:5' ? 4 / 5 : 2.39;
  const pr = projectW / projectH;
  const w = ratio < pr ? (ratio / pr) * 100 : 100;
  const h = ratio < pr ? 100 : (pr / ratio) * 100;
  return (
    <div className="guide" style={{ left: `${(100 - w) / 2}%`, top: `${(100 - h) / 2}%`, width: `${w}%`, height: `${h}%` }}>
      <span className="guide-label">{guide}</span>
    </div>
  );
}
