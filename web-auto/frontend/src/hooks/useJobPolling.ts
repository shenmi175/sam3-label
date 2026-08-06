import { useEffect } from 'react';
import { getInferJob, getInferActiveJob } from '../api/inference';
import { clearBundleCache } from '../api/bundleCache';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';

const JOB_POLL_INTERVAL_MS = 1000;
const TASK_BAR_HIDE_DELAY_MS = 3000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Job status polling loop — 1:1 port of the legacy `pollTaskStatus` state
 * machine. Module-level (not per-component) so only one loop ever runs:
 *   - done/error/cancelled → hide bar after 3 s, show the batch result modal
 *     for finished text_batch jobs (dedup via batchResultShownForJobId),
 *     clear the whole bundle cache on done, refresh project info and reload
 *     the selected image.
 *   - pausing/paused states are surfaced through inferenceStore.job for the
 *     task bar's Stop/Resume/Cancel buttons.
 */
export function startJobPolling(): void {
  const store = useInferenceStore.getState();
  if (store.isPolling) return;
  useInferenceStore.setState({ isPolling: true });
  useInferenceStore.getState().setTaskBar(true, '');

  const poll = async () => {
    const state = useInferenceStore.getState();
    if (!state.activeJobId) {
      state.setIsPolling(false);
      return;
    }
    try {
      const res = await getInferJob(state.activeJobId);
      const job = res?.job || null;
      if (!job) {
        state.setActiveJobId(null);
        state.setIsPolling(false);
        state.setTaskBar(false, '');
        return;
      }
      const current = useInferenceStore.getState();
      const pct = Number(job.progress_pct || 0);
      current.setJob(job);
      current.setTaskBar(true, job.message || `${Math.round(pct)}%`);

      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        setTimeout(() => {
          const s = useInferenceStore.getState();
          if (!s.activeJobId) s.setTaskBar(false, '');
        }, TASK_BAR_HIDE_DELAY_MS);
        if (job.job_type === 'text_batch' && job.status === 'done') {
          if (current.batchResultShownForJobId !== job.job_id) {
            current.showBatchResult(job);
          }
        }
        if (job.status === 'done') {
          clearBundleCache();
        }
        current.setActiveJobId(null);
        current.setIsPolling(false);
        await useProjectStore.getState().loadProjectInfo();
        if (useImageStore.getState().selectedImageId) {
          await useImageStore.getState().reloadSelectedImage();
        }
        return;
      }
      pollTimer = setTimeout(poll, JOB_POLL_INTERVAL_MS);
    } catch (err) {
      console.error('Poll error', err);
      useInferenceStore.getState().setIsPolling(false);
    }
  };

  void poll();
}

export function stopJobPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  useInferenceStore.getState().setIsPolling(false);
}

/**
 * Component hook: restores the project's active job on mount (legacy
 * loadProjectInfo active-job check) and stops polling on unmount.
 */
export function useJobPolling(projectId: string) {
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getInferActiveJob(projectId)
      .then((res) => {
        if (cancelled) return;
        const job = res?.job;
        if (job && job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') {
          const store = useInferenceStore.getState();
          store.setActiveJobId(job.job_id);
          store.setJob(job);
          startJobPolling();
        }
      })
      .catch(() => {
        // No active job or transient error — nothing to poll.
      });
    return () => {
      cancelled = true;
      stopJobPolling();
    };
  }, [projectId]);
}
