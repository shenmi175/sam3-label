import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFilterJobMock, startFilterApplyJobMock, pauseFilterJobMock, resumeFilterJobMock, cancelFilterJobMock } = vi.hoisted(() => ({
  getFilterJobMock: vi.fn(),
  startFilterApplyJobMock: vi.fn(),
  pauseFilterJobMock: vi.fn(),
  resumeFilterJobMock: vi.fn(),
  cancelFilterJobMock: vi.fn(),
}));

vi.mock('../../api/filters', () => ({
  getFilterJob: getFilterJobMock,
  startFilterApplyJob: startFilterApplyJobMock,
  startFilterPreviewJob: vi.fn(),
  getLatestFilterRun: vi.fn(),
  rollbackFilterRun: vi.fn(),
  pauseFilterJob: pauseFilterJobMock,
  resumeFilterJob: resumeFilterJobMock,
  cancelFilterJob: cancelFilterJobMock,
}));

vi.mock('../../utils/notify', () => ({ toast: vi.fn() }));

import { DEFAULT_CONFIG, useSmartFilterStore } from './smartFilterStore';
import { useProjectStore } from './projectStore';
import { useImageStore } from './imageStore';

describe('smart filter apply refresh', () => {
  const originalReloadSelectedImage = useImageStore.getState().reloadSelectedImage;

  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.getState().reset();
    useProjectStore.getState().setProjectId('project-1');
    useImageStore.getState().reset();
    useImageStore.setState({ selectedImageId: 'image-1' });
    useSmartFilterStore.getState().reset();
    useSmartFilterStore.setState({
      projectId: 'project-1',
      config: {
        ...DEFAULT_CONFIG,
        taskType: 'deduplicate_same_class',
        operationMode: 'merge',
      },
      previewToken: 'preview-token',
      previewResult: { preview_artwork: { version: 1, status: 'ready' } },
    });
  });

  it('reloads the selected image as soon as an annotation cleaning job completes', async () => {
    const reloadSelectedImage = vi.fn().mockResolvedValue(true);
    useImageStore.setState({ reloadSelectedImage });
    startFilterApplyJobMock.mockResolvedValue({ job: { job_id: 'apply-job' } });
    getFilterJobMock.mockResolvedValue({
      job: {
        status: 'done',
        progress_pct: 100,
        result: {
          operation_mode: 'merge',
          task_type: 'deduplicate_same_class',
          changed_images: 1,
          removed_annotations: 1,
        },
      },
    });

    await useSmartFilterStore.getState().startApply();
    await vi.waitFor(() => expect(reloadSelectedImage).toHaveBeenCalledOnce());

    expect(useSmartFilterStore.getState().jobRunning).toBe(false);
    expect(useSmartFilterStore.getState().applyCompletedSeq).toBe(1);
    useImageStore.setState({ reloadSelectedImage: originalReloadSelectedImage });
  });

  it('pauses, resumes and permanently stops the active cleaning job', async () => {
    useSmartFilterStore.setState({
      jobId: 'preview-job',
      jobKind: 'preview',
      jobStatus: 'running',
      jobRunning: true,
    });
    pauseFilterJobMock.mockResolvedValue({ job: { job_id: 'preview-job', status: 'paused' } });
    resumeFilterJobMock.mockResolvedValue({ job: { job_id: 'preview-job', status: 'queued' } });
    cancelFilterJobMock.mockResolvedValue({ job: { job_id: 'preview-job', status: 'cancelled' } });
    getFilterJobMock.mockResolvedValue({ job: { job_id: 'preview-job', status: 'paused', progress_pct: 25 } });

    await useSmartFilterStore.getState().pauseJob();
    expect(pauseFilterJobMock).toHaveBeenCalledWith('preview-job');
    expect(useSmartFilterStore.getState().jobStatus).toBe('paused');

    getFilterJobMock.mockImplementation(() => new Promise(() => undefined));
    await useSmartFilterStore.getState().resumeJob();
    expect(resumeFilterJobMock).toHaveBeenCalledWith('preview-job');
    expect(useSmartFilterStore.getState().jobStatus).toBe('queued');

    useSmartFilterStore.setState({ jobStatus: 'paused' });
    await useSmartFilterStore.getState().cancelJob();
    expect(cancelFilterJobMock).toHaveBeenCalledWith('preview-job');
    expect(useSmartFilterStore.getState().jobStatus).toBe('cancelled');
    expect(useSmartFilterStore.getState().jobRunning).toBe(false);
  });
});
