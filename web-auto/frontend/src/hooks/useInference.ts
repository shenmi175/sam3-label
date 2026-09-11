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
  };
}

/**
 * Inference orchestration — 1:1 port of the legacy InferenceController's
 * request side (runSingle / batch start / stop / resume / cancel / retry).
 * Polling lives in useJobPolling; modal state lives in
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
    const defaultClasses = useProjectStore.getState().getSelectedClassesForInference();
    const inference = useInferenceStore.getState();
    const config = await inference.openBatchConfig(
      defaultClasses,
      t('batch_title'),
      useSettingsStore.getState().defaultBackend !== 'locate-anything',
    );
    if (!config) return;

    const settings = useSettingsStore.getState();
    const payload = {
      project_id: projectId,
      mode: 'text' as const,
      classes: config.classes,
      threshold: settings.threshold,
      batch_size: settings.batchSize,
      api_base_url: settings.sam3ApiUrl,
      scope_mode: config.scope_mode,
      merge_mode: config.merge_mode,
      related_classes: config.related_classes || [],
      image_ids: config.image_ids || [],
      retry_image_ids: config.retry_image_ids || [],
      save_ai_features: Boolean(config.save_ai_features),
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
    const defaultClasses = useProjectStore.getState().getSelectedClassesForInference();
    const inference = useInferenceStore.getState();
    const config = await inference.openBatchConfig(defaultClasses, t('la_boxes_batch'), false, false);
    if (!config) return;

    const settings = useSettingsStore.getState();
    const payload = {
      project_id: projectId,
      mode: 'la_boxes' as const,
      classes: config.classes,
      threshold: settings.threshold,
      batch_size: settings.batchSize,
      api_base_url: settings.sam3ApiUrl,
      scope_mode: config.scope_mode,
      merge_mode: 'replace' as const,
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
      const result = (job.result || {}) as Record<string, unknown>;
      const isCudaOom = Boolean(job.fatal || result.fatal)
        && String(job.error_code || result.error_code || '') === 'CUDA_OOM';
      if (isCudaOom && !window.confirm(t('batch_oom_retry_confirm', {
        count: retryImageIds.length,
        batchSize: Number(job.payload_dict?.batch_size || 1),
        saveFeatures: job.payload_dict?.save_ai_features ? t('yes') : t('no'),
      }))) {
        return;
      }
      try {
        const res = await startBatchInfer({
          project_id: projectId,
          mode: jobMode === 'la_boxes' ? 'la_boxes' : 'text',
          classes: Array.isArray(job.payload_dict?.classes)
            ? job.payload_dict.classes.map((value) => String(value)).filter(Boolean)
            : [],
          merge_mode: job.payload_dict?.merge_mode === 'append' ? 'append' : 'replace',
          retry_image_ids: retryImageIds,
          threshold: Number(job.payload_dict?.threshold ?? settings.threshold),
          batch_size: Number(job.payload_dict?.batch_size ?? settings.batchSize),
          api_base_url: String(job.payload_dict?.api_base_url || settings.sam3ApiUrl),
          save_ai_features: Boolean(job.payload_dict?.save_ai_features),
          model_backend: String(job.payload_dict?.model_backend || settings.defaultBackend || 'sam3'),
          locate_api_base_url: String(job.payload_dict?.locate_api_base_url || settings.locateApiUrl || ''),
          score_default: Number(job.payload_dict?.score_default ?? settings.scoreDefault ?? 0.5),
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

  return {
    runSingle,
    startBatchTask,
    startLaBoxesBatchTask,
    retryBatch,
    stopActiveTask,
    resumeActiveTask,
    cancelActiveTask,
    handleBackendError,
  };
}
