import { create } from 'zustand';
import {
  getInferActiveJob,
  getFilterActiveJob,
  stopInferJob,
  resumeInferJob,
  type InferJob,
} from '../../api/inference';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskJob extends InferJob {
  /** Which subsystem produced this job. */
  taskKind: 'infer' | 'filter';
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const TASK_POLL_INTERVAL_MS = 2000;

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Global task status store — mirrors the legacy TaskManager component
 * (components/tasks.js).
 *
 * Backend fact: GET /api/jobs requires project_id (no global endpoint), so we
 * poll the per-project active-job endpoints for both inference and smart
 * filter jobs, exactly like the legacy TaskManager.
 *
 * Polling is driven by startPolling/stopPolling. The workspace page registers
 * the current project via setProjectContext; the App-level TaskWidget renders
 * whatever jobs are present.
 */
interface TasksStore {
  projectId: string | null;
  projectName: string | null;
  jobs: TaskJob[];
  /** Job ids dismissed by the user (cleared when the job disappears). */
  dismissed: string[];
  polling: boolean;
  actionBusy: string | null; // job id currently being stopped/resumed

  setProjectContext: (projectId: string | null, projectName?: string | null) => void;
  poll: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  dismissJob: (jobId: string) => void;
  stopJob: (projectId: string, jobId: string, taskKind: 'infer' | 'filter') => Promise<void>;
  resumeJob: (projectId: string, job: TaskJob) => Promise<void>;
  reset: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useTasksStore = create<TasksStore>((set, get) => ({
  projectId: null,
  projectName: null,
  jobs: [],
  dismissed: [],
  polling: false,
  actionBusy: null,

  setProjectContext: (projectId, projectName = null) => {
    const current = get();
    if (current.projectId === projectId) {
      // Same project: only allow a late project-name fill-in.
      if (current.projectName !== projectName) set({ projectName });
      return;
    }
    set({ projectId, projectName, jobs: [], dismissed: [] });
  },

  poll: async () => {
    const { projectId, dismissed } = get();
    if (!projectId) {
      set({ jobs: [] });
      return;
    }
    const [inferResult, filterResult] = await Promise.allSettled([
      getInferActiveJob(projectId),
      getFilterActiveJob(projectId),
    ]);
    const jobs: TaskJob[] = [];
    if (inferResult.status === 'fulfilled' && inferResult.value?.job) {
      const job = inferResult.value.job;
      if (job.status !== 'done' && job.status !== 'error') {
        jobs.push({ ...job, taskKind: 'infer' });
      }
    }
    if (filterResult.status === 'fulfilled' && filterResult.value?.job) {
      const job = filterResult.value.job;
      if (job.status !== 'done' && job.status !== 'error') {
        jobs.push({ ...job, taskKind: 'filter' });
      }
    }
    // Clean up dismissed ids for jobs that are gone.
    const liveIds = new Set(jobs.map((j) => j.job_id));
    const nextDismissed = dismissed.filter((id) => liveIds.has(id));
    set({ jobs, dismissed: nextDismissed });
  },

  startPolling: () => {
    if (pollTimer) return;
    set({ polling: true });
    const tick = async () => {
      try {
        await get().poll();
      } catch {
        // Ignore transient poll failures.
      }
      pollTimer = setTimeout(tick, TASK_POLL_INTERVAL_MS);
    };
    void tick();
  },

  stopPolling: () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    set({ polling: false });
  },

  dismissJob: (jobId) => {
    set((state) => ({ dismissed: [...state.dismissed, jobId] }));
  },

  stopJob: async (projectId, jobId, taskKind) => {
    if (taskKind === 'filter') {
      // Legacy behavior: filter jobs have no stop endpoint and cannot be
      // stopped manually.
      return;
    }
    set({ actionBusy: jobId });
    try {
      await stopInferJob(projectId);
      await get().poll();
    } finally {
      set({ actionBusy: null });
    }
  },

  resumeJob: async (projectId, job) => {
    set({ actionBusy: job.job_id });
    try {
      await resumeInferJob({ project_id: projectId });
      await get().poll();
    } finally {
      set({ actionBusy: null });
    }
  },

  reset: () => {
    get().stopPolling();
    set({ projectId: null, projectName: null, jobs: [], dismissed: [], actionBusy: null });
  },
}));
