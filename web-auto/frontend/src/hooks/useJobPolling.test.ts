import { describe, expect, it } from 'vitest';
import { shouldShowBatchResult } from './useJobPolling';

describe('shouldShowBatchResult', () => {
  it('shows a persistent result for fatal text batch errors', () => {
    expect(shouldShowBatchResult({
      job_id: 'oom-job',
      job_type: 'text_batch',
      status: 'error',
      fatal: true,
      result: { error_code: 'CUDA_OOM' },
    })).toBe(true);
  });

  it('does not turn ordinary text batch errors into a result modal', () => {
    expect(shouldShowBatchResult({
      job_id: 'ordinary-error',
      job_type: 'text_batch',
      status: 'error',
    })).toBe(false);
  });
});
