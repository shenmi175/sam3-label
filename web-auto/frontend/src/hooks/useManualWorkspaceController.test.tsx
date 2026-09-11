import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useManualWorkspaceController } from './useManualWorkspaceController';
import { useAiAssistantStore } from '../stores/workspace/aiAssistantStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useViewerStore } from '../stores/workspace/viewerStore';

const aiMocks = vi.hoisted(() => ({
  prepareCurrent: vi.fn<() => Promise<boolean>>(),
  closeCurrentSession: vi.fn<() => Promise<void>>(),
  addPoint: vi.fn(),
  toggle: vi.fn(),
  setOperationMode: vi.fn(),
  clear: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  undoPrompt: vi.fn(),
  redoPrompt: vi.fn(),
}));

vi.mock('./useAiAssistant', () => ({
  closeCurrentSession: aiMocks.closeCurrentSession,
  useAiAssistant: () => ({
    prepareCurrent: aiMocks.prepareCurrent,
    addPoint: aiMocks.addPoint,
    toggle: aiMocks.toggle,
    setOperationMode: aiMocks.setOperationMode,
    clear: aiMocks.clear,
    finish: aiMocks.finish,
    cancel: aiMocks.cancel,
    undoPrompt: aiMocks.undoPrompt,
    redoPrompt: aiMocks.redoPrompt,
  }),
}));

describe('manual workspace AI binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.closeCurrentSession.mockResolvedValue();
    useImageStore.getState().reset();
    useAnnotationStore.getState().reset();
    useViewerStore.getState().reset();
    useAiAssistantStore.getState().reset();
    useAnnotationStore.getState().resetForImage('image-1', [
      { id: 'ann-1', class_name: 'chair', bbox: [0, 0, 20, 20] },
      { id: 'ann-2', class_name: 'chair', bbox: [30, 30, 50, 50] },
    ]);
    useImageStore.setState({ selectedImageId: 'image-1', isLoading: false });
    useViewerStore.getState().setFocusedAnnotation('ann-1');
    useAiAssistantStore.getState().set({ enabled: true, operationMode: 'refine' });
  });

  afterEach(() => {
    useAnnotationStore.getState().clearSaveTimer();
  });

  it('does not retry the same failed refine binding after preparing toggles', async () => {
    aiMocks.prepareCurrent.mockImplementation(async () => {
      useAiAssistantStore.getState().set({ preparing: true });
      await Promise.resolve();
      useAiAssistantStore.getState().set({ preparing: false });
      return false;
    });
    const viewerRef = { current: null };
    const { unmount } = renderHook(() => useManualWorkspaceController(viewerRef));

    await waitFor(() => expect(aiMocks.prepareCurrent).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(aiMocks.prepareCurrent).toHaveBeenCalledTimes(1);

    act(() => useViewerStore.getState().setFocusedAnnotation('ann-2'));
    await waitFor(() => expect(aiMocks.prepareCurrent).toHaveBeenCalledTimes(2));
    unmount();
  });

  it('clears a stale or temporary focus without opening a backend session', async () => {
    aiMocks.prepareCurrent.mockResolvedValue(true);
    useViewerStore.getState().setFocusedAnnotation('__sam3_ai_candidate__');
    const viewerRef = { current: null };
    const { unmount } = renderHook(() => useManualWorkspaceController(viewerRef));

    await waitFor(() => expect(useViewerStore.getState().focusedAnnotationId).toBeNull());
    expect(aiMocks.prepareCurrent).not.toHaveBeenCalled();
    unmount();
  });
});
