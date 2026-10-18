import type { AppSettings, Asset, JobRecord, ProviderInfo, SystemStatus } from '../../shared/api';
import type { ExportSettings, Project, ProjectSummary } from '../../shared/project';
import type { ProjectTemplate } from '../../shared/factory';

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Voidcraft server. Is it running?', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = data as { error?: string; details?: unknown } | null;
    const details = Array.isArray(d?.details) ? ` (${(d!.details as string[]).slice(0, 3).join('; ')})` : '';
    throw new ApiError((d?.error ?? `Request failed (${res.status})`) + details, res.status, d?.details);
  }
  return data as T;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Upload with progress (XHR, since fetch has no upload progress events). */
export function uploadFile(file: File | Blob, fields: Record<string, string> = {}, onProgress?: (p: UploadProgress) => void, url = '/api/assets'): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', file, file instanceof File ? file.name : 'recording.webm');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => onProgress?.({ loaded: e.loaded, total: e.total });
    xhr.onload = () => {
      let data: { error?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as Asset);
      else reject(new ApiError(data?.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: network error', 0));
    xhr.send(form);
  });
}

export interface EngineModelView {
  id: string;
  name: string;
  pipeline: string;
  tasks: string[];
  diskGB: number;
  minVramGB: number;
  fps: number;
  durations: number[];
  sizes: Record<string, [number, number]>;
  license: string;
  notes: string;
  installed: boolean;
  estimate: string;
  test?: boolean;
}

export interface EngineView {
  status: {
    state: 'checking' | 'no-python' | 'not-installed' | 'ready' | 'error';
    message: string;
    python: string | null;
    systemPython: string | null;
    torch: string | null;
    diffusers: string | null;
    device: 'cuda' | 'mps' | 'cpu' | null;
    gpu: string | null;
    vramGB: number | null;
    cpuThreads: number | null;
    installed: Record<string, boolean>;
    engineDir: string;
    modelsDir: string;
    checkedAt: string | null;
  };
  recommended: string | null;
  models: EngineModelView[];
}

export const api = {
  engine: () => call<EngineView>('GET', '/api/engine'),
  refreshEngine: () => call<EngineView>('POST', '/api/engine/refresh'),
  installEngine: (cpu = false) => call<JobRecord>('POST', '/api/engine/setup', { cpu }),
  downloadModel: (id: string) => call<JobRecord>('POST', `/api/engine/models/${id}/download`),
  deleteModel: (id: string) => call<EngineView & { removedBytes: number }>('DELETE', `/api/engine/models/${id}`),

  system: () => call<SystemStatus>('GET', '/api/system'),
  clearTemp: () => call<{ freedBytes: number }>('POST', '/api/system/clear-temp'),
  settings: () => call<AppSettings>('GET', '/api/settings'),
  patchSettings: (patch: Partial<AppSettings> | Record<string, unknown>) => call<AppSettings>('PATCH', '/api/settings', patch),
  resetSettings: () => call<AppSettings>('POST', '/api/settings/reset'),

  providers: () => call<ProviderInfo[]>('GET', '/api/providers'),
  setCredentials: (id: string, values: Record<string, string>) => call<ProviderInfo>('PUT', `/api/providers/${id}/credentials`, values),
  clearCredentials: (id: string) => call<ProviderInfo>('DELETE', `/api/providers/${id}/credentials`),
  testProvider: (id: string) => call<{ ok: boolean; message: string }>('POST', `/api/providers/${id}/test`),

  projects: () => call<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => call<Project>('GET', `/api/projects/${id}`),
  createProject: (body: { name: string; aspectRatio?: string; resolution?: string; fps?: number; templateId?: string | null }) => call<Project>('POST', '/api/projects', body),
  saveProject: (p: Project) => call<Project>('PUT', `/api/projects/${p.id}`, p),
  autosave: (p: Project) => call<{ updatedAt: string }>('POST', `/api/projects/${p.id}/autosave`, p),
  recovery: (id: string) => call<{ updatedAt: string; project: Project } | null>('GET', `/api/projects/${id}/recovery`),
  discardRecovery: (id: string) => call<{ ok: true }>('DELETE', `/api/projects/${id}/recovery`),
  duplicateProject: (id: string, name?: string) => call<Project>('POST', `/api/projects/${id}/duplicate`, { name }),
  renameProject: (id: string, name: string) => call<Project>('POST', `/api/projects/${id}/rename`, { name }),
  saveAs: (project: Project, name: string) => call<Project>('POST', '/api/projects/save-as', { project, name }),
  deleteProject: (id: string) => call<{ ok: true }>('DELETE', `/api/projects/${id}`, { confirm: true }),
  saveAsTemplate: (id: string, name: string, description: string) => call<ProjectTemplate>('POST', `/api/projects/${id}/template`, { name, description }),
  importProject: (file: File, onProgress?: (p: UploadProgress) => void) =>
    uploadFile(file, {}, onProgress, '/api/projects/import') as unknown as Promise<{ project: Project; warnings: string[] }>,

  templates: () => call<ProjectTemplate[]>('GET', '/api/templates'),
  deleteTemplate: (id: string) => call<{ ok: true }>('DELETE', `/api/templates/${id}`),
  prompts: () => call<Array<{ id: string; title: string; prompt: string; negative: string; tags: string[]; createdAt: string }>>('GET', '/api/prompts'),
  savePrompt: (b: { title: string; prompt: string; negative?: string; tags?: string[] }) => call<{ id: string }>('POST', '/api/prompts', b),
  deletePrompt: (id: string) => call<{ ok: true }>('DELETE', `/api/prompts/${id}`),

  assets: () => call<Asset[]>('GET', '/api/assets'),
  patchAsset: (id: string, patch: Partial<Pick<Asset, 'name' | 'tags' | 'favorite' | 'projectIds'>>) => call<Asset>('PATCH', `/api/assets/${id}`, patch),
  deleteAsset: (id: string) => call<{ ok: true }>('DELETE', `/api/assets/${id}`),

  jobs: () => call<JobRecord[]>('GET', '/api/jobs'),
  createJob: (body: { task: JobRecord['task']; providerId: string; modelId: string; params: Record<string, unknown>; projectId?: string | null; shotId?: string | null }) =>
    call<JobRecord[]>('POST', '/api/jobs', body),
  cancelJob: (id: string) => call<JobRecord>('POST', `/api/jobs/${id}/cancel`),
  retryJob: (id: string) => call<JobRecord[]>('POST', `/api/jobs/${id}/retry`),
  deleteJob: (id: string) => call<{ ok: true }>('DELETE', `/api/jobs/${id}`),

  startExport: (project: Project, settings: ExportSettings, opts: { preview?: boolean; range?: { start: number; end: number } | null } = {}) =>
    call<JobRecord>('POST', '/api/exports', { project, settings, ...opts }),
  async renderFrame(project: Project, t: number, width?: number): Promise<string> {
    const res = await fetch('/api/render/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, t, width }) });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new ApiError((d as { error?: string }).error ?? 'Frame render failed', res.status);
    }
    return URL.createObjectURL(await res.blob());
  },

  ai: <T>(task: string, providerId: string, input: unknown) => call<{ result: T; providerId: string; isAI: boolean }>('POST', `/api/ai/${task}`, { providerId, input }),
};

export function mediaUrl(a: Pick<Asset, 'id' | 'fileName'>): string {
  return `/media/${a.id}/${a.fileName}`;
}
export function thumbUrl(a: Pick<Asset, 'id' | 'hasThumbnail'> | undefined | null): string | null {
  return a?.hasThumbnail ? `/media/${a.id}/thumb.jpg` : null;
}
export function waveUrl(a: Pick<Asset, 'id' | 'hasWaveform'> | undefined | null): string | null {
  return a?.hasWaveform ? `/media/${a.id}/waveform.png` : null;
}

/** Subscribe to server-sent job events; reconnects automatically. */
export function subscribeJobs(onJob: (j: JobRecord) => void, onState?: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const connect = () => {
    es = new EventSource('/api/events');
    es.addEventListener('job', (e) => onJob(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => onState?.(true);
    es.onerror = () => {
      onState?.(false);
      if (es?.readyState === EventSource.CLOSED && !closed) setTimeout(connect, 3000);
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
