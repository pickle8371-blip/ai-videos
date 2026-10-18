import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Loader2, Redo2, Save, Settings as SettingsIcon, Undo2, UserCircle2, Check } from 'lucide-react';
import { useApp, type Workspace } from '../store/app';
import { useProject, usePlayback } from '../store/project';
import { closeProject, deleteProject, downloadBundle, saveProject } from '../lib/actions';
import { addKeyframeAtPlayhead, deleteSelection, duplicateSelection, splitAtPlayhead } from '../lib/shortcuts';
import { addCue, addTitle, addTrack } from '../../../shared/ops';
import { newId } from '../../../shared/factory';
import { timeAgo } from './ui';

interface MenuItem {
  label: string;
  kbd?: string;
  run?: () => void;
  disabled?: boolean;
  sep?: boolean;
}

function Menu({ label, items, open, onOpen, onHover, onClose }: { label: string; items: MenuItem[]; open: boolean; onOpen: () => void; onHover: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)');
    first?.focus();
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(idx + 1) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(idx - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === 'Escape') onClose();
  };
  return (
    <div style={{ position: 'relative' }} ref={ref} onKeyDown={onKey}>
      <button className="menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? onClose() : onOpen())} onMouseEnter={onHover}>
        {label}
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it, i) =>
            it.sep ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className="menu-item"
                disabled={it.disabled}
                onClick={() => {
                  onClose();
                  it.run?.();
                }}
              >
                {it.label}
                {it.kbd && <span className="kbd">{it.kbd}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Popover({ trigger, children, label }: { trigger: ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="icon-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div className="menu" style={{ left: 'auto', right: 0, width: 340, maxHeight: 420, overflow: 'auto' }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const project = useProject((s) => s.project);
  const savedVersion = useProject((s) => s.savedVersion);
  const saving = useProject((s) => s.saving);
  const past = useProject((s) => s.past);
  const future = useProject((s) => s.future);
  const jobs = useApp((s) => s.jobs);
  const notices = useApp((s) => s.notices);
  const system = useApp((s) => s.system);
  const setDialog = useApp((s) => s.setDialog);
  const setWorkspace = useApp((s) => s.setWorkspace);
  const togglePanel = useApp((s) => s.togglePanel);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const markRead = useApp((s) => s.markNoticesRead);
  const [title, setTitle] = useState(project?.name ?? '');
  useEffect(() => setTitle(project?.name ?? ''), [project?.name]);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.menubar') && setOpenMenu(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openMenu]);

  const dirty = Boolean(project && project !== savedVersion);
  const running = jobs.filter((j) => ['queued', 'submitting', 'running', 'downloading'].includes(j.status));
  const progressJobs = running.filter((j) => j.progress !== null);
  const avg = progressJobs.length ? progressJobs.reduce((s, j) => s + (j.progress ?? 0), 0) / progressJobs.length : null;
  const unread = notices.filter((n) => !n.read).length;
  const aiReady = system?.localAi.state === 'ready' && system.localAi.modelsInstalled > 0;
  const ps = useProject.getState;
  const go = (w: Workspace) => () => setWorkspace(w);
  const noP = !project;

  const menus: Record<string, MenuItem[]> = {
    File: [
      { label: 'New project…', run: () => setDialog({ kind: 'new-project' }) },
      { label: 'Open project…', run: () => setDialog({ kind: 'open-project' }) },
      { sep: true, label: '' },
      { label: 'Save', kbd: 'Ctrl+S', disabled: noP, run: () => void saveProject() },
      { label: 'Save as…', disabled: noP, run: () => setDialog({ kind: 'save-as' }) },
      { label: 'Rename project', disabled: noP, run: () => document.getElementById('project-title-input')?.focus() },
      { sep: true, label: '' },
      { label: 'Import project…', run: () => setDialog({ kind: 'open-project' }) },
      { label: 'Export project bundle (.voidcraft)', disabled: noP, run: () => project && downloadBundle(project.id) },
      { label: 'Export video…', kbd: 'Ctrl+E', disabled: noP, run: () => setDialog({ kind: 'export' }) },
      { sep: true, label: '' },
      { label: 'Close project', disabled: noP, run: () => void closeProject() },
      { label: 'Delete project…', disabled: noP, run: () => project && void deleteProject(project.id, project.name) },
    ],
    Edit: [
      { label: past.length ? `Undo ${past[past.length - 1].label}` : 'Undo', kbd: 'Ctrl+Z', disabled: !past.length, run: () => ps().undo() },
      { label: future.length ? `Redo ${future[0].label}` : 'Redo', kbd: 'Ctrl+Shift+Z', disabled: !future.length, run: () => ps().redo() },
      { sep: true, label: '' },
      { label: 'Split at playhead', kbd: 'S', disabled: noP, run: splitAtPlayhead },
      { label: 'Duplicate', kbd: 'Ctrl+D', disabled: noP, run: duplicateSelection },
      { label: 'Delete', kbd: 'Del', disabled: noP, run: deleteSelection },
      { label: 'Add keyframe at playhead', kbd: 'K', disabled: noP, run: addKeyframeAtPlayhead },
      { label: 'Deselect all', kbd: 'Esc', disabled: noP, run: () => ps().select({ clipIds: [], cueId: null }) },
    ],
    Create: [
      { label: 'Title', disabled: noP, run: () => ps().apply('Add title', (d) => void addTitle(d, 'New title', usePlayback.getState().time)) },
      { label: 'Subtitle cue', disabled: noP, run: () => ps().apply('Add subtitle', (d) => void addCue(d, usePlayback.getState().time, usePlayback.getState().time + 2.5, 'Subtitle text')) },
      { sep: true, label: '' },
      { label: 'Video track', disabled: noP, run: () => ps().apply('Add video track', (d) => void addTrack(d, 'video')) },
      { label: 'Audio track', disabled: noP, run: () => ps().apply('Add audio track', (d) => void addTrack(d, 'audio')) },
      { label: 'Title track', disabled: noP, run: () => ps().apply('Add title track', (d) => void addTrack(d, 'text')) },
      { label: 'Subtitle track', disabled: noP, run: () => ps().apply('Add subtitle track', (d) => void addTrack(d, 'subtitle')) },
      { sep: true, label: '' },
      { label: 'Character…', disabled: noP, run: go('characters') },
      { label: 'Environment…', disabled: noP, run: go('scenes') },
      {
        label: 'Storyboard shot',
        disabled: noP,
        run: () => {
          ps().apply('Add shot', (d) =>
            void d.storyboard.shots.push({
              id: newId('sht'),
              title: `Shot ${d.storyboard.shots.length + 1}`,
              description: '',
              prompt: '',
              characterIds: [],
              environmentId: null,
              cameraAngle: '',
              camera: { move: 'static', framing: 'auto', speed: 0.4, intensity: 0.5, subjectFocus: '', direction: 'auto' },
              lighting: '',
              dialogue: '',
              duration: 5,
              status: 'draft',
              frameAssetId: null,
              videoAssetId: null,
              lastJobId: null,
              review: 'unreviewed',
              error: null,
            }),
          );
          setWorkspace('storyboard');
        },
      },
    ],
    Generate: [
      { label: 'Text to video', run: go('generate') },
      { label: 'Image to video', run: go('image-to-video') },
      { label: 'Video to video', run: go('video-to-video') },
      { label: 'Idea to storyboard', disabled: noP, run: go('storyboard') },
      { label: 'Voice-over (text to speech)', disabled: noP, run: go('audio') },
      { label: 'AI tools', run: go('ai-tools') },
      { sep: true, label: '' },
      { label: 'Generation history', run: go('history') },
    ],
    View: [
      { label: 'Toggle sidebar', run: toggleSidebar },
      { label: 'Toggle properties panel', run: () => togglePanel('right') },
      { label: 'Toggle timeline', kbd: 'Ctrl+\\', run: () => togglePanel('timeline') },
      { sep: true, label: '' },
      { label: 'Zoom timeline in', kbd: '=', disabled: noP, run: () => ps().setZoom(ps().zoom * 1.25) },
      { label: 'Zoom timeline out', kbd: '-', disabled: noP, run: () => ps().setZoom(ps().zoom / 1.25) },
      { label: 'Full-screen preview', disabled: noP, run: () => document.querySelector<HTMLElement>('.preview-stage')?.requestFullscreen?.() },
    ],
    Window: [
      { label: 'Home', run: go('home') },
      { label: 'Editor', run: go('editor') },
      { label: 'Storyboard', run: go('storyboard') },
      { label: 'Audio studio', run: go('audio') },
      { label: 'Visual effects', run: go('effects') },
      { label: 'Asset library', run: go('assets') },
      { label: 'Project settings', run: go('project-settings') },
      { label: 'Preferences', run: go('settings') },
    ],
    Help: [
      { label: 'Keyboard shortcuts', run: () => setDialog({ kind: 'shortcuts' }) },
      { label: 'Connect an AI provider', run: go('settings') },
      { label: 'About Voidcraft.Video', run: () => setDialog({ kind: 'about' }) },
    ],
  };

  const commitTitle = () => {
    const name = title.trim();
    if (!project || !name || name === project.name) return setTitle(project?.name ?? '');
    ps().apply('Rename project', (d) => {
      d.name = name.slice(0, 200);
    });
  };

  return (
    <header className="topbar">
      <div className="logo">
        <div className="logo-mark">
          <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden>
            <path d="M6 7l10 19L26 7" stroke="#a78bfa" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span>
          Voidcraft<span className="logo-dot">.</span>Video
        </span>
      </div>
      <nav className="menubar" aria-label="Main menu">
        {Object.entries(menus).map(([name, items]) => (
          <Menu key={name} label={name} items={items} open={openMenu === name} onOpen={() => setOpenMenu(name)} onHover={() => openMenu && setOpenMenu(name)} onClose={() => setOpenMenu(null)} />
        ))}
      </nav>
      <div className="project-title">
        {project ? (
          <>
            <input
              id="project-title-input"
              aria-label="Project name"
              value={title}
              size={Math.max(8, title.length)}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setTitle(project.name);
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <span className={`status-pill ${dirty ? 'warn' : 'ok'}`} title={dirty ? 'Unsaved changes (autosaved for recovery)' : 'All changes saved'}>
              {saving ? <Loader2 size={11} className="spin" /> : dirty ? <span className="dot" /> : <Check size={11} />}
              {saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}
            </span>
          </>
        ) : (
          <span className="dim small">No project open</span>
        )}
      </div>
      <button className="icon-btn" aria-label="Undo" title={past.length ? `Undo ${past[past.length - 1].label}` : 'Undo'} disabled={!past.length} onClick={() => ps().undo()}>
        <Undo2 size={15} />
      </button>
      <button className="icon-btn" aria-label="Redo" title="Redo" disabled={!future.length} onClick={() => ps().redo()}>
        <Redo2 size={15} />
      </button>
      <button className="icon-btn" aria-label="Save project" title="Save (Ctrl+S)" disabled={!project || saving} onClick={() => void saveProject()}>
        <Save size={15} />
      </button>
      <button
        className={`status-pill ${running.length ? 'accent' : aiReady ? 'ok' : 'warn'}`}
        style={{ background: 'none', cursor: 'pointer', margin: '0 6px' }}
        title={aiReady ? system?.localAi.message : 'Local AI is not set up yet — click to set it up'}
        onClick={() => setWorkspace(!aiReady && !running.length ? 'settings' : 'history')}
      >
        {running.length ? (
          <>
            <Loader2 size={11} className="spin" /> {running.length} job{running.length > 1 ? 's' : ''}
            {avg !== null ? ` · ${Math.round(avg * 100)}%` : ''}
          </>
        ) : aiReady ? (
          <>
            <span className="dot" /> Local AI · {system?.localAi.device === 'cuda' ? system.localAi.gpu : system?.localAi.device?.toUpperCase()}
          </>
        ) : (
          <>
            <span className="dot" /> Set up local AI
          </>
        )}
      </button>
      <Popover
        label="Notifications"
        trigger={
          <span style={{ position: 'relative', display: 'inline-flex' }} onClick={() => setTimeout(markRead, 1500)}>
            <Bell size={15} />
            {unread > 0 && <span style={{ position: 'absolute', top: -4, right: -5, background: 'var(--accent)', color: 'white', fontSize: 9, borderRadius: 6, padding: '0 3px' }}>{unread}</span>}
          </span>
        }
      >
        {() =>
          notices.length === 0 ? (
            <div className="empty small">No notifications yet</div>
          ) : (
            notices.slice(0, 40).map((n) => (
              <div key={n.id} className="menu-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <span className={`badge ${n.kind === 'err' ? 'err' : n.kind === 'ok' ? 'ok' : n.kind === 'warn' ? 'warn' : ''}`}>{n.kind}</span>
                <span className="grow small">{n.message}</span>
                <span className="tiny dim">{timeAgo(n.at)}</span>
              </div>
            ))
          )
        }
      </Popover>
      <button className="icon-btn" aria-label="Settings" onClick={() => setWorkspace('settings')}>
        <SettingsIcon size={15} />
      </button>
      <Popover label="Profile" trigger={<UserCircle2 size={16} />}>
        {(close) => (
          <div style={{ padding: 10 }} className="col">
            <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>Local workspace</div>
            <div className="small muted">Voidcraft runs on this machine. Projects and media are stored in:</div>
            <div className="mono tiny" style={{ wordBreak: 'break-all' }}>{system?.dataDir}</div>
            <div className="small muted">API keys are stored encrypted on the server and never sent to the browser.</div>
            <button className="btn sm" onClick={() => { close(); setWorkspace('settings'); }}>
              Preferences & providers
            </button>
          </div>
        )}
      </Popover>
    </header>
  );
}
