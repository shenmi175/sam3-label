import { create } from 'zustand';
import { getProject, type ProjectInfo } from '../../api/projects';
import * as classesApi from '../../api/classes';
import type { ImageInfo } from '../../api/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImageFilterStatus = 'all' | 'labeled' | 'unlabeled';

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Project-level workspace state — mirrors the project/image-list/class fields
 * on the legacy God Object:
 *   projectId, projectMeta, classes, selectedClass, classInferenceChecked,
 *   images, totalImages, offset, limit, imageFilterClass, imageFilterStatus,
 *   imageListLoadSeq.
 *
 * List loading orchestration (sanitize offset, race protection, pagination)
 * lives in useImageNavigation; this store holds data + simple mutations.
 */
interface ProjectStore {
  projectId: string;
  projectMeta: ProjectInfo | null;
  classes: string[];
  selectedClass: string;
  /** Classes checked for inference (legacy cls-chk-infer checkboxes). */
  inferenceCheckedClasses: Set<string>;

  images: ImageInfo[];
  totalImages: number;
  offset: number;
  limit: number;
  imageFilterClass: string;
  imageFilterStatus: ImageFilterStatus;
  /** Monotonic counter guarding against stale image list responses. */
  imageListLoadSeq: number;

  setProjectId: (projectId: string) => void;
  loadProjectInfo: () => Promise<void>;
  setClasses: (classes: string[]) => void;
  addClass: (classesText: string) => Promise<boolean>;
  deleteClass: (className: string) => Promise<boolean>;
  /** Add any missing classes to the project (legacy ensureAnnotationClasses). */
  ensureClasses: (classNames: string[]) => Promise<void>;
  migrateSources: () => Promise<void>;
  setSelectedClass: (className: string) => void;
  toggleInferenceClass: (className: string, checked: boolean) => void;
  setAllInferenceClasses: (checked: boolean) => void;
  getSelectedClassesForInference: () => string[];

  setImages: (images: ImageInfo[], total: number) => void;
  setOffset: (offset: number) => void;
  setLimit: (limit: number) => void;
  setImageFilter: (className: string, status: ImageFilterStatus) => void;
  bumpImageListLoadSeq: () => number;
  /** Update one image item's labeled state + projectMeta.labeled_images count. */
  setImageLabeled: (imageId: string, labeled: boolean) => void;
  /** Delete one image from the local list and adjust total. */
  removeImage: (imageId: string) => void;

  reset: () => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projectId: '',
  projectMeta: null,
  classes: [],
  selectedClass: '',
  inferenceCheckedClasses: new Set<string>(),

  images: [],
  totalImages: 0,
  offset: 0,
  limit: 50,
  imageFilterClass: '',
  imageFilterStatus: 'all',
  imageListLoadSeq: 0,

  setProjectId: (projectId) => set({ projectId }),

  loadProjectInfo: async () => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const resp = await getProject(projectId);
      const project = resp?.project;
      if (!project) return;
      const classes = Array.isArray((project as Record<string, unknown>).classes)
        ? ((project as Record<string, unknown>).classes as unknown[]).map((c) => String(c))
        : [];
      set((state) => ({
        projectMeta: project,
        classes,
        // Newly added classes default to checked for inference (legacy
        // re-rendered all checkboxes as checked every time).
        inferenceCheckedClasses: new Set(classes),
        selectedClass: state.selectedClass && classes.includes(state.selectedClass)
          ? state.selectedClass
          : (classes[0] || ''),
      }));
    } catch (err) {
      console.warn('load project info failed', err);
    }
  },

  setClasses: (classes) =>
    set({ classes, inferenceCheckedClasses: new Set(classes) }),

  addClass: async (classesText) => {
    const { projectId } = get();
    if (!projectId || !classesText.trim()) return false;
    try {
      await classesApi.addClass(projectId, classesText.trim());
      await get().loadProjectInfo();
      return true;
    } catch (err) {
      console.warn('add class failed', err);
      return false;
    }
  },

  deleteClass: async (className) => {
    const { projectId } = get();
    if (!projectId || !className) return false;
    try {
      await classesApi.deleteClass(projectId, className);
      if (get().selectedClass === className) {
        set({ selectedClass: '' });
      }
      await get().loadProjectInfo();
      return true;
    } catch (err) {
      console.warn('delete class failed', err);
      return false;
    }
  },

  ensureClasses: async (classNames) => {
    const missing = classNames.filter(
      (name) => name && !get().classes.includes(name),
    );
    if (!missing.length) return;
    await get().addClass(missing.join('\n'));
  },

  migrateSources: async () => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      await classesApi.migrateSources(projectId);
    } catch (err) {
      console.warn('migrate sources failed', err);
    }
  },

  setSelectedClass: (className) => set({ selectedClass: className }),

  toggleInferenceClass: (className, checked) =>
    set((state) => {
      const next = new Set(state.inferenceCheckedClasses);
      if (checked) next.add(className);
      else next.delete(className);
      return { inferenceCheckedClasses: next };
    }),

  setAllInferenceClasses: (checked) =>
    set((state) => ({
      inferenceCheckedClasses: checked ? new Set(state.classes) : new Set<string>(),
    })),

  getSelectedClassesForInference: () => {
    const { classes, inferenceCheckedClasses } = get();
    const checked = classes.filter((c) => inferenceCheckedClasses.has(c));
    return checked.length ? checked : classes;
  },

  setImages: (images, total) => set({ images, totalImages: total }),

  setOffset: (offset) => set({ offset }),

  setLimit: (limit) => set({ limit }),

  setImageFilter: (className, status) =>
    set({ imageFilterClass: className, imageFilterStatus: status }),

  bumpImageListLoadSeq: () => {
    const seq = get().imageListLoadSeq + 1;
    set({ imageListLoadSeq: seq });
    return seq;
  },

  setImageLabeled: (imageId, labeled) =>
    set((state) => {
      const changed = state.images.some(
        (img) => img.id === imageId && Boolean(img.status === 'labeled') !== labeled,
      );
      const images = state.images.map((img) =>
        img.id === imageId ? { ...img, status: labeled ? 'labeled' : 'unlabeled' } : img,
      );
      const meta = state.projectMeta;
      let projectMeta = meta;
      if (changed && meta) {
        const labeledCount = Number(meta.labeled_images || 0);
        projectMeta = {
          ...meta,
          labeled_images: labeled ? labeledCount + 1 : Math.max(0, labeledCount - 1),
        };
      }
      return { images, projectMeta };
    }),

  removeImage: (imageId) =>
    set((state) => ({
      images: state.images.filter((img) => img.id !== imageId),
      totalImages: Math.max(0, state.totalImages - 1),
    })),

  reset: () =>
    set({
      projectId: '',
      projectMeta: null,
      classes: [],
      selectedClass: '',
      inferenceCheckedClasses: new Set<string>(),
      images: [],
      totalImages: 0,
      offset: 0,
      limit: 50,
      imageFilterClass: '',
      imageFilterStatus: 'all',
      imageListLoadSeq: 0,
    }),
}));
