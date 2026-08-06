import { get, post, type RequestOptions } from './client';
import type { Annotation } from './types';

/** GET /api/projects/{pid}/images/{imageId}/annotations */
export function getAnnotations(projectId: string, imageId: string, requestOptions: RequestOptions = {}) {
  return get<{ annotations: Annotation[]; [key: string]: unknown }>(
    `/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/annotations`,
    requestOptions,
  );
}

/** POST /api/annotations/save — full replacement of the image's annotation list. */
export function saveAnnotations(projectId: string, imageId: string, annotations: Annotation[]) {
  return post<Record<string, unknown>>('/annotations/save', {
    project_id: projectId,
    image_id: imageId,
    annotations,
  });
}

/** POST /api/annotations/append — append without replacing. */
export function appendAnnotations(projectId: string, imageId: string, annotations: Annotation[]) {
  return post<Record<string, unknown>>('/annotations/append', {
    project_id: projectId,
    image_id: imageId,
    annotations,
  });
}

/** GET /api/projects/{pid}/annotation_dashboard */
export function getAnnotationDashboard(projectId: string) {
  return get<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/annotation_dashboard`);
}

/** POST /api/projects/{pid}/annotation_index/rebuild */
export function rebuildAnnotationIndex(projectId: string) {
  return post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/annotation_index/rebuild`);
}

/** POST /api/projects/{pid}/annotations/migrate — dry_run=true returns the plan only. */
export function migrateAnnotationLayout(projectId: string, dryRun = true) {
  return post<{ moved?: number; conflicts?: number; failed?: number; [key: string]: unknown }>(
    `/projects/${encodeURIComponent(projectId)}/annotations/migrate`,
    { dry_run: Boolean(dryRun) },
  );
}
