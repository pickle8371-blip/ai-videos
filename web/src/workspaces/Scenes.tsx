import { useState } from 'react';
import { Mountain, Plus, Trash2, X, Clapperboard } from 'lucide-react';
import type { Environment } from '../../../shared/project';
import { ENVIRONMENT_CATEGORIES } from '../../../shared/project';
import { newId } from '../../../shared/factory';
import { thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { AssetPickerModal, DropZone } from '../components/pickers';
import { ColorSwatches, Empty, Field, Select } from '../components/ui';
import { useGen } from './Generate';

const CATEGORY_LABEL: Record<(typeof ENVIRONMENT_CATEGORIES)[number], string> = {
  city: 'City',
  forest: 'Forest',
  mountain: 'Mountains',
  interior: 'Interior room',
  fantasy: 'Fantasy world',
  'sci-fi': 'Science fiction',
  horror: 'Horror location',
  historical: 'Historical',
  custom: 'Custom location',
};

const STARTERS: Array<Pick<Environment, 'name' | 'category' | 'description' | 'lighting' | 'atmosphere' | 'palette'>> = [
  { name: 'Neon megacity', category: 'sci-fi', description: 'Dense vertical city of towers, holographic billboards and elevated trains', lighting: 'Magenta and cyan neon, wet reflections', atmosphere: 'Night, light rain, steam from vents', palette: ['#0b0f2a', '#ff2e88', '#22d3ee'] },
  { name: 'Ancient forest', category: 'forest', description: 'Old-growth forest with moss-covered giant trees and ferns', lighting: 'Soft god rays through the canopy', atmosphere: 'Morning mist, floating pollen', palette: ['#1f3b2b', '#6b8f4e', '#e8e2b8'] },
  { name: 'Haunted manor hall', category: 'horror', description: 'Victorian entrance hall with peeling wallpaper and a sweeping staircase', lighting: 'Single flickering candelabra, deep shadows', atmosphere: 'Dust in the air, cold and silent', palette: ['#120d0d', '#5a3a2a', '#c9a66b'] },
  { name: 'Alpine ridge', category: 'mountain', description: 'Knife-edge snowy ridge above a sea of clouds', lighting: 'Golden hour sun low on the horizon', atmosphere: 'Wind-blown snow, thin air', palette: ['#dfe7f2', '#7d8fb3', '#f4b860'] },
];

export function Scenes() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const [selected, setSelected] = useState<string | null>(project.environments[0]?.id ?? null);
  const env = project.environments.find((e) => e.id === selected);
  const add = (starter?: (typeof STARTERS)[number]) => {
    const e: Environment = { id: newId('env'), name: 'New environment', category: 'custom', description: '', lighting: '', atmosphere: '', palette: [], referenceAssetIds: [], notes: '', createdAt: new Date().toISOString(), ...(starter ?? {}) };
    apply('Add environment', (d) => void d.environments.push(e));
    setSelected(e.id);
  };
  return (
    <div className="split-2">
      <div className="list-pane">
        <div className="panel-header">
          <Mountain size={15} /> Environments
          <div className="grow" />
          <button className="btn sm" onClick={() => add()}>
            <Plus size={13} /> New
          </button>
        </div>
        {project.environments.length === 0 && <div className="empty small">No environments yet.</div>}
        {project.environments.map((e) => {
          const ref = useApp.getState().assets.find((a) => a.id === e.referenceAssetIds[0]);
          return (
            <button key={e.id} className={`list-item${e.id === selected ? ' on' : ''}`} onClick={() => setSelected(e.id)}>
              <div className="project-thumb" style={{ width: 48, height: 32, ...(ref && thumbUrl(ref) ? { backgroundImage: `url(${thumbUrl(ref)})` } : { background: e.palette.length ? `linear-gradient(135deg, ${e.palette.join(',')})` : undefined }) }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{e.name}</div>
                <div className="tiny muted">{CATEGORY_LABEL[e.category]}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="workspace">
        {env ? (
          <EnvEditor key={env.id} env={env} onDelete={() => setSelected(null)} />
        ) : (
          <div className="page">
            <Empty icon={<Mountain size={32} />} title="Scene & World Studio" action={<button className="btn primary" onClick={() => add()}><Plus size={14} /> Create environment</button>}>
              Save locations with lighting, atmosphere, palette and reference images, then reuse them across shots for visual continuity.
            </Empty>
            <h4 style={{ margin: '12px 0 8px' }}>Start from an example</h4>
            <div className="row wrap">
              {STARTERS.map((s) => (
                <button key={s.name} className="chip" onClick={() => add(s)}>
                  {s.name} · {CATEGORY_LABEL[s.category]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvEditor({ env, onDelete }: { env: Environment; onDelete: () => void }) {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const assets = useApp((s) => s.assets);
  const setWs = useApp((s) => s.setWorkspace);
  const [picker, setPicker] = useState(false);
  const set = (label: string, fn: (e: Environment) => void, key: string) =>
    apply(label, (d) => {
      const e = d.environments.find((x) => x.id === env.id);
      if (e) fn(e);
    }, { coalesce: `${env.id}:${key}` });
  const shots = project.storyboard.shots.filter((s) => s.environmentId === env.id);
  const refs = env.referenceAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const area = (key: 'description' | 'lighting' | 'atmosphere' | 'notes', label: string, placeholder: string) => (
    <Field label={label}>
      <textarea className="textarea" rows={2} placeholder={placeholder} value={env[key]} onChange={(e) => set(`Edit ${label.toLowerCase()}`, (x) => void (x[key] = e.target.value.slice(0, 4000)), key)} />
    </Field>
  );
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-header">
        <div>
          <h1>{env.name}</h1>
          <p>
            {CATEGORY_LABEL[env.category]} · used in {shots.length} shot(s)
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              useGen.getState().set('generate', { environmentId: env.id });
              setWs('generate');
            }}
          >
            <Clapperboard size={14} /> Generate in this location
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!(await useApp.getState().confirm({ title: 'Delete environment?', message: `Remove "${env.name}"? Shots using it will be unlinked. You can undo this.`, confirmLabel: 'Delete', danger: true }))) return;
              apply('Delete environment', (d) => {
                d.environments = d.environments.filter((e) => e.id !== env.id);
                for (const s of d.storyboard.shots) if (s.environmentId === env.id) s.environmentId = null;
              });
              onDelete();
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
      <div className="grid2" style={{ alignItems: 'start', gap: 20 }}>
        <div className="card pad col">
          <div className="grid2">
            <Field label="Name">
              <input className="input" value={env.name} onChange={(e) => set('Rename environment', (x) => void (x.name = e.target.value.slice(0, 120)), 'name')} />
            </Field>
            <Field label="Category">
              <Select value={env.category} onChange={(v) => set('Category', (x) => void (x.category = v), 'cat')} options={ENVIRONMENT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
            </Field>
          </div>
          {area('description', 'Description', 'Architecture, terrain, key landmarks, era…')}
          {area('lighting', 'Lighting notes', 'Time of day, light sources, colour temperature…')}
          {area('atmosphere', 'Atmosphere', 'Weather, particles, sound, mood…')}
          <Field label="Colour palette">
            <ColorSwatches colors={env.palette} onChange={(p) => set('Edit palette', (x) => void (x.palette = p), 'palette')} />
          </Field>
          {area('notes', 'Notes', 'Continuity notes for this location')}
        </div>
        <div className="col" style={{ gap: 16 }}>
          <div className="card pad col">
            <div className="row between">
              <h3>Reference images</h3>
              <button className="btn sm" onClick={() => setPicker(true)}>
                <Plus size={13} /> From library
              </button>
            </div>
            <DropZone allow={['image']} multiple onAsset={(a) => set('Add reference', (x) => void (x.referenceAssetIds = [...new Set([...x.referenceAssetIds, a.id])]), `ref-${a.id}`)} label="Drop location reference images" />
            {refs.length > 0 && (
              <div className="media-grid sm">
                {refs.map((a) => (
                  <div key={a.id} className="media-card">
                    <div className="media-thumb" style={{ backgroundImage: `url(${thumbUrl(a)})` }} />
                    <div className="row" style={{ padding: 4 }}>
                      <span className="tiny ellipsis grow">{a.name}</span>
                      <button className="icon-btn" aria-label="Remove reference" onClick={() => set('Remove reference', (x) => void (x.referenceAssetIds = x.referenceAssetIds.filter((r) => r !== a.id)), `rm-${a.id}`)}>
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card pad col">
            <h3>Associated shots</h3>
            {shots.length === 0 ? (
              <div className="small muted">Assign this environment to storyboard shots to keep locations consistent.</div>
            ) : (
              shots.map((s) => (
                <div key={s.id} className="row small">
                  <span className="mono dim">{String(project.storyboard.shots.indexOf(s) + 1).padStart(2, '0')}</span>
                  <span className="grow ellipsis">{s.title}</span>
                  <span className="badge">{s.status}</span>
                </div>
              ))
            )}
            <button className="btn sm" onClick={() => setWs('storyboard')}>
              Open storyboard
            </button>
          </div>
        </div>
      </div>
      {picker && <AssetPickerModal allow={['image']} onClose={() => setPicker(false)} onPick={(a) => set('Add reference', (x) => void (x.referenceAssetIds = [...new Set([...x.referenceAssetIds, a.id])]), `ref-${a.id}`)} />}
    </div>
  );
}
