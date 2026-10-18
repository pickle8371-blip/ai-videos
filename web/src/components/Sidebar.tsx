import {
  Home,
  Clapperboard,
  ImagePlay,
  Repeat2,
  LayoutGrid,
  UserRound,
  Mountain,
  Scissors,
  AudioLines,
  Sparkles,
  Wand2,
  LayoutTemplate,
  Library,
  History,
  SlidersHorizontal,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useApp, type Workspace } from '../store/app';

const NAV: Array<{ group?: string; id?: Workspace; label?: string; icon?: ComponentType<{ size?: number }> }> = [
  { id: 'home', label: 'Home', icon: Home },
  { group: 'Create' },
  { id: 'generate', label: 'AI Video Generator', icon: Clapperboard },
  { id: 'image-to-video', label: 'Image to Video', icon: ImagePlay },
  { id: 'video-to-video', label: 'Video to Video', icon: Repeat2 },
  { id: 'storyboard', label: 'AI Storyboard', icon: LayoutGrid },
  { id: 'characters', label: 'Character Studio', icon: UserRound },
  { id: 'scenes', label: 'Scene Studio', icon: Mountain },
  { group: 'Edit' },
  { id: 'editor', label: 'Video Editor & Timeline', icon: Scissors },
  { id: 'audio', label: 'Audio Studio', icon: AudioLines },
  { id: 'effects', label: 'Visual Effects', icon: Sparkles },
  { id: 'ai-tools', label: 'AI Tools', icon: Wand2 },
  { group: 'Library' },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'assets', label: 'Asset Library', icon: Library },
  { id: 'history', label: 'Generation History', icon: History },
  { group: 'Configure' },
  { id: 'project-settings', label: 'Project Settings', icon: SlidersHorizontal },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const ws = useApp((s) => s.workspace);
  const setWs = useApp((s) => s.setWorkspace);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggle = useApp((s) => s.toggleSidebar);
  const running = useApp((s) => s.jobs.filter((j) => ['queued', 'submitting', 'running', 'downloading'].includes(j.status)).length);
  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Workspaces">
      {NAV.map((n, i) =>
        n.group ? (
          <h4 key={i} className="nav-group">
            {n.group}
          </h4>
        ) : (
          <button key={n.id} className={`nav-item${ws === n.id ? ' active' : ''}`} aria-current={ws === n.id ? 'page' : undefined} title={collapsed ? n.label : undefined} onClick={() => setWs(n.id!)}>
            {n.icon && <n.icon size={16} />}
            {!collapsed && <span className="ellipsis">{n.label}</span>}
            {!collapsed && n.id === 'history' && running > 0 && <span className="count">{running}</span>}
          </button>
        ),
      )}
      <div style={{ flex: 1 }} />
      <button className="nav-item" onClick={toggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  );
}
