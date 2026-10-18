import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Captions,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  Maximize,
  Plus,
  Scissors,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Headphones,
} from 'lucide-react';
import type { Asset } from '../../../shared/api';
import type { Clip, MediaClip, Track } from '../../../shared/project';
import { addAssetClip, addCue, addTitle, addTrack, compatibleTrackKind, moveClip, moveTrack, removeTrack, trimClip } from '../../../shared/ops';
import { clipDuration, clipEnd, formatTimecode, snapTime, timelineDuration } from '../../../shared/timeline';
import { thumbUrl, waveUrl } from '../api';
import { useApp } from '../store/app';
import { useProject, usePlayback } from '../store/project';
import { deleteSelection, duplicateSelection, splitAtPlayhead } from '../lib/shortcuts';

export const ASSET_DRAG_TYPE = 'application/x-voidcraft-asset';
const RULER_H = 26;

const KIND_COLOR: Record<Track['kind'], string> = { video: 'var(--video)', audio: 'var(--audio)', text: 'var(--text-track)', subtitle: 'var(--sub-track)' };

function tickStep(zoom: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * zoom >= 70) ?? 600;
}

type Drag =
  | { kind: 'move'; clipId: string; pointerX: number; origStarts: Map<string, number>; origTrack: string; moved: boolean }
  | { kind: 'trim'; clipId: string; edge: 'left' | 'right'; assetDuration: number | null }
  | { kind: 'cue-move'; trackId: string; cueId: string; pointerX: number; origStart: number; origEnd: number }
  | { kind: 'cue-trim'; trackId: string; cueId: string; edge: 'left' | 'right' }
  | { kind: 'scrub' }
  | { kind: 'track-height'; trackId: string; startY: number; origH: number };

export function Timeline() {
  const project = useProject((s) => s.project)!;
  const zoom = useProject((s) => s.zoom);
  const selection = useProject((s) => s.selection);
  const settings = useApp((s) => s.settings);
  const assets = useApp((s) => s.assets);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [snapOn, setSnapOn] = useState(settings?.timeline.snapping ?? true);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const assetMap = useMemo(() => new Map<string, Asset>(assets.map((a) => [a.id, a])), [assets]);
  const ps = useProject.getState;
  const duration = timelineDuration(project.timeline);
  const [viewW, setViewW] = useState(800);
  const contentW = Math.max(viewW, (duration + 20) * zoom);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view during playback.
  useEffect(
    () =>
      usePlayback.subscribe((s) => {
        const el = scrollRef.current;
        if (!el || !s.playing) return;
        const x = s.time * useProject.getState().zoom;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }),
    [],
  );

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / useProject.getState().zoom);
  };
  const snap = (t: number, excludeId?: string) => {
    if (!snapOn) return t;
    const p = useProject.getState().project!;
    const cands = [0, usePlayback.getState().time];
    for (const tr of p.timeline.tracks) for (const c of tr.clips) if (c.id !== excludeId) cands.push(c.start, clipEnd(c));
    return snapTime(t, cands, 8 / useProject.getState().zoom);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = useProject.getState().project!;
      if (d.kind === 'scrub') {
        usePlayback.getState().setTime(timeAt(e.clientX));
      } else if (d.kind === 'move') {
        const dx = (e.clientX - d.pointerX) / useProject.getState().zoom;
        if (!d.moved && Math.abs(e.clientX - d.pointerX) < 3) return;
        d.moved = true;
        const primaryStart = d.origStarts.get(d.clipId)!;
        const clip = p.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
        if (!clip) return;
        const dur = clipDuration(clip);
        let ns = Math.max(0, primaryStart + dx);
        const sStart = snap(ns, d.clipId);
        const sEnd = snap(ns + dur, d.clipId) - dur;
        ns = Math.abs(sStart - ns) <= Math.abs(sEnd - ns) ? sStart : sEnd;
        const delta = ns - primaryStart;
        const laneEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track-id]');
        const toTrack = d.origStarts.size === 1 ? laneEl?.dataset.trackId : undefined;
        ps().apply(
          'Move clip',
          (draft) => {
            for (const [id, s0] of d.origStarts) moveClip(draft, id, Math.max(0, s0 + delta), id === d.clipId ? toTrack : undefined);
          },
          { transient: true },
        );
      } else if (d.kind === 'trim') {
        const t = snap(timeAt(e.clientX), d.clipId);
        ps().apply('Trim clip', (draft) => void trimClip(draft, d.clipId, d.edge, t, d.assetDuration), { transient: true });
      } else if (d.kind === 'cue-move') {
        const dx = (e.clientX - d.pointerX) / useProject.getState().zoom;
        const len = d.origEnd - d.origStart;
        const ns = Math.max(0, snap(d.origStart + dx));
        ps().apply(
          'Move subtitle',
          (draft) => {
            const cue = draft.timeline.tracks.find((t) => t.id === d.trackId)?.cues.find((c) => c.id === d.cueId);
            if (cue) {
              cue.start = ns;
              cue.end = ns + len;
            }
          },
          { transient: true },
        );
      } else if (d.kind === 'cue-trim') {
        const t = snap(timeAt(e.clientX));
        ps().apply(
          'Trim subtitle',
          (draft) => {
            const cue = draft.timeline.tracks.find((tr) => tr.id === d.trackId)?.cues.find((c) => c.id === d.cueId);
            if (!cue) return;
            if (d.edge === 'left') cue.start = Math.min(t, cue.end - 0.2);
            else cue.end = Math.max(t, cue.start + 0.2);
          },
          { transient: true },
        );
      } else if (d.kind === 'track-height') {
        const h = Math.min(240, Math.max(28, d.origH + e.clientY - d.startY));
        ps().apply(
          'Resize track',
          (draft) => {
            const tr = draft.timeline.tracks.find((t) => t.id === d.trackId);
            if (tr) tr.height = h;
          },
          { transient: true },
        );
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || d.kind === 'scrub') return;
      const labels: Record<string, string> = { move: 'Move clip', trim: 'Trim clip', 'cue-move': 'Move subtitle', 'cue-trim': 'Trim subtitle', 'track-height': 'Resize track' };
      ps().commitGesture(labels[d.kind]);
      if (d.kind === 'cue-move' || d.kind === 'cue-trim') {
        ps().apply('Sort subtitles', (draft) => {
          const tr = draft.timeline.tracks.find((t) => t.id === d.trackId);
          tr?.cues.sort((a, b) => a.start - b.start);
        }, { transient: true });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapOn]);

  const startClipDrag = (e: React.PointerEvent, track: Track, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sel = useProject.getState().selection.clipIds;
    let ids: string[];
    if (e.shiftKey || e.ctrlKey || e.metaKey) ids = sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id];
    else ids = sel.includes(clip.id) ? sel : [clip.id];
    ps().select({ clipIds: ids, trackId: track.id, cueId: null });
    if (track.locked) return;
    const p = useProject.getState().project!;
    const origStarts = new Map<string, number>();
    for (const t of p.timeline.tracks) for (const c of t.clips) if (ids.includes(c.id) && !t.locked) origStarts.set(c.id, c.start);
    if (!origStarts.has(clip.id)) origStarts.set(clip.id, clip.start);
    ps().beginGesture();
    dragRef.current = { kind: 'move', clipId: clip.id, pointerX: e.clientX, origStarts, origTrack: track.id, moved: false };
  };

  const startTrim = (e: React.PointerEvent, track: Track, clip: Clip, edge: 'left' | 'right') => {
    e.stopPropagation();
    if (track.locked) return;
    ps().select({ clipIds: [clip.id], trackId: track.id, cueId: null });
    ps().beginGesture();
    const asset = clip.kind === 'media' ? assetMap.get(clip.assetId) : undefined;
    dragRef.current = { kind: 'trim', clipId: clip.id, edge, assetDuration: clip.kind === 'media' ? (asset?.type === 'image' ? null : asset?.duration ?? null) : null };
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    setDropTrack(null);
    const raw = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    const asset = JSON.parse(raw) as Asset;
    if (track.locked) return useApp.getState().toast('warn', 'That track is locked');
    if (!compatibleTrackKind(asset).includes(track.kind)) return useApp.getState().toast('warn', `${asset.type} files cannot go on a ${track.kind} track`);
    const start = snap(timeAt(e.clientX));
    let createdId: string | null = null;
    ps().apply('Add clip', (d) => {
      const c = addAssetClip(d, asset, { trackId: track.id, start });
      createdId = c?.id ?? null;
    });
    if (createdId) ps().select({ clipIds: [createdId], trackId: track.id });
  };

  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t * zoom <= contentW; t += step) ticks.push(Math.round(t * 1000) / 1000);
  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    ps().setZoom(Math.max(4, (el.clientWidth - 40) / Math.max(5, duration)));
    el.scrollLeft = 0;
  };

  return (
    <div className="timeline" aria-label="Timeline">
      <div className="timeline-toolbar">
        <div style={{ position: 'relative' }}>
          <button className="btn sm" onClick={() => setAddOpen(!addOpen)} aria-expanded={addOpen}>
            <Plus size={13} /> Track
          </button>
          {addOpen && (
            <div className="menu" onMouseLeave={() => setAddOpen(false)}>
              {(['video', 'audio', 'text', 'subtitle'] as const).map((k) => (
                <button key={k} className="menu-item" onClick={() => { ps().apply(`Add ${k} track`, (d) => void addTrack(d, k)); setAddOpen(false); }}>
                  {k === 'video' ? 'Video track' : k === 'audio' ? 'Audio track' : k === 'text' ? 'Title track' : 'Subtitle track'}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" title="Split at playhead (S)" aria-label="Split at playhead" onClick={splitAtPlayhead}>
          <Scissors size={14} />
        </button>
        <button className="icon-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate" disabled={!selection.clipIds.length} onClick={duplicateSelection}>
          <Copy size={14} />
        </button>
        <button className="icon-btn" title="Delete (Del)" aria-label="Delete selection" disabled={!selection.clipIds.length && !selection.cueId} onClick={deleteSelection}>
          <Trash2 size={14} />
        </button>
        <button className="icon-btn" title="Add title at playhead" aria-label="Add title" onClick={() => { let id: string | null = null; ps().apply('Add title', (d) => { id = addTitle(d, 'New title', usePlayback.getState().time); }); if (id) ps().select({ clipIds: [id] }); }}>
          <Type size={14} />
        </button>
        <button className="icon-btn" title="Add subtitle at playhead" aria-label="Add subtitle" onClick={() => { let id = ''; ps().apply('Add subtitle', (d) => { id = addCue(d, usePlayback.getState().time, usePlayback.getState().time + 2.5, 'Subtitle text'); }); ps().select({ cueId: id, clipIds: [] }); }}>
          <Captions size={14} />
        </button>
        <button className={`icon-btn${snapOn ? ' on' : ''}`} title="Snapping" aria-label="Toggle snapping" aria-pressed={snapOn} onClick={() => setSnapOn(!snapOn)}>
          <Magnet size={14} />
        </button>
        <div className="grow" />
        <span className="small dim">{project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · {formatTimecode(duration, project.settings.fps)}</span>
        <button className="icon-btn" aria-label="Zoom out" onClick={() => ps().setZoom(zoom / 1.25)}>
          <ZoomOut size={14} />
        </button>
        <input type="range" aria-label="Timeline zoom" min={4} max={400} value={zoom} onChange={(e) => ps().setZoom(Number(e.target.value))} style={{ width: 110, accentColor: 'var(--accent)' }} />
        <button className="icon-btn" aria-label="Zoom in" onClick={() => ps().setZoom(zoom * 1.25)}>
          <ZoomIn size={14} />
        </button>
        <button className="icon-btn" aria-label="Fit timeline" title="Fit to window" onClick={fit}>
          <Maximize size={14} />
        </button>
      </div>
      <div className="timeline-body">
        <div className="track-headers" ref={headersRef}>
          <div style={{ height: RULER_H, borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }} />
          {project.timeline.tracks.map((track, i) => (
            <TrackHeader key={track.id} track={track} index={i} count={project.timeline.tracks.length} onResizeStart={(e) => {
              e.preventDefault();
              ps().beginGesture();
              dragRef.current = { kind: 'track-height', trackId: track.id, startY: e.clientY, origH: track.height };
            }} />
          ))}
        </div>
        <div
          className="lanes-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            if (headersRef.current) headersRef.current.scrollTop = (e.target as HTMLDivElement).scrollTop;
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              ps().setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
            }
          }}
        >
          <div style={{ width: contentW, position: 'relative' }}>
            <div
              className="ruler"
              onPointerDown={(e) => {
                dragRef.current = { kind: 'scrub' };
                usePlayback.getState().setTime(timeAt(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <div key={t}>
                  <div className="ruler-tick" style={{ left: t * zoom, height: 10 }} />
                  <div className="ruler-tick" style={{ left: (t + step / 2) * zoom, height: 5 }} />
                  <div className="ruler-label" style={{ left: t * zoom }}>
                    {formatTimecode(t, project.settings.fps).replace(/:\d\d$/, '')}
                  </div>
                </div>
              ))}
            </div>
            {project.timeline.tracks.map((track) => (
              <div
                key={track.id}
                data-track-id={track.id}
                className={`lane${dropTrack === track.id ? ' drop-ok' : ''}${track.locked ? ' locked' : ''}`}
                style={{ height: track.height }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  ps().select({ clipIds: [], cueId: null, trackId: track.id });
                  usePlayback.getState().setTime(timeAt(e.clientX));
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  if (dropTrack !== track.id) setDropTrack(track.id);
                }}
                onDragLeave={() => setDropTrack(null)}
                onDrop={(e) => onDrop(e, track)}
              >
                {track.kind === 'subtitle'
                  ? track.cues.map((cue) => (
                      <div
                        key={cue.id}
                        className={`clip cue${selection.cueId === cue.id ? ' selected' : ''}${track.hidden ? ' dimmed' : ''}`}
                        style={{ left: cue.start * zoom, width: Math.max(4, (cue.end - cue.start) * zoom) }}
                        title={cue.text}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          ps().select({ cueId: cue.id, clipIds: [], trackId: track.id });
                          if (track.locked) return;
                          ps().beginGesture();
                          dragRef.current = { kind: 'cue-move', trackId: track.id, cueId: cue.id, pointerX: e.clientX, origStart: cue.start, origEnd: cue.end };
                        }}
                      >
                        <div className="clip-label ellipsis">{cue.text}</div>
                        {(['left', 'right'] as const).map((edge) => (
                          <div
                            key={edge}
                            className={`clip-handle ${edge === 'left' ? 'l' : 'r'}`}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              if (track.locked) return;
                              ps().select({ cueId: cue.id, clipIds: [] });
                              ps().beginGesture();
                              dragRef.current = { kind: 'cue-trim', trackId: track.id, cueId: cue.id, edge };
                            }}
                          />
                        ))}
                      </div>
                    ))
                  : track.clips.map((clip) => (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        track={track}
                        zoom={zoom}
                        asset={clip.kind === 'media' ? assetMap.get(clip.assetId) : undefined}
                        selected={selection.clipIds.includes(clip.id)}
                        onPointerDown={(e) => startClipDrag(e, track, clip)}
                        onTrim={(e, edge) => startTrim(e, track, clip, edge)}
                      />
                    ))}
              </div>
            ))}
            <Playhead zoom={zoom} />
            {project.timeline.tracks.length === 0 && <div className="empty small">No tracks. Use “+ Track” to add one.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Playhead({ zoom }: { zoom: number }) {
  const t = usePlayback((s) => s.time);
  return <div className="playhead" style={{ left: t * zoom }} />;
}

function ClipView({ clip, track, zoom, asset, selected, onPointerDown, onTrim }: { clip: Clip; track: Track; zoom: number; asset?: Asset; selected: boolean; onPointerDown: (e: React.PointerEvent) => void; onTrim: (e: React.PointerEvent, edge: 'left' | 'right') => void }) {
  const dur = clipDuration(clip);
  const w = Math.max(4, dur * zoom);
  const style: CSSProperties = { left: clip.start * zoom, width: w };
  let cls = 'clip';
  let label = '';
  let wave: CSSProperties | null = null;
  if (clip.kind === 'text') {
    cls += ' text';
    label = clip.text.split('\n')[0] || '(empty title)';
  } else {
    const m = clip as MediaClip;
    label = m.label ?? asset?.name ?? 'Media';
    if (!asset) {
      cls += ' offline';
      label = `Offline: ${label}`;
    } else if (track.kind === 'audio') {
      cls += ' audio';
      const wu = waveUrl(asset);
      if (wu && asset.duration) {
        const full = (asset.duration / m.speed) * zoom;
        wave = { backgroundImage: `url(${wu})`, backgroundSize: `${full}px 100%`, backgroundPositionX: `${-(m.in / m.speed) * zoom}px` };
      }
    } else {
      cls += ' video';
      const tu = thumbUrl(asset);
      if (tu) Object.assign(style, { backgroundImage: `linear-gradient(rgba(20,12,40,0.25), rgba(20,12,40,0.25)), url(${tu})` });
    }
    if (m.speed !== 1) label += ` · ${m.speed}×`;
  }
  if (selected) cls += ' selected';
  if (track.hidden || (clip.kind === 'media' && clip.muted && track.kind === 'audio')) cls += ' dimmed';
  const m = clip.kind === 'media' ? clip : null;
  const keyTimes = m ? [...new Set(Object.values(m.keyframes).flatMap((ks) => (ks ?? []).map((k) => k.t)))] : [];
  return (
    <div className={cls} style={style} onPointerDown={onPointerDown} title={label} role="button" aria-label={`Clip ${label}`} aria-pressed={selected}>
      {wave && <div className="clip-wave" style={wave} />}
      {m && m.transitionIn.type !== 'none' && <div className="clip-transition" style={{ width: Math.min(w, m.transitionIn.duration * zoom) }} />}
      {clip.fadeIn > 0 && <div className="clip-fade in" style={{ width: Math.min(w / 2, clip.fadeIn * zoom) }} />}
      {clip.fadeOut > 0 && <div className="clip-fade out" style={{ width: Math.min(w / 2, clip.fadeOut * zoom) }} />}
      <div className="clip-label ellipsis">{label}</div>
      {selected && keyTimes.map((t) => <div key={t} className="kf" style={{ left: t * zoom }} />)}
      {!track.locked && (
        <>
          <div className="clip-handle l" onPointerDown={(e) => onTrim(e, 'left')} />
          <div className="clip-handle r" onPointerDown={(e) => onTrim(e, 'right')} />
        </>
      )}
    </div>
  );
}

function TrackHeader({ track, index, count, onResizeStart }: { track: Track; index: number; count: number; onResizeStart: (e: React.PointerEvent) => void }) {
  const ps = useProject.getState;
  const [name, setName] = useState(track.name);
  useEffect(() => setName(track.name), [track.name]);
  const toggle = (key: 'muted' | 'hidden' | 'locked' | 'solo' | 'burnIn', label: string) => ps().apply(label, (d) => {
    const t = d.timeline.tracks.find((x) => x.id === track.id);
    if (t) t[key] = !t[key];
  });
  const remove = async () => {
    const n = track.clips.length + track.cues.length;
    if (n > 0 && !(await useApp.getState().confirm({ title: 'Delete track?', message: `"${track.name}" contains ${n} item(s). Delete the track and its contents? (You can undo this.)`, confirmLabel: 'Delete track', danger: true }))) return;
    ps().apply('Delete track', (d) => void removeTrack(d, track.id));
  };
  return (
    <div className="track-header" style={{ height: track.height }}>
      <div className="kind" style={{ background: KIND_COLOR[track.kind] }} />
      <input
        aria-label="Track name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== track.name && ps().apply('Rename track', (d) => {
          const t = d.timeline.tracks.find((x) => x.id === track.id);
          if (t) t.name = name.trim().slice(0, 100);
        })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {(track.kind === 'video' || track.kind === 'audio') && (
        <button className={`icon-btn${track.muted ? ' on' : ''}`} title={track.muted ? 'Unmute' : 'Mute'} aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`} aria-pressed={track.muted} onClick={() => toggle('muted', 'Toggle mute')}>
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      {track.kind === 'audio' && (
        <button className={`icon-btn${track.solo ? ' on' : ''}`} title="Solo" aria-label={`Solo ${track.name}`} aria-pressed={track.solo} onClick={() => toggle('solo', 'Toggle solo')}>
          <Headphones size={13} />
        </button>
      )}
      {track.kind !== 'audio' && (
        <button className={`icon-btn${track.hidden ? ' on' : ''}`} title={track.hidden ? 'Show' : 'Hide'} aria-label={`${track.hidden ? 'Show' : 'Hide'} ${track.name}`} aria-pressed={track.hidden} onClick={() => toggle('hidden', 'Toggle visibility')}>
          {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      )}
      <button className={`icon-btn${track.locked ? ' on' : ''}`} title={track.locked ? 'Unlock' : 'Lock'} aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`} aria-pressed={track.locked} onClick={() => toggle('locked', 'Toggle lock')}>
        {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
      </button>
      {track.height >= 50 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <button className="icon-btn" style={{ height: 16 }} aria-label="Move track up" disabled={index === 0} onClick={() => ps().apply('Reorder track', (d) => moveTrack(d, track.id, -1))}>
            <ArrowUp size={11} />
          </button>
          <button className="icon-btn" style={{ height: 16 }} aria-label="Move track down" disabled={index === count - 1} onClick={() => ps().apply('Reorder track', (d) => moveTrack(d, track.id, 1))}>
            <ArrowDown size={11} />
          </button>
        </div>
      )}
      <button className="icon-btn" title="Delete track" aria-label={`Delete ${track.name}`} onClick={() => void remove()}>
        <Trash2 size={12} />
      </button>
      <div className="track-resize" onPointerDown={onResizeStart} />
    </div>
  );
}
