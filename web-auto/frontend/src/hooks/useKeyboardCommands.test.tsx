import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useKeyboardCommands } from './useKeyboardCommands';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useViewerStore } from '../stores/workspace/viewerStore';

const navigationMocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('./useImageNavigation', () => ({
  useImageNavigation: () => ({ navigate: navigationMocks.navigate }),
}));

function KeyboardHarness({
  editable,
  onDeleteImage,
  onToggleAiOperationMode,
  onToggleAiPointLabel,
}: {
  editable: boolean;
  onDeleteImage: (imageId: string) => void;
  onToggleAiOperationMode?: () => void;
  onToggleAiPointLabel?: () => void;
}) {
  useKeyboardCommands({ editable, onDeleteImage, onToggleAiOperationMode, onToggleAiPointLabel });
  return (
    <div data-image-item="image-1">
      <button type="button">image row</button>
      <input aria-label="class name" />
    </div>
  );
}

describe('workspace keyboard editable policy', () => {
  afterEach(cleanup);

  beforeEach(() => {
    navigationMocks.navigate.mockReset();
    useViewerStore.getState().reset();
    useAnnotationStore.getState().reset();
    useAnnotationStore.getState().setAutosaveEnabled(false);
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'ann-1', class_name: 'chair', bbox: [0, 0, 10, 10],
    }]);
    useViewerStore.getState().setFocusedAnnotation('ann-1');
  });

  it('blocks annotation shortcuts in read-only mode and only deletes a focused image row', () => {
    const onDeleteImage = vi.fn();
    useViewerStore.getState().setEditable(false);
    useAnnotationStore.getState().setEditingEnabled(false);
    render(<KeyboardHarness editable={false} onDeleteImage={onDeleteImage} />);

    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(useViewerStore.getState().promptMode).toBe('none');
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    expect(onDeleteImage).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'image row' }).focus();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(onDeleteImage).toHaveBeenCalledWith('image-1');
  });

  it('keeps manual drawing and focused-annotation deletion in editable mode', () => {
    const onDeleteImage = vi.fn();
    render(<KeyboardHarness editable onDeleteImage={onDeleteImage} />);

    fireEvent.keyDown(window, { key: 'b' });
    expect(useViewerStore.getState().promptMode).toBe('manual-box');
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(useAnnotationStore.getState().annotations).toEqual([]);
    expect(onDeleteImage).not.toHaveBeenCalled();
  });

  it('gives a focused image row ownership of Delete in editable mode', () => {
    const onDeleteImage = vi.fn();
    render(<KeyboardHarness editable onDeleteImage={onDeleteImage} />);

    screen.getByRole('button', { name: 'image row' }).focus();
    fireEvent.keyDown(window, { key: 'Delete' });

    expect(onDeleteImage).toHaveBeenCalledWith('image-1');
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
  });

  it('uses Ctrl+A to toggle the AI operation mode only in an editable workspace', () => {
    const onToggleAiOperationMode = vi.fn();
    const { rerender } = render(
      <KeyboardHarness editable onDeleteImage={vi.fn()} onToggleAiOperationMode={onToggleAiOperationMode} />,
    );

    const editableEvent = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true });
    window.dispatchEvent(editableEvent);
    expect(onToggleAiOperationMode).toHaveBeenCalledOnce();
    expect(editableEvent.defaultPrevented).toBe(true);

    rerender(
      <KeyboardHarness editable={false} onDeleteImage={vi.fn()} onToggleAiOperationMode={onToggleAiOperationMode} />,
    );
    const readOnlyEvent = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true });
    window.dispatchEvent(readOnlyEvent);
    expect(onToggleAiOperationMode).toHaveBeenCalledOnce();
    expect(readOnlyEvent.defaultPrevented).toBe(false);
  });

  it('uses plain A and D to navigate while preserving Ctrl+A for the AI mode', () => {
    const onToggleAiOperationMode = vi.fn();
    render(
      <KeyboardHarness editable onDeleteImage={vi.fn()} onToggleAiOperationMode={onToggleAiOperationMode} />,
    );
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(100);

    fireEvent.keyDown(window, { key: 'a' });
    expect(navigationMocks.navigate).toHaveBeenLastCalledWith(-1);

    fireEvent.keyDown(window, { key: 'd' });
    expect(navigationMocks.navigate).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(onToggleAiOperationMode).toHaveBeenCalledOnce();
    expect(navigationMocks.navigate).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('does not navigate with A or D while typing in a form control', () => {
    render(<KeyboardHarness editable onDeleteImage={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'class name' });

    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'd' });

    expect(navigationMocks.navigate).not.toHaveBeenCalled();
  });

  it('preserves native Ctrl+A selection inside form controls', () => {
    const onToggleAiOperationMode = vi.fn();
    render(
      <KeyboardHarness editable onDeleteImage={vi.fn()} onToggleAiOperationMode={onToggleAiOperationMode} />,
    );

    const input = screen.getByRole('textbox', { name: 'class name' });
    const inputEvent = new KeyboardEvent('keydown', {
      key: 'a', ctrlKey: true, bubbles: true, cancelable: true,
    });
    input.dispatchEvent(inputEvent);

    expect(onToggleAiOperationMode).not.toHaveBeenCalled();
    expect(inputEvent.defaultPrevented).toBe(false);
  });

  it('uses W to toggle the AI point type only in an editable workspace', () => {
    const onToggleAiPointLabel = vi.fn();
    const { rerender } = render(
      <KeyboardHarness editable onDeleteImage={vi.fn()} onToggleAiPointLabel={onToggleAiPointLabel} />,
    );

    const editableEvent = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
    window.dispatchEvent(editableEvent);
    expect(onToggleAiPointLabel).toHaveBeenCalledOnce();
    expect(editableEvent.defaultPrevented).toBe(true);

    rerender(
      <KeyboardHarness editable={false} onDeleteImage={vi.fn()} onToggleAiPointLabel={onToggleAiPointLabel} />,
    );
    const readOnlyEvent = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
    window.dispatchEvent(readOnlyEvent);
    expect(onToggleAiPointLabel).toHaveBeenCalledOnce();
    expect(readOnlyEvent.defaultPrevented).toBe(false);
  });

  it('does not claim the browser-reserved Ctrl+W shortcut', () => {
    const onToggleAiPointLabel = vi.fn();
    render(
      <KeyboardHarness editable onDeleteImage={vi.fn()} onToggleAiPointLabel={onToggleAiPointLabel} />,
    );

    const browserEvent = new KeyboardEvent('keydown', {
      key: 'w', ctrlKey: true, cancelable: true,
    });
    window.dispatchEvent(browserEvent);

    expect(onToggleAiPointLabel).not.toHaveBeenCalled();
    expect(browserEvent.defaultPrevented).toBe(false);
  });
});
