import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Project } from '../../../shared/project';
import { api } from '../api';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 900;

interface HistoryEntry {
  project: Project;
  label: string;
}

export interface Selection {
  clipIds: string[];
  trackId: string | null;
  cueId: string | null;
}

interface ProjectState {
  project: Project | null;
  /** Snapshot that matches the last successful explicit save. */
  savedVersion: Project | null;
  /** Snapshot that matches the last successful autosave. */
  autosavedVersion: Project | null;
  lastSavedAt: string | null;
  lastAutosaveAt: string | null;
  saving: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: Selection;
  zoom: number;
  /** Selected storyboard shot (for the storyboard/generator link). */
  activeShotId: string | null;

  load: (p: Project) => void;
  close: () => void;
  /**
   * Apply an edit. `coalesce` merges rapid edits with the same key (e.g. slider
   * drags) into one undo step. `transient` skips history entirely (used during
   * pointer drags; call commitGesture at the end).
   */
  apply: (label: string, recipe: (d: Draft<Project>) => void, opts?: { coalesce?: string; transient?: boolean }) => void;
  beginGesture: () => void;
  commitGesture: (label: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;
  select: (sel: Partial<Selection>) => void;
  setZoom: (z: number) => void;
  setActiveShot: (id: string | null) => void;
  isDirty: () => boolean;
  save: () => Promise<Project>;
  autosave: () => Promise<void>;
}

let lastCoalesce: { key: string; at: number } | null = null;
let gestureBase: Project | null = null;

export const useProject = create<ProjectState>((set, get) => ({
  project: null,
  savedVersion: null,
  autosavedVersion: null,
  lastSavedAt: null,
  lastAutosaveAt: null,
  saving: false,
  past: [],
  future: [],
  selection: { clipIds: [], trackId: null, cueId: null },
  zoom: 60,
  activeShotId: null,

  load: (p) => {
    lastCoalesce = null;
    set({ project: p, savedVersion: p, autosavedVersion: p, lastSavedAt: p.updatedAt, past: [], future: [], selection: { clipIds: [], trackId: null, cueId: null }, activeShotId: null });
    try {
      localStorage.setItem('voidcraft:lastProject', p.id);
    } catch {
      /* ignore */
    }
  },
  close: () => set({ project: null, savedVersion: null, autosavedVersion: null, past: [], future: [], selection: { clipIds: [], trackId: null, cueId: null } }),

  apply: (label, recipe, opts = {}) => {
    const cur = get().project;
    if (!cur) return;
    const next = produce(cur, recipe);
    if (next === cur) return;
    if (opts.transient) {
      set({ project: next });
      return;
    }
    const now = Date.now();
    const merge = opts.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.at < COALESCE_MS;
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
    set((s) => ({
      project: next,
      past: merge ? s.past : [...s.past, { project: cur, label }].slice(-HISTORY_LIMIT),
      future: [],
    }));
  },
  beginGesture: () => {
    gestureBase = get().project;
  },
  commitGesture: (label) => {
    const base = gestureBase;
    gestureBase = null;
    const cur = get().project;
    if (!base || !cur || base === cur) return;
    lastCoalesce = null;
    set((s) => ({ past: [...s.past, { project: base, label }].slice(-HISTORY_LIMIT), future: [] }));
  },
  undo: () => {
    const { past, project } = get();
    if (!past.length || !project) return;
    const prev = past[past.length - 1];
    lastCoalesce = null;
    set((s) => ({ project: prev.project, past: s.past.slice(0, -1), future: [{ project, label: prev.label }, ...s.future] }));
  },
  redo: () => {
    const { future, project } = get();
    if (!future.length || !project) return;
    const next = future[0];
    lastCoalesce = null;
    set((s) => ({ project: next.project, future: s.future.slice(1), past: [...s.past, { project, label: next.label }] }));
  },
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
  redoLabel: () => get().future[0]?.label ?? null,
  select: (sel) => set((s) => ({ selection: { ...s.selection, ...sel } })),
  setZoom: (z) => set({ zoom: Math.min(400, Math.max(4, z)) }),
  setActiveShot: (id) => set({ activeShotId: id }),
  isDirty: () => get().project !== get().savedVersion,

  save: async () => {
    const p = get().project;
    if (!p) throw new Error('No project open');
    set({ saving: true });
    try {
      const saved = await api.saveProject(p);
      if (get().project === p) {
        const adopted = produce(p, (d) => {
          d.updatedAt = saved.updatedAt;
        });
        set({ project: adopted, savedVersion: adopted, autosavedVersion: adopted, lastSavedAt: saved.updatedAt });
      } else {
        // Edits happened while saving: the saved state is `p`, the project stays dirty.
        set({ savedVersion: p, lastSavedAt: saved.updatedAt });
      }
      try {
        localStorage.removeItem(`voidcraft:unsaved:${p.id}`);
      } catch {
        /* ignore */
      }
      return saved;
    } finally {
      set({ saving: false });
    }
  },
  autosave: async () => {
    const p = get().project;
    if (!p || p === get().autosavedVersion || p === get().savedVersion) return;
    try {
      const r = await api.autosave(p);
      set({ autosavedVersion: p, lastAutosaveAt: r.updatedAt });
      try {
        localStorage.removeItem(`voidcraft:unsaved:${p.id}`);
      } catch {
        /* ignore */
      }
    } catch (err) {
      // Server unreachable: keep a browser-side copy so work is not lost.
      try {
        localStorage.setItem(`voidcraft:unsaved:${p.id}`, JSON.stringify({ at: new Date().toISOString(), project: p }));
      } catch {
        /* quota */
      }
      throw err;
    }
  },
}));

/** Convenience hook: current project (throws if none — use only inside project workspaces). */
export function useCurrentProject(): Project {
  const p = useProject((s) => s.project);
  if (!p) throw new Error('No project open');
  return p;
}

interface PlaybackState {
  time: number;
  playing: boolean;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
}

/** Playhead lives in its own store so frequent updates don't re-render the whole app. */
export const usePlayback = create<PlaybackState>((set) => ({
  time: 0,
  playing: false,
  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
}));
