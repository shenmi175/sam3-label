import { create } from 'zustand';

export type WorkspaceMode = 'auto' | 'review';

/**
 * Layout + persisted UI state (replaces LayoutController and the panel/section
 * fields of the legacy God Object). `useUiStateSync` watches this store and
 * debounce-syncs it to /api/ui_state.
 */
interface LayoutState {
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;
  classesSectionCollapsed: boolean;
  annotationsSectionCollapsed: boolean;
  unlabeledNavigationEnabled: boolean;
  workspaceMode: WorkspaceMode;
  routeWorkspaceMode: WorkspaceMode;
  reviewContinuousMode: boolean;

  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setRouteWorkspaceMode: (mode: WorkspaceMode) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleClassesSection: () => void;
  toggleAnnotationsSection: () => void;
  toggleUnlabeledNavigation: () => void;
  setUnlabeledNavigation: (enabled: boolean) => void;
  toggleReviewContinuousMode: () => void;
  applyRestoredState: (state: Partial<Pick<LayoutState,
    'leftPanelHidden' | 'rightPanelHidden' | 'classesSectionCollapsed' |
    'annotationsSectionCollapsed' | 'unlabeledNavigationEnabled' |
    'workspaceMode' | 'reviewContinuousMode'>>) => void;
  reset: () => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  leftPanelHidden: false,
  rightPanelHidden: false,
  classesSectionCollapsed: false,
  annotationsSectionCollapsed: false,
  unlabeledNavigationEnabled: false,
  workspaceMode: 'auto',
  routeWorkspaceMode: 'auto',
  reviewContinuousMode: true,

  setWorkspaceMode: (mode) => set({ workspaceMode: mode === 'review' ? 'review' : 'auto' }),
  setRouteWorkspaceMode: (mode) => set({ routeWorkspaceMode: mode === 'review' ? 'review' : 'auto' }),
  toggleLeftPanel: () => set((s) => ({ leftPanelHidden: !s.leftPanelHidden })),
  toggleRightPanel: () => set((s) => ({ rightPanelHidden: !s.rightPanelHidden })),
  toggleClassesSection: () => set((s) => ({ classesSectionCollapsed: !s.classesSectionCollapsed })),
  toggleAnnotationsSection: () => set((s) => ({ annotationsSectionCollapsed: !s.annotationsSectionCollapsed })),
  toggleUnlabeledNavigation: () => set((s) => ({ unlabeledNavigationEnabled: !s.unlabeledNavigationEnabled })),
  setUnlabeledNavigation: (enabled) => set({ unlabeledNavigationEnabled: Boolean(enabled) }),
  toggleReviewContinuousMode: () => set((s) => ({ reviewContinuousMode: !s.reviewContinuousMode })),

  applyRestoredState: (state) =>
    set({
      leftPanelHidden: Boolean(state.leftPanelHidden),
      rightPanelHidden: Boolean(state.rightPanelHidden),
      classesSectionCollapsed: Boolean(state.classesSectionCollapsed),
      annotationsSectionCollapsed: Boolean(state.annotationsSectionCollapsed),
      unlabeledNavigationEnabled: Boolean(state.unlabeledNavigationEnabled),
      workspaceMode: state.workspaceMode === 'review' ? 'review' : 'auto',
      reviewContinuousMode: state.reviewContinuousMode !== false,
    }),

  reset: () =>
    set({
      leftPanelHidden: false,
      rightPanelHidden: false,
      classesSectionCollapsed: false,
      annotationsSectionCollapsed: false,
      unlabeledNavigationEnabled: false,
      workspaceMode: 'auto',
      routeWorkspaceMode: 'auto',
      reviewContinuousMode: true,
    }),
}));
