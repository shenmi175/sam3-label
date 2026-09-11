import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { useImageNavigation } from './useImageNavigation';
import { toast } from '../utils/notify';

/**
 * Review-mode flow — 1:1 port of the legacy ReviewController:
 *   - continuous mode toggle (layoutStore.reviewContinuousMode, persisted via
 *     useUiStateSync like the legacy scheduleProjectUIStateSave)
 *   - apply the current class to the focused annotation (改类别)
 *   - delete the focused annotation (驳回 current annotation)
 *   - saveAndNavigate: accept flow — flush/save first, block navigation while
 *     dirty, then move to the next image (连续审图 auto-next uses the same
 *     path through useImageNavigation.navigate)
 *   - jump to the next unlabeled image
 */
export function useReviewFlow() {
  const { t } = useTranslation();
  const { navigate, navigateUnlabeled } = useImageNavigation();

  const toggleContinuousMode = useCallback(() => {
    useLayoutStore.getState().toggleReviewContinuousMode();
  }, []);

  const applyClassToFocused = useCallback(async () => {
    const focused = useViewerStore.getState().focusedAnnotationId;
    if (!focused) {
      toast(t('select_annotation_first'), 'info');
      return;
    }
    const project = useProjectStore.getState();
    const nextClass = project.selectedClass || project.classes[0] || '';
    if (!nextClass) {
      toast(t('review_no_class'), 'error');
      return;
    }
    await useAnnotationStore.getState().updateClass(focused, nextClass);
  }, [t]);

  const deleteFocusedAnnotation = useCallback(() => {
    const focused = useViewerStore.getState().focusedAnnotationId;
    if (!focused) {
      toast(t('select_annotation_first'), 'info');
      return;
    }
    useAnnotationStore.getState().deleteAnnotation(focused);
  }, [t]);

  /** Legacy ReviewController.saveAndNavigate (accept + auto next). */
  const saveAndNavigate = useCallback(
    async (delta = 1) => {
      const selectedImageId = useImageStore.getState().selectedImageId;
      if (!selectedImageId) {
        toast(t('select_image_first'), 'error');
        return;
      }
      try {
        const ready = await useAnnotationStore.getState().prepareForNavigation();
        if (!ready || useAnnotationStore.getState().dirty) {
          toast(t('review_unsaved_block'), 'error');
          return;
        }
        await navigate(delta);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [navigate, t],
  );

  const nextUnlabeled = useCallback(async () => {
    await navigateUnlabeled(1);
  }, [navigateUnlabeled]);

  return {
    toggleContinuousMode,
    applyClassToFocused,
    deleteFocusedAnnotation,
    saveAndNavigate,
    nextUnlabeled,
  };
}
