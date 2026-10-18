import { useMemo, useState } from 'react';
import { Check, Plus, Trash2, UserRound, X, ThumbsUp, ThumbsDown, Clapperboard } from 'lucide-react';
import type { Character } from '../../../shared/project';
import { newId } from '../../../shared/factory';
import { mediaUrl, thumbUrl } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { AssetPickerModal, DropZone } from '../components/pickers';
import { ColorSwatches, Empty, Field, Notice, ProvenanceBadge } from '../components/ui';
import { useGen } from './Generate';

function blank(): Character {
  return {
    id: newId('chr'),
    name: 'New character',
    description: '',
    appearance: '',
    face: '',
    body: '',
    clothing: '',
    accessories: '',
    palette: [],
    referenceAssetIds: [],
    approvedAssetIds: [],
    rejectedAssetIds: [],
    notes: '',
    createdAt: new Date().toISOString(),
  };
}

export function Characters() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const [selected, setSelected] = useState<string | null>(project.characters[0]?.id ?? null);
  const ch = project.characters.find((c) => c.id === selected);
  const add = () => {
    const c = blank();
    apply('Add character', (d) => void d.characters.push(c));
    setSelected(c.id);
  };
  return (
    <div className="split-2">
      <div className="list-pane">
        <div className="panel-header">
          <UserRound size={15} /> Characters
          <div className="grow" />
          <button className="btn sm" onClick={add}>
            <Plus size={13} /> New
          </button>
        </div>
        {project.characters.length === 0 && <div className="empty small">No characters yet.</div>}
        {project.characters.map((c) => {
          const ref = useApp.getState().assets.find((a) => a.id === c.referenceAssetIds[0]);
          return (
            <button key={c.id} className={`list-item${c.id === selected ? ' on' : ''}`} onClick={() => setSelected(c.id)}>
              <div className="project-thumb" style={{ width: 40, height: 40, borderRadius: 20, ...(ref && thumbUrl(ref) ? { backgroundImage: `url(${thumbUrl(ref)})` } : {}) }}>{!ref && <UserRound size={15} />}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{c.name}</div>
                <div className="tiny muted ellipsis">{c.description || c.appearance || 'No description'}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="workspace">
        {ch ? (
          <CharacterEditor key={ch.id} ch={ch} onDelete={() => setSelected(null)} />
        ) : (
          <Empty icon={<UserRound size={32} />} title="Character Studio" action={<button className="btn primary" onClick={add}><Plus size={14} /> Create character</button>}>
            Store a character's appearance, wardrobe, palette and reference images, then attach them to shots and generations. Their description is added to prompts and references are used where the model supports image conditioning.
          </Empty>
        )}
      </div>
    </div>
  );
}

function CharacterEditor({ ch, onDelete }: { ch: Character; onDelete: () => void }) {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const assets = useApp((s) => s.assets);
  const setWs = useApp((s) => s.setWorkspace);
  const [picker, setPicker] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  const set = (label: string, fn: (c: Character) => void, key: string) =>
    apply(label, (d) => {
      const c = d.characters.find((x) => x.id === ch.id);
      if (c) fn(c);
    }, { coalesce: `${ch.id}:${key}` });
  const text = (key: 'name' | 'description' | 'appearance' | 'face' | 'body' | 'clothing' | 'accessories' | 'notes', label: string, rows = 2, placeholder = '') => (
    <Field label={label}>
      {rows === 1 ? (
        <input className="input" value={ch[key]} placeholder={placeholder} onChange={(e) => set(`Edit ${label.toLowerCase()}`, (c) => void (c[key] = e.target.value.slice(0, key === 'name' ? 120 : 4000)), key)} />
      ) : (
        <textarea className="textarea" rows={rows} value={ch[key]} placeholder={placeholder} onChange={(e) => set(`Edit ${label.toLowerCase()}`, (c) => void (c[key] = e.target.value.slice(0, 4000)), key)} />
      )}
    </Field>
  );
  // Generated clips/frames that involve this character, for consistency review.
  const results = useMemo(() => {
    const ids = new Set<string>();
    for (const s of project.storyboard.shots) if (s.characterIds.includes(ch.id)) [s.videoAssetId, s.frameAssetId].forEach((x) => x && ids.add(x));
    for (const j of useApp.getState().jobs) if (((j.params as { characterIds?: string[] }).characterIds ?? []).includes(ch.id)) j.outputAssetIds.forEach((x) => ids.add(x));
    return [...ids].map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  }, [project, ch.id, assets]);
  const refs = ch.referenceAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const compare = results.find((a) => a.id === compareId);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-header">
        <div>
          <h1>{ch.name}</h1>
          <p>Character profile · used in {project.storyboard.shots.filter((s) => s.characterIds.includes(ch.id)).length} shot(s)</p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              useGen.getState().set('generate', { characterIds: [ch.id] });
              useGen.getState().set('image-to-video', { characterIds: [ch.id], startImageAssetId: ch.referenceAssetIds[0] ?? null });
              setWs(ch.referenceAssetIds.length ? 'image-to-video' : 'generate');
            }}
          >
            <Clapperboard size={14} /> Generate with character
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!(await useApp.getState().confirm({ title: 'Delete character?', message: `Remove "${ch.name}" from this project? Shots referencing it will be unlinked. You can undo this.`, confirmLabel: 'Delete', danger: true }))) return;
              apply('Delete character', (d) => {
                d.characters = d.characters.filter((c) => c.id !== ch.id);
                for (const s of d.storyboard.shots) s.characterIds = s.characterIds.filter((x) => x !== ch.id);
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
          {text('name', 'Name', 1)}
          {text('description', 'Role / personality', 2, 'Who they are, how they move and behave')}
          {text('appearance', 'Overall appearance', 2, 'Age, ethnicity, build, hair…')}
          <div className="grid2">
            {text('face', 'Facial characteristics', 2, 'Eyes, scars, beard…')}
            {text('body', 'Body characteristics', 2, 'Height, posture…')}
          </div>
          {text('clothing', 'Clothing', 2, 'Costume, materials, colours')}
          {text('accessories', 'Accessories', 2, 'Weapons, jewelry, props')}
          <Field label="Colour palette (right-click a swatch to remove)">
            <ColorSwatches colors={ch.palette} onChange={(p) => set('Edit palette', (c) => void (c.palette = p), 'palette')} />
          </Field>
          {text('notes', 'Notes', 2)}
        </div>
        <div className="col" style={{ gap: 16 }}>
          <div className="card pad col">
            <div className="row between">
              <h3>Reference images</h3>
              <button className="btn sm" onClick={() => setPicker(true)}>
                <Plus size={13} /> From library
              </button>
            </div>
            <DropZone allow={['image']} multiple onAsset={(a) => set('Add reference', (c) => void (c.referenceAssetIds = [...new Set([...c.referenceAssetIds, a.id])]), `ref-${a.id}`)} label="Drop reference images (PNG/JPG/WebP)" />
            {refs.length > 0 && (
              <div className="media-grid sm">
                {refs.map((a, i) => (
                  <div key={a.id} className="media-card">
                    <div className="media-thumb" style={{ backgroundImage: `url(${thumbUrl(a)})`, aspectRatio: '1' }}>
                      {i === 0 && <span className="corner"><span className="badge accent">primary</span></span>}
                    </div>
                    <div className="row" style={{ padding: 4 }}>
                      <span className="tiny ellipsis grow">{a.name}</span>
                      {i > 0 && (
                        <button className="icon-btn" title="Make primary" aria-label="Make primary" onClick={() => set('Primary reference', (c) => void (c.referenceAssetIds = [a.id, ...c.referenceAssetIds.filter((x) => x !== a.id)]), 'primary')}>
                          <Check size={12} />
                        </button>
                      )}
                      <button className="icon-btn" aria-label="Remove reference" onClick={() => set('Remove reference', (c) => void (c.referenceAssetIds = c.referenceAssetIds.filter((x) => x !== a.id)), `rm-${a.id}`)}>
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="tiny muted">The primary reference is used as the start frame for image-to-video and as conditioning where a model supports it. Text-only models receive the written description.</div>
          </div>
          <div className="card pad col">
            <h3>Consistency review</h3>
            <Notice>Character consistency across separately generated shots is never guaranteed. Compare each result with the reference, approve good matches, and reject/regenerate the rest.</Notice>
            {results.length === 0 ? (
              <div className="small muted">No generated results with this character yet.</div>
            ) : (
              <div className="media-grid sm">
                {results.map((a) => (
                  <div key={a.id} className={`media-card${compareId === a.id ? ' selected' : ''}`} onClick={() => setCompareId(a.id)}>
                    <div className="media-thumb" style={thumbUrl(a) ? { backgroundImage: `url(${thumbUrl(a)})` } : undefined}>
                      <span className="corner">
                        {ch.approvedAssetIds.includes(a.id) && <span className="badge ok">approved</span>}
                        {ch.rejectedAssetIds.includes(a.id) && <span className="badge err">rejected</span>}
                      </span>
                    </div>
                    <div className="media-meta">
                      <span className="tiny ellipsis">{a.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {compare && (
              <div className="col">
                <div className="compare">
                  <div>
                    {refs[0] ? <img src={mediaUrl(refs[0])} alt="Reference" /> : <div className="empty small">No reference image</div>}
                    <span className="badge tag">Reference</span>
                  </div>
                  <div>
                    {compare.type === 'video' ? <video src={mediaUrl(compare)} controls loop autoPlay muted /> : <img src={mediaUrl(compare)} alt="Result" />}
                    <span className="tag">
                      <ProvenanceBadge ai={compare.provenance.aiGenerated} generator={compare.provenance.generator} />
                    </span>
                  </div>
                </div>
                <div className="row">
                  <button className="btn sm" onClick={() => set('Approve design', (c) => {
                    c.approvedAssetIds = [...new Set([...c.approvedAssetIds, compare.id])];
                    c.rejectedAssetIds = c.rejectedAssetIds.filter((x) => x !== compare.id);
                  }, `ap-${compare.id}`)}>
                    <ThumbsUp size={13} /> Approve
                  </button>
                  <button className="btn sm" onClick={() => set('Reject design', (c) => {
                    c.rejectedAssetIds = [...new Set([...c.rejectedAssetIds, compare.id])];
                    c.approvedAssetIds = c.approvedAssetIds.filter((x) => x !== compare.id);
                  }, `rj-${compare.id}`)}>
                    <ThumbsDown size={13} /> Reject
                  </button>
                  <span className="tiny muted">Regenerate rejected shots from the Storyboard.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {picker && <AssetPickerModal allow={['image']} title="Add reference image" onClose={() => setPicker(false)} onPick={(a) => set('Add reference', (c) => void (c.referenceAssetIds = [...new Set([...c.referenceAssetIds, a.id])]), `ref-${a.id}`)} />}
    </div>
  );
}
