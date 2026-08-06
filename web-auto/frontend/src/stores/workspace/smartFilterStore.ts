import { create } from 'zustand';
import * as filtersApi from '../../api/filters';
import type {
  FilterAreaMode,
  FilterMergeMode,
  FilterOperationMode,
  FilterRun,
  FilterSpatialMode,
  SmartFilterJobResult,
  SmartFilterPayload,
} from '../../api/filters';
import { clearBundleCache } from '../../api/bundleCache';
import { toast } from '../../utils/notify';
import i18n from '../../i18n';

// ─── Constants ────────────────────────────────────────────────────────────────

export const FILTER_POLL_INTERVAL_MS = 1200;

export type FilterPreset = '' | 'dedupe' | 'canonical' | 'cleanup' | 'delete_unlabeled';
export type FilterJobKind = 'preview' | 'apply';

export interface SmartFilterConfig {
  operationMode: FilterOperationMode;
  mergeMode: FilterMergeMode;
  spatialMode: FilterSpatialMode;
  areaMode: FilterAreaMode;
  coverageThreshold: number;
  canonicalClass: string;
  sourceClasses: string[];
  ruleClasses: string[];
  smallTargetEnabled: boolean;
  maxAreaRatio: number;
  instanceCountEnabled: boolean;
  minInstances: number;
  maxInstances: number;
  positionEnabled: boolean;
  centerXHalfWidth: number;
  centerYHalfHeight: number;
  confidenceEnabled: boolean;
  minConfidence: number;
  maxConfidence: number;
}

const DEFAULT_CONFIG: SmartFilterConfig = {
  operationMode: 'merge',
  mergeMode: 'same_class',
  spatialMode: 'instance_cover',
  areaMode: 'instance',
  coverageThreshold: 0.98,
  canonicalClass: '',
  sourceClasses: [],
  ruleClasses: [],
  smallTargetEnabled: false,
  maxAreaRatio: 0.02,
  instanceCountEnabled: false,
  minInstances: 1,
  maxInstances: 0,
  positionEnabled: false,
  centerXHalfWidth: 0.25,
  centerYHalfHeight: 0.05,
  confidenceEnabled: false,
  minConfidence: 0,
  maxConfidence: 1,
};

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Smart filter state machine — 1:1 port of the legacy SmartFilterController
 * (smart-filter-controller.js): config collection + validation, preview/apply
 * job submission with 1.2 s polling, runs/latest rollback panel state.
 *
 * Post-apply workspace refresh (bundle cache clear + project reload + image
 * list/selection fixups) is driven by `useSmartFilterJob` watching the
 * applyCompletedSeq / rollbackCompletedSeq counters.
 */
interface SmartFilterStore {
  projectId: string;
  config: SmartFilterConfig;
  activePreset: FilterPreset;

  // Job state
  jobId: string;
  jobKind: FilterJobKind | null;
  jobRunning: boolean;
  progressPct: number;
  jobMessage: string;
  jobFailed: boolean;

  // Results
  previewToken: string;
  previewResult: SmartFilterJobResult | null;
  applyResult: SmartFilterJobResult | null;
  lastAppliedMode: FilterOperationMode | '';
  latestRun: FilterRun | null;
  rollbackBusy: boolean;

  /** Bumped after a successful apply so useSmartFilterJob refreshes the workspace. */
  applyCompletedSeq: number;
  /** Bumped after a successful rollback. */
  rollbackCompletedSeq: number;

  setProjectId: (projectId: string) => void;
  updateConfig: (partial: Partial<SmartFilterConfig>) => void;
  applyPreset: (preset: Exclude<FilterPreset, ''>, classes: string[]) => void;
  startPreview: () => Promise<void>;
  startApply: () => Promise<void>;
  loadLatestRun: () => Promise<void>;
  rollbackLatestRun: () => Promise<void>;
  stopPolling: () => void;
  reset: () => void;
}

let filterPollTimer: ReturnType<typeof setTimeout> | null = null;

function clearFilterTimer() {
  if (filterPollTimer) {
    clearTimeout(filterPollTimer);
    filterPollTimer = null;
  }
}

/** Legacy resetPreviewState: hide apply, clear summary/token/progress. */
function previewIdleState() {
  return {
    previewToken: '',
    previewResult: null,
    applyResult: null,
    progressPct: 0,
    jobFailed: false,
    jobMessage: i18n.t('sf_idle_hint'),
  };
}

/** Legacy collectPayload — validates per operation mode and builds the body. */
function buildPayload(projectId: string, config: SmartFilterConfig): SmartFilterPayload {
  const {
    operationMode, mergeMode, spatialMode, areaMode, coverageThreshold,
    canonicalClass, sourceClasses, ruleClasses,
    smallTargetEnabled, maxAreaRatio, instanceCountEnabled, minInstances, maxInstances,
    positionEnabled, centerXHalfWidth, centerYHalfHeight,
    confidenceEnabled, minConfidence, maxConfidence,
  } = config;

  if (operationMode === 'merge' && mergeMode === 'canonical_class' && sourceClasses.length === 0) {
    throw new Error(i18n.t('sf_need_source_class'));
  }
  if (operationMode === 'rule' && ruleClasses.length === 0) {
    throw new Error(i18n.t('sf_need_rule_classes'));
  }
  if (
    operationMode === 'rule'
    && !(smallTargetEnabled || instanceCountEnabled || positionEnabled || confidenceEnabled)
  ) {
    throw new Error(i18n.t('sf_need_one_rule'));
  }

  return {
    project_id: projectId,
    operation_mode: operationMode,
    merge_mode: operationMode === 'merge' ? mergeMode : 'same_class',
    spatial_mode: operationMode === 'merge' ? spatialMode : 'instance_cover',
    coverage_threshold: Number(coverageThreshold),
    canonical_class: operationMode === 'merge' && mergeMode === 'canonical_class' ? canonicalClass : '',
    source_classes: operationMode === 'merge' && mergeMode === 'canonical_class' ? sourceClasses : [],
    area_mode: areaMode,
    rule_classes: operationMode === 'rule' ? ruleClasses : [],
    small_target_enabled: operationMode === 'rule' ? smallTargetEnabled : false,
    max_area_ratio: Number(maxAreaRatio) || 0.02,
    instance_count_enabled: operationMode === 'rule' ? instanceCountEnabled : false,
    min_instances: Math.max(0, Math.trunc(Number(minInstances) || 1)),
    max_instances: Math.max(0, Math.trunc(Number(maxInstances) || 0)),
    position_enabled: operationMode === 'rule' ? positionEnabled : false,
    center_x_half_width: Number(centerXHalfWidth) || 0.25,
    center_y_half_height: Number(centerYHalfHeight) || 0.05,
    confidence_enabled: operationMode === 'rule' ? confidenceEnabled : false,
    min_confidence: Number(minConfidence) || 0,
    max_confidence: Number.isFinite(Number(maxConfidence)) ? Number(maxConfidence) : 1,
  };
}

/** Legacy pollFilterJob — 1.2 s polling state machine for preview/apply jobs. */
function pollFilterJob(jobId: string, kind: FilterJobKind) {
  clearFilterTimer();
  void (async () => {
    let store = useSmartFilterStore.getState();
    if (!jobId || store.jobId !== jobId) return;
    try {
      const res = await filtersApi.getFilterJob(jobId);
      const job = res?.job || null;
      store = useSmartFilterStore.getState();
      if (store.jobId !== jobId) return;
      if (!job) {
        useSmartFilterStore.setState({ jobRunning: false, jobMessage: i18n.t('sf_job_not_found') });
        return;
      }
      const pct = Number(job.progress_pct || 0);
      useSmartFilterStore.setState({ progressPct: pct, jobMessage: job.message || i18n.t('sf_processing') });

      if (job.status === 'done') {
        const result = job.result || {};
        if (kind === 'preview') {
          useSmartFilterStore.setState({
            jobRunning: false,
            previewToken: String(result.preview_token || ''),
            previewResult: result,
          });
          return;
        }
        // apply done (legacy branch): summary + rollback panel + workspace refresh.
        const mode = String(result.operation_mode || store.config.operationMode);
        let latestRun: FilterRun | null = null;
        if (mode !== 'delete_unlabeled' && result.rollback_run_id) {
          latestRun = {
            run_id: String(result.rollback_run_id),
            summary: result,
            snapshot_count: Number(result.changed_images || 0),
          };
        }
        clearBundleCache();
        useSmartFilterStore.setState((s) => ({
          jobRunning: false,
          applyResult: result,
          previewResult: null,
          previewToken: '',
          latestRun,
          lastAppliedMode: mode as FilterOperationMode,
          applyCompletedSeq: s.applyCompletedSeq + 1,
        }));
        toast(
          mode === 'merge'
            ? i18n.t('sf_applied_merge')
            : mode === 'delete_unlabeled'
              ? i18n.t('sf_applied_delete_unlabeled')
              : i18n.t('sf_applied_rule'),
          'success',
        );
        return;
      }

      if (job.status === 'error') {
        useSmartFilterStore.setState({
          jobRunning: false,
          jobFailed: true,
          jobMessage: job.error || job.message || i18n.t('sf_job_failed'),
        });
        return;
      }

      filterPollTimer = setTimeout(() => pollFilterJob(jobId, kind), FILTER_POLL_INTERVAL_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useSmartFilterStore.setState({
        jobRunning: false,
        jobFailed: true,
        jobMessage: i18n.t('sf_poll_failed', { error: message }),
      });
    }
  })();
}

export const useSmartFilterStore = create<SmartFilterStore>((set, get) => ({
  projectId: '',
  config: { ...DEFAULT_CONFIG },
  activePreset: 'dedupe',

  jobId: '',
  jobKind: null,
  jobRunning: false,
  progressPct: 0,
  jobMessage: i18n.t('sf_idle_hint'),
  jobFailed: false,

  previewToken: '',
  previewResult: null,
  applyResult: null,
  lastAppliedMode: '',
  latestRun: null,
  rollbackBusy: false,

  applyCompletedSeq: 0,
  rollbackCompletedSeq: 0,

  setProjectId: (projectId) => set({ projectId }),

  updateConfig: (partial) =>
    set((s) => ({ config: { ...s.config, ...partial }, activePreset: '', ...previewIdleState() })),

  applyPreset: (preset, classes) => {
    // Legacy applyPreset: reset preview state then seed the config.
    const base: Partial<SmartFilterConfig> = {
      smallTargetEnabled: false,
      instanceCountEnabled: false,
      positionEnabled: false,
      confidenceEnabled: false,
      minConfidence: 0,
      maxConfidence: 1,
      maxAreaRatio: 0.02,
    };
    let config: Partial<SmartFilterConfig>;
    if (preset === 'delete_unlabeled') {
      config = { ...base, operationMode: 'delete_unlabeled' };
    } else if (preset === 'cleanup') {
      config = {
        ...base,
        operationMode: 'rule',
        smallTargetEnabled: true,
        confidenceEnabled: true,
        maxConfidence: 0.35,
        ruleClasses: [...classes],
      };
    } else {
      config = {
        ...base,
        operationMode: 'merge',
        mergeMode: preset === 'canonical' ? 'canonical_class' : 'same_class',
        spatialMode: 'instance_cover',
        areaMode: 'instance',
        coverageThreshold: preset === 'canonical' ? 0.95 : 0.98,
      };
    }
    set((s) => ({ config: { ...s.config, ...config }, activePreset: preset, ...previewIdleState() }));
  },

  startPreview: async () => {
    const { projectId, config, jobRunning } = get();
    if (!projectId || jobRunning) return;
    let payload: SmartFilterPayload;
    try {
      payload = buildPayload(projectId, config);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    set({
      jobKind: 'preview',
      jobRunning: true,
      jobId: '',
      progressPct: 0,
      jobFailed: false,
      jobMessage: i18n.t('sf_submitting_preview'),
      previewToken: '',
      previewResult: null,
      applyResult: null,
    });
    try {
      const res = await filtersApi.startFilterPreviewJob(payload);
      const job = res?.job || null;
      if (!job?.job_id) throw new Error(i18n.t('sf_no_job_id'));
      set({ jobId: job.job_id, jobMessage: i18n.t('sf_preview_started') });
      pollFilterJob(job.job_id, 'preview');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ jobRunning: false, jobFailed: true, jobMessage: message });
      toast(message, 'error');
    }
  },

  startApply: async () => {
    const { projectId, config, previewToken, jobRunning } = get();
    if (!projectId || jobRunning) return;
    if (!previewToken) {
      toast(i18n.t('filter_preview_expired'), 'error');
      return;
    }
    let payload: SmartFilterPayload;
    try {
      payload = { ...buildPayload(projectId, config), preview_token: previewToken };
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    set({
      jobKind: 'apply',
      jobRunning: true,
      jobId: '',
      progressPct: 0,
      jobFailed: false,
      jobMessage: i18n.t('sf_submitting_apply'),
      previewResult: null,
      applyResult: null,
    });
    try {
      const res = await filtersApi.startFilterApplyJob(payload);
      const job = res?.job || null;
      if (!job?.job_id) throw new Error(i18n.t('sf_no_job_id'));
      const mode = config.operationMode;
      set({
        jobId: job.job_id,
        jobMessage:
          mode === 'merge'
            ? i18n.t('sf_applying_merge')
            : mode === 'delete_unlabeled'
              ? i18n.t('sf_applying_delete_unlabeled')
              : i18n.t('sf_applying_rule'),
      });
      pollFilterJob(job.job_id, 'apply');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ jobRunning: false, jobFailed: true, jobMessage: message });
      toast(message, 'error');
    }
  },

  loadLatestRun: async () => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const res = await filtersApi.getLatestFilterRun(projectId);
      // Ignore stale responses after a project switch/reset.
      if (useSmartFilterStore.getState().projectId !== projectId) return;
      set({ latestRun: res?.run || null });
    } catch (err) {
      console.warn('load latest smart filter run failed', err);
    }
  },

  rollbackLatestRun: async () => {
    const { projectId, latestRun, rollbackBusy } = get();
    if (!projectId || !latestRun?.run_id || rollbackBusy) return;
    set({ rollbackBusy: true });
    try {
      const res = await filtersApi.rollbackFilterRun(projectId, latestRun.run_id);
      const restored = Number(res?.result?.restored_images || 0);
      toast(i18n.t('sf_rollback_done', { count: restored }), 'success');
      clearBundleCache();
      set((s) => ({ latestRun: null, rollbackCompletedSeq: s.rollbackCompletedSeq + 1 }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      set({ rollbackBusy: false });
    }
  },

  stopPolling: () => {
    clearFilterTimer();
  },

  reset: () => {
    clearFilterTimer();
    set({
      projectId: '',
      config: { ...DEFAULT_CONFIG },
      activePreset: 'dedupe',
      jobId: '',
      jobKind: null,
      jobRunning: false,
      progressPct: 0,
      jobMessage: i18n.t('sf_idle_hint'),
      jobFailed: false,
      previewToken: '',
      previewResult: null,
      applyResult: null,
      lastAppliedMode: '',
      latestRun: null,
      rollbackBusy: false,
      applyCompletedSeq: 0,
      rollbackCompletedSeq: 0,
    });
  },
}));
