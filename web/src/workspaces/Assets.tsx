import { useMemo, useState } from 'react';
import { Download, Film, Image as ImageIcon, Library, ListPlus, Music, Search, Star, Tag, Trash2, UserRound, Mountain, LayoutGrid, LayoutTemplate, BookmarkCheck } from 'lucide-react';
import type { Asset } from '../../../shared/api';
import { mediaUrl, thumbUrl, api } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { addAssetsToTimeline, errMsg } from '../lib/actions';
import { DropZone } from '../components/pickers';
import { ASSET_DRAG_TYPE } from '../components/Timeline';
import { Empty, Field, Modal, ProvenanceBadge, Select, formatBytes, formatDuration, timeAgo } from '../components/ui';

type Filter = 'all' | 'generated' | 'uploaded' | 'video' | 'image' | 'audio' | 'exports' | 'favorites';
type Sort = 'newest' | 'oldest' | 'name' | 'size' | 'duration';

export function AssetLibrary() {
  const assets = useApp((s) => s.assets);
  const project = useProject((s) => s.project);
  const apply = useProject((s) => s.apply);
  const setWs = useApp((s) => s.setWorkspace);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [scope, setScope] = useState<'all' | 'project'>(project ? 'project' : 'all');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [showPreviews, setShowPreviews] = useState(false);

  const allTags = useMemo(() => [...new Set(assets.flatMap((a) => a.tags))].sort(), [assets]);
  const list = useMemo(() => {
    let l = assets.filter((a) => showPreviews || !a.tags.includes('preview'));
    if (scope === 'project' && project) l = l.filter((a) => a.projectIds.includes(project.id) || project.assetIds.includes(a.id));
    l = l.filter((a) => {
      switch (filter) {
        case 'generated':
          return a.origin === 'generated';
        case 'uploaded':
          return a.origin === 'upload' || a.origin === 'recording';
        case 'video':
        case 'image':
        case 'audio':
          return a.type === filter;
        case 'exports':
          return a.origin === 'export';
        case 'favorites':
          return a.favorite;
        default:
          return true;
      }
    });
    if (tag) l = l.filter((a) => a.tags.includes(tag));
    if (q) {
      const s = q.toLowerCase();
      l = l.filter((a) => a.name.toLowerCase().includes(s) || a.tags.some((t) => t.toLowerCase().includes(s)) || (a.provenance.prompt ?? '').toLowerCase().includes(s));
    }
    const by: Record<Sort, (a: Asset, b: Asset) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => b.sizeBytes - a.sizeBytes,
      duration: (a, b) => (b.duration ?? 0) - (a.duration ?? 0),
    };
    return [...l].sort(by[sort]);
  }, [assets, filter, sort, scope, project, q, tag, showPreviews]);

  const toggleSel = (id: string, multi: boolean) => setSelected((s) => (multi ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  const selAssets = assets.filter((a) => selected.includes(a.id));
  const deleteSelected = async () => {
    const used = project ? selAssets.filter((a) => project.timeline.tracks.some((t) => t.clips.some((c) => c.kind === 'media' && c.assetId === a.id))) : [];
    const ok = await useApp.getState().confirm({
      title: `Delete ${selAssets.length} file(s)?`,
      message: `This permanently deletes the media from disk.${used.length ? ` ${used.length} of them are used on the current timeline and those clips will go offline.` : ''} Other projects using these files will also show them as offline.`,
      confirmLabel: 'Delete files',
      danger: true,
    });
    if (!ok) return;
    for (const a of selAssets) {
      try {
        await api.deleteAsset(a.id);
        useApp.getState().removeAsset(a.id);
      } catch (err) {
        useApp.getState().toast('err', errMsg(err));
      }
    }
    setSelected([]);
  };

  const det = assets.find((a) => a.id === detail);

  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 1500 }}>
        <div className="page-header">
          <div>
            <h1>Asset Library</h1>
            <p>
              {list.length} of {assets.length} files · drag items onto the timeline or into reference slots
            </p>
          </div>
          <div className="row">
            {selected.length > 0 && (
              <>
                <span className="small muted">{selected.length} selected</span>
                <button className="btn" disabled={!project} onClick={() => addAssetsToTimeline(selAssets)}>
                  <ListPlus size={14} /> Add to timeline
                </button>
                <button className="btn danger" onClick={() => void deleteSelected()}>
                  <Trash2 size={14} /> Delete
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <DropZone allow={['video', 'image', 'audio']} multiple onAsset={() => undefined} label="Import media — drop video, images or audio here (validated on the server)" />
        </div>
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <div className="row" style={{ position: 'relative', width: 280 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, color: 'var(--text-3)' }} />
            <input className="input" style={{ paddingLeft: 28 }} placeholder="Search names, tags, prompts" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            {(['all', 'generated', 'uploaded', 'video', 'image', 'audio', 'exports', 'favorites'] as Filter[]).map((f) => (
              <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="grow" />
          {project && <Select label="Scope" value={scope} onChange={setScope} options={[{ value: 'project', label: 'Current project' }, { value: 'all', label: 'All projects' }]} />}
          <Select label="Tag" value={tag} onChange={setTag} options={[{ value: '', label: 'Any tag' }, ...allTags.map((t) => ({ value: t, label: t }))]} />
          <Select label="Sort" value={sort} onChange={setSort} options={[{ value: 'newest', label: 'Newest' }, { value: 'oldest', label: 'Oldest' }, { value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'duration', label: 'Duration' }]} />
          <label className="check small">
            <input type="checkbox" checked={showPreviews} onChange={(e) => setShowPreviews(e.target.checked)} /> previews
          </label>
        </div>
        {project && (
          <div className="row wrap" style={{ marginBottom: 14, gap: 8 }}>
            <button className="chip" onClick={() => setWs('characters')}><UserRound size={12} /> {project.characters.length} characters</button>
            <button className="chip" onClick={() => setWs('scenes')}><Mountain size={12} /> {project.environments.length} environments</button>
            <button className="chip" onClick={() => setWs('storyboard')}><LayoutGrid size={12} /> {project.storyboard.shots.length} storyboard shots</button>
            <button className="chip" onClick={() => setWs('templates')}><LayoutTemplate size={12} /> templates</button>
            <button className="chip" onClick={() => setWs('templates')}><BookmarkCheck size={12} /> saved prompts</button>
          </div>
        )}
        {list.length === 0 ? (
          <div className="card">
            <Empty icon={<Library size={30} />} title="No media here">
              Import files above, or generate clips — results are saved to the library automatically.
            </Empty>
          </div>
        ) : (
          <div className="media-grid">
            {list.map((a) => (
              <div
                key={a.id}
                className={`media-card${selected.includes(a.id) ? ' selected' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(a));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={(e) => toggleSel(a.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                onDoubleClick={() => setDetail(a.id)}
                role="button"
                tabIndex={0}
                aria-pressed={selected.includes(a.id)}
                onKeyDown={(e) => e.key === 'Enter' && setDetail(a.id)}
              >
                <div className="media-thumb" style={thumbUrl(a) ? { backgroundImage: `url(${thumbUrl(a)})` } : a.hasWaveform ? { backgroundImage: `url(/media/${a.id}/waveform.png)`, backgroundSize: '100% 60%', backgroundColor: '#0d1514' } : undefined}>
                  {!thumbUrl(a) && !a.hasWaveform && (a.type === 'audio' ? <Music size={22} /> : a.type === 'image' ? <ImageIcon size={22} /> : <Film size={22} />)}
                  <span className="corner">
                    <ProvenanceBadge ai={a.provenance.aiGenerated} generator={a.provenance.generator} />
                    {a.origin === 'export' && <span className="badge">export</span>}
                    {a.origin === 'sample' && <span className="badge">sample</span>}
                  </span>
                  {a.duration ? <span className="dur">{formatDuration(a.duration)}</span> : null}
                </div>
                <div className="media-meta">
                  <div className="row" style={{ gap: 4 }}>
                    <span className="name ellipsis grow">{a.name}</span>
                    <button className={`icon-btn${a.favorite ? ' on' : ''}`} aria-label={a.favorite ? 'Unfavorite' : 'Favorite'} onClick={(e) => { e.stopPropagation(); void api.patchAsset(a.id, { favorite: !a.favorite }).then(useApp.getState().upsertAsset); }}>
                      <Star size={13} fill={a.favorite ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                  <span className="tiny muted">
                    {a.type}
                    {a.width ? ` · ${a.width}×${a.height}` : ''} · {formatBytes(a.sizeBytes)} · {timeAgo(a.createdAt)}
                  </span>
                  {a.tags.length > 0 && <span className="tiny dim ellipsis">#{a.tags.join(' #')}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {det && <AssetDetail asset={det} onClose={() => setDetail(null)} onAssignRef={(kind, id) => {
        apply(kind === 'character' ? 'Add character reference' : 'Add environment reference', (d) => {
          if (kind === 'character') {
            const c = d.characters.find((x) => x.id === id);
            if (c && !c.referenceAssetIds.includes(det.id)) c.referenceAssetIds.push(det.id);
          } else {
            const e = d.environments.find((x) => x.id === id);
            if (e && !e.referenceAssetIds.includes(det.id)) e.referenceAssetIds.push(det.id);
          }
        });
        useApp.getState().toast('ok', 'Reference assigned');
      }} />}
    </div>
  );
}

function AssetDetail({ asset, onClose, onAssignRef }: { asset: Asset; onClose: () => void; onAssignRef: (kind: 'character' | 'environment', id: string) => void }) {
  const project = useProject((s) => s.project);
  const [name, setName] = useState(asset.name);
  const [tags, setTags] = useState(asset.tags.join(', '));
  const [ref, setRef] = useState('');
  const save = async () => {
    try {
      const a = await api.patchAsset(asset.id, { name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
      useApp.getState().upsertAsset(a);
      onClose();
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    }
  };
  const p = asset.provenance;
  return (
    <Modal
      title={asset.name}
      wide
      onClose={onClose}
      footer={
        <>
          <a className="btn" href={`${mediaUrl(asset)}?download=1`}>
            <Download size={14} /> Download
          </a>
          {project && (
            <button className="btn" onClick={() => { addAssetsToTimeline([asset]); onClose(); }}>
              <ListPlus size={14} /> Add to timeline
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div>
          {asset.type === 'video' ? (
            <video src={mediaUrl(asset)} controls style={{ width: '100%', borderRadius: 6, background: '#000' }} poster={thumbUrl(asset) ?? undefined} />
          ) : asset.type === 'image' ? (
            <img src={mediaUrl(asset)} alt={asset.name} style={{ width: '100%', borderRadius: 6 }} />
          ) : (
            <audio src={mediaUrl(asset)} controls style={{ width: '100%' }} />
          )}
        </div>
        <div className="col">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags (comma separated)" right={<Tag size={12} />}>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{asset.type} ({asset.mime})</dd>
            <dt>Origin</dt>
            <dd>{asset.origin}</dd>
            <dt>Provenance</dt>
            <dd>
              <ProvenanceBadge ai={p.aiGenerated} generator={p.generator} /> {p.generator ?? 'Uploaded file'}
              {p.note ? ` — ${p.note}` : ''}
            </dd>
            {p.prompt && (
              <>
                <dt>Prompt</dt>
                <dd>{p.prompt}</dd>
              </>
            )}
            <dt>Size</dt>
            <dd>{formatBytes(asset.sizeBytes)}</dd>
            {asset.width && (
              <>
                <dt>Dimensions</dt>
                <dd>
                  {asset.width}×{asset.height}
                  {asset.fps ? ` @ ${asset.fps} fps` : ''}
                </dd>
              </>
            )}
            {asset.duration && (
              <>
                <dt>Duration</dt>
                <dd>{formatDuration(asset.duration)}</dd>
              </>
            )}
            <dt>Audio</dt>
            <dd>{asset.hasAudio ? 'yes' : 'no'}</dd>
            <dt>Projects</dt>
            <dd>{asset.projectIds.length}</dd>
            <dt>Created</dt>
            <dd>{new Date(asset.createdAt).toLocaleString()}</dd>
          </dl>
          {project && asset.type === 'image' && (project.characters.length > 0 || project.environments.length > 0) && (
            <Field label="Assign as reference">
              <div className="row">
                <select className="select" value={ref} onChange={(e) => setRef(e.target.value)}>
                  <option value="">Choose…</option>
                  {project.characters.map((c) => (
                    <option key={c.id} value={`character:${c.id}`}>
                      Character: {c.name}
                    </option>
                  ))}
                  {project.environments.map((e) => (
                    <option key={e.id} value={`environment:${e.id}`}>
                      Environment: {e.name}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!ref} onClick={() => { const [k, id] = ref.split(':'); onAssignRef(k as 'character' | 'environment', id); }}>
                  Assign
                </button>
              </div>
            </Field>
          )}
        </div>
      </div>
    </Modal>
  );
}
