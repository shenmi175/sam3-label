import { useEffect } from 'react';
import { useSmartFilterStore } from '../stores/workspace/smartFilterStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useImageNavigation } from './useImageNavigation';

/**
 * Smart filter job side effects — complements smartFilterStore the same way
 * useJobPolling complements inferenceStore:
 *   - on mount: restore runs/latest for the rollback panel, stop polling on
 *     unmount (legacy closeModal cleared the timer);
 *   - after an apply job finishes (legacy pollFilterJob done branch):
 *     reload project info; delete_unlabeled → reload the image list and fix
 *     the selection (keep it when still visible, else first image, else
 *     clear); other modes → reload the selected image bundle;
 *   - after a rollback: reload project info + selected image.
 * The bundle cache itself is cleared inside the store (legacy
 * ws.clearImageBundleCache()).
 */
export function useSmartFilterJob(projectId: string) {
  const { loadImages } = useImageNavigation();
  const applyCompletedSeq = useSmartFilterStore((s) => s.applyCompletedSeq);
  const rollbackCompletedSeq = useSmartFilterStore((s) => s.rollbackCompletedSeq);
  const lastAppliedMode = useSmartFilterStore((s) => s.lastAppliedMode);

  useEffect(() => {
    if (!projectId) return undefined;
    useSmartFilterStore.getState().setProjectId(projectId);
    void useSmartFilterStore.getState().loadLatestRun();
    return () => {
      useSmartFilterStore.getState().stopPolling();
    };
  }, [projectId]);

  // Post-apply workspace refresh.
  useEffect(() => {
    if (!applyCompletedSeq) return undefined;
    let cancelled = false;
    void (async () => {
      await useProjectStore.getState().loadProjectInfo();
      if (cancelled) return;
      if (lastAppliedMode === 'delete_unlabeled') {
        await loadImages();
        if (cancelled) return;
        const images = useProjectStore.getState().images;
        const selectedId = useImageStore.getState().selectedImageId;
        const stillVisible = images.some((img) => String(img.id) === String(selectedId));
        if (stillVisible && selectedId) {
          await useImageStore.getState().selectImage(selectedId);
        } else if (images.length > 0) {
          await useImageStore.getState().selectImage(String(images[0].id));
        } else {
          useImageStore.getState().clearSelection();
        }
        return;
      }
      if (useImageStore.getState().selectedImageId) {
        await useImageStore.getState().reloadSelectedImage();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyCompletedSeq, lastAppliedMode, loadImages]);

  // Post-rollback refresh (legacy rollback button handler).
  useEffect(() => {
    if (!rollbackCompletedSeq) return undefined;
    let cancelled = false;
    void (async () => {
      await useProjectStore.getState().loadProjectInfo();
      if (cancelled) return;
      if (useImageStore.getState().selectedImageId) {
        await useImageStore.getState().reloadSelectedImage();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rollbackCompletedSeq]);
}
