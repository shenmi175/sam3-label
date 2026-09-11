import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import type { ExportPreflight, ExportProfile } from '../../api/exports';
import { JsonPackagePreflightDialog } from './JsonPackagePreflightDialog';


function segmentationReport(
  profile: ExportProfile,
  bySource: Record<string, number>,
): ExportPreflight {
  return {
    ok: true,
    profile,
    project_id: 'project-1',
    project_content_rev: 8,
    stats: {
      annotations_selected: Object.values(bySource).reduce((total, count) => total + count, 0),
      instances_written: 0,
      regions_written: 0,
      images_written: 1,
      negative_images: 1,
      output_records: 1,
    },
    warnings: [{
      code: 'SEGMENTATION_REQUIRES_POLYGON',
      message: 'A bbox-only instance will be skipped after explicit confirmation.',
      severity: 'warning',
      count: Object.values(bySource).reduce((total, count) => total + count, 0),
      samples: [],
      details: {
        profile,
        by_source: bySource,
        selected_sources: ['sam3', ...Object.keys(bySource)],
        skipped_sources: Object.keys(bySource),
      },
    }],
    blockers: [],
    confirmation_required_codes: ['SEGMENTATION_REQUIRES_POLYGON'],
    format_details: {},
  };
}

describe('JsonPackagePreflightDialog segmentation source details', () => {
  beforeEach(async () => {
    localStorage.setItem('language', 'zh');
    await i18n.changeLanguage('zh');
  });

  afterEach(cleanup);

  it('shows every skipped source and allows confirmation for COCO instance export', () => {
    const onConfirmedCodesChange = vi.fn();
    render(
      <JsonPackagePreflightDialog
        report={segmentationReport('coco_instance', { 'locate-anything': 349, 'future-detector': 2 })}
        exporting={false}
        confirmedCodes={[]}
        onConfirmedCodesChange={onConfirmedCodesChange}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onOpenDataCleaning={vi.fn()}
      />,
    );

    expect(screen.getByText('LA：349 个实例只有目标框，没有 polygon；确认后将从COCO 实例分割导出中跳过，也可改用COCO 检测保留目标框。')).toBeInTheDocument();
    expect(screen.getByText('future-detector：2 个实例只有目标框，没有 polygon；确认后将从COCO 实例分割导出中跳过，也可改用COCO 检测保留目标框。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认导出' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('我确认跳过只有目标框、没有分割区域的实例。'));
    expect(onConfirmedCodesChange).toHaveBeenCalledWith(['SEGMENTATION_REQUIRES_POLYGON']);
  });

  it('recommends YOLO detection for a YOLO instance export', () => {
    render(
      <JsonPackagePreflightDialog
        report={segmentationReport('yolo_instance', { 'locate-anything': 15 })}
        exporting={false}
        confirmedCodes={[]}
        onConfirmedCodesChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onOpenDataCleaning={vi.fn()}
      />,
    );

    expect(screen.getByText('LA：15 个实例只有目标框，没有 polygon；确认后将从YOLO 实例分割导出中跳过，也可改用YOLO 检测保留目标框。')).toBeInTheDocument();
  });
});
