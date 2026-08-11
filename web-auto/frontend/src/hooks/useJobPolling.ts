import { useEffect } from 'react';
import { getInferJob, getInferActiveJob } from '../api/inference';
import { clearBundleCache } from '../api/bundleCache';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';

const JOB_POLL_INTERVAL_MS = 1000;
const JOB_POLL_ERROR_INTERVAL_MS = 3000;
const TASK_BAR_HIDE_DELAY_MS = 3000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);

/**
 * Job status polling loop — 1:1 port of the legacy `pollTaskStatus` state
 * machine. Module-level (not per-component) so only one loop ever runs:
 *   - done/error/cancelled → hide bar after 3 s, show the batch result modal
 *     for finished text_batch jobs (dedup via batchResultShownForJobId),
 *     clear the whole bundle cache on done, refresh project info and reload
 *     the selected image. If the project still has another active job (e.g.
 *     a queued job unblocked after a cancellation), hand polling over to it.
 *   - pausing/paused states are surfaced through inferenceStore.job for the
 *     task bar's Stop/Resume/Cancel buttons.
 *   - transient fetch errors retry on a slower interval instead of killing
 *     the loop, which used to freeze the task bar at a stale message.
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

      if (TERMINAL_STATUSES.has(job.status)) {
        if (job.job_type === 'text_batch' && job.status === 'done') {
          if (current.batchResultShownForJobId !== job.job_id) {
            current.showBatchResult(job);
          }
        }
        if (job.status === 'done') {
          clearBundleCache();
          await useProjectStore.getState().loadProjectInfo();
          if (useImageStore.getState().selectedImageId) {
            await useImageStore.getState().reloadSelectedImage();
          }
        }
        const nextJob = await fetchActiveJob();
        if (nextJob) {
          current.setActiveJobId(nextJob.job_id);
          current.setJob(nextJob);
          current.setTaskBar(true, nextJob.message || '');
          pollTimer = setTimeout(poll, JOB_POLL_INTERVAL_MS);
          return;
        }
        setTimeout(() => {
          const s = useInferenceStore.getState();
          if (!s.activeJobId) s.setTaskBar(false, '');
        }, TASK_BAR_HIDE_DELAY_MS);
        current.setActiveJobId(null);
        current.setIsPolling(false);
        return;
      }
      pollTimer = setTimeout(poll, JOB_POLL_INTERVAL_MS);
    } catch (err) {
      console.error('Poll error', err);
      pollTimer = setTimeout(poll, JOB_POLL_ERROR_INTERVAL_MS);
    }
  };

  void poll();
}

/** Returns the project's active job if one is still running/queued. */
async function fetchActiveJob() {
  const projectId = useProjectStore.getState().projectId;
  if (!projectId) return null;
  try {
    const res = await getInferActiveJob(projectId);
    const job = res?.job || null;
    return job && !TERMINAL_STATUSES.has(job.status) ? job : null;
  } catch {
    return null;
  }
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
