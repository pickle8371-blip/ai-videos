/** App-level actions shared by menus, the home screen and keyboard shortcuts. */
import type { Asset, JobRecord } from '../../../shared/api';
import type { Project } from '../../../shared/project';
import { addAssetClip, appendShotsToTimeline } from '../../../shared/ops';
import { api, ApiError } from '../api';
import { useApp, type Workspace } from '../store/app';
import { useProject, usePlayback } from '../store/project';

const toast = (...a: Parameters<ReturnType<typeof useApp.getState>['toast']>) => useApp.getState().toast(...a);

export function errMsg(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

async function confirmDiscardChanges(): Promise<boolean> {
  const ps = useProject.getState();
  if (!ps.project || !ps.isDirty()) return true;
  return useApp.getState().confirm({
    title: 'Unsaved changes',
    message: `"${ps.project.name}" has unsaved changes. They are kept in the recovery slot, but will not be in the saved project. Continue?`,
    confirmLabel: 'Continue without saving',
  });
}

export async function openProject(id: string, goTo: Workspace = 'editor'): Promise<boolean> {
  if (useProject.getState().project?.id === id) {
    useApp.getState().setWorkspace(goTo);
    return true;
  }
  if (!(await confirmDiscardChanges())) return false;
  try {
    // Autosave the current project first so nothing is lost when switching.
    await useProject.getState().autosave().catch(() => undefined);
    let project = await api.project(id);
    const recovery = await api.recovery(id).catch(() => null);
    let local: { at: string; project: Project } | null = null;
    try {
      const raw = localStorage.getItem(`voidcraft:unsaved:${id}`);
      local = raw ? JSON.parse(raw) : null;
    } catch {
      local = null;
    }
    const candidate = local && (!recovery || local.at > recovery.updatedAt) ? { updatedAt: local.at, project: local.project, source: 'browser' } : recovery ? { ...recovery, source: 'server' } : null;
    let recovered = false;
    if (candidate && candidate.updatedAt > project.updatedAt) {
      const restore = await useApp.getState().confirm({
        title: 'Recover unsaved work?',
        message: `Voidcraft found changes to "${project.name}" from ${new Date(candidate.updatedAt).toLocaleString()} that were never saved (the session was interrupted). Restore them?`,
        confirmLabel: 'Restore changes',
      });
      if (restore) {
        project = candidate.project;
        recovered = true;
      } else {
        await api.discardRecovery(id).catch(() => undefined);
        try {
          localStorage.removeItem(`voidcraft:unsaved:${id}`);
        } catch {
          /* ignore */
        }
      }
    }
    useProject.getState().load(project);
    if (recovered) {
      // Mark as dirty relative to the saved file so the user can save the recovered state.
      useProject.setState({ savedVersion: null });
      toast('ok', 'Recovered unsaved changes. Save to keep them.');
    }
    usePlayback.getState().setTime(0);
    useApp.getState().setWorkspace(goTo);
    return true;
  } catch (err) {
    toast('err', `Could not open project: ${errMsg(err)}`);
    return false;
  }
}

export async function newProject(opts: { name: string; aspectRatio?: string; resolution?: string; fps?: number; templateId?: string | null }, goTo: Workspace = 'editor'): Promise<Project | null> {
  if (!(await confirmDiscardChanges())) return null;
  try {
    await useProject.getState().autosave().catch(() => undefined);
    const p = await api.createProject(opts);
    useProject.getState().load(p);
    usePlayback.getState().setTime(0);
    useApp.getState().setWorkspace(goTo);
    toast('ok', `Created project "${p.name}"`);
    return p;
  } catch (err) {
    toast('err', `Could not create project: ${errMsg(err)}`);
    return null;
  }
}

/** Make sure a project is open (generation workspaces can create one on demand). */
export async function ensureProject(): Promise<Project | null> {
  const cur = useProject.getState().project;
  if (cur) return cur;
  const s = useApp.getState().settings;
  try {
    const p = await api.createProject({ name: `Untitled ${new Date().toLocaleDateString()}`, aspectRatio: s?.defaults.aspectRatio, resolution: s?.defaults.resolution });
    useProject.getState().load(p);
    toast('info', `Created project "${p.name}" to hold your generations`);
    return p;
  } catch (err) {
    toast('err', errMsg(err));
    return null;
  }
}

export async function saveProject(): Promise<boolean> {
  const ps = useProject.getState();
  if (!ps.project) return false;
  try {
    await ps.save();
    toast('ok', 'Project saved');
    return true;
  } catch (err) {
    toast('err', `Save failed: ${errMsg(err)}. Your changes are still in memory and in the recovery slot.`);
    return false;
  }
}

export async function saveProjectAs(name: string): Promise<boolean> {
  const p = useProject.getState().project;
  if (!p) return false;
  try {
    const copy = await api.saveAs(p, name);
    useProject.getState().load(copy);
    toast('ok', `Saved as "${name}"`);
    return true;
  } catch (err) {
    toast('err', errMsg(err));
    return false;
  }
}

export async function closeProject(): Promise<void> {
  if (!(await confirmDiscardChanges())) return;
  await useProject.getState().autosave().catch(() => undefined);
  useProject.getState().close();
  useApp.getState().setWorkspace('home');
}

export async function deleteProject(id: string, name: string): Promise<boolean> {
  const ok = await useApp.getState().confirm({
    title: 'Delete project?',
    message: `"${name}" will be permanently deleted, including its saved versions and recovery data. Media in the asset library is kept.`,
    confirmLabel: 'Delete project',
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.deleteProject(id);
    if (useProject.getState().project?.id === id) {
      useProject.getState().close();
      useApp.getState().setWorkspace('home');
    }
    toast('ok', `Deleted "${name}"`);
    return true;
  } catch (err) {
    toast('err', errMsg(err));
    return false;
  }
}

export function downloadBundle(id: string, includeMedia = true): void {
  const a = document.createElement('a');
  a.href = `/api/projects/${id}/bundle${includeMedia ? '' : '?media=0'}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function importProjectFile(file: File): Promise<void> {
  try {
    toast('info', `Importing ${file.name}…`);
    const r = await api.importProject(file);
    await useApp.getState().refreshAssets();
    for (const w of r.warnings) toast('warn', w);
    toast('ok', `Imported "${r.project.name}"`);
    await openProject(r.project.id);
  } catch (err) {
    toast('err', `Import failed: ${errMsg(err)}`);
  }
}

/** Submit a generation job, record it in the project, and surface errors. */
export async function submitJob(body: Parameters<typeof api.createJob>[0]): Promise<JobRecord[] | null> {
  try {
    const jobs = await api.createJob(body);
    for (const j of jobs) useApp.getState().upsertJob(j);
    const p = useProject.getState().project;
    if (p && body.projectId === p.id) {
      useProject.getState().apply('Start generation', (d) => {
        for (const j of jobs) if (!d.generationJobIds.includes(j.id)) d.generationJobIds.push(j.id);
        const text = String(body.params.prompt ?? body.params.text ?? '').trim();
        if (text && (body.task === 'text-to-video' || body.task === 'image-to-video' || body.task === 'video-to-video' || body.task === 'text-to-image')) {
          d.promptHistory.unshift({ id: jobs[0].id, text, negative: String(body.params.negativePrompt ?? ''), kind: body.task, createdAt: new Date().toISOString() });
          d.promptHistory = d.promptHistory.slice(0, 500);
        }
      });
    }
    return jobs;
  } catch (err) {
    toast('err', errMsg(err));
    return null;
  }
}

export function addAssetsToTimeline(assets: Asset[]): void {
  if (!useProject.getState().project) {
    toast('warn', 'Open or create a project first');
    return;
  }
  useProject.getState().apply('Add to timeline', (d) => {
    appendShotsToTimeline(
      d,
      assets.filter((a) => a.type !== 'audio').map((a) => ({ asset: a, label: a.name })),
    );
    for (const a of assets.filter((x) => x.type === 'audio')) addAssetClip(d, a);
  });
  toast('ok', `Added ${assets.length} item(s) to the timeline`);
}
