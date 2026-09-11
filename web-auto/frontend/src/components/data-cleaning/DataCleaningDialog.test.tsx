import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComponentNoiseConfig } from './ComponentNoiseConfig';
import { DataCleaningDialog } from './DataCleaningDialog';
import { JobStatusSection } from './JobStatusSection';
import { ModeSelectCards } from './ModeSelectCards';
import { RuleFilterConfig } from './RuleFilterConfig';
import { parseDataCleaningConfig, serializeDataCleaningConfig } from './configFile';
import {
  DEFAULT_CONFIG,
  buildPayload,
  useSmartFilterStore,
} from '../../stores/workspace/smartFilterStore';
import { useProjectStore } from '../../stores/workspace/projectStore';

describe('data cleaning workbench', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    useProjectStore.setState({ classes: ['chair', 'table'] });
    useSmartFilterStore.setState({
      config: { ...DEFAULT_CONFIG },
      previewToken: '',
      previewResult: null,
      applyResult: null,
      jobRunning: false,
      latestRun: null,
    });
  });

  afterEach(cleanup);

  it('selects exactly one of the twelve cleaning tasks', () => {
    render(<ModeSelectCards />);
    expect(screen.getAllByRole('button')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: '置信度删除' }));
    expect(useSmartFilterStore.getState().config.taskType).toBe('remove_confidence_range');
    expect(useSmartFilterStore.getState().config.operationMode).toBe('rule');
  });

  it('restores the cleaning project context whenever the dialog opens', async () => {
    useProjectStore.getState().setProjectId('project-1');
    useSmartFilterStore.setState({ projectId: '' });

    render(<DataCleaningDialog open onClose={() => {}} />);

    await waitFor(() => expect(useSmartFilterStore.getState().projectId).toBe('project-1'));
  });

  it('controls each component threshold independently', () => {
    render(<ComponentNoiseConfig />);
    const absolute = screen.getByRole('checkbox', { name: /绝对面积阈值/ });
    const relative = screen.getByRole('checkbox', { name: /相对主体面积阈值/ });
    expect(absolute).toBeChecked();
    expect(relative).toBeChecked();
    fireEvent.click(absolute);
    expect(useSmartFilterStore.getState().config.componentAbsAreaEnabled).toBe(false);
    expect(useSmartFilterStore.getState().config.componentRelativeAreaEnabled).toBe(true);
  });

  it('keeps topology-changing operations off until explicitly enabled', () => {
    render(<ComponentNoiseConfig />);
    fireEvent.click(screen.getByRole('button', { name: /粘连毛刺/ }));
    fireEvent.click(screen.getByRole('button', { name: /短间隙连接/ }));
    fireEvent.click(screen.getByRole('button', { name: /小孔洞填充/ }));
    expect(screen.getByRole('checkbox', { name: '启用形态学开运算' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '启用同一实例内的短间隙修复' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '启用实例内部小孔洞填充' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用同一实例内的短间隙修复' }));
    expect(useSmartFilterStore.getState().config.componentGapRepairEnabled).toBe(true);
  });

  it('builds v2 AND and OR component payloads without hidden task fields', () => {
    const andPayload = buildPayload('project', { ...DEFAULT_CONFIG });
    const orPayload = buildPayload('project', { ...DEFAULT_CONFIG, componentRequireAllThresholds: false });
    expect(andPayload.schema_version).toBe(2);
    expect(andPayload.task_type).toBe('remove_small_components');
    expect(andPayload.params.threshold_mode).toBe('and');
    expect(orPayload.params.threshold_mode).toBe('or');
    expect(andPayload.params.max_area_px).toBe(128);
    expect(andPayload.params).not.toHaveProperty('radius_px');
  });

  it('builds externally configurable topology payloads', () => {
    const payload = buildPayload('project', {
      ...DEFAULT_CONFIG,
      taskType: 'morph_close',
      operationMode: 'component_noise',
      componentClosingRadiusPx: 12,
      componentGapAvoidOtherInstances: false,
    });
    expect(payload.task_type).toBe('morph_close');
    expect(payload.params.radius_px).toBe(12);
    expect(payload.params.avoid_other_instances).toBe(false);
    expect(payload.params).not.toHaveProperty('max_area_px');
  });

  it('round-trips versioned full-workbench configuration files', () => {
    const original = {
      ...DEFAULT_CONFIG,
      taskType: 'shortest_bridge' as const,
      operationMode: 'component_noise' as const,
      ruleClasses: ['chair'],
      classScopeMode: 'selected' as const,
      componentBridgeMaxGapPx: 23,
    };
    const parsed = parseDataCleaningConfig(serializeDataCleaningConfig(original));
    expect(parsed.config).toEqual(original);
    expect(parsed.warnings).toEqual([]);

    const document = JSON.parse(serializeDataCleaningConfig(original));
    document.version = 3;
    expect(() => parseDataCleaningConfig(JSON.stringify(document))).toThrow('unsupported_schema');
  });

  it('shows cleanup recipes and an explicit advanced parameter entry', () => {
    useSmartFilterStore.setState({
      config: { ...DEFAULT_CONFIG, operationMode: 'rule', ruleClasses: ['chair'] },
    });
    render(<RuleFilterConfig />);
    expect(screen.getByRole('button', { name: /高级参数（精确控制）/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /低置信度/ }));
    expect(useSmartFilterStore.getState().config.confidenceEnabled).toBe(true);
    expect(useSmartFilterStore.getState().config.maxConfidence).toBe(0.35);
    expect(useSmartFilterStore.getState().config.ruleClasses).toEqual(['chair']);
    fireEvent.click(screen.getByRole('button', { name: /密集图片/ }));
    expect(useSmartFilterStore.getState().config.instanceCountEnabled).toBe(true);
    expect(useSmartFilterStore.getState().config.minInstances).toBe(10);
    expect(screen.getByText(/删除命中图片中所选类别的全部实例/)).toBeInTheDocument();
  });

  it('shows one draggable before-and-after preview sample and expands it', () => {
    useSmartFilterStore.setState({
      previewResult: {
        operation_mode: 'component_noise',
        image_count: 5,
        modified_annotations: 5,
        removed_components: 10,
        removed_pixels: 20,
        preview_samples: [{
          image_id: 'image-0',
          rel_path: 'path-0.jpg',
          kind: 'annotation_change',
          before_url: '/sample-0-before.webp',
          after_url: '/sample-0-after.webp',
        }],
        items: Array.from({ length: 5 }, (_value, index) => ({
          image_id: `image-${index}`,
          rel_path: `path-${index}.jpg`,
          removed_components: index + 1,
          removed_pixels: index + 2,
        })),
      },
    });
    render(<JobStatusSection />);
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /path-0\.jpg 清理前/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /path-1\.jpg/ })).not.toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '50');
    fireEvent.click(screen.getByRole('button', { name: '打开大图卷帘' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '关闭大图卷帘' })).toBeInTheDocument();
  });

  it('renders boxes and segmentation in one task-specific instance preview', () => {
    useSmartFilterStore.setState({
      config: { ...DEFAULT_CONFIG, operationMode: 'merge' },
      previewResult: {
        operation_mode: 'merge',
        image_count: 1,
        candidate_count: 2,
        preview_samples: [{
          image_id: 'mixed-image', rel_path: 'mixed.jpg', kind: 'annotation_change', geometry_type: 'mixed',
          annotation_count: 7, candidate_count: 2, relabel_count: 0,
          before_url: '/mixed-before.webp', after_url: '/mixed-after.webp',
        }],
        items: [{ image_id: 'mixed-image', rel_path: 'mixed.jpg', candidate_count: 2, relabel_count: 0 }],
      },
    });
    render(<JobStatusSection />);
    expect(screen.queryByRole('tablist', { name: /目标框与分割预览切换/ })).not.toBeInTheDocument();
    expect(screen.getByText('实例')).toBeInTheDocument();
    expect(screen.getByText('共 7 个实例；预览删除 2 个实例、改类 0 个实例')).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it.each([
    ['merge', '标注合并', '预览删除 2 个实例、改类 1 个实例'],
    ['rule', '实例清理', '预览删除 2 个实例'],
    ['delete_unlabeled', '无标注图片删除', '右侧表示应用后该图片将被删除'],
  ] as const)('reuses the comparison viewer for %s preview', (operationMode, _label, subtitle) => {
    useSmartFilterStore.setState({
      config: { ...DEFAULT_CONFIG, operationMode },
      previewResult: {
        operation_mode: operationMode,
        image_count: 1,
        candidate_count: 2,
        relabel_count: 1,
        preview_samples: [{
          image_id: 'image-1',
          rel_path: 'shared.jpg',
          kind: operationMode === 'delete_unlabeled' ? 'image_delete' : 'annotation_change',
          before_url: '/shared-before.webp',
          after_url: '/shared-after.webp',
        }],
        items: [{ image_id: 'image-1', rel_path: 'shared.jpg', candidate_count: 2, relabel_count: 1 }],
      },
    });
    render(<JobStatusSection />);
    expect(screen.getByText(subtitle)).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });

  it('uses a MUI confirmation dialog before apply', () => {
    useSmartFilterStore.setState({ previewToken: 'preview-token' });
    render(<DataCleaningDialog open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '应用：小连通域删除' }));
    expect(screen.getByRole('dialog', { name: '确认应用预览结果' })).toBeInTheDocument();
    expect(screen.getByText(/实例数量、ID、类别和置信度均保持不变/)).toBeInTheDocument();
  });

  it('warns but permits confirmation when an old worker returned no artwork status', () => {
    useSmartFilterStore.setState({
      config: { ...DEFAULT_CONFIG, operationMode: 'merge' },
      previewToken: 'legacy-preview-token',
      previewResult: { operation_mode: 'merge', image_count: 2, candidate_count: 3, items: [] },
    });
    render(<DataCleaningDialog open onClose={() => undefined} />);
    expect(screen.getByText(/尚未加载新版对比预览功能/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '应用：小连通域删除' }));
    expect(screen.getByRole('dialog', { name: '确认应用预览结果' })).toBeInTheDocument();
    expect(screen.getByText(/你尚未查看清洗前后对比图/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确定' })).toBeEnabled();
  });
});
