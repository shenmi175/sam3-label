import { useCallback, useEffect, useRef } from 'react';
import { getUIState, setUIState } from '../api/config';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';

export const UI_STATE_DEBOUNCE_MS = 700;

export interface RestoredUiState {
  selectedImageId?: string;
  selectedImagePath?: string;
  offset?: number;
  [key: string]: unknown;
}

function collectUiState(): Record<string, unknown> {
  const project = useProjectStore.getState();
  const image = useImageStore.getState();
  const viewer = useViewerStore.getState();
  const layout = useLayoutStore.getState();
  const annotation = useAnnotationStore.getState();
  return {
    offset: project.offset,
    limit: project.limit,
    selectedImageId: image.selectedImageId,
    selectedImagePath: image.selectedImagePath,
    focusedAnnotationId: viewer.focusedAnnotationId,
    unlabeledNavigationEnabled: layout.unlabeledNavigationEnabled,
    imageFilterClass: project.imageFilterClass,
    imageFilterStatus: project.imageFilterStatus,
    leftPanelHidden: layout.leftPanelHidden,
    rightPanelHidden: layout.rightPanelHidden,
    classesSectionCollapsed: layout.classesSectionCollapsed,
    annotationsSectionCollapsed: layout.annotationsSectionCollapsed,
    annotationAutosaveEnabled: annotation.autosaveEnabled,
    workspaceMode: layout.workspaceMode,
    reviewContinuousMode: layout.reviewContinuousMode,
  };
}

/**
 * Restore persisted per-project UI state (legacy restoreProjectUIState).
 * Applies layout/panel/filter fields to the stores; the selected image id is
 * returned so the page can restore it after the image list loads.
 */
export async function restoreUiState(projectId: string): Promise<RestoredUiState> {
  if (!projectId) return {};
  try {
    const resp = await getUIState(projectId);
    const state = (resp?.state || {}) as Record<string, unknown>;

    const project = useProjectStore.getState();
    if (typeof state.offset === 'number') project.setOffset(state.offset);
    if (typeof state.limit === 'number' && state.limit > 0) project.setLimit(state.limit);
    project.setImageFilter(
      String(state.imageFilterClass || ''),
      state.imageFilterStatus === 'labeled' || state.imageFilterStatus === 'unlabeled'
        ? state.imageFilterStatus
        : 'all',
    );

    useLayoutStore.getState().applyRestoredState({
      leftPanelHidden: Boolean(state.leftPanelHidden),
      rightPanelHidden: Boolean(state.rightPanelHidden),
      classesSectionCollapsed: Boolean(state.classesSectionCollapsed),
      annotationsSectionCollapsed: Boolean(state.annotationsSectionCollapsed),
      unlabeledNavigationEnabled: Boolean(state.unlabeledNavigationEnabled),
      workspaceMode: state.workspaceMode === 'review' ? 'review' : 'auto',
      reviewContinuousMode: state.reviewContinuousMode !== false,
    });

    if (typeof state.annotationAutosaveEnabled === 'boolean') {
      useAnnotationStore.getState().setAutosaveEnabled(state.annotationAutosaveEnabled);
    }
    return {
      selectedImageId: state.selectedImageId ? String(state.selectedImageId) : '',
      selectedImagePath: String(state.selectedImagePath || ''),
      offset: typeof state.offset === 'number' ? state.offset : undefined,
    };
  } catch (err) {
    console.warn('restore ui state failed', err);
    return {};
  }
}

/**
 * Debounced (700 ms) ui_state sync — subscribes to all workspace stores and
 * pushes a snapshot to /api/ui_state after changes settle. Flushes
 * synchronously-scheduled pending state on unmount.
 */
export function useUiStateSync(projectId: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pid = projectIdRef.current;
      if (!pid) return;
      setUIState(pid, collectUiState()).catch((err) => {
        console.warn('save ui state failed', err);
      });
    }, UI_STATE_DEBOUNCE_MS);
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pid = projectIdRef.current;
    if (!pid) return;
    setUIState(pid, collectUiState()).catch(() => {});
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const unsubs = [
      useProjectStore.subscribe(scheduleSave),
      useImageStore.subscribe(scheduleSave),
      useViewerStore.subscribe(scheduleSave),
      useLayoutStore.subscribe(scheduleSave),
      useAnnotationStore.subscribe(scheduleSave),
    ];
    return () => {
      unsubs.forEach((u) => u());
      flush();
    };
  }, [projectId, scheduleSave, flush]);

  return { flush };
}
