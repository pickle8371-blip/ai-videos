import { useState } from 'react';
import { Copy, Download, Trash2, BookmarkPlus } from 'lucide-react';
import type { AspectRatio } from '../../../shared/project';
import { dimensionsFor } from '../../../shared/factory';
import { api } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { deleteProject, downloadBundle, errMsg, openProject } from '../lib/actions';
import { Field, Notice, Select, Seg, timeAgo, formatDuration } from '../components/ui';
import { timelineDuration } from '../../../shared/timeline';

export function ProjectSettings() {
  const project = useProject((s) => s.project)!;
  const apply = useProject((s) => s.apply);
  const lastSavedAt = useProject((s) => s.lastSavedAt);
  const lastAutosaveAt = useProject((s) => s.lastAutosaveAt);
  const setDialog = useApp((s) => s.setDialog);
  const s = project.settings;
  const res = s.height >= 2160 || s.width >= 2160 * (16 / 9) - 1 ? '4k' : Math.min(s.width, s.height) >= 1080 ? '1080p' : '720p';
  const [customW, setCustomW] = useState(s.width);
  const [customH, setCustomH] = useState(s.height);
  const setFormat = (aspect: AspectRatio, r: '720p' | '1080p' | '4k') => {
    const [w, h] = dimensionsFor(aspect, r);
    apply('Change project format', (d) => {
      d.settings.aspectRatio = aspect;
      d.settings.width = w;
      d.settings.height = h;
      d.exportSettings.width = w;
      d.exportSettings.height = h;
    });
    setCustomW(w);
    setCustomH(h);
  };
  return (
    <div className="workspace">
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="page-header">
          <div>
            <h1>Project settings</h1>
            <p>
              Created {new Date(project.createdAt).toLocaleString()} · saved {timeAgo(lastSavedAt)} {lastAutosaveAt ? `· autosaved ${timeAgo(lastAutosaveAt)}` : ''}
            </p>
          </div>
        </div>
        <div className="col" style={{ gap: 16 }}>
          <div className="card pad col">
            <h3>General</h3>
            <Field label="Name">
              <input className="input" value={project.name} onChange={(e) => apply('Rename project', (d) => void (d.name = e.target.value.slice(0, 200) || 'Untitled'), { coalesce: 'name' })} />
            </Field>
            <Field label="Description">
              <textarea className="textarea" rows={2} value={project.description} onChange={(e) => apply('Edit description', (d) => void (d.description = e.target.value.slice(0, 4000)), { coalesce: 'desc' })} />
            </Field>
          </div>
          <div className="card pad col">
            <h3>Canvas</h3>
            <Field label="Aspect ratio">
              <Seg value={s.aspectRatio} onChange={(a) => setFormat(a, res as '720p')} options={(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as AspectRatio[]).map((a) => ({ value: a, label: a }))} />
            </Field>
            <div className="grid3">
              <Field label="Resolution preset">
                <Select value={res} onChange={(r) => setFormat(s.aspectRatio, r as '720p')} options={[{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }]} />
              </Field>
              <Field label="Frame rate">
                <Select value={String(s.fps)} onChange={(v) => apply('Frame rate', (d) => { d.settings.fps = Number(v); d.exportSettings.fps = Number(v); })} options={['23.976', '24', '25', '29.97', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))} />
              </Field>
              <Field label="Background">
                <input type="color" value={s.background} onChange={(e) => apply('Background colour', (d) => void (d.settings.background = e.target.value), { coalesce: 'bg' })} />
              </Field>
            </div>
            <div className="grid3">
              <Field label="Custom width">
                <input className="input" type="number" min={64} max={7680} step={2} value={customW} onChange={(e) => setCustomW(Number(e.target.value))} />
              </Field>
              <Field label="Custom height">
                <input className="input" type="number" min={64} max={4320} step={2} value={customH} onChange={(e) => setCustomH(Number(e.target.value))} />
              </Field>
              <Field label=" ">
                <button
                  className="btn"
                  disabled={customW < 64 || customH < 64 || customW > 7680 || customH > 4320}
                  onClick={() =>
                    apply('Custom canvas size', (d) => {
                      d.settings.width = Math.round(customW / 2) * 2;
                      d.settings.height = Math.round(customH / 2) * 2;
                      d.exportSettings.width = d.settings.width;
                      d.exportSettings.height = d.settings.height;
                    })
                  }
                >
                  Apply size
                </button>
              </Field>
            </div>
            <Field label={`Default still-image duration: ${s.stillDuration}s`}>
              <input type="range" min={0.5} max={20} step={0.5} value={s.stillDuration} onChange={(e) => apply('Still duration', (d) => void (d.settings.stillDuration = Number(e.target.value)), { coalesce: 'still' })} style={{ accentColor: 'var(--accent)' }} />
            </Field>
            <Notice>Changing the canvas re-fits every clip on export (fit/fill/stretch per clip). Titles scale with the canvas height.</Notice>
          </div>
          <div className="card pad col">
            <h3>Contents</h3>
            <dl className="kv">
              <dt>Duration</dt>
              <dd>{formatDuration(timelineDuration(project.timeline))}</dd>
              <dt>Tracks / clips</dt>
              <dd>
                {project.timeline.tracks.length} / {project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0)}
              </dd>
              <dt>Storyboard shots</dt>
              <dd>{project.storyboard.shots.length}</dd>
              <dt>Characters / environments</dt>
              <dd>
                {project.characters.length} / {project.environments.length}
              </dd>
              <dt>Prompt history</dt>
              <dd>{project.promptHistory.length} entries</dd>
              <dt>Generations</dt>
              <dd>{project.generationJobIds.length}</dd>
              <dt>Media files</dt>
              <dd>{project.assetIds.length}</dd>
              <dt>Format</dt>
              <dd>Voidcraft project v{project.formatVersion} (see docs/PROJECT_FORMAT.md)</dd>
            </dl>
          </div>
          {project.promptHistory.length > 0 && (
            <div className="card pad col">
              <h3>Prompt history</h3>
              {project.promptHistory.slice(0, 20).map((p) => (
                <div key={p.id} className="small">
                  <span className="badge">{p.kind}</span> <span className="muted">{timeAgo(p.createdAt)}</span> — {p.text.slice(0, 200)}
                </div>
              ))}
            </div>
          )}
          <div className="card pad col">
            <h3>Manage</h3>
            <div className="row wrap">
              <button className="btn" onClick={() => setDialog({ kind: 'save-as' })}>
                Save as…
              </button>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await useProject.getState().autosave().catch(() => undefined);
                    const copy = await api.duplicateProject(project.id);
                    useApp.getState().toast('ok', `Duplicated as "${copy.name}" (from the last saved version)`, { label: 'Open', run: () => void openProject(copy.id) });
                  } catch (err) {
                    useApp.getState().toast('err', errMsg(err));
                  }
                }}
              >
                <Copy size={14} /> Duplicate saved version
              </button>
              <button className="btn" onClick={() => downloadBundle(project.id)}>
                <Download size={14} /> Export bundle with media
              </button>
              <button className="btn" onClick={() => downloadBundle(project.id, false)}>
                <Download size={14} /> Export project JSON only
              </button>
              <button className="btn" onClick={() => useApp.getState().setWorkspace('templates')}>
                <BookmarkPlus size={14} /> Save as template
              </button>
              <div className="grow" />
              <button className="btn danger" onClick={() => void deleteProject(project.id, project.name)}>
                <Trash2 size={14} /> Delete project
              </button>
            </div>
            <div className="tiny muted">Bundles export the last saved state. Save first to include recent edits.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
