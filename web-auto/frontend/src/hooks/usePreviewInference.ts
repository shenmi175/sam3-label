import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getAnnotations, saveAnnotations } from '../api/annotations';
import * as bundleCache from '../api/bundleCache';
import type { Annotation } from '../api/types';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { toast } from '../utils/notify';

function makeAdoptedAnnotationId(): string {
  return `ann_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Preview adoption — 1:1 port of the legacy PreviewController's keepAll /
 * keepSingle / remove. Adopted previews are re-fetched against the server's
 * current annotation list, saved, then the bundle is invalidated and the
 * image reloaded (mirrors the legacy flow exactly).
 */
export function usePreviewInference() {
  const { t } = useTranslation();

  const resolveAdoptClass = useCallback((): string => {
    const project = useProjectStore.getState();
    return project.selectedClass || project.classes[0] || 'Object';
  }, []);

  const removePreview = useCallback((previewId: string) => {
    useViewerStore.getState().removePreview(previewId);
  }, []);

  const keepAll = useCallback(async () => {
    const viewer = useViewerStore.getState();
    const previews = viewer.previews;
    if (!previews.length) return;
    const projectId = useProjectStore.getState().projectId;
    const imageId = useImageStore.getState().selectedImageId;
    if (!projectId || !imageId) return;
    const className = resolveAdoptClass();
    try {
      const existing = await getAnnotations(projectId, imageId);
      const newAnns: Annotation[] = [
        ...(existing?.annotations || []),
        ...previews.map((p) => ({ ...p, id: makeAdoptedAnnotationId(), class_name: className })),
      ];
      await saveAnnotations(projectId, imageId, newAnns);
      useViewerStore.getState().clearPromptsAndPreviews();
      await useProjectStore.getState().loadProjectInfo();
      bundleCache.invalidateBundle(projectId, imageId);
      await useImageStore.getState().reloadSelectedImage();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(t('save_failed_msg', { error: message }), 'error');
    }
  }, [t, resolveAdoptClass]);

  const keepSingle = useCallback(
    async (previewId: string) => {
      const viewer = useViewerStore.getState();
      const preview = viewer.previews.find((p) => String(p.id) === String(previewId));
      if (!preview) return;
      const projectId = useProjectStore.getState().projectId;
      const imageId = useImageStore.getState().selectedImageId;
      if (!projectId || !imageId) return;
      const className = resolveAdoptClass();
      try {
        const existing = await getAnnotations(projectId, imageId);
        const newAnns: Annotation[] = [
          ...(existing?.annotations || []),
          { ...preview, id: makeAdoptedAnnotationId(), class_name: className },
        ];
        await saveAnnotations(projectId, imageId, newAnns);
        useViewerStore.getState().removePreview(previewId);
        await useProjectStore.getState().loadProjectInfo();
        bundleCache.invalidateBundle(projectId, imageId);
        await useImageStore.getState().reloadSelectedImage();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast(t('save_failed_msg', { error: message }), 'error');
      }
    },
    [t, resolveAdoptClass],
  );

  return { keepAll, keepSingle, removePreview, resolveAdoptClass };
}
