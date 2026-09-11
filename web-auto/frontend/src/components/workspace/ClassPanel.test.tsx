import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassPanel } from './ClassPanel';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';

describe('ClassPanel focused annotation synchronization', () => {
  beforeEach(() => {
    localStorage.setItem('language', 'zh');
    useProjectStore.getState().reset();
    useProjectStore.getState().setClasses(['chair', 'table']);
    useProjectStore.getState().setSelectedClass('chair');
    useAnnotationStore.getState().reset();
    useAnnotationStore.getState().resetForImage('image-1', [
      { id: 'ann-1', class_name: 'chair', bbox: [0, 0, 10, 10], source_model: 'sam3' },
      { id: 'ann-2', class_name: 'table', bbox: [20, 20, 40, 40], source_model: 'sam3' },
    ]);
    useViewerStore.getState().reset();
  });

  afterEach(cleanup);

  it('selects and scrolls to the class of the focused canvas annotation', () => {
    render(<ClassPanel collapsed={false} />);
    const row = screen.getByText('table').closest('[data-class-name="table"]') as HTMLElement;
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;

    act(() => useViewerStore.getState().setFocusedAnnotation('ann-2'));

    expect(useProjectStore.getState().selectedClass).toBe('table');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('highlights every annotation in a clicked class and clears single-instance focus', () => {
    useAnnotationStore.getState().resetForImage('image-1', [
      { id: 'chair-1', class_name: 'chair', bbox: [0, 0, 10, 10], source_model: 'sam3' },
      { id: 'table-1', class_name: 'table', bbox: [20, 20, 40, 40], source_model: 'sam3' },
      { id: 'table-2', class_name: 'table', bbox: [50, 50, 70, 70], source_model: 'sam3' },
    ]);
    useViewerStore.getState().setFocusedAnnotation('chair-1');
    render(<ClassPanel collapsed={false} />);

    fireEvent.click(screen.getByText('table').closest('[data-class-name="table"]') as HTMLElement);

    expect(useViewerStore.getState().focusedAnnotationId).toBeNull();
    expect(useViewerStore.getState().highlightedAnnotationIds).toEqual(['table-1', 'table-2']);
  });
});
