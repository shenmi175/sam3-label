import { create } from 'zustand';
import type { Annotation, Prompt } from '../../api/types';
import type { PromptMode } from '../../components/viewer/ImageViewer';

export type SourceFilter = 'sam3' | 'locate-anything' | 'manual';

/**
 * Viewer-side semantic state (replaces the prompt/preview/focus fields of the
 * legacy God Object). The heavy per-frame canvas state stays inside
 * viewer-core; this store only holds declarative inputs.
 */
interface ViewerState {
  promptMode: PromptMode;
  boxPromptLabel: 0 | 1;
  currentPrompts: Prompt[];
  previews: Annotation[];
  focusedAnnotationId: string | null;
  previewSectionCollapsed: boolean;
  showMasks: boolean;
  /**
   * Guard registered by the workspace page: commits a pending manual polygon
   * before save/switch operations. Returns false (and shows a toast) when the
   * polygon cannot be committed yet. Replaces ws.commitPendingManualPolygon.
   */
  commitPolygonGuard: (() => boolean) | null;

  setPromptMode: (mode: PromptMode | 'pointer' | 'pan', workspaceMode?: 'auto' | 'review') => void;
  setBoxPromptLabel: (label: number) => void;
  addPrompt: (type: 'point' | 'box', data: number[]) => void;
  clearPromptsAndPreviews: () => void;
  setPreviews: (previews: Annotation[]) => void;
  removePreview: (id: string) => void;
  setFocusedAnnotation: (id: string | null) => void;
  togglePreviewSection: () => void;
  setShowMasks: (show: boolean) => void;
  registerCommitPolygonGuard: (guard: (() => boolean) | null) => void;
  commitPendingManualPolygon: () => boolean;
  reset: () => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  promptMode: 'none',
  boxPromptLabel: 1,
  currentPrompts: [],
  previews: [],
  focusedAnnotationId: null,
  previewSectionCollapsed: false,
  showMasks: true,
  commitPolygonGuard: null,

  setPromptMode: (mode, workspaceMode = 'auto') => {
    let next: PromptMode = mode === 'pointer' || mode === 'none' ? 'none' : (mode as PromptMode);
    if (next === 'point') next = 'none';
    // Legacy behavior: box prompts are not available in review mode.
    if (workspaceMode === 'review' && next === 'box') next = 'none';
    set({ promptMode: next });
  },

  setBoxPromptLabel: (label) => {
    const nextLabel: 0 | 1 = Number(label) === 0 ? 0 : 1;
    set({ boxPromptLabel: nextLabel, promptMode: 'box' });
  },

  // Legacy addPrompt: points are ignored, boxes carry a positive/negative label.
  addPrompt: (type, data) => {
    if (type === 'point') return;
    const { boxPromptLabel } = get();
    const promptData =
      type === 'box'
        ? [...data.slice(0, 4), data.length >= 5 ? (Number(data[4]) === 0 ? 0 : 1) : boxPromptLabel]
        : data;
    set((state) => ({
      currentPrompts: [...state.currentPrompts, { type, data: promptData }],
    }));
  },

  clearPromptsAndPreviews: () => set({ currentPrompts: [], previews: [] }),

  setPreviews: (previews) => set({ previews }),

  removePreview: (id) => set((state) => ({ previews: state.previews.filter((p) => String(p.id) !== String(id)) })),

  setFocusedAnnotation: (id) => set({ focusedAnnotationId: id || null }),

  togglePreviewSection: () => set((state) => ({ previewSectionCollapsed: !state.previewSectionCollapsed })),

  setShowMasks: (show) => set({ showMasks: Boolean(show) }),

  registerCommitPolygonGuard: (guard) => set({ commitPolygonGuard: guard }),

  commitPendingManualPolygon: () => {
    const guard = get().commitPolygonGuard;
    return guard ? guard() : true;
  },

  reset: () =>
    set({
      promptMode: 'none',
      boxPromptLabel: 1,
      currentPrompts: [],
      previews: [],
      focusedAnnotationId: null,
      previewSectionCollapsed: false,
      showMasks: true,
      commitPolygonGuard: null,
    }),
}));

/** Selector helper: annotations visible under the single-select source filter. */
export function filterAnnotationsBySource(annotations: Annotation[], sourceFilter: SourceFilter): Annotation[] {
  return (annotations || []).filter((a) => String(a.source_model || 'sam3') === sourceFilter);
}
