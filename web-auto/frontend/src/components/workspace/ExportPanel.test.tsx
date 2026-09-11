import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { ExportPanel } from './ExportPanel';


const apiMocks = vi.hoisted(() => ({
  previewExport: vi.fn(),
  preflightExport: vi.fn(),
  exportProject: vi.fn(),
}));
vi.mock('../../api/exports', () => apiMocks);

async function selectProfile(name: string) {
  fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('ExportPanel profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('language', 'zh');
    useProjectStore.setState({ classes: ['door'] });
    apiMocks.previewExport.mockResolvedValue({
      classes: ['door'], by_source: { sam3: 1 }, by_class: { door: 1 },
    });
    apiMocks.preflightExport.mockResolvedValue({
      ok: true,
      profile: 'coco_detection',
      project_id: 'project-1',
      project_content_rev: 8,
      stats: { annotations_selected: 1, instances_written: 1, regions_written: 1, images_written: 2, negative_images: 1, output_records: 1 },
      warnings: [], blockers: [], confirmation_required_codes: [], format_details: {},
    });
    apiMocks.exportProject.mockResolvedValue({
      output: '/srv/exports/project_coco_detection.json',
      stats: { instances_written: 1, regions_written: 1, images_written: 2, negative_images: 1, output_records: 1 },
    });
  });

  afterEach(cleanup);

  it('preflights COCO before exporting and sends only profile semantics', async () => {
    render(<ExportPanel projectId="project-1" open onClose={() => undefined} />);
    const preflightButton = await screen.findByRole('button', { name: '预检并导出' });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    expect(screen.queryByText('BBox')).not.toBeInTheDocument();
    fireEvent.click(preflightButton);
    await waitFor(() => expect(apiMocks.preflightExport).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1', profile: 'coco_detection', source_models: ['sam3'], classes: ['door'], image_mode: 'none',
    })));
    fireEvent.click(await screen.findByRole('button', { name: '确认导出' }));
    await waitFor(() => expect(apiMocks.exportProject).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'coco_detection', expected_content_rev: 8,
    })));
  });

  it('requires the explicit YOLO bridge checkbox and offers data cleaning', async () => {
    apiMocks.preflightExport.mockResolvedValueOnce({
      ok: true,
      profile: 'yolo_instance',
      project_id: 'project-1',
      project_content_rev: 9,
      stats: { annotations_selected: 1, instances_written: 1, regions_written: 2, images_written: 1, negative_images: 0, output_records: 1, multipart_instances: 1 },
      warnings: [{ code: 'YOLO_MULTIPART_BRIDGE', message: 'bridge', severity: 'warning', count: 1, samples: [] }],
      blockers: [],
      confirmation_required_codes: ['YOLO_MULTIPART_BRIDGE'],
      format_details: { multipart_bridge: { affected_instances: 1, connections: 1, added_pixels: 7, iou: 0.9, area_change_ratio: 0.1 } },
    });
    const openCleaning = vi.fn();
    render(<ExportPanel projectId="project-1" open onClose={() => undefined} onOpenDataCleaning={openCleaning} />);
    await selectProfile('YOLO 实例分割');
    const preflightButton = screen.getByRole('button', { name: '预检并导出' });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    fireEvent.click(preflightButton);
    const confirm = await screen.findByRole('button', { name: '确认导出' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: '前往数据清洗' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/我已了解多区域/));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMocks.exportProject).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'yolo_instance',
      confirmed_issue_codes: ['YOLO_MULTIPART_BRIDGE'],
      expected_content_rev: 9,
    })));
  });

  it('converts the displayed YOLO validation percentage to an API ratio', async () => {
    render(<ExportPanel projectId="project-1" open onClose={() => undefined} />);
    await selectProfile('YOLO 检测');
    const preflightButton = screen.getByRole('button', { name: '预检并导出' });
    await waitFor(() => expect(preflightButton).toBeEnabled());
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '15' } });
    fireEvent.mouseDown(screen.getAllByRole('combobox').at(-1)!);
    fireEvent.click(await screen.findByRole('option', { name: '复制图片（可移动数据集）' }));
    fireEvent.click(preflightButton);
    await waitFor(() => expect(apiMocks.preflightExport).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'yolo_detection', val_ratio: 0.15, image_mode: 'copy',
    })));
  });

  it('opens data cleaning without applying changes', async () => {
    apiMocks.preflightExport.mockResolvedValueOnce({
      ok: false,
      profile: 'yolo_instance', project_id: 'project-1', project_content_rev: 9,
      stats: {}, warnings: [],
      blockers: [{ code: 'YOLO_MULTIPART_REJECTED', message: 'reject', severity: 'blocker', count: 1, samples: [] }],
      confirmation_required_codes: [], format_details: {},
    });
    const onClose = vi.fn();
    const openCleaning = vi.fn();
    render(<ExportPanel projectId="project-1" open onClose={onClose} onOpenDataCleaning={openCleaning} />);
    await selectProfile('YOLO 实例分割');
    await waitFor(() => expect(screen.getByRole('button', { name: '预检并导出' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '预检并导出' }));
    fireEvent.click(await screen.findByRole('button', { name: '前往数据清洗' }));
    expect(onClose).toHaveBeenCalled();
    expect(openCleaning).toHaveBeenCalled();
    expect(apiMocks.exportProject).not.toHaveBeenCalled();
  });
});
