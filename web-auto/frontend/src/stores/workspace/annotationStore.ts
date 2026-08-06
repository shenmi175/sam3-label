import { create } from 'zustand';
import { saveAnnotations as saveAnnotationsApi } from '../../api/annotations';
import * as bundleCache from '../../api/bundleCache';
import type { Annotation } from '../../api/types';
import { bboxFromPolygon } from '../../utils/geometry';
import { toast } from '../../utils/notify';
import i18n from '../../i18n';
import { useProjectStore } from './projectStore';
import { useViewerStore, type SourceFilter } from './viewerStore';

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTOSAVE_DELAY_MS = 700;
export const HISTORY_LIMIT = 50;

export type SaveStatus = 'saved' | 'unsaved' | 'pending' | 'saving' | 'failed';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function cloneAnnotations(annotations: Annotation[] | undefined | null): Annotation[] {
  try {
    return JSON.parse(JSON.stringify(Array.isArray(annotations) ? annotations : [])) as Annotation[];
  } catch {
    return [];
  }
}

function makeAnnotationId(): string {
  return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Legacy markManualAnnotation — flags an annotation as manually edited. */
export function markManualAnnotation(ann: Annotation): Annotation {
  if (!ann || typeof ann !== 'object') return ann;
  const now = new Date().toISOString();
  const next: Annotation = { ...ann, edited: true, updated_at: now };
  if (!next.source) next.source = 'manual';
  else if (next.source !== 'manual') next.modified_by = 'manual';
  if (!next.score) next.score = 1;
  return next;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Annotation editing state machine — 1:1 port of the legacy
 * AnnotationController (annotation-controller.js): undo/redo history capped at
 * 50 snapshots with JSON-equality dedup, 700 ms autosave with rev-check,
 * save-target image tracking for dirty-while-switching saves.
 *
 * Components should subscribe to canUndo/canRedo selectors only; heavy lists
 * stay here.
 */
interface AnnotationStore {
  /** Image the current annotation list belongs to. */
  imageId: string;
  annotations: Annotation[];
  dirty: boolean;
  saving: boolean;
  rev: number;
  autosaveEnabled: boolean;
  sourceFilter: SourceFilter;
  history: Annotation[][];
  redoStack: Annotation[][];
  saveImageId: string;
  saveStatus: SaveStatus;
  unmounted: boolean;

  resetForImage: (imageId: string, annotations: Annotation[]) => void;
  resetEmptySelection: () => void;
  setAutosaveEnabled: (enabled: boolean) => void;
  /** Schedule a save now if dirty (used when autosave is toggled on). */
  triggerAutosave: () => void;
  setSourceFilter: (source: SourceFilter) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  createAnnotation: (shape: { bbox?: number[]; polygon?: [number, number][] }, className: string) => void;
  handleGeometryUpdated: (annotationId: string, geometry: Partial<Annotation>) => void;
  markDirty: (reason?: string) => void;
  flushSave: (reason?: string) => Promise<boolean>;
  saveCurrent: () => Promise<boolean>;
  clearAnnotations: () => void;
  deleteAnnotation: (annotationId: string) => void;
  updateClass: (annotationId: string, nextClass: string) => Promise<boolean>;
  clearSaveTimer: () => void;
  setUnmounted: (unmounted: boolean) => void;
  reset: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave(reason: string) {
  const state = useAnnotationStore.getState();
  if (!state.imageId) return;
  if (saveTimer) clearTimeout(saveTimer);
  useAnnotationStore.setState({ saveStatus: 'pending' });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useAnnotationStore.getState().flushSave(reason);
  }, AUTOSAVE_DELAY_MS);
}

export const useAnnotationStore = create<AnnotationStore>((set, get) => ({
  imageId: '',
  annotations: [],
  dirty: false,
  saving: false,
  rev: 0,
  autosaveEnabled: true,
  sourceFilter: 'sam3',
  history: [],
  redoStack: [],
  saveImageId: '',
  saveStatus: 'saved',
  unmounted: false,

  resetForImage: (imageId, annotations) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      imageId,
      annotations: Array.isArray(annotations) ? annotations : [],
      history: [],
      redoStack: [],
      dirty: false,
      saveImageId: '',
      saveStatus: 'saved',
    });
    useViewerStore.getState().setFocusedAnnotation(null);
  },

  resetEmptySelection: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      imageId: '',
      annotations: [],
      history: [],
      redoStack: [],
      dirty: false,
      saveImageId: '',
      saveStatus: 'saved',
    });
    useViewerStore.getState().setFocusedAnnotation(null);
  },

  setAutosaveEnabled: (enabled) => set({ autosaveEnabled: Boolean(enabled) }),

  triggerAutosave: () => {
    if (get().dirty) scheduleAutosave('autosave-enabled');
  },

  setSourceFilter: (source) => set({ sourceFilter: source }),

  pushHistory: () => {
    const { imageId, history, annotations } = get();
    if (!imageId) return;
    const snapshot = cloneAnnotations(annotations);
    const previous = history[history.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    const nextHistory = [...history, snapshot];
    if (nextHistory.length > HISTORY_LIMIT) nextHistory.shift();
    set({ history: nextHistory, redoStack: [] });
  },

  undo: () => {
    const { history, annotations } = get();
    if (!history.length) return;
    const redoStack = [...get().redoStack, cloneAnnotations(annotations)];
    const nextHistory = history.slice(0, -1);
    const snapshot = history[history.length - 1];
    set({ history: nextHistory, redoStack });
    restoreSnapshot(set, get, snapshot);
  },

  redo: () => {
    const { redoStack, annotations } = get();
    if (!redoStack.length) return;
    const history = [...get().history, cloneAnnotations(annotations)];
    const nextRedo = redoStack.slice(0, -1);
    const snapshot = redoStack[redoStack.length - 1];
    set({ history, redoStack: nextRedo });
    restoreSnapshot(set, get, snapshot);
  },

  createAnnotation: (shape, className) => {
    const { imageId, annotations } = get();
    if (!imageId) {
      toast(i18n.t('select_image_first'), 'error');
      return;
    }
    const now = new Date().toISOString();
    const polygon = Array.isArray(shape?.polygon) ? shape.polygon : null;
    const bbox = Array.isArray(shape?.bbox)
      ? shape.bbox
      : polygon
        ? bboxFromPolygon(polygon)
        : null;
    if (!bbox || bbox.length !== 4) return;

    get().pushHistory();
    const ann: Annotation = {
      id: makeAnnotationId(),
      class_name: className,
      label: className,
      bbox: bbox.map((v) => Number(v || 0)) as [number, number, number, number],
      score: 1,
      source: 'manual',
      edited: true,
      created_at: now,
      updated_at: now,
    };
    if (polygon && polygon.length >= 3) ann.polygon = polygon;

    const next = [...(annotations || []), ann];
    set({ annotations: next });
    const viewer = useViewerStore.getState();
    viewer.setFocusedAnnotation(ann.id);
    viewer.setPromptMode('none');
    bundleCache.updateBundleAnnotations(
      useProjectStore.getState().projectId,
      imageId,
      '',
      next,
    );
    get().markDirty('create');
  },

  handleGeometryUpdated: (annotationId, geometry) => {
    const { annotations, imageId } = get();
    if (!annotationId) return;
    const next = annotations.map((ann) => {
      if (String(ann?.id || '') !== String(annotationId)) return ann;
      return markManualAnnotation({ ...ann, ...geometry });
    });
    set({ annotations: next });
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', next);
    get().markDirty('geometry');
  },

  markDirty: () => {
    const state = get();
    const rev = state.rev + 1;
    set({
      dirty: true,
      rev,
      saveImageId: state.imageId || '',
    });
    bundleCache.updateBundleAnnotations(
      useProjectStore.getState().projectId,
      state.imageId,
      '',
      state.annotations,
    );
    useProjectStore.getState().setImageLabeled(state.imageId, (state.annotations || []).length > 0);
    if (state.autosaveEnabled) {
      scheduleAutosave('');
    } else {
      set({ saveStatus: 'unsaved' });
    }
  },

  flushSave: async () => {
    const viewer = useViewerStore.getState();
    if (!viewer.commitPendingManualPolygon()) return false;
    const state = get();
    if (!state.imageId || state.saving || !state.dirty) return !state.dirty;
    const projectId = useProjectStore.getState().projectId;
    const imageId = state.saveImageId || state.imageId;
    if (!imageId) return false;
    const cached = bundleCache.getCachedBundle(projectId, imageId);
    const annotations =
      String(imageId) === String(state.imageId)
        ? cloneAnnotations(state.annotations)
        : cloneAnnotations(cached?.annotations || []);
    const rev = state.rev;
    try {
      set({ saving: true, saveStatus: 'saving' });
      const classNames = Array.from(
        new Set(
          annotations
            .map((a) => String(a?.class_name || '').trim())
            .filter(Boolean),
        ),
      );
      await useProjectStore.getState().ensureClasses(classNames);
      await saveAnnotationsApi(projectId, imageId, annotations);
      if (get().unmounted) return true;
      if (String(get().imageId) === String(imageId)) {
        bundleCache.updateBundleAnnotations(projectId, imageId, '', annotations);
        useProjectStore.getState().setImageLabeled(imageId, annotations.length > 0);
        if (get().rev === rev) {
          set({ dirty: false, saveImageId: '', saveStatus: 'saved' });
        } else {
          scheduleAutosave('dirty-during-save');
        }
      }
    } catch (err) {
      set({ saveStatus: 'failed' });
      const message = err instanceof Error ? err.message : String(err);
      toast(i18n.t('save_failed_msg', { error: message }), 'error');
    } finally {
      set({ saving: false });
    }
    return !get().dirty;
  },

  saveCurrent: async () => {
    const state = get();
    if (!state.imageId) return false;
    const viewer = useViewerStore.getState();
    if (!viewer.commitPendingManualPolygon()) return false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ dirty: true, saveImageId: state.imageId, rev: state.rev + 1 });
    await get().flushSave('manual-save');
    return !get().dirty;
  },

  clearAnnotations: () => {
    const { imageId } = get();
    if (!imageId) return;
    get().pushHistory();
    set({ annotations: [] });
    useViewerStore.getState().setFocusedAnnotation(null);
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', []);
    get().markDirty('clear');
  },

  deleteAnnotation: (annotationId) => {
    const { imageId, annotations } = get();
    if (!imageId) return;
    get().pushHistory();
    const next = annotations.filter((ann) => String(ann?.id || '') !== String(annotationId || ''));
    set({ annotations: next });
    const viewer = useViewerStore.getState();
    if (String(viewer.focusedAnnotationId || '') === String(annotationId || '')) {
      viewer.setFocusedAnnotation(null);
    }
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', next);
    get().markDirty('delete');
  },

  updateClass: async (annotationId, nextClass) => {
    const { imageId, annotations } = get();
    if (!imageId) return false;
    const cleanClass = String(nextClass || '').trim();
    if (!cleanClass) {
      toast(i18n.t('class_name_empty'), 'error');
      return false;
    }
    const annIndex = annotations.findIndex((item) => String(item?.id || '') === String(annotationId || ''));
    if (annIndex < 0) {
      toast(i18n.t('ann_not_found'), 'error');
      return false;
    }
    const currentClass = String(annotations[annIndex]?.class_name || '').trim();
    if (currentClass === cleanClass) {
      toast(i18n.t('class_unchanged'), 'info');
      return true;
    }
    try {
      const projectStore = useProjectStore.getState();
      await projectStore.ensureClasses([cleanClass]);
      get().pushHistory();
      const next = annotations.map((ann) => {
        if (String(ann?.id || '') !== String(annotationId || '')) return ann;
        const updated = markManualAnnotation({ ...ann, class_name: cleanClass, label: cleanClass });
        delete updated.color;
        return updated;
      });
      set({ annotations: next });
      bundleCache.updateBundleAnnotations(projectStore.projectId, imageId, '', next);
      useProjectStore.getState().setSelectedClass(cleanClass);
      get().markDirty('class');
      toast(i18n.t('ann_class_changed', { name: cleanClass }), 'success');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(message, 'error');
      return false;
    }
  },

  clearSaveTimer: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  },

  setUnmounted: (unmounted) => set({ unmounted: Boolean(unmounted) }),

  reset: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      imageId: '',
      annotations: [],
      dirty: false,
      saving: false,
      rev: 0,
      autosaveEnabled: true,
      sourceFilter: 'sam3',
      history: [],
      redoStack: [],
      saveImageId: '',
      saveStatus: 'saved',
      unmounted: false,
    });
  },
}));

/** Apply an undo/redo snapshot (legacy restoreSnapshot). */
function restoreSnapshot(
  set: (partial: Partial<AnnotationStore>) => void,
  get: () => AnnotationStore,
  snapshot: Annotation[],
) {
  const restored = cloneAnnotations(snapshot);
  set({ annotations: restored });
  const viewer = useViewerStore.getState();
  if (
    viewer.focusedAnnotationId &&
    !restored.some((ann) => String(ann?.id || '') === String(viewer.focusedAnnotationId))
  ) {
    viewer.setFocusedAnnotation(null);
  }
  get().markDirty('history');
}

// ─── Selectors (components subscribe to these only) ───────────────────────────

export const selectCanUndo = (state: AnnotationStore) => state.history.length > 0;
export const selectCanRedo = (state: AnnotationStore) => state.redoStack.length > 0;
