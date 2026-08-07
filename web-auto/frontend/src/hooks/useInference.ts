import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  infer,
  startBatchInfer,
  stopInferJob,
  resumeInferJob,
  cancelInferJob,
  type BackendPayload,
  type InferJob,
} from '../api/inference';
import * as bundleCache from '../api/bundleCache';
import { useSettingsStore } from '../stores/settingsStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { toast } from '../utils/notify';
import { startJobPolling } from './useJobPolling';

/** Extract a backend error code (BOTH_LOADED / SAM3_NOT_READY) from an ApiError. */
export function getBackendErrorCode(err: unknown): string {
  const e = err as { code?: string; detail?: unknown } | null;
  if (!e) return '';
  if (e.detail && typeof e.detail === 'object') {
    const code = (e.detail as Record<string, unknown>).code;
    if (code) return String(code);
  }
  return e.code ? String(e.code) : '';
}

function getErrorDetail(err: unknown): Record<string, unknown> {
  const e = err as { detail?: unknown } | null;
  if (e?.detail && typeof e.detail === 'object') return e.detail as Record<string, unknown>;
  return {};
}

function backendPayload(): BackendPayload {
  const settings = useSettingsStore.getState();
  return {
    model_backend: settings.defaultBackend || 'sam3',
    locate_api_base_url: settings.locateApiUrl || '',
    score_default: Number(settings.scoreDefault ?? 0.5),
    contour_mode: settings.contourMode || 'split',
  };
}

/**
 * Inference orchestration — 1:1 port of the legacy InferenceController's
 * request side (runSingle / box-prompt infer / batch start / stop / resume /
 * cancel / retry). Polling lives in useJobPolling; modal state lives in
 * inferenceStore.
 */
export function useInference() {
  const { t } = useTranslation();

  /** BOTH_LOADED / SAM3_NOT_READY → modal. Returns true when handled. */
  const handleBackendError = useCallback((err: unknown): boolean => {
    const code = getBackendErrorCode(err);
    if (code === 'BOTH_LOADED') {
      useInferenceStore.getState().showBackendError('both-loaded', getErrorDetail(err));
      return true;
    }
    if (code === 'SAM3_NOT_READY') {
      useInferenceStore.getState().showBackendError('sam3-not-ready', getErrorDetail(err));
      return true;
    }
    return false;
  }, []);

  const runSingle = useCallback(async () => {
    const image = useImageStore.getState();
    const projectId = useProjectStore.getState().projectId;
    if (!image.selectedImageId) {
      toast(t('select_image_first'), 'error');
      return;
    }
    const annotation = useAnnotationStore.getState();
    if (annotation.dirty) {
      await annotation.flushSave('before-infer');
      if (useAnnotationStore.getState().dirty) {
        toast(t('anns_not_saved_infer'), 'error');
        return;
      }
    }
    try {
      const settings = useSettingsStore.getState();
      await infer({
        project_id: projectId,
        image_id: image.selectedImageId,
        mode: 'text',
        classes: useProjectStore.getState().getSelectedClassesForInference(),
        threshold: settings.threshold,
        api_base_url: settings.sam3ApiUrl,
        ...backendPayload(),
      });
      toast(t('save_success'), 'success');
      bundleCache.invalidateBundle(projectId, image.selectedImageId);
      await useImageStore.getState().reloadSelectedImage();
      await useProjectStore.getState().loadProjectInfo();
    } catch (err) {
      if (handleBackendError(err)) return;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t, handleBackendError]);

  const startBatchTask = useCallback(async () => {
    const projectId = useProjectStore.getState().projectId;
    const classes = useProjectStore.getState().getSelectedClassesForInference();
    if (classes.length === 0) {
      toast(t('text_infer_class_required'), 'error');
      return;
    }
    const inference = useInferenceStore.getState();
    const config = await inference.openBatchConfig(classes, t('batch_title'));
    if (!config) return;

    const settings = useSettingsStore.getState();
    const payload = {
      project_id: projectId,
      mode: 'text' as const,
      classes,
      threshold: settings.threshold,
      batch_size: settings.batchSize,
      api_base_url: settings.sam3ApiUrl,
      scope_mode: config.scope_mode,
      related_classes: config.related_classes || [],
      image_ids: config.image_ids || [],
      retry_image_ids: config.retry_image_ids || [],
      all_images:
        config.scope_mode === 'all' &&
        (config.image_ids || []).length === 0 &&
        (config.retry_image_ids || []).length === 0,
      ...backendPayload(),
    };
    try {
      const res = await startBatchInfer(payload);
      const jobId = res?.job?.job_id || '';
      if (!jobId) {
        toast(t('batch_no_job_id'), 'error');
        return;
      }
      const store = useInferenceStore.getState();
      store.setActiveJobId(jobId);
      store.setBatchResultShownForJobId('');
      startJobPolling();
      toast(t('batch_started'), 'success');
    } catch (err) {
      if (handleBackendError(err)) return;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t, handleBackendError]);

  const startLaBoxesBatchTask = useCallback(async () => {
    const projectId = useProjectStore.getState().projectId;
    const classes = useProjectStore.getState().getSelectedClassesForInference();
    const inference = useInferenceStore.getState();
    const config = await inference.openBatchConfig(classes, t('la_boxes_batch'));
    if (!config) return;

    const settings = useSettingsStore.getState();
    const payload = {
      project_id: projectId,
      mode: 'la_boxes' as const,
      classes,
      threshold: settings.threshold,
      batch_size: settings.batchSize,
      api_base_url: settings.sam3ApiUrl,
      scope_mode: config.scope_mode,
      related_classes: config.related_classes || [],
      image_ids: config.image_ids || [],
      retry_image_ids: config.retry_image_ids || [],
      all_images:
        config.scope_mode === 'all' &&
        (config.image_ids || []).length === 0 &&
        (config.retry_image_ids || []).length === 0,
      ...backendPayload(),
      model_backend: 'sam3',
    };
    try {
      const res = await startBatchInfer(payload);
      const jobId = res?.job?.job_id || '';
      if (!jobId) {
        toast(t('batch_no_job_id'), 'error');
        return;
      }
      const store = useInferenceStore.getState();
      store.setActiveJobId(jobId);
      store.setBatchResultShownForJobId('');
      startJobPolling();
      toast(t('la_boxes_started'), 'success');
    } catch (err) {
      if (handleBackendError(err)) return;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t, handleBackendError]);

  /** Retry failed images from a finished batch result. */
  const retryBatch = useCallback(
    async (job: InferJob, retryImageIds: string[]) => {
      const projectId = useProjectStore.getState().projectId;
      const settings = useSettingsStore.getState();
      const jobMode = String(job.payload_dict?.mode || 'text');
      try {
        const res = await startBatchInfer({
          project_id: projectId,
          mode: jobMode === 'la_boxes' ? 'la_boxes' : 'text',
          classes: useProjectStore.getState().getSelectedClassesForInference(),
          retry_image_ids: retryImageIds,
          threshold: settings.threshold,
          batch_size: settings.batchSize,
          api_base_url: settings.sam3ApiUrl,
          ...backendPayload(),
          ...(jobMode === 'la_boxes' ? { model_backend: 'sam3' } : {}),
        });
        const jobId = res?.job?.job_id || '';
        if (!jobId) {
          toast(t('batch_no_job_id'), 'error');
          return;
        }
        const store = useInferenceStore.getState();
        store.setActiveJobId(jobId);
        store.setBatchResultShownForJobId('');
        store.closeBatchResult();
        startJobPolling();
        toast(t('batch_retry_started'), 'success');
      } catch (err) {
        if (handleBackendError(err)) return;
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [t, handleBackendError],
  );

  const stopActiveTask = useCallback(async () => {
    const projectId = useProjectStore.getState().projectId;
    try {
      const res = await stopInferJob(projectId);
      const job = res?.job || null;
      if (job?.job_id) useInferenceStore.getState().setActiveJobId(job.job_id);
      toast(t('task_paused'), 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t]);

  const resumeActiveTask = useCallback(async () => {
    const projectId = useProjectStore.getState().projectId;
    const settings = useSettingsStore.getState();
    try {
      const res = await resumeInferJob({
        project_id: projectId,
        threshold: settings.threshold,
        batch_size: settings.batchSize,
        api_base_url: settings.sam3ApiUrl,
        ...backendPayload(),
      });
      const job = res?.job || null;
      const store = useInferenceStore.getState();
      if (job?.job_id) store.setActiveJobId(job.job_id);
      store.setTaskBar(true, t('task_resuming'));
      if (store.activeJobId) startJobPolling();
      toast(t('task_resuming'), 'info');
    } catch (err) {
      if (handleBackendError(err)) return;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t, handleBackendError]);

  const cancelActiveTask = useCallback(async () => {
    if (!window.confirm(t('cancel_task_confirm'))) return;
    const projectId = useProjectStore.getState().projectId;
    try {
      await cancelInferJob(projectId);
      const store = useInferenceStore.getState();
      store.setActiveJobId(null);
      store.setIsPolling(false);
      store.setTaskBar(true, t('task_cancelled'));
      // Auto-hide the task bar after 3 s, same as the done/error branch in
      // useJobPolling.
      setTimeout(() => {
        const s = useInferenceStore.getState();
        if (!s.activeJobId) s.setTaskBar(false, '');
      }, 3000);
      toast(t('task_cancelled'), 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t]);

  /**
   * SAM box-prompt inference (replaces the legacy example-preview flow). The
   * positive/negative prompt boxes drawn on the current image are sent to the
   * existing POST /api/infer endpoint with mode='boxes'; the backend saves the
   * result directly (save_result=true), so no preview/adoption step remains.
   */
  const runBoxPromptInference = useCallback(async () => {
    const image = useImageStore.getState();
    const projectId = useProjectStore.getState().projectId;
    const settings = useSettingsStore.getState();
    const viewer = useViewerStore.getState();
    if (!image.selectedImageId) {
      toast(t('select_image_first'), 'error');
      return;
    }
    if (settings.defaultBackend === 'locate-anything') {
      toast(t('locate_backend_text_only'), 'error');
      return;
    }
    // Prompt boxes carry [x1, y1, x2, y2, label] (label 0 = negative).
    const boxes = viewer.currentPrompts.filter((p) => p.type === 'box').map((p) => p.data);
    if (boxes.length === 0) {
      viewer.setBoxPromptLabel(1);
      toast(t('box_exemplar_required'), 'info');
      return;
    }
    const selectedClass = useProjectStore.getState().selectedClass;
    if (!selectedClass) {
      toast(t('select_class_first'), 'error');
      return;
    }
    const annotation = useAnnotationStore.getState();
    if (annotation.dirty) {
      await annotation.flushSave('before-infer');
      if (useAnnotationStore.getState().dirty) {
        toast(t('anns_not_saved_infer'), 'error');
        return;
      }
    }
    try {
      const res = await infer({
        project_id: projectId,
        image_id: image.selectedImageId,
        mode: 'boxes',
        active_class: selectedClass,
        boxes,
        threshold: settings.threshold,
        api_base_url: settings.sam3ApiUrl,
        ...backendPayload(),
      });
      // Result is already saved server-side: clear the prompts and refresh.
      useViewerStore.getState().clearPrompts();
      bundleCache.invalidateBundle(projectId, image.selectedImageId);
      await useImageStore.getState().reloadSelectedImage();
      await useProjectStore.getState().loadProjectInfo();
      toast(t('box_infer_saved', { count: Number(res?.num_detections ?? 0) }), 'success');
    } catch (err) {
      if (handleBackendError(err)) return;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [t, handleBackendError]);

  return {
    runSingle,
    runBoxPromptInference,
    startBatchTask,
    startLaBoxesBatchTask,
    retryBatch,
    stopActiveTask,
    resumeActiveTask,
    cancelActiveTask,
    handleBackendError,
  };
}
