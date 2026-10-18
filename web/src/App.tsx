import { useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FolderOpen, Plus, ServerCrash } from 'lucide-react';
import { api, subscribeJobs } from './api';
import { useApp, WORKSPACE_LAYOUT, type Workspace } from './store/app';
import { useProject, usePlayback } from './store/project';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Dialogs } from './components/Dialogs';
import { Toasts } from './components/Toasts';
import { Timeline } from './components/Timeline';
import { Preview } from './components/Preview';
import { Inspector } from './components/Inspector';
import { Empty } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Home } from './workspaces/Home';
import { GenerateCenter, GenerateParams, type GenMode } from './workspaces/Generate';
import { Storyboard } from './workspaces/Storyboard';
import { Characters } from './workspaces/Characters';
import { Scenes } from './workspaces/Scenes';
import { AudioStudio } from './workspaces/AudioStudio';
import { EffectsPanel } from './workspaces/Effects';
import { AITools } from './workspaces/AITools';
import { Templates } from './workspaces/Templates';
import { AssetLibrary } from './workspaces/Assets';
import { History } from './workspaces/History';
import { ProjectSettings } from './workspaces/ProjectSettings';
import { Settings } from './workspaces/Settings';
import { openProject, saveProject } from './lib/actions';
import { useGlobalShortcuts } from './lib/shortcuts';
import { useJobSync } from './lib/jobSync';

function useBootstrap() {
  const refreshAll = useApp((s) => s.refreshAll);
  useEffect(() => {
    void (async () => {
      await refreshAll();
      // Restore the last open project/workspace after a reload.
      try {
        const last = localStorage.getItem('voidcraft:lastProject');
        const ws = sessionStorage.getItem('voidcraft:workspace') as Workspace | null;
        if (last && ws && ws !== 'home') {
          const ok = await openProject(last, ws);
          if (!ok) useApp.getState().setWorkspace('home');
        }
      } catch {
        /* ignore */
      }
    })();
    const unsub = subscribeJobs(
      (j) => useApp.getState().upsertJob(j),
      (connected) => {
        const was = useApp.getState().sseConnected;
        useApp.getState().setSse(connected);
        if (connected && !was) void useApp.getState().refreshJobs().catch(() => undefined);
      },
    );
    const sys = setInterval(() => void useApp.getState().refreshSystem().catch(() => undefined), 30_000);
    // The server checks the local AI engine in the background after it starts; follow it until done.
    const engineCheck = setInterval(() => {
      const st = useApp.getState();
      if (st.engine?.status.state !== 'checking' && st.system?.localAi.state !== 'checking') return;
      void api
        .engine()
        .then(async (e) => {
          useApp.setState({ engine: e });
          if (e.status.state !== 'checking') await Promise.all([st.refreshProviders(), st.refreshSystem()]);
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      unsub();
      clearInterval(sys);
      clearInterval(engineCheck);
    };
  }, [refreshAll]);
}

function useAutosave() {
  const seconds = useApp((s) => s.settings?.autosaveSeconds ?? 20);
  const warned = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      useProject
        .getState()
        .autosave()
        .then(() => (warned.current = false))
        .catch((err) => {
          if (!warned.current) useApp.getState().toast('warn', `Autosave failed (${err.message}). A copy is kept in this browser.`);
          warned.current = true;
        });
    }, seconds * 1000);
    const onUnload = (e: BeforeUnloadEvent) => {
      const ps = useProject.getState();
      if (ps.project && ps.isDirty() && ps.project !== ps.autosavedVersion) {
        try {
          localStorage.setItem(`voidcraft:unsaved:${ps.project.id}`, JSON.stringify({ at: new Date().toISOString(), project: ps.project }));
        } catch {
          /* ignore */
        }
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [seconds]);
}

function NoProject() {
  const setDialog = useApp((s) => s.setDialog);
  return (
    <div className="workspace">
      <Empty
        icon={<FolderOpen size={36} />}
        title="No project open"
        action={
          <div className="row">
            <button className="btn primary" onClick={() => setDialog({ kind: 'new-project' })}>
              <Plus size={14} /> New project
            </button>
            <button className="btn" onClick={() => setDialog({ kind: 'open-project' })}>
              Open project
            </button>
          </div>
        }
      >
        This workspace edits a project. Create a new one or open an existing project.
      </Empty>
    </div>
  );
}

function centerFor(ws: Workspace) {
  switch (ws) {
    case 'home':
      return <Home />;
    case 'generate':
    case 'image-to-video':
    case 'video-to-video':
      return <GenerateCenter mode={ws as GenMode} />;
    case 'storyboard':
      return <Storyboard />;
    case 'characters':
      return <Characters />;
    case 'scenes':
      return <Scenes />;
    case 'editor':
    case 'effects':
      return <Preview />;
    case 'audio':
      return <AudioStudio />;
    case 'ai-tools':
      return <AITools />;
    case 'templates':
      return <Templates />;
    case 'assets':
      return <AssetLibrary />;
    case 'history':
      return <History />;
    case 'project-settings':
      return <ProjectSettings />;
    case 'settings':
      return <Settings />;
  }
}

function rightFor(ws: Workspace) {
  switch (ws) {
    case 'generate':
    case 'image-to-video':
    case 'video-to-video':
      return <GenerateParams mode={ws as GenMode} />;
    case 'effects':
      return <EffectsPanel />;
    default:
      return <Inspector />;
  }
}

const goHome = () => useApp.getState().setWorkspace('home');

/** Shown when the live connection to the local server drops (e.g. its window was closed). */
function ConnectionBanner() {
  const connected = useApp((s) => s.sseConnected);
  const [everConnected, setEverConnected] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) {
      setEverConnected(true);
      setShow(false);
      return;
    }
    if (!everConnected) return;
    const t = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(t);
  }, [connected, everConnected]);
  if (!show) return null;
  return (
    <div className="conn-banner" role="status">
      Lost connection to the Voidcraft server — is the <span className="mono">start-windows.bat</span> window still open? Reconnecting automatically…
    </div>
  );
}

function WorkspaceLayout() {
  const ws = useApp((s) => s.workspace);
  const overrides = useApp((s) => s.panelOverrides);
  const hasProject = useProject((s) => Boolean(s.project));
  const layout = WORKSPACE_LAYOUT[ws];
  const right = overrides[ws]?.right ?? layout.right;
  const timeline = overrides[ws]?.timeline ?? layout.timeline;
  if (layout.needsProject && !hasProject) return <NoProject />;
  return (
    <PanelGroup direction="vertical" autoSaveId="vc-vertical">
      <Panel id="top" order={1} minSize={25}>
        <PanelGroup direction="horizontal" autoSaveId={`vc-horizontal-${right ? 'r' : 'n'}`}>
          <Panel id="center" order={1} minSize={30}>
            <ErrorBoundary key={ws} label="This workspace" onHome={goHome}>
              {centerFor(ws)}
            </ErrorBoundary>
          </Panel>
          {right && (
            <>
              <PanelResizeHandle className="resize-h" />
              <Panel id="right" order={2} defaultSize={27} minSize={18} maxSize={50}>
                <ErrorBoundary key={ws} label="This panel" onHome={goHome}>
                  {rightFor(ws)}
                </ErrorBoundary>
              </Panel>
            </>
          )}
        </PanelGroup>
      </Panel>
      {timeline && (
        <>
          <PanelResizeHandle className="resize-v" />
          <Panel id="timeline" order={2} defaultSize={36} minSize={14} maxSize={70}>
            {hasProject ? (
              <ErrorBoundary label="The timeline" onHome={goHome}>
                <Timeline />
              </ErrorBoundary>
            ) : (
              <div className="panel">
                <Empty title="No project open">Generated clips are saved to the asset library. Open or create a project to arrange them on the timeline.</Empty>
              </div>
            )}
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}

export function App() {
  useBootstrap();
  useAutosave();
  useJobSync();
  useGlobalShortcuts();
  const serverError = useApp((s) => s.serverError);
  const refreshAll = useApp((s) => s.refreshAll);
  // Stop playback when leaving a workspace that shows the preview.
  const ws = useApp((s) => s.workspace);
  useEffect(() => usePlayback.getState().setPlaying(false), [ws]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject();
      }
    };
    // Capture phase so Ctrl+S also works while typing in fields that stop key propagation.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="shell">
      <TopBar />
      <Sidebar />
      <main className="main">
        <ConnectionBanner />
        {serverError ? (
          <div className="workspace">
            <Empty icon={<ServerCrash size={36} />} title="Cannot reach the Voidcraft server" action={<button className="btn primary" onClick={() => void refreshAll()}>Retry</button>}>
              {serverError} Start it with <span className="mono">start-windows.bat</span> (or <span className="mono">npm start</span>), keep that window open, and press Retry.
            </Empty>
          </div>
        ) : (
          <WorkspaceLayout />
        )}
      </main>
      <Dialogs />
      <Toasts />
    </div>
  );
}
