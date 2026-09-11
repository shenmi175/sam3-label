import { create } from 'zustand';
import { saveAnnotations as saveAnnotationsApi } from '../../api/annotations';
import * as bundleCache from '../../api/bundleCache';
import type { Annotation } from '../../api/types';
import type { AiCandidate } from '../../api/ai';
import { bboxFromPolygon } from '../../utils/geometry';
import { toast } from '../../utils/notify';
import i18n from '../../i18n';
import { useProjectStore } from './projectStore';
import { useViewerStore, type SourceFilter } from './viewerStore';
import { requestNavigationDecision } from './navigationGuardStore';

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTOSAVE_DELAY_MS = 0;
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

/** Mark a human edit without changing the annotation's result layer. */
export function markManualAnnotation(ann: Annotation): Annotation {
  if (!ann || typeof ann !== 'object') return ann;
  const now = new Date().toISOString();
  const next: Annotation = { ...ann, edited: true, modified_by: 'manual', updated_at: now };
  const producer = String(next.source_model || next.source || '').trim();
  next.source_model = !producer || producer === 'manual' ? 'sam3' : producer;
  delete next.source;
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
  editingEnabled: boolean;
  /** Image the current annotation list belongs to. */
  imageId: string;
  annotations: Annotation[];
  savedAnnotations: Annotation[];
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

  setEditingEnabled: (enabled: boolean) => void;
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
  prepareForNavigation: () => Promise<boolean>;
  discardChanges: () => void;
  clearAnnotations: () => void;
  deleteAnnotation: (annotationId: string) => void;
  updateClass: (annotationId: string, nextClass: string) => Promise<boolean>;
  acceptAiCandidate: (candidate: AiCandidate, selectedAnnotationId: string, className: string) => void;
  clearSaveTimer: () => void;
  setUnmounted: (unmounted: boolean) => void;
  reset: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveTail: Promise<boolean> = Promise.resolve(true);
let saveBlocked = false;
let lastQueuedKey = '';
let queuedSaves = 0;

function enqueueSnapshot(reason: string, force = false): Promise<boolean> {
  const state = useAnnotationStore.getState();
  const projectId = useProjectStore.getState().projectId;
  if (!state.imageId || !projectId) return Promise.resolve(false);
  const imageId = state.imageId;
  const rev = state.rev;
  const key = `${projectId}:${imageId}:${rev}`;
  if (!force && key === lastQueuedKey) return saveTail;
  if (force) saveBlocked = false;
  if (saveBlocked && !force) return Promise.resolve(false);
  lastQueuedKey = key;
  queuedSaves += 1;
  const annotations = cloneAnnotations(state.annotations);
  useAnnotationStore.setState({ saveStatus: 'pending', saveImageId: imageId });
  saveTail = saveTail.then(async (previousOk) => {
    if ((!previousOk || saveBlocked) && !force) {
      queuedSaves = Math.max(0, queuedSaves - 1);
      return false;
    }
    try {
      useAnnotationStore.setState({ saving: true, saveStatus: 'saving' });
      const classNames = Array.from(new Set(annotations.map((item) => String(item.class_name || '').trim()).filter(Boolean)));
      await useProjectStore.getState().ensureClasses(classNames);
      const response = await saveAnnotationsApi(projectId, imageId, annotations);
      const persisted = Array.isArray(response.saved_annotations)
        ? cloneAnnotations(response.saved_annotations as Annotation[])
        : annotations;
      queuedSaves = Math.max(0, queuedSaves - 1);
      const current = useAnnotationStore.getState();
      bundleCache.updateBundleAnnotations(projectId, imageId, '', persisted);
      useProjectStore.getState().setImageLabeled(imageId, persisted.length > 0);
      if (current.imageId === imageId && current.rev === rev && queuedSaves === 0) {
        useAnnotationStore.setState({
          annotations: cloneAnnotations(persisted),
          dirty: false,
          savedAnnotations: cloneAnnotations(persisted),
          saveImageId: '',
          saveStatus: 'saved',
        });
      } else if (current.imageId === imageId && queuedSaves > 0) {
        useAnnotationStore.setState({ saveStatus: 'pending' });
      }
      return true;
    } catch (err) {
      queuedSaves = Math.max(0, queuedSaves - 1);
      saveBlocked = true;
      useAnnotationStore.setState({ saveStatus: 'failed' });
      const message = err instanceof Error ? err.message : String(err);
      toast(i18n.t('save_failed_msg', { error: message }), 'error');
      return false;
    } finally {
      useAnnotationStore.setState({ saving: false });
      void reason;
    }
  });
  return saveTail;
}

export const useAnnotationStore = create<AnnotationStore>((set, get) => ({
  editingEnabled: true,
  imageId: '',
  annotations: [],
  savedAnnotations: [],
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

  setEditingEnabled: (enabled) => set({ editingEnabled: Boolean(enabled) }),

  resetForImage: (imageId, annotations) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveBlocked = false;
    lastQueuedKey = '';
    set({
      imageId,
      annotations: Array.isArray(annotations) ? annotations : [],
      savedAnnotations: cloneAnnotations(annotations),
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
      savedAnnotations: [],
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
    if (!get().editingEnabled) return;
    if (get().dirty) void enqueueSnapshot('autosave-enabled', true);
  },

  setSourceFilter: (source) => set({ sourceFilter: source }),

  pushHistory: () => {
    if (!get().editingEnabled) return;
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
    if (!get().editingEnabled) return;
    const { history, annotations } = get();
    if (!history.length) return;
    const redoStack = [...get().redoStack, cloneAnnotations(annotations)];
    const nextHistory = history.slice(0, -1);
    const snapshot = history[history.length - 1];
    set({ history: nextHistory, redoStack });
    restoreSnapshot(set, get, snapshot);
  },

  redo: () => {
    if (!get().editingEnabled) return;
    const { redoStack, annotations } = get();
    if (!redoStack.length) return;
    const history = [...get().history, cloneAnnotations(annotations)];
    const nextRedo = redoStack.slice(0, -1);
    const snapshot = redoStack[redoStack.length - 1];
    set({ history, redoStack: nextRedo });
    restoreSnapshot(set, get, snapshot);
  },

  createAnnotation: (shape, className) => {
    if (!get().editingEnabled) return;
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
      raw_label: className,
      schema_version: 3,
      bbox: bbox.map((v) => Number(v || 0)) as [number, number, number, number],
      polygon: polygon && polygon.length >= 3 ? polygon : [],
      polygons: polygon && polygon.length >= 3 ? [polygon] : [],
      area: null,
      mask_url: '',
      overlay_url: '',
      score: 1,
      source_model: get().sourceFilter,
      component_count: polygon && polygon.length >= 3 ? 1 : 0,
      edited: true,
      modified_by: 'manual',
      accepted_by: '',
      ai_assisted_by: '',
      created_at: now,
      updated_at: now,
    };

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
    if (!get().editingEnabled) return;
    const { annotations, imageId } = get();
    if (!annotationId) return;
    const next = annotations.map((ann) => {
      if (String(ann?.id || '') !== String(annotationId)) return ann;
      return markManualAnnotation({
        ...ann,
        ...geometry,
        mask_url: '',
        __invalidate_mask: true,
        __geometry_edited: true,
      });
    });
    set({ annotations: next });
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', next);
    get().markDirty('geometry');
  },

  markDirty: () => {
    if (!get().editingEnabled) return;
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
      void enqueueSnapshot('operation');
    } else {
      set({ saveStatus: 'unsaved' });
    }
  },

  flushSave: async () => {
    const viewer = useViewerStore.getState();
    if (!viewer.commitPendingManualPolygon()) return false;
    const state = get();
    if (!state.imageId) return false;
    if (state.dirty) await enqueueSnapshot('flush', !state.autosaveEnabled || saveBlocked);
    else await saveTail;
    return !get().dirty && get().saveStatus !== 'failed';
  },

  saveCurrent: async () => {
    if (!get().editingEnabled) return false;
    const state = get();
    if (!state.imageId) return false;
    const viewer = useViewerStore.getState();
    if (!viewer.commitPendingManualPolygon()) return false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!state.dirty) set({ dirty: true, saveImageId: state.imageId, rev: state.rev + 1 });
    await enqueueSnapshot('manual-save', true);
    return !get().dirty;
  },

  prepareForNavigation: async () => {
    const state = get();
    if (!state.dirty) {
      await saveTail;
      return get().saveStatus !== 'failed';
    }
    if (state.autosaveEnabled) return get().flushSave('before-navigation');
    const decision = await requestNavigationDecision();
    if (decision === 'cancel') return false;
    if (decision === 'discard') {
      get().discardChanges();
      return true;
    }
    return get().saveCurrent();
  },

  discardChanges: () => {
    const state = get();
    const restored = cloneAnnotations(state.savedAnnotations);
    saveBlocked = false;
    lastQueuedKey = '';
    set({
      annotations: restored,
      dirty: false,
      history: [],
      redoStack: [],
      saveImageId: '',
      saveStatus: 'saved',
      rev: state.rev + 1,
    });
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, state.imageId, '', restored);
    useProjectStore.getState().setImageLabeled(state.imageId, restored.length > 0);
    useViewerStore.getState().setFocusedAnnotation(null);
  },

  clearAnnotations: () => {
    if (!get().editingEnabled) return;
    const { imageId } = get();
    if (!imageId) return;
    get().pushHistory();
    set({ annotations: [] });
    useViewerStore.getState().setFocusedAnnotation(null);
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', []);
    get().markDirty('clear');
  },

  deleteAnnotation: (annotationId) => {
    if (!get().editingEnabled) return;
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
    if (!get().editingEnabled) return false;
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
        const updated = markManualAnnotation({ ...ann, class_name: cleanClass, raw_label: cleanClass });
        delete updated.label;
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

  acceptAiCandidate: (candidate, selectedAnnotationId, className) => {
    if (!get().editingEnabled) return;
    const { imageId, annotations } = get();
    if (!imageId || !candidate) return;
    const now = new Date().toISOString();
    get().pushHistory();
    let next: Annotation[];
    if (selectedAnnotationId) {
      next = annotations.map((annotation) => {
        if (String(annotation.id || '') !== String(selectedAnnotationId)) return annotation;
        return markManualAnnotation({
          ...annotation,
          bbox: candidate.bbox,
          polygon: candidate.polygon,
          polygons: candidate.polygons,
          area: candidate.area,
          mask_url: '',
          ai_quality_score: candidate.score,
          ai_assisted_by: 'sam3',
          __invalidate_mask: true,
          __geometry_edited: true,
        });
      });
    } else {
      const annotation: Annotation = {
        id: makeAnnotationId(),
        schema_version: 3,
        class_name: className,
        raw_label: className,
        bbox: candidate.bbox,
        polygon: candidate.polygon || [],
        polygons: candidate.polygons || (candidate.polygon ? [candidate.polygon] : []),
        area: candidate.area ?? null,
        mask_url: '',
        overlay_url: '',
        score: 1,
        ai_quality_score: candidate.score,
        source_model: 'sam3',
        accepted_by: 'manual',
        ai_assisted_by: 'sam3',
        modified_by: '',
        edited: true,
        component_count: candidate.polygons?.length || (candidate.polygon ? 1 : 0),
        created_at: now,
        updated_at: now,
      };
      next = [...annotations, annotation];
      useViewerStore.getState().setFocusedAnnotation(annotation.id);
    }
    set({ annotations: next });
    bundleCache.updateBundleAnnotations(useProjectStore.getState().projectId, imageId, '', next);
    get().markDirty('ai-accept');
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
    saveBlocked = false;
    lastQueuedKey = '';
    queuedSaves = 0;
    saveTail = Promise.resolve(true);
    set({
      editingEnabled: true,
      imageId: '',
      annotations: [],
      savedAnnotations: [],
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
