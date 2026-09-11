import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../common/ToastProvider';
import { ServicesPanel } from './ServicesPanel';
import '../../i18n';

const systemMocks = vi.hoisted(() => ({
  downloadLogs: vi.fn(),
  getLatestModelLoadJob: vi.fn(),
  getModelLoadJob: vi.fn(),
  startModelLoadJob: vi.fn(),
}));

vi.mock('../../api/system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/system')>()),
  downloadLogs: systemMocks.downloadLogs,
  getLatestModelLoadJob: systemMocks.getLatestModelLoadJob,
  getModelLoadJob: systemMocks.getModelLoadJob,
  startModelLoadJob: systemMocks.startModelLoadJob,
}));

const runningServices = {
  services: [
    { service: 'sam3-api', status: 'running' },
    { service: 'locate-anything-api', status: 'running' },
    { service: 'sapiens-api', status: 'running' },
  ],
};

describe('ServicesPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    systemMocks.downloadLogs.mockReset();
    systemMocks.getLatestModelLoadJob.mockReset();
    systemMocks.getModelLoadJob.mockReset();
    systemMocks.startModelLoadJob.mockReset();
    systemMocks.getLatestModelLoadJob.mockResolvedValue({ job: null });
  });

  it('shows preparation state and a clear download failure', async () => {
    let rejectDownload: (error: Error) => void = () => undefined;
    systemMocks.downloadLogs.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectDownload = reject;
    }));
    render(
      <ToastProvider>
        <ServicesPanel
          servicesStatus={{ services: [] }}
          sapiensStatus={null}
          onRefresh={() => undefined}
          onControlService={() => undefined}
          onStartSapiensDownload={() => undefined}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '下载日志' }));
    expect(screen.getByRole('button', { name: '正在准备日志...' })).toBeDisabled();
    rejectDownload(new Error('ops unavailable'));
    await waitFor(() => expect(screen.getByText('日志下载失败：ops unavailable')).toBeInTheDocument());
  });

  it('renders exactly one load-model button per service and disables stopped services', async () => {
    render(
      <ToastProvider>
        <ServicesPanel
          servicesStatus={{
            services: [
              { service: 'sam3-api', status: 'running' },
              { service: 'locate-anything-api', status: 'exited' },
              { service: 'sapiens-api', status: 'not_created' },
            ],
          }}
          sapiensStatus={null}
          onRefresh={() => undefined}
          onControlService={() => undefined}
          onStartSapiensDownload={() => undefined}
        />
      </ToastProvider>,
    );

    const buttons = screen.getAllByRole('button', { name: '加载模型' });
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    expect(buttons[2]).toBeDisabled();
  });

  it('creates a job, disables the button while polling, then shows success and refreshes', async () => {
    let finishPoll: (value: unknown) => void = () => undefined;
    systemMocks.startModelLoadJob.mockResolvedValue({
      created: true,
      job_id: 'job-1',
      job: { job_id: 'job-1', service: 'sam3-api', status: 'queued' },
    });
    systemMocks.getModelLoadJob.mockImplementation(() => new Promise((resolve) => {
      finishPoll = resolve;
    }));
    const refresh = vi.fn();
    render(
      <ToastProvider>
        <ServicesPanel
          servicesStatus={runningServices}
          sapiensStatus={null}
          onRefresh={refresh}
          onControlService={() => undefined}
          onStartSapiensDownload={() => undefined}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '加载模型' })[0]);
    await waitFor(() => expect(systemMocks.startModelLoadJob).toHaveBeenCalledWith('sam3-api'));
    const loading = await screen.findByRole('button', { name: '加载中…' });
    expect(loading).toBeDisabled();
    await waitFor(() => expect(systemMocks.getModelLoadJob).toHaveBeenCalledWith('job-1'));
    finishPoll({
      job: {
        job_id: 'job-1',
        service: 'sam3-api',
        status: 'completed',
        summary: { duration_ms: 12, detection_count: 2 },
      },
    });
    await waitFor(() => expect(screen.getByText('模型加载并预热成功')).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole('button', { name: '加载模型' })).toHaveLength(3));
  });

  it('restores an active latest job after refresh and displays a normalized failure', async () => {
    systemMocks.getLatestModelLoadJob.mockImplementation((service: string) => Promise.resolve({
      job: service === 'sapiens-api'
        ? { job_id: 'job-sapiens', service, status: 'running' }
        : null,
    }));
    systemMocks.getModelLoadJob.mockResolvedValue({
      job: {
        job_id: 'job-sapiens',
        service: 'sapiens-api',
        status: 'failed',
        error: { code: 'weights_missing', message: '模型权重缺失：checkpoint not found' },
      },
    });
    render(
      <ToastProvider>
        <ServicesPanel
          servicesStatus={runningServices}
          sapiensStatus={null}
          onRefresh={() => undefined}
          onControlService={() => undefined}
          onStartSapiensDownload={() => undefined}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(systemMocks.getModelLoadJob).toHaveBeenCalledWith('job-sapiens'));
    await waitFor(() => expect(screen.getByText('模型权重缺失：checkpoint not found')).toBeInTheDocument());
    expect(systemMocks.startModelLoadJob).not.toHaveBeenCalled();
  });
});
