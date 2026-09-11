import { create } from 'zustand';
import type { Annotation, Prompt } from '../../api/types';
import type { PromptMode } from '../../components/viewer/ImageViewer';
import { annotationSource } from '../../utils/annotations';

export type SourceFilter = 'sam3' | 'locate-anything';

/**
 * Viewer-side semantic state (replaces the prompt/focus fields of the
 * legacy God Object). The heavy per-frame canvas state stays inside
 * viewer-core; this store only holds declarative inputs.
 */
interface ViewerState {
  editable: boolean;
  promptMode: PromptMode;
  pointPromptLabel: 0 | 1;
  currentPrompts: Prompt[];
  promptRedoStack: Prompt[];
  focusedAnnotationId: string | null;
  /** Annotation ids highlighted together after clicking a class-count row. */
  highlightedAnnotationIds: string[];
  showMasks: boolean;
  /**
   * Guard registered by the workspace page: commits a pending manual polygon
   * before save/switch operations. Returns false (and shows a toast) when the
   * polygon cannot be committed yet. Replaces ws.commitPendingManualPolygon.
   */
  commitPolygonGuard: (() => boolean) | null;

  setEditable: (editable: boolean) => void;
  setPromptMode: (mode: PromptMode | 'pointer' | 'pan', workspaceMode?: 'auto' | 'review') => void;
  setPointPromptLabel: (label: number) => void;
  addPrompt: (type: 'point', data: number[]) => void;
  undoPrompt: () => void;
  redoPrompt: () => void;
  clearPrompts: () => void;
  setFocusedAnnotation: (id: string | null) => void;
  setHighlightedAnnotations: (ids: string[]) => void;
  setShowMasks: (show: boolean) => void;
  registerCommitPolygonGuard: (guard: (() => boolean) | null) => void;
  commitPendingManualPolygon: () => boolean;
  reset: () => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  editable: true,
  promptMode: 'none',
  pointPromptLabel: 1,
  currentPrompts: [],
  promptRedoStack: [],
  focusedAnnotationId: null,
  highlightedAnnotationIds: [],
  showMasks: true,
  commitPolygonGuard: null,

  setEditable: (editable) => set({
    editable: Boolean(editable),
    ...(editable ? {} : { promptMode: 'none' as PromptMode, currentPrompts: [], promptRedoStack: [] }),
  }),

  setPromptMode: (mode) => {
    const next: PromptMode = mode === 'pointer' || mode === 'none' || !get().editable ? 'none' : (mode as PromptMode);
    set({ promptMode: next });
  },

  setPointPromptLabel: (label) => {
    if (!get().editable) return;
    const nextLabel: 0 | 1 = Number(label) === 0 ? 0 : 1;
    set({ pointPromptLabel: nextLabel, promptMode: 'point' });
  },

  addPrompt: (type, data) => {
    if (!get().editable) return;
    const promptData = data.slice(0, 2);
    const pointLabel = data.length >= 3 ? (Number(data[2]) === 0 ? 0 : 1) : get().pointPromptLabel;
    set((state) => ({
      currentPrompts: [...state.currentPrompts, { type, data: promptData, label: pointLabel }],
      promptRedoStack: [],
    }));
  },

  undoPrompt: () => set((state) => {
    if (!state.editable) return state;
    const prompt = state.currentPrompts[state.currentPrompts.length - 1];
    if (!prompt) return state;
    return {
      currentPrompts: state.currentPrompts.slice(0, -1),
      promptRedoStack: [...state.promptRedoStack, prompt],
    };
  }),

  redoPrompt: () => set((state) => {
    if (!state.editable) return state;
    const prompt = state.promptRedoStack[state.promptRedoStack.length - 1];
    if (!prompt) return state;
    return {
      currentPrompts: [...state.currentPrompts, prompt],
      promptRedoStack: state.promptRedoStack.slice(0, -1),
    };
  }),

  clearPrompts: () => set({ currentPrompts: [], promptRedoStack: [] }),

  setFocusedAnnotation: (id) => set({
    focusedAnnotationId: id || null,
    highlightedAnnotationIds: [],
  }),

  setHighlightedAnnotations: (ids) => set({
    focusedAnnotationId: null,
    highlightedAnnotationIds: Array.from(new Set(ids.map(String).filter(Boolean))),
  }),

  setShowMasks: (show) => set({ showMasks: Boolean(show) }),

  registerCommitPolygonGuard: (guard) => set({ commitPolygonGuard: guard }),

  commitPendingManualPolygon: () => {
    const guard = get().commitPolygonGuard;
    return guard ? guard() : true;
  },

  reset: () =>
    set({
      editable: true,
      promptMode: 'none',
      pointPromptLabel: 1,
      currentPrompts: [],
      promptRedoStack: [],
      focusedAnnotationId: null,
      highlightedAnnotationIds: [],
      showMasks: true,
      commitPolygonGuard: null,
    }),
}));

/** Selector helper: annotations visible under the single-select source filter. */
export function filterAnnotationsBySource(annotations: Annotation[], sourceFilter: SourceFilter): Annotation[] {
  return (annotations || []).filter((annotation) => annotationSource(annotation) === sourceFilter);
}
