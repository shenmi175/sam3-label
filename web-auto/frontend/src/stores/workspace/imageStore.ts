import { create } from 'zustand';
import type { ImageBundle, PreviewInfo, TileInfo } from '../../api/types';
import * as bundleCache from '../../api/bundleCache';
import { loadImageBundle, prefetchNeighbors } from '../../hooks/useImageBundle';
import { toast } from '../../utils/notify';
import i18n from '../../i18n';
import { useProjectStore } from './projectStore';
import { useAnnotationStore } from './annotationStore';
import { useViewerStore } from './viewerStore';

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Selected-image state + bundle load orchestration — replaces the legacy
 * `selectImage` / `commitImageBundle` flow on the God Object:
 *   - commitPendingManualPolygon guard
 *   - flush dirty annotations before switching (blocks the switch on failure)
 *   - imageLoadSeq + AbortController race protection
 *   - cache-first bundle load, then viewer/annotation commit + prefetch
 */
interface ImageStore {
  selectedImageId: string;
  selectedImagePath: string;
  /** Monotonic counter guarding against stale bundle loads. */
  imageLoadSeq: number;
  isLoading: boolean;
  /** Committed viewer inputs for the selected image. */
  previewInfo: PreviewInfo | null;
  tileInfo: TileInfo | null;
  abortController: AbortController | null;

  selectImage: (imageId: string) => Promise<boolean>;
  commitImageBundle: (bundle: ImageBundle) => void;
  /** Re-select the current image after a cache invalidation (no guard/flush). */
  reloadSelectedImage: () => Promise<boolean>;
  clearSelection: () => void;
  reset: () => void;
}

export const useImageStore = create<ImageStore>((set, get) => ({
  selectedImageId: '',
  selectedImagePath: '',
  imageLoadSeq: 0,
  isLoading: false,
  previewInfo: null,
  tileInfo: null,
  abortController: null,

  selectImage: async (imageId) => {
    if (!imageId) return false;
    const viewer = useViewerStore.getState();
    if (!viewer.commitPendingManualPolygon()) return false;

    const annotationStore = useAnnotationStore.getState();
    if (!(await annotationStore.prepareForNavigation())) {
      if (useAnnotationStore.getState().dirty) toast(i18n.t('anns_not_saved_switch'), 'warning');
      return false;
    }

    const seq = get().imageLoadSeq + 1;
    get().abortController?.abort();
    const controller = new AbortController();
    set({
      imageLoadSeq: seq,
      abortController: controller,
      selectedImageId: imageId,
      isLoading: true,
    });
    viewer.clearPrompts();

    const projectId = useProjectStore.getState().projectId;

    // Fast path: fully-loaded cached bundle.
    const cached = bundleCache.getCachedBundle(projectId, imageId);
    if (bundleCache.bundleSatisfies(cached, { annotations: true, preview: true })) {
      if (seq !== get().imageLoadSeq || get().selectedImageId !== imageId) return false;
      get().commitImageBundle(cached as ImageBundle);
      set({ isLoading: false });
      void prefetchNeighbors(projectId, imageId);
      return true;
    }

    try {
      const bundle = await loadImageBundle(projectId, imageId, {
        signal: controller.signal,
        includeAnnotations: true,
        includePreview: true,
      });
      if (seq !== get().imageLoadSeq || get().selectedImageId !== imageId) return false;
      if (!bundle) return false;
      get().commitImageBundle(bundle);
      void prefetchNeighbors(projectId, imageId);
      return true;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return false;
      console.warn('load image bundle failed', err);
      return false;
    } finally {
      if (seq === get().imageLoadSeq) set({ isLoading: false });
    }
  },

  commitImageBundle: (bundle) => {
    useAnnotationStore.getState().resetForImage(bundle.id, bundle.annotations || []);
    const viewer = useViewerStore.getState();
    viewer.clearPrompts();
    set({
      selectedImageId: bundle.id,
      selectedImagePath: bundle.relPath || '',
      previewInfo: bundle.previewInfo || null,
      tileInfo: bundle.tileInfo || null,
    });
  },

  reloadSelectedImage: async () => {
    const { selectedImageId } = get();
    if (!selectedImageId) return false;
    const projectId = useProjectStore.getState().projectId;
    bundleCache.invalidateBundle(projectId, selectedImageId);

    const seq = get().imageLoadSeq + 1;
    get().abortController?.abort();
    const controller = new AbortController();
    set({ imageLoadSeq: seq, abortController: controller, isLoading: true });
    useViewerStore.getState().clearPrompts();

    try {
      const bundle = await loadImageBundle(projectId, selectedImageId, {
        signal: controller.signal,
        includeAnnotations: true,
        includePreview: true,
        forceRefresh: true,
      });
      if (seq !== get().imageLoadSeq || get().selectedImageId !== selectedImageId) return false;
      if (!bundle) return false;
      get().commitImageBundle(bundle);
      return true;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return false;
      console.warn('reload image bundle failed', err);
      return false;
    } finally {
      if (seq === get().imageLoadSeq) set({ isLoading: false });
    }
  },

  clearSelection: () => {
    get().abortController?.abort();
    set({
      selectedImageId: '',
      selectedImagePath: '',
      isLoading: false,
      previewInfo: null,
      tileInfo: null,
      abortController: null,
    });
    useAnnotationStore.getState().resetEmptySelection();
    useViewerStore.getState().clearPrompts();
  },

  reset: () => {
    get().abortController?.abort();
    set({
      selectedImageId: '',
      selectedImagePath: '',
      imageLoadSeq: 0,
      isLoading: false,
      previewInfo: null,
      tileInfo: null,
      abortController: null,
    });
  },
}));
