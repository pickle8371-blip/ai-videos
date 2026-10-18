import { useEffect, useRef } from 'react';
import type { JobRecord } from '../../../shared/api';
import { useApp } from '../store/app';
import { useProject } from '../store/project';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const LABEL: Record<string, string> = {
  'text-to-video': 'Video generation',
  'image-to-video': 'Image-to-video',
  'video-to-video': 'Video-to-video',
  'text-to-image': 'Image generation',
  'text-to-speech': 'Voice generation',
  transcribe: 'Transcription',
  export: 'Export',
  tool: 'Tool',
  'engine-setup': 'Local AI engine installation',
  'model-download': 'Model download',
};

/**
 * Reacts to job status transitions: refreshes the asset library, updates
 * storyboard shots tied to a job, and notifies the user.
 */
export function useJobSync() {
  const prev = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = prev.current;
    for (const j of useApp.getState().jobs) seen.set(j.id, j.status);
    return useApp.subscribe((state) => {
      for (const job of state.jobs) {
        const before = seen.get(job.id);
        if (before === job.status) continue;
        seen.set(job.id, job.status);
        onTransition(job, before);
      }
    });
  }, []);
}

function onTransition(job: JobRecord, before: string | undefined) {
  const app = useApp.getState();
  const ps = useProject.getState();
  const label = LABEL[job.task] ?? job.task;
  if (job.shotId && ps.project?.id === job.projectId && ps.project.storyboard.shots.some((s) => s.id === job.shotId)) {
    ps.apply(
      'Update shot from generation',
      (d) => {
        const shot = d.storyboard.shots.find((s) => s.id === job.shotId);
        if (!shot) return;
        shot.lastJobId = job.id;
        if (job.status === 'queued' || job.status === 'submitting') shot.status = 'queued';
        else if (job.status === 'running' || job.status === 'downloading') shot.status = 'generating';
        else if (job.status === 'succeeded') {
          const id = job.outputAssetIds[0] ?? null;
          if (job.task === 'text-to-image') shot.frameAssetId = id ?? shot.frameAssetId;
          else {
            shot.videoAssetId = id ?? shot.videoAssetId;
            shot.status = 'done';
            shot.review = 'unreviewed';
          }
          if (job.task === 'text-to-image' && shot.status !== 'done') shot.status = 'draft';
          shot.error = null;
          for (const a of job.outputAssetIds) if (!d.assetIds.includes(a)) d.assetIds.push(a);
        } else if (job.status === 'failed') {
          shot.status = 'failed';
          shot.error = job.error;
        } else if (job.status === 'canceled') shot.status = 'draft';
      },
      { coalesce: `shot-${job.shotId}` },
    );
  } else if (job.status === 'succeeded' && ps.project?.id === job.projectId && job.outputAssetIds.length && job.task !== 'export') {
    ps.apply('Record generated assets', (d) => {
      for (const a of job.outputAssetIds) if (!d.assetIds.includes(a)) d.assetIds.push(a);
    }, { coalesce: 'record-assets' });
  }
  if (!TERMINAL.has(job.status) || before === undefined) return;
  if (job.task === 'engine-setup' || job.task === 'model-download') {
    void app.refreshEngine(true).catch(() => undefined);
    if (job.status === 'succeeded') app.toast('ok', job.task === 'engine-setup' ? 'Local AI engine installed and verified' : `Model downloaded: ${job.modelId}`);
    else if (job.status === 'failed') app.toast('err', `${label} failed: ${job.error ?? 'unknown error'}`);
    return;
  }
  if (job.status === 'succeeded') {
    void app.refreshAssets().catch(() => undefined);
    if (job.task === 'export') {
      const preview = (job.params as { preview?: boolean }).preview;
      if (!preview) app.toast('ok', `Export finished and validated: ${String((job.result as { file?: string } | null)?.file ?? '')}`, { label: 'Show', run: () => app.setWorkspace('history') });
    } else app.toast('ok', `${label} finished${job.outputAssetIds.length ? ` — ${job.outputAssetIds.length} file(s) saved to the library` : ''}`);
  } else if (job.status === 'failed') {
    app.toast('err', `${label} failed: ${job.error ?? 'unknown error'}`, { label: 'History', run: () => app.setWorkspace('history') });
  }
}
