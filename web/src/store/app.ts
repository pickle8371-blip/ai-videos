import { create } from 'zustand';
import type { AppSettings, Asset, JobRecord, ProviderInfo, SystemStatus } from '../../../shared/api';
import type { ProjectTemplate } from '../../../shared/factory';
import { api } from '../api';

export type Workspace =
  | 'home'
  | 'generate'
  | 'image-to-video'
  | 'video-to-video'
  | 'storyboard'
  | 'characters'
  | 'scenes'
  | 'editor'
  | 'audio'
  | 'effects'
  | 'ai-tools'
  | 'templates'
  | 'assets'
  | 'history'
  | 'project-settings'
  | 'settings';

/** Default panel layout per workspace; the user can override with the View menu. */
export const WORKSPACE_LAYOUT: Record<Workspace, { right: boolean; timeline: boolean; needsProject: boolean }> = {
  home: { right: false, timeline: false, needsProject: false },
  generate: { right: true, timeline: true, needsProject: false },
  'image-to-video': { right: true, timeline: true, needsProject: false },
  'video-to-video': { right: true, timeline: true, needsProject: false },
  storyboard: { right: false, timeline: false, needsProject: true },
  characters: { right: false, timeline: false, needsProject: true },
  scenes: { right: false, timeline: false, needsProject: true },
  editor: { right: true, timeline: true, needsProject: true },
  audio: { right: true, timeline: true, needsProject: true },
  effects: { right: true, timeline: true, needsProject: true },
  'ai-tools': { right: false, timeline: false, needsProject: false },
  templates: { right: false, timeline: false, needsProject: false },
  assets: { right: false, timeline: false, needsProject: false },
  history: { right: false, timeline: false, needsProject: false },
  'project-settings': { right: false, timeline: false, needsProject: true },
  settings: { right: false, timeline: false, needsProject: false },
};

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'err';
  message: string;
  action?: { label: string; run: () => void };
}

export interface Notice {
  id: number;
  kind: Toast['kind'];
  message: string;
  at: string;
  read: boolean;
}

interface AppState {
  workspace: Workspace;
  setWorkspace: (w: Workspace) => void;
  system: SystemStatus | null;
  settings: AppSettings | null;
  providers: ProviderInfo[];
  assets: Asset[];
  jobs: JobRecord[];
  templates: ProjectTemplate[];
  sseConnected: boolean;
  serverError: string | null;
  toasts: Toast[];
  notices: Notice[];
  sidebarCollapsed: boolean;
  panelOverrides: Partial<Record<Workspace, { right?: boolean; timeline?: boolean }>>;
  dialog: null | { kind: 'new-project' } | { kind: 'export' } | { kind: 'open-project' } | { kind: 'shortcuts' } | { kind: 'about' } | { kind: 'save-as' } | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void };

  toast: (kind: Toast['kind'], message: string, action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  markNoticesRead: () => void;
  setDialog: (d: AppState['dialog']) => void;
  confirm: (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  toggleSidebar: () => void;
  togglePanel: (panel: 'right' | 'timeline') => void;
  panelVisible: (panel: 'right' | 'timeline') => boolean;

  refreshAll: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshAssets: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshTemplates: () => Promise<void>;
  upsertJob: (j: JobRecord) => void;
  upsertAsset: (a: Asset) => void;
  removeAsset: (id: string) => void;
  setSettings: (s: AppSettings) => void;
  setSse: (c: boolean) => void;
}

let toastSeq = 1;

function loadOverrides(): AppState['panelOverrides'] {
  try {
    return JSON.parse(localStorage.getItem('voidcraft:panels') ?? '{}');
  } catch {
    return {};
  }
}

export const useApp = create<AppState>((set, get) => ({
  workspace: 'home',
  setWorkspace: (w) => {
    set({ workspace: w });
    try {
      sessionStorage.setItem('voidcraft:workspace', w);
    } catch {
      /* ignore */
    }
  },
  system: null,
  settings: null,
  providers: [],
  assets: [],
  jobs: [],
  templates: [],
  sseConnected: false,
  serverError: null,
  toasts: [],
  notices: [],
  sidebarCollapsed: false,
  panelOverrides: loadOverrides(),
  dialog: null,

  toast: (kind, message, action) => {
    const id = toastSeq++;
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, kind, message, action }],
      notices: [{ id, kind, message, at: new Date().toISOString(), read: false }, ...s.notices].slice(0, 100),
    }));
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 9000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markNoticesRead: () => set((s) => ({ notices: s.notices.map((n) => ({ ...n, read: true })) })),
  setDialog: (dialog) => set({ dialog }),
  confirm: (opts) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        set({ dialog: null });
        resolve(v);
      };
      set({ dialog: { kind: 'confirm', title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel ?? 'Confirm', danger: opts.danger, onConfirm: () => done(true) } });
      // Resolve false when the dialog is closed any other way.
      const unsub = useApp.subscribe((s) => {
        if (s.dialog?.kind !== 'confirm') {
          unsub();
          done(false);
        }
      });
    }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  togglePanel: (panel) => {
    const { workspace, panelOverrides } = get();
    const cur = get().panelVisible(panel);
    const next = { ...panelOverrides, [workspace]: { ...panelOverrides[workspace], [panel]: !cur } };
    set({ panelOverrides: next });
    try {
      localStorage.setItem('voidcraft:panels', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  },
  panelVisible: (panel) => {
    const { workspace, panelOverrides } = get();
    return panelOverrides[workspace]?.[panel] ?? WORKSPACE_LAYOUT[workspace][panel];
  },

  refreshAll: async () => {
    try {
      await Promise.all([get().refreshSystem(), get().refreshSettings(), get().refreshProviders(), get().refreshAssets(), get().refreshJobs(), get().refreshTemplates()]);
      set({ serverError: null });
    } catch (err) {
      set({ serverError: (err as Error).message });
    }
  },
  refreshSystem: async () => set({ system: await api.system() }),
  refreshSettings: async () => {
    const s = await api.settings();
    get().setSettings(s);
  },
  refreshProviders: async () => set({ providers: await api.providers() }),
  refreshAssets: async () => set({ assets: await api.assets() }),
  refreshJobs: async () => set({ jobs: await api.jobs() }),
  refreshTemplates: async () => set({ templates: await api.templates() }),
  upsertJob: (j) =>
    set((s) => {
      const idx = s.jobs.findIndex((x) => x.id === j.id);
      if (idx < 0) return { jobs: [j, ...s.jobs] };
      const jobs = s.jobs.slice();
      jobs[idx] = j;
      return { jobs };
    }),
  upsertAsset: (a) =>
    set((s) => {
      const idx = s.assets.findIndex((x) => x.id === a.id);
      if (idx < 0) return { assets: [a, ...s.assets] };
      const assets = s.assets.slice();
      assets[idx] = a;
      return { assets };
    }),
  removeAsset: (id) => set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  setSettings: (settings) => {
    set({ settings });
    const root = document.documentElement;
    root.dataset.accent = settings.appearance.accent;
    root.dataset.density = settings.appearance.density;
    root.dataset.reducedMotion = String(settings.appearance.reducedMotion);
  },
  setSse: (c) => set({ sseConnected: c }),
}));

export function assetById(id: string | null | undefined): Asset | undefined {
  if (!id) return undefined;
  return useApp.getState().assets.find((a) => a.id === id);
}

export function useAsset(id: string | null | undefined): Asset | undefined {
  return useApp((s) => (id ? s.assets.find((a) => a.id === id) : undefined));
}
