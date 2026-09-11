import { create } from 'zustand';
import * as filtersApi from '../../api/filters';
import type {
  FilterAreaMode,
  FilterMergeMode,
  FilterOperationMode,
  FilterRun,
  FilterSpatialMode,
  FilterTaskType,
  SmartFilterJobResult,
  SmartFilterPayload,
} from '../../api/filters';
import { clearBundleCache } from '../../api/bundleCache';
import { toast } from '../../utils/notify';
import i18n from '../../i18n';
import { useProjectStore } from './projectStore';
import { useImageStore } from './imageStore';

// ─── Constants ────────────────────────────────────────────────────────────────

export const FILTER_POLL_INTERVAL_MS = 1200;

export type FilterPreset = '' | 'dedupe' | 'canonical' | 'cleanup' | 'delete_unlabeled';
export type FilterJobKind = 'preview' | 'apply';

export interface SmartFilterConfig {
  taskType: FilterTaskType;
  classScopeMode: 'all' | 'selected';
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
  includeMissingConfidence: boolean;
  ruleMatchMode: 'all' | 'any';
  positionMatchMode: 'inside' | 'outside';
  componentAbsAreaEnabled: boolean;
  componentMaxAreaPx: number;
  componentRelativeAreaEnabled: boolean;
  componentMaxMainRatio: number;
  componentRequireAllThresholds: boolean;
  componentOpeningEnabled: boolean;
  componentOpeningRadiusPx: number;
  componentOpeningIterations: number;
  componentGapRepairEnabled: boolean;
  componentGapRepairMethod: 'shortest_bridge' | 'morph_close';
  componentBridgeMaxGapPx: number;
  componentBridgeWidthPx: number;
  componentBridgeTopology: 'mst' | 'main_only';
  componentClosingRadiusPx: number;
  componentClosingIterations: number;
  componentGapAvoidOtherInstances: boolean;
  componentHoleFillEnabled: boolean;
  componentHoleAbsAreaEnabled: boolean;
  componentMaxHoleAreaPx: number;
  componentHoleRelativeAreaEnabled: boolean;
  componentMaxHoleMainRatio: number;
  componentHoleRequireAllThresholds: boolean;
}

export const DEFAULT_CONFIG: SmartFilterConfig = {
  taskType: 'remove_small_components',
  classScopeMode: 'all',
  operationMode: 'component_noise',
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
  includeMissingConfidence: false,
  ruleMatchMode: 'all',
  positionMatchMode: 'inside',
  componentAbsAreaEnabled: true,
  componentMaxAreaPx: 128,
  componentRelativeAreaEnabled: true,
  componentMaxMainRatio: 0.001,
  componentRequireAllThresholds: true,
  componentOpeningEnabled: false,
  componentOpeningRadiusPx: 1,
  componentOpeningIterations: 1,
  componentGapRepairEnabled: false,
  componentGapRepairMethod: 'shortest_bridge',
  componentBridgeMaxGapPx: 16,
  componentBridgeWidthPx: 3,
  componentBridgeTopology: 'mst',
  componentClosingRadiusPx: 8,
  componentClosingIterations: 1,
  componentGapAvoidOtherInstances: true,
  componentHoleFillEnabled: false,
  componentHoleAbsAreaEnabled: true,
  componentMaxHoleAreaPx: 128,
  componentHoleRelativeAreaEnabled: true,
  componentMaxHoleMainRatio: 0.001,
  componentHoleRequireAllThresholds: true,
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
  jobStatus: string;
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
  selectTask: (taskType: FilterTaskType) => void;
  applyPreset: (preset: Exclude<FilterPreset, ''>, classes: string[]) => void;
  startPreview: () => Promise<void>;
  startApply: () => Promise<void>;
  pauseJob: () => Promise<void>;
  resumeJob: () => Promise<void>;
  cancelJob: () => Promise<void>;
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

const waitForFilterControl = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

function resolveProjectId(storedProjectId: string): string {
  return String(useProjectStore.getState().projectId || storedProjectId || '').trim();
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

export function taskOperation(taskType: FilterTaskType): FilterOperationMode {
  if (['remove_small_components', 'remove_edge_spurs', 'shortest_bridge', 'morph_close', 'fill_small_holes'].includes(taskType)) return 'component_noise';
  if (taskType === 'deduplicate_same_class' || taskType === 'normalize_classes') return 'merge';
  if (taskType === 'delete_unlabeled_images') return 'delete_unlabeled';
  return 'rule';
}

/** Build a strict v2 body containing parameters for exactly one task. */
export function buildPayload(projectId: string, config: SmartFilterConfig): SmartFilterPayload {
  const task = config.taskType;
  if (config.classScopeMode === 'selected' && config.ruleClasses.length === 0) throw new Error(i18n.t('sf_need_rule_classes'));
  if (task === 'delete_by_box_count' && config.maxInstances > 0 && config.maxInstances < config.minInstances) throw new Error(i18n.t('sf_invalid_instance_range'));
  if (task === 'remove_confidence_range' && config.maxConfidence < config.minConfidence) throw new Error(i18n.t('sf_invalid_confidence_range'));
  if (task === 'remove_small_components' && !(config.componentAbsAreaEnabled || config.componentRelativeAreaEnabled)) throw new Error(i18n.t('sf_component_need_operation'));
  if (task === 'fill_small_holes' && !(config.componentHoleAbsAreaEnabled || config.componentHoleRelativeAreaEnabled)) throw new Error(i18n.t('sf_hole_need_threshold'));
  if (task === 'normalize_classes' && !config.canonicalClass.trim()) throw new Error(i18n.t('sf_need_target_class'));

  let params: SmartFilterPayload['params'];
  switch (task) {
    case 'remove_small_components': params = { absolute_area_enabled: config.componentAbsAreaEnabled, max_area_px: config.componentMaxAreaPx, relative_area_enabled: config.componentRelativeAreaEnabled, max_main_ratio: config.componentMaxMainRatio, threshold_mode: config.componentRequireAllThresholds ? 'and' : 'or' }; break;
    case 'remove_edge_spurs': params = { radius_px: config.componentOpeningRadiusPx, iterations: config.componentOpeningIterations }; break;
    case 'shortest_bridge': params = { max_gap_px: config.componentBridgeMaxGapPx, bridge_width_px: config.componentBridgeWidthPx, topology: config.componentBridgeTopology, avoid_other_instances: config.componentGapAvoidOtherInstances }; break;
    case 'morph_close': params = { radius_px: config.componentClosingRadiusPx, iterations: config.componentClosingIterations, avoid_other_instances: config.componentGapAvoidOtherInstances }; break;
    case 'fill_small_holes': params = { absolute_area_enabled: config.componentHoleAbsAreaEnabled, max_area_px: config.componentMaxHoleAreaPx, relative_area_enabled: config.componentHoleRelativeAreaEnabled, max_main_ratio: config.componentMaxHoleMainRatio, threshold_mode: config.componentHoleRequireAllThresholds ? 'and' : 'or' }; break;
    case 'deduplicate_same_class': params = { spatial_mode: config.spatialMode, coverage_threshold: config.coverageThreshold }; break;
    case 'remove_small_instances': params = { max_image_ratio: config.maxAreaRatio }; break;
    case 'remove_confidence_range': params = { min_confidence: config.minConfidence, max_confidence: config.maxConfidence }; break;
    case 'remove_position_region': params = { center_x_half_width: config.centerXHalfWidth, center_y_half_height: config.centerYHalfHeight, relation: config.positionMatchMode }; break;
    case 'delete_by_box_count': params = { min_boxes: config.minInstances, max_boxes: config.maxInstances }; break;
    case 'normalize_classes': params = { target_class: config.canonicalClass.trim() }; break;
    default: params = {};
  }
  return {
    schema_version: 2,
    project_id: projectId,
    task_type: task,
    class_scope: { mode: config.classScopeMode, classes: config.classScopeMode === 'selected' ? [...config.ruleClasses] : [] },
    params,
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
        useSmartFilterStore.setState({ jobRunning: false, jobStatus: 'error', jobMessage: i18n.t('sf_job_not_found') });
        return;
      }
      const pct = Number(job.progress_pct || 0);
      const status = String(job.status || 'running');
      useSmartFilterStore.setState({ jobStatus: status, progressPct: pct, jobMessage: job.message || i18n.t('sf_processing') });

      if (status === 'paused') {
        useSmartFilterStore.setState({ jobRunning: true, jobMessage: i18n.t('sf_job_paused') });
        return;
      }

      if (status === 'cancelled') {
        useSmartFilterStore.setState({ jobRunning: false, jobMessage: i18n.t('sf_job_stopped') });
        return;
      }

      if (status === 'done') {
        const result = job.result || {};
        if (kind === 'preview') {
          useSmartFilterStore.setState({
            jobRunning: false,
            jobStatus: 'done',
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
          jobStatus: 'done',
          applyResult: result,
          previewResult: null,
          previewToken: '',
          latestRun,
          lastAppliedMode: mode as FilterOperationMode,
          applyCompletedSeq: s.applyCompletedSeq + 1,
        }));
        // Annotation-changing cleaning tasks must refresh independently of
        // the dialog hook lifecycle. This also clears focused/highlighted ids
        // through commitImageBundle -> annotationStore.resetForImage.
        if (mode !== 'delete_unlabeled' && useImageStore.getState().selectedImageId) {
          await useImageStore.getState().reloadSelectedImage();
        }
        const task = String(result.task_type || store.config.taskType);
        toast(i18n.t('sf_applied_task', { task: i18n.t(`sf_task_${task}`) }), 'success');
        return;
      }

      if (status === 'error') {
        useSmartFilterStore.setState({
          jobRunning: false,
          jobStatus: 'error',
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
        jobStatus: 'error',
        jobFailed: true,
        jobMessage: i18n.t('sf_poll_failed', { error: message }),
      });
    }
  })();
}

export const useSmartFilterStore = create<SmartFilterStore>((set, get) => ({
  projectId: '',
  config: { ...DEFAULT_CONFIG },
  activePreset: '',

  jobId: '',
  jobKind: null,
  jobStatus: 'idle',
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

  selectTask: (taskType) => set((s) => ({
    config: {
      ...DEFAULT_CONFIG,
      taskType,
      operationMode: taskOperation(taskType),
      classScopeMode: s.config.classScopeMode,
      ruleClasses: [...s.config.ruleClasses],
    },
    activePreset: '',
    ...previewIdleState(),
  })),

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
      config = { ...base, taskType: 'delete_unlabeled_images', operationMode: 'delete_unlabeled' };
    } else if (preset === 'cleanup') {
      config = {
        ...base,
        taskType: 'remove_confidence_range',
        operationMode: 'rule',
        confidenceEnabled: true,
        maxConfidence: 0.35,
        classScopeMode: 'selected',
        ruleClasses: [...classes],
      };
    } else {
      config = {
        ...base,
        taskType: preset === 'canonical' ? 'normalize_classes' : 'deduplicate_same_class',
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
    const state = get();
    const projectId = resolveProjectId(state.projectId);
    const { config, jobRunning } = state;
    if (jobRunning) return;
    if (!projectId) {
      const message = i18n.t('sf_project_not_ready');
      set({ jobFailed: true, jobMessage: message });
      toast(message, 'error');
      return;
    }
    if (state.projectId !== projectId) set({ projectId });
    let payload: SmartFilterPayload;
    try {
      payload = buildPayload(projectId, config);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    set({
      jobKind: 'preview',
      jobStatus: 'submitting',
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
      set({ jobId: job.job_id, jobStatus: String(job.status || 'queued'), jobMessage: i18n.t('sf_preview_started') });
      pollFilterJob(job.job_id, 'preview');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ jobRunning: false, jobStatus: 'error', jobFailed: true, jobMessage: message });
      toast(message, 'error');
    }
  },

  startApply: async () => {
    const state = get();
    const projectId = resolveProjectId(state.projectId);
    const { config, previewToken, previewResult, jobRunning } = state;
    if (jobRunning) return;
    if (!projectId) {
      const message = i18n.t('sf_project_not_ready');
      set({ jobFailed: true, jobMessage: message });
      toast(message, 'error');
      return;
    }
    if (state.projectId !== projectId) set({ projectId });
    if (!previewToken) {
      toast(i18n.t('filter_preview_expired'), 'error');
      return;
    }
    let payload: SmartFilterPayload;
    try {
      payload = {
        ...buildPayload(projectId, config),
        preview_token: previewToken,
        confirm_preview_failure: previewResult?.preview_artwork?.status === 'failed',
      };
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    set({
      jobKind: 'apply',
      jobStatus: 'submitting',
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
        jobStatus: String(job.status || 'queued'),
        jobMessage:
          mode === 'component_noise'
            ? i18n.t('sf_applied_component')
            : mode === 'merge'
            ? i18n.t('sf_applying_merge')
            : mode === 'delete_unlabeled'
              ? i18n.t('sf_applying_delete_unlabeled')
              : i18n.t('sf_applying_rule'),
      });
      pollFilterJob(job.job_id, 'apply');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ jobRunning: false, jobStatus: 'error', jobFailed: true, jobMessage: message });
      toast(message, 'error');
    }
  },

  pauseJob: async () => {
    const { jobId, jobKind, jobStatus } = get();
    if (!jobId || !jobKind || !['queued', 'running'].includes(jobStatus)) return;
    try {
      const response = await filtersApi.pauseFilterJob(jobId);
      const status = String(response.job?.status || 'pausing');
      set({
        jobStatus: status,
        jobRunning: true,
        jobMessage: status === 'paused' ? i18n.t('sf_job_paused') : i18n.t('sf_job_pausing'),
      });
      if (status !== 'paused') pollFilterJob(jobId, jobKind);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  },

  resumeJob: async () => {
    const { jobId, jobKind, jobStatus } = get();
    if (!jobId || !jobKind || jobStatus !== 'paused') return;
    try {
      const response = await filtersApi.resumeFilterJob(jobId);
      set({
        jobStatus: String(response.job?.status || 'queued'),
        jobRunning: true,
        jobFailed: false,
        jobMessage: i18n.t('sf_job_resuming'),
      });
      pollFilterJob(jobId, jobKind);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  },

  cancelJob: async () => {
    const { config, jobId, jobKind, jobStatus } = get();
    if (!jobId || !['queued', 'running', 'pausing', 'paused'].includes(jobStatus)) return;
    if (jobKind === 'apply' && config.operationMode === 'delete_unlabeled') {
      toast(i18n.t('sf_uninterruptible_delete'), 'error');
      return;
    }
    try {
      clearFilterTimer();
      if (jobStatus !== 'paused') {
        set({ jobStatus: 'stopping', jobRunning: true, jobMessage: i18n.t('sf_job_stopping') });
        await filtersApi.pauseFilterJob(jobId);
        let paused = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const response = await filtersApi.getFilterJob(jobId);
          const status = String(response.job?.status || '');
          if (status === 'paused') {
            paused = true;
            break;
          }
          if (['done', 'error', 'cancelled'].includes(status)) {
            if (jobKind) pollFilterJob(jobId, jobKind);
            return;
          }
          await waitForFilterControl(250);
        }
        if (!paused) {
          set({ jobMessage: i18n.t('sf_stop_waiting') });
          if (jobKind) pollFilterJob(jobId, jobKind);
          return;
        }
      }
      await filtersApi.cancelFilterJob(jobId);
      set({ jobStatus: 'cancelled', jobRunning: false, jobMessage: i18n.t('sf_job_stopped') });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      if (jobKind) pollFilterJob(jobId, jobKind);
    }
  },

  loadLatestRun: async () => {
    const projectId = resolveProjectId(get().projectId);
    if (!projectId) return;
    if (get().projectId !== projectId) set({ projectId });
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
    const state = get();
    const projectId = resolveProjectId(state.projectId);
    const { latestRun, rollbackBusy } = state;
    if (!projectId || !latestRun?.run_id || rollbackBusy) return;
    if (state.projectId !== projectId) set({ projectId });
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
      activePreset: '',
      jobId: '',
      jobKind: null,
      jobStatus: 'idle',
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
