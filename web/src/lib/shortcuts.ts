import { useEffect } from 'react';
import { splitAt, deleteClips, duplicateClips, setKeyframe } from '../../../shared/ops';
import { findClip, keyframeValue, timelineDuration } from '../../../shared/timeline';
import { useApp } from '../store/app';
import { useProject, usePlayback } from '../store/project';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export function splitAtPlayhead() {
  const ps = useProject.getState();
  const t = usePlayback.getState().time;
  const ids = ps.selection.clipIds.length ? ps.selection.clipIds : undefined;
  let created: string[] = [];
  ps.apply('Split clip', (d) => {
    created = splitAt(d, t, ids);
  });
  if (!created.length) useApp.getState().toast('info', 'Nothing to split at the playhead');
}

export function deleteSelection() {
  const ps = useProject.getState();
  const ripple = useApp.getState().settings?.timeline.rippleDelete ?? false;
  if (ps.selection.cueId) {
    const cueId = ps.selection.cueId;
    ps.apply('Delete subtitle', (d) => {
      for (const t of d.timeline.tracks) t.cues = t.cues.filter((c) => c.id !== cueId);
    });
    ps.select({ cueId: null });
    return;
  }
  if (!ps.selection.clipIds.length) return;
  const ids = ps.selection.clipIds;
  ps.apply(ids.length > 1 ? 'Delete clips' : 'Delete clip', (d) => void deleteClips(d, ids, ripple));
  ps.select({ clipIds: [] });
}

export function duplicateSelection() {
  const ps = useProject.getState();
  if (!ps.selection.clipIds.length) return;
  let created: string[] = [];
  ps.apply('Duplicate', (d) => {
    created = duplicateClips(d, ps.selection.clipIds);
  });
  ps.select({ clipIds: created });
}

export function addKeyframeAtPlayhead() {
  const ps = useProject.getState();
  const p = ps.project;
  const id = ps.selection.clipIds[0];
  if (!p || !id) return useApp.getState().toast('info', 'Select a clip to add keyframes');
  const found = findClip(p, id);
  if (!found || found.clip.kind !== 'media') return;
  const clip = found.clip;
  const local = usePlayback.getState().time - clip.start;
  if (local < 0) return useApp.getState().toast('info', 'Move the playhead over the selected clip');
  ps.apply('Add keyframes', (d) => {
    for (const prop of ['opacity', 'scale', 'x', 'y'] as const) setKeyframe(d, id, prop, local, keyframeValue(clip, prop, local));
  });
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || useApp.getState().dialog) return;
      const ps = useProject.getState();
      const pb = usePlayback.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        ps.undo();
        return;
      }
      if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) {
        e.preventDefault();
        ps.redo();
        return;
      }
      if (mod && key === '\\') {
        e.preventDefault();
        useApp.getState().togglePanel('timeline');
        return;
      }
      if (!ps.project) return;
      if (mod && key === 'e') {
        e.preventDefault();
        useApp.getState().setDialog({ kind: 'export' });
        return;
      }
      const fps = ps.project.settings.fps;
      if (key === ' ') {
        e.preventDefault();
        pb.setPlaying(!pb.playing);
      } else if (key === 's' && !mod) splitAtPlayhead();
      else if (key === 'delete' || key === 'backspace') deleteSelection();
      else if (mod && key === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (key === 'arrowleft') {
        e.preventDefault();
        pb.setTime(pb.time - (e.shiftKey ? 1 : 1 / fps));
      } else if (key === 'arrowright') {
        e.preventDefault();
        pb.setTime(pb.time + (e.shiftKey ? 1 : 1 / fps));
      } else if (key === 'home') pb.setTime(0);
      else if (key === 'end') pb.setTime(timelineDuration(ps.project.timeline));
      else if (key === '=' || key === '+') ps.setZoom(ps.zoom * 1.25);
      else if (key === '-') ps.setZoom(ps.zoom / 1.25);
      else if (key === 'k') addKeyframeAtPlayhead();
      else if (key === 'escape') ps.select({ clipIds: [], cueId: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
