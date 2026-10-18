import { useEffect, useState } from 'react';
import { BookmarkPlus, LayoutTemplate, Plus, Trash2, Copy } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';
import { errMsg, newProject } from '../lib/actions';
import { useGen } from './Generate';
import { Field, Modal, timeAgo } from '../components/ui';
import { SAMPLE_PROMPTS } from '../../../shared/prompt';

export function Templates() {
  const templates = useApp((s) => s.templates);
  const refresh = useApp((s) => s.refreshTemplates);
  const project = useProject((s) => s.project);
  const setWs = useApp((s) => s.setWorkspace);
  const [prompts, setPrompts] = useState<Awaited<ReturnType<typeof api.prompts>>>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const loadPrompts = () => api.prompts().then(setPrompts).catch(() => undefined);
  useEffect(() => {
    void loadPrompts();
  }, []);

  return (
    <div className="workspace">
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Templates</h1>
            <p>Start projects from presets or your own saved templates, and reuse saved prompts.</p>
          </div>
          <button className="btn" disabled={!project} onClick={() => setSaveOpen(true)}>
            <BookmarkPlus size={14} /> Save current project as template
          </button>
        </div>
        <h2 style={{ marginBottom: 10 }}>Project templates</h2>
        <div className="media-grid" style={{ marginBottom: 28 }}>
          {templates.map((t) => (
            <div key={t.id} className="card pad col">
              <div className="row">
                <LayoutTemplate size={16} color="var(--lavender)" />
                <h3 className="grow">{t.name}</h3>
                {!t.builtIn && <span className="badge accent">saved</span>}
              </div>
              <div className="row wrap" style={{ gap: 4 }}>
                <span className="badge">{t.aspectRatio}</span>
                <span className="badge">{t.resolution}</span>
                <span className="badge">{t.fps} fps</span>
              </div>
              <div className="small muted grow">{t.description || 'Saved project template'}</div>
              {t.shotTitles?.length ? <div className="tiny dim">Shots: {t.shotTitles.join(' · ')}</div> : null}
              <div className="row">
                <button className="btn sm primary" onClick={() => void newProject({ name: `${t.name} project`, templateId: t.id })}>
                  <Plus size={13} /> Use template
                </button>
                {!t.builtIn && (
                  <button
                    className="icon-btn"
                    aria-label={`Delete template ${t.name}`}
                    onClick={async () => {
                      if (!(await useApp.getState().confirm({ title: 'Delete template?', message: `Delete "${t.name}"? Projects created from it are not affected.`, confirmLabel: 'Delete', danger: true }))) return;
                      await api.deleteTemplate(t.id).catch((e) => useApp.getState().toast('err', errMsg(e)));
                      void refresh();
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <h2 style={{ marginBottom: 10 }}>Saved prompts</h2>
        <div className="card">
          {[...prompts.map((p) => ({ ...p, sample: false })), ...SAMPLE_PROMPTS.map((s, i) => ({ id: `sample-${i}`, title: s.title, prompt: s.prompt, negative: '', tags: [s.kind], createdAt: '', sample: true }))].map((p) => (
            <div key={p.id} className="list-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--text-0)' }} className="ellipsis">
                  {p.title} {p.sample && <span className="badge">sample</span>}
                </div>
                <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.prompt}</div>
                {!p.sample && <div className="tiny dim">{p.tags.join(', ')} · saved {timeAgo(p.createdAt)}</div>}
              </div>
              <button
                className="btn sm"
                onClick={() => {
                  const mode = p.tags.includes('image-to-video') ? 'image-to-video' : p.tags.includes('video-to-video') ? 'video-to-video' : 'generate';
                  useGen.getState().set(mode, { prompt: p.prompt, negativePrompt: p.negative });
                  setWs(mode);
                }}
              >
                Use
              </button>
              <button className="icon-btn" aria-label="Copy prompt" onClick={() => void navigator.clipboard?.writeText(p.prompt).then(() => useApp.getState().toast('ok', 'Copied'))}>
                <Copy size={13} />
              </button>
              {!p.sample && (
                <button className="icon-btn" aria-label="Delete prompt" onClick={() => void api.deletePrompt(p.id).then(loadPrompts)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {saveOpen && project && <SaveTemplate projectId={project.id} name={project.name} onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

function SaveTemplate({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const [n, setN] = useState(`${name} template`);
  const [d, setD] = useState('');
  const save = async () => {
    try {
      // Templates are created from the saved project; save first so recent edits are included.
      await useProject.getState().save();
      await api.saveAsTemplate(projectId, n, d);
      await useApp.getState().refreshTemplates();
      useApp.getState().toast('ok', 'Template saved');
      onClose();
    } catch (err) {
      useApp.getState().toast('err', errMsg(err));
    }
  };
  return (
    <Modal
      title="Save as template"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save template
          </button>
        </>
      }
    >
      <Field label="Template name">
        <input className="input" value={n} onChange={(e) => setN(e.target.value)} />
      </Field>
      <Field label="Description" hint="The project (tracks, storyboard, characters, environments, effects and media references) is saved as the template. The project is saved first.">
        <textarea className="textarea" rows={2} value={d} onChange={(e) => setD(e.target.value)} />
      </Field>
    </Modal>
  );
}
