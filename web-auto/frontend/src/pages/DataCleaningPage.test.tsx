import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DataCleaningPage } from './DataCleaningPage';
import { DEFAULT_CONFIG, useSmartFilterStore } from '../stores/workspace/smartFilterStore';
import { useProjectStore } from '../stores/workspace/projectStore';

vi.mock('../api/projects', () => ({
  getProject: vi.fn(async () => ({
    project: { id: 'p1', name: 'Demo', project_type: 'image', classes: ['chair'] },
  })),
}));

vi.mock('../hooks/useSmartFilterJob', () => ({ useSmartFilterJob: vi.fn() }));

describe('DataCleaningPage', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    useProjectStore.getState().reset();
    useSmartFilterStore.getState().reset();
    useSmartFilterStore.setState({ config: { ...DEFAULT_CONFIG } });
  });

  afterEach(cleanup);

  it('uses standalone tabs for the four cleaning task categories', async () => {
    render(
      <MemoryRouter initialEntries={['/project/image/p1/cleaning']}>
        <Routes>
          <Route path="/project/image/:id/cleaning" element={<DataCleaningPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '数据清洗工作台' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: '常用清洗' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '小连通域删除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '置信度删除' })).not.toBeInTheDocument();
    expect(screen.getByText(/正式清洗直接复用该变更集/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '条件筛选' }));
    expect(screen.getByRole('button', { name: '置信度删除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '小连通域删除' })).not.toBeInTheDocument();
  });

  it('shows pause and stop controls for an active cleaning job', async () => {
    render(
      <MemoryRouter initialEntries={['/project/image/p1/cleaning']}>
        <Routes>
          <Route path="/project/image/:id/cleaning" element={<DataCleaningPage />} />
        </Routes>
      </MemoryRouter>,
    );
    useSmartFilterStore.setState({
      jobId: 'preview-job',
      jobKind: 'preview',
      jobStatus: 'running',
      jobRunning: true,
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '暂停任务' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '停止任务' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '常用清洗' })).toBeDisabled();
  });
});
