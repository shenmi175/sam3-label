import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBatchInfer } from '../api/inference';
import { useInference } from './useInference';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { useProjectStore } from '../stores/workspace/projectStore';

vi.mock('../api/inference', () => ({
  infer: vi.fn(),
  startBatchInfer: vi.fn(),
  stopInferJob: vi.fn(),
  resumeInferJob: vi.fn(),
  cancelInferJob: vi.fn(),
}));

vi.mock('./useJobPolling', () => ({ startJobPolling: vi.fn() }));

describe('useInference batch retry', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    vi.clearAllMocks();
    useInferenceStore.getState().reset();
    useProjectStore.getState().reset();
    useProjectStore.getState().setProjectId('project-1');
    useProjectStore.getState().setClasses(['current-global-class']);
    vi.mocked(startBatchInfer).mockResolvedValue({
      job: { job_id: 'retry-job', status: 'queued' },
    });
  });

  afterEach(cleanup);

  it('retries with the original task classes and append mode', async () => {
    const { result } = renderHook(() => useInference());

    await act(async () => {
      await result.current.retryBatch({
        job_id: 'original-job',
        status: 'failed',
        payload_dict: {
          mode: 'text',
          classes: ['chair', 'table'],
          merge_mode: 'append',
        },
      }, ['image-2']);
    });

    expect(startBatchInfer).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      classes: ['chair', 'table'],
      merge_mode: 'append',
      retry_image_ids: ['image-2'],
    }));
  });

  it('requires confirmation and preserves original OOM task parameters', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderHook(() => useInference());

    await act(async () => {
      await result.current.retryBatch({
        job_id: 'oom-job',
        status: 'error',
        fatal: true,
        error_code: 'CUDA_OOM',
        payload_dict: {
          mode: 'text',
          classes: ['humanface'],
          merge_mode: 'append',
          threshold: 0.37,
          batch_size: 1,
          api_base_url: 'http://original-sam3',
          save_ai_features: true,
          model_backend: 'sam3',
        },
      }, ['image-1', 'image-2']);
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(startBatchInfer).toHaveBeenCalledWith(expect.objectContaining({
      classes: ['humanface'],
      merge_mode: 'append',
      retry_image_ids: ['image-1', 'image-2'],
      threshold: 0.37,
      batch_size: 1,
      api_base_url: 'http://original-sam3',
      save_ai_features: true,
    }));
  });

  it('does not retry OOM when the warning is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(() => useInference());

    await act(async () => {
      await result.current.retryBatch({
        job_id: 'oom-job',
        status: 'error',
        fatal: true,
        error_code: 'CUDA_OOM',
        payload_dict: { mode: 'text', classes: ['humanface'], batch_size: 1 },
      }, ['image-1']);
    });

    expect(startBatchInfer).not.toHaveBeenCalled();
  });
});
