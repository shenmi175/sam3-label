import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { buildTheme } from '../../theme';
import { DataAnalyticsPage } from './DataAnalyticsPage';
import '../../i18n';

vi.mock('echarts-for-react/lib/core', () => ({
  default: () => <div data-testid="echarts" />,
}));

vi.mock('../../api/projects', () => ({
  getProject: vi.fn(async () => ({ project: { id: 'p1', name: 'Demo', project_type: 'image' } })),
}));

const { getAnalyticsOverview } = vi.hoisted(() => ({ getAnalyticsOverview: vi.fn() }));
const overviewResponse = { overview: {
  project_id: 'p1', index_version: 3, content_rev: 2, generated_at: '',
  scope: { task: 'detection', sources: ['sam3'], project_total_images: 2, hit_images: 1, instance_count: 2, class_count: 1, anomaly_count: 0 },
  source_summary: [{ source: 'sam3', image_count: 1, instance_count: 2, class_count: 1 }],
  class_distribution: { categories: ['cat'], series: [{ source: 'sam3', values: [2], image_values: [1] }] },
  class_distribution_truncated: 0,
  density_distribution: { categories: ['0', '1', '2'], series: [{ source: 'sam3', values: [0, 0, 1] }] },
  area_distribution: { categories: ['0-1%', '1-5%'], series: [{ source: 'sam3', values: [0, 2] }], missing_by_source: { sam3: 0 } },
  aspect_ratio_distribution: { categories: ['0.5-1', '1-2'], series: [{ source: 'sam3', values: [0, 2] }] },
  geometry_distribution_by_source: null,
  center_heatmap: { x_edges: [0, 0.5, 1], y_edges: [0, 0.5, 1], series: [{ source: 'sam3', cells: [{ x: 0, y: 0, count: 2 }] }] },
  resolution_distribution: { x_edges: [40, 100], y_edges: [40, 50], series: [{ source: 'sam3', cells: [{ x: 0, y: 0, count: 1 }] }] },
} };
const segmentationOverviewResponse = { overview: {
  ...overviewResponse.overview,
  scope: { ...overviewResponse.overview.scope, task: 'instance_segmentation', instance_count: 2 },
  aspect_ratio_distribution: null,
  geometry_distribution_by_source: { categories: ['polygon', 'multi_polygon', 'mask'], series: [{ source: 'sam3', values: [1, 0, 1] }] },
  center_heatmap: null,
} };

vi.mock('../../api/analytics', () => ({
  getAnalyticsIndex: vi.fn(async () => ({ index: {
    project_id: 'p1', status: 'ready', index_version: 3, indexed_content_rev: 2,
    content_rev: 2, indexed_images: 2, total_images: 2, needs_rebuild: false, job: null,
  } })),
  getAnalyticsDimensions: vi.fn(async () => ({ dimensions: {
    project_id: 'p1', index_version: 3, invalid_instance_count: 0,
    tasks: [
      { task: 'detection', image_count: 1, instance_count: 2, sources: [
        { source: 'sam3', image_count: 1, instance_count: 2 },
        { source: 'locate-anything', image_count: 0, instance_count: 0 },
        { source: 'manual', image_count: 0, instance_count: 0 },
        { source: 'unknown', image_count: 0, instance_count: 0 },
        { source: 'yolo-v11', display_name: 'YOLO v11', image_count: 1, instance_count: 1 },
      ] },
      { task: 'instance_segmentation', image_count: 1, instance_count: 2, sources: [
        { source: 'sam3', image_count: 1, instance_count: 2 },
      ] },
    ], sources: [{ source: 'yolo-v11', display_name: 'YOLO v11', image_count: 1, instance_count: 1 }],
  } })),
  getAnalyticsOverview,
  rebuildAnalyticsIndex: vi.fn(async () => ({ job: {} })),
}));

describe('DataAnalyticsPage', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    getAnalyticsOverview.mockClear();
    getAnalyticsOverview.mockImplementation(async (...args: unknown[]) => (
      args[1] === 'instance_segmentation' ? segmentationOverviewResponse : overviewResponse
    ));
  });
  afterEach(cleanup);

  it('defaults to detection + SAM3 and renders task-specific charts', async () => {
    render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter initialEntries={['/project/image/p1/analytics']}>
          <Routes>
            <Route path="/project/image/:id/analytics" element={<DataAnalyticsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(await screen.findByText('Demo')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '目标检测 (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByText('SAM3').length).toBeGreaterThan(0);
    expect(screen.getByText('类别实例分布')).toBeInTheDocument();
    expect(screen.getByText('每图检测框数量')).toBeInTheDocument();
    expect(screen.getByText('BBox 长宽比分布')).toBeInTheDocument();
    expect(screen.getByText('BBox 中心点分布')).toBeInTheDocument();
    expect(screen.getAllByTestId('echarts')).toHaveLength(6);
    expect(getAnalyticsOverview).toHaveBeenCalledWith('p1', 'detection', ['sam3'], expect.anything());
  });

  it('renders only the five common instance-segmentation charts', async () => {
    render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter initialEntries={['/project/image/p1/analytics?task=instance_segmentation&source=sam3']}>
          <Routes>
            <Route path="/project/image/:id/analytics" element={<DataAnalyticsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(await screen.findByText('Demo')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '实例分割 (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('标注类型分布')).toBeInTheDocument();
    expect(screen.queryByText('BBox 中心点分布')).not.toBeInTheDocument();
    expect(screen.queryByText('实例对 BBox 填充率')).not.toBeInTheDocument();
    expect(screen.queryByText('连通分量数量')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('echarts')).toHaveLength(5);
    expect(getAnalyticsOverview).toHaveBeenCalledWith('p1', 'instance_segmentation', ['sam3'], expect.anything());
  });

  it('restores a future source id from the URL and uses its backend display name', async () => {
    render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter initialEntries={['/project/image/p1/analytics?task=detection&source=yolo-v11']}>
          <Routes>
            <Route path="/project/image/:id/analytics" element={<DataAnalyticsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(await screen.findByText('Demo')).toBeInTheDocument();
    expect(screen.getAllByText('YOLO v11').length).toBeGreaterThan(0);
    expect(getAnalyticsOverview).toHaveBeenCalledWith('p1', 'detection', ['yolo-v11'], expect.anything());
  });
});
