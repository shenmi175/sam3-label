import { create } from 'zustand';
import type { InferJob } from '../../api/inference';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackendErrorType = 'both-loaded' | 'sam3-not-ready';

export interface BackendErrorModalState {
  type: BackendErrorType;
  detail: Record<string, unknown>;
}

export interface BatchConfigRequest {
  classes: string[];
  title: string;
  /** Resolved with the modal result, or null when the modal is cancelled. */
  resolve: (result: BatchConfigResult | null) => void;
}

export interface BatchConfigResult {
  scope_mode: 'all' | 'unlabeled' | 'class_related' | 'class_related_unlabeled';
  related_classes: string[];
  image_ids: string[];
  retry_image_ids: string[];
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Passive inference state. Mirrors the inference-related fields on the legacy
 * God Object. Orchestration (polling, modals, API calls) lives in the
 * useInference / useJobPolling hooks, keeping this store side-effect free.
 */
interface InferenceStore {
  activeJobId: string | null;
  isPolling: boolean;
  /** Job snapshot driving the task progress bar. */
  job: InferJob | null;
  taskBarVisible: boolean;
  taskBarText: string;
  /** Dedup guard: the job id the batch result modal was already shown for. */
  batchResultShownForJobId: string;
  /** Job whose result modal is currently open. */
  batchResultJob: InferJob | null;
  backendErrorModal: BackendErrorModalState | null;
  batchConfigRequest: BatchConfigRequest | null;

  setActiveJobId: (jobId: string | null) => void;
  setIsPolling: (polling: boolean) => void;
  setJob: (job: InferJob | null) => void;
  setTaskBar: (visible: boolean, text: string) => void;
  setBatchResultShownForJobId: (jobId: string) => void;
  showBatchResult: (job: InferJob) => void;
  closeBatchResult: () => void;
  showBackendError: (type: BackendErrorType, detail: Record<string, unknown>) => void;
  closeBackendError: () => void;
  openBatchConfig: (classes: string[], title: string) => Promise<BatchConfigResult | null>;
  resolveBatchConfig: (result: BatchConfigResult | null) => void;
  reset: () => void;
}

export const useInferenceStore = create<InferenceStore>((set, get) => ({
  activeJobId: null,
  isPolling: false,
  job: null,
  taskBarVisible: false,
  taskBarText: '',
  batchResultShownForJobId: '',
  batchResultJob: null,
  backendErrorModal: null,
  batchConfigRequest: null,

  setActiveJobId: (jobId) => set({ activeJobId: jobId }),
  setIsPolling: (polling) => set({ isPolling: polling }),
  setJob: (job) => set({ job }),
  setTaskBar: (visible, text) => set({ taskBarVisible: visible, taskBarText: text }),
  setBatchResultShownForJobId: (jobId) => set({ batchResultShownForJobId: jobId }),

  showBatchResult: (job) => set({ batchResultJob: job, batchResultShownForJobId: job.job_id }),

  closeBatchResult: () => set({ batchResultJob: null }),

  showBackendError: (type, detail) => set({ backendErrorModal: { type, detail } }),

  closeBackendError: () => set({ backendErrorModal: null }),

  openBatchConfig: (classes, title) => {
    return new Promise<BatchConfigResult | null>((resolve) => {
      set({ batchConfigRequest: { classes, title, resolve } });
    });
  },

  resolveBatchConfig: (result) => {
    const request = get().batchConfigRequest;
    if (request) request.resolve(result);
    set({ batchConfigRequest: null });
  },

  reset: () =>
    set({
      activeJobId: null,
      isPolling: false,
      job: null,
      taskBarVisible: false,
      taskBarText: '',
      batchResultShownForJobId: '',
      batchResultJob: null,
      backendErrorModal: null,
      batchConfigRequest: null,
    }),
}));
