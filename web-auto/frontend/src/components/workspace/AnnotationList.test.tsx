import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnnotationList } from './AnnotationList';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';

describe('AnnotationList editable policy', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    useProjectStore.getState().reset();
    useProjectStore.getState().setClasses(['chair']);
    useViewerStore.getState().reset();
    useAnnotationStore.getState().reset();
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'ann-1', class_name: 'chair', bbox: [0, 0, 10, 10], source_model: 'sam3',
    }]);
  });

  afterEach(cleanup);

  it('renders model annotations without mutation controls when read-only', () => {
    render(<AnnotationList collapsed={false} editable={false} />);
    expect(screen.getByText('chair')).toBeInTheDocument();
    expect(screen.queryByText('编辑')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除当前选中标注' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '清空当前图标注' })).not.toBeInTheDocument();
    expect(screen.queryByText('手动')).not.toBeInTheDocument();
  });

  it('replaces the edit button with double-click class editing in manual mode', () => {
    render(<AnnotationList collapsed={false} editable />);
    expect(screen.queryByText('编辑')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除当前选中标注' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清空当前图标注' })).toBeInTheDocument();

    const row = document.querySelector('[data-annotation-id="ann-1"]');
    expect(row).not.toBeNull();
    fireEvent.doubleClick(row as Element);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('修改标注类别')).toBeInTheDocument();
  });

  it('scrolls the focused canvas annotation into view in the list', () => {
    render(<AnnotationList collapsed={false} editable />);
    const row = document.querySelector('[data-annotation-id="ann-1"]') as HTMLElement;
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;

    act(() => useViewerStore.getState().setFocusedAnnotation('ann-1'));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });
});
