import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getImages, getUnlabeledImage, deleteImage as deleteImageApi } from '../api/images';
import * as bundleCache from '../api/bundleCache';
import { toast } from '../utils/notify';
import { useProjectStore, type ImageFilterStatus } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useSettingsStore } from '../stores/settingsStore';

function sanitizeOffset(offset: number, total: number, limit: number): number {
  let next = Math.max(0, Math.floor(offset));
  if (total > 0 && next >= total) {
    next = Math.max(0, Math.floor((total - 1) / limit) * limit);
  }
  return next;
}

/**
 * Image list + navigation orchestration — 1:1 port of the legacy
 * ImageNavigationController: race-protected loadImages, filter application,
 * arrow-key pagination across pages, unlabeled-only navigation, and image
 * deletion with selection fixups.
 */
export function useImageNavigation() {
  const { t } = useTranslation();

  const loadImages = useCallback(async (): Promise<void> => {
    const project = useProjectStore.getState();
    const projectId = project.projectId;
    if (!projectId) return;
    const seq = project.bumpImageListLoadSeq();
    const offset = sanitizeOffset(project.offset, project.totalImages, project.limit);
    if (offset !== project.offset) project.setOffset(offset);

    try {
      const resp = await getImages(projectId, offset, project.limit, {
        status: project.imageFilterStatus === 'all' ? undefined : project.imageFilterStatus,
        className: project.imageFilterClass || undefined,
        sourceModel: project.imageFilterClass
          ? (useSettingsStore.getState().defaultBackend || 'sam3')
          : undefined,
        imageId: useImageStore.getState().selectedImageId || '',
      });
      const current = useProjectStore.getState();
      if (seq !== current.imageListLoadSeq) return; // stale response
      current.setImages(resp?.items || [], Number(resp?.total || 0));
    } catch (err) {
      console.warn('load images failed', err);
    }
  }, []);

  const goToPage = useCallback(
    async (page: number) => {
      const project = useProjectStore.getState();
      const totalPages = Math.max(1, Math.ceil(project.totalImages / project.limit));
      const target = Math.min(Math.max(1, page), totalPages);
      const offset = (target - 1) * project.limit;
      if (offset === project.offset) return;
      project.setOffset(offset);
      await loadImages();
    },
    [loadImages],
  );

  const applyFilters = useCallback(
    async (className: string, status: ImageFilterStatus) => {
      const project = useProjectStore.getState();
      project.setImageFilter(className, status);
      project.setOffset(0);
      await loadImages();
      // If the selected image is no longer in the filtered list, select the
      // first visible image (legacy behavior).
      const { images } = useProjectStore.getState();
      const selectedId = useImageStore.getState().selectedImageId;
      if (selectedId && !images.some((img) => String(img.id) === String(selectedId))) {
        if (images.length) {
          void useImageStore.getState().selectImage(String(images[0].id));
        } else {
          useImageStore.getState().clearSelection();
        }
      }
    },
    [loadImages],
  );

  const navigateUnlabeled = useCallback(
    async (delta: number) => {
      const project = useProjectStore.getState();
      const projectId = project.projectId;
      const imageStore = useImageStore.getState();
      if (!projectId) return;
      try {
        const resp = await getUnlabeledImage(
          projectId,
          imageStore.selectedImageId || '',
          delta < 0 ? 'prev' : 'next',
        );
        const image = resp?.image;
        if (!image) {
          toast(t('no_unlabeled_images'), 'info');
          return;
        }
        const imageIndex = Number(resp?.image_index ?? -1);
        if (imageIndex >= 0) {
          const offset = Math.floor(imageIndex / project.limit) * project.limit;
          if (offset !== project.offset) {
            project.setOffset(offset);
            await loadImages();
          }
        }
        await useImageStore.getState().selectImage(String(image.id));
      } catch (err) {
        console.warn('navigate unlabeled failed', err);
      }
    },
    [loadImages, t],
  );

  const navigate = useCallback(
    async (delta: number) => {
      const layout = useLayoutStore.getState();
      if (layout.unlabeledNavigationEnabled) {
        await navigateUnlabeled(delta);
        return;
      }
      const project = useProjectStore.getState();
      const images = project.images;
      const selectedId = useImageStore.getState().selectedImageId;
      const index = images.findIndex((img) => String(img.id) === String(selectedId));
      const nextIndex = index + delta;

      if (index >= 0 && nextIndex >= 0 && nextIndex < images.length) {
        const target = images[nextIndex];
        await useImageStore.getState().selectImage(String(target.id));
        setTimeout(() => {
          document
            .querySelector(`[data-image-item="${String(target.id)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        }, 50);
        return;
      }
      if (nextIndex < 0 && project.offset >= project.limit) {
        project.setOffset(project.offset - project.limit);
        await loadImages();
        const fresh = useProjectStore.getState().images;
        if (fresh.length) {
          void useImageStore.getState().selectImage(String(fresh[fresh.length - 1].id));
        }
        return;
      }
      if (nextIndex >= images.length && project.offset + project.limit < project.totalImages) {
        project.setOffset(project.offset + project.limit);
        await loadImages();
        const fresh = useProjectStore.getState().images;
        if (fresh.length) {
          void useImageStore.getState().selectImage(String(fresh[0].id));
        }
      }
    },
    [loadImages, navigateUnlabeled],
  );

  const toggleUnlabeledNavigation = useCallback(() => {
    const layout = useLayoutStore.getState();
    layout.toggleUnlabeledNavigation();
    const enabled = useLayoutStore.getState().unlabeledNavigationEnabled;
    toast(t(enabled ? 'unlabeled_nav_enabled_msg' : 'unlabeled_nav_disabled_msg'), 'info');
  }, [t]);

  const deleteProjectImage = useCallback(
    async (imageId: string) => {
      const project = useProjectStore.getState();
      const projectId = project.projectId;
      if (!projectId || !imageId) return;
      const imageStore = useImageStore.getState();
      const annotationStore = useAnnotationStore.getState();
      const targetIndex = project.images.findIndex((img) => String(img.id) === String(imageId));
      const target = project.images[targetIndex];
      const path = String(target?.rel_path || imageId);
      if (!window.confirm(t('confirm_delete_image', { path }))) return;

      const deletingSelected = String(imageStore.selectedImageId) === String(imageId);
      if (deletingSelected && annotationStore.saving) {
        toast(t('image_saving_wait'), 'warning');
        return;
      }
      if (deletingSelected) {
        // Detach the selection before deletion (legacy inline reset).
        imageStore.clearSelection();
        const ann = useAnnotationStore.getState();
        ann.clearSaveTimer();
        useAnnotationStore.setState({ dirty: false, saveImageId: '' });
      }

      try {
        await deleteImageApi(projectId, imageId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(t('image_delete_failed', { error: message }), 'error');
        return;
      }
      bundleCache.invalidateBundle(projectId, imageId);
      await project.loadProjectInfo();
      await loadImages();

      const after = useProjectStore.getState();
      if (after.images.length === 0 && after.totalImages > 0 && after.offset > 0) {
        after.setOffset(Math.max(0, after.offset - after.limit));
        await loadImages();
      }
      const list = useProjectStore.getState().images;
      if (list.length) {
        const clamped = Math.min(Math.max(targetIndex, 0), list.length - 1);
        void useImageStore.getState().selectImage(String(list[clamped].id));
      } else {
        useImageStore.getState().clearSelection();
      }
      toast(t('image_deleted', { path }), 'success');
    },
    [loadImages, t],
  );

  return {
    loadImages,
    goToPage,
    applyFilters,
    navigate,
    navigateUnlabeled,
    toggleUnlabeledNavigation,
    deleteProjectImage,
  };
}
