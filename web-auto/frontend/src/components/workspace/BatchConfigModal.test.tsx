import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchConfigModal } from './BatchConfigModal';
import { useInferenceStore, type BatchConfigResult } from '../../stores/workspace/inferenceStore';
import { useProjectStore } from '../../stores/workspace/projectStore';

describe('BatchConfigModal', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    useInferenceStore.getState().reset();
    useProjectStore.getState().reset();
    useProjectStore.getState().setClasses(['chair', 'table', 'person']);
    useProjectStore.getState().toggleInferenceClass('table', false);
    useProjectStore.getState().toggleInferenceClass('person', false);
  });

  afterEach(cleanup);

  function open(supportsAppendMode = true): Promise<BatchConfigResult | null> {
    let result!: Promise<BatchConfigResult | null>;
    act(() => {
      result = useInferenceStore.getState().openBatchConfig(
        useProjectStore.getState().getSelectedClassesForInference(),
        '测试批量推理',
        false,
        supportsAppendMode,
      );
    });
    return result;
  }

  it('uses external checks as defaults while allowing all project classes for this run', async () => {
    render(<BatchConfigModal />);
    const resultPromise = open();

    expect(await screen.findByRole('button', { name: 'chair' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'table' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'chair' }));
    fireEvent.click(screen.getByRole('button', { name: 'table' }));
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    const result = await resultPromise;
    expect(result?.classes).toEqual(['table']);
    expect(result?.merge_mode).toBe('replace');
    expect(useProjectStore.getState().getSelectedClassesForInference()).toEqual(['chair']);
  });

  it('does not submit with an empty run class selection', async () => {
    render(<BatchConfigModal />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'chair' }));
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    expect(useInferenceStore.getState().batchConfigRequest).not.toBeNull();
  });

  it('maps the append scope to all images plus append merge mode and warns about duplicates', async () => {
    render(<BatchConfigModal />);
    const resultPromise = open();
    fireEvent.mouseDown(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByText('仅追加所选类别，不替换已有标注'));

    expect(screen.getByText(/可能产生同类别的重复实例/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }));

    await expect(resultPromise).resolves.toMatchObject({
      classes: ['chair'],
      scope_mode: 'all',
      merge_mode: 'append',
    });
  });

  it('does not offer append mode for LA box segmentation', async () => {
    render(<BatchConfigModal />);
    open(false);
    fireEvent.mouseDown(await screen.findByRole('combobox'));

    expect(screen.queryByText('仅追加所选类别，不替换已有标注')).not.toBeInTheDocument();
  });
});
