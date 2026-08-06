import { get, post, del, request, type RequestOptions } from './client';
import type { Annotation, ImageInfo, PreviewInfo, TileInfo } from './types';

export interface ImageListFilters {
  imageId?: string;
  status?: string;
  className?: string;
}

export interface ImageListResponse {
  items: ImageInfo[];
  total: number;
  offset: number;
  limit: number;
  image_index?: number;
  status?: string;
  class_name?: string;
}

export interface BundleResponse {
  id?: string;
  image?: ImageInfo;
  annotations?: Annotation[];
  preview_info?: PreviewInfo | null;
  tile_info?: TileInfo | null;
  [key: string]: unknown;
}

export interface BundleQuery {
  priority?: string | number;
  enqueue?: boolean;
  includeAnnotations?: boolean;
  includePreview?: boolean;
  includeTileInfo?: boolean;
}

/** GET /api/projects/{id}/images (list with pagination + filters) */
export function getImages(
  projectId: string,
  offset = 0,
  limit = 200,
  filters: ImageListFilters = {},
) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (filters.imageId) params.set('image_id', filters.imageId);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.className) params.set('class_name', filters.className);
  return get<ImageListResponse>(
    `/projects/${encodeURIComponent(projectId)}/images?${params.toString()}`,
  );
}

/** GET /api/projects/{id}/images/unlabeled */
export function getUnlabeledImage(projectId: string, afterImageId = '', direction: 'next' | 'prev' = 'next') {
  const params = new URLSearchParams();
  if (afterImageId) params.set('after_image_id', afterImageId);
  if (direction) params.set('direction', direction);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return get<{ image: ImageInfo | null; image_index: number }>(
    `/projects/${encodeURIComponent(projectId)}/images/unlabeled${suffix}`,
  );
}

/** GET /api/projects/{id}/images/{imageId}/bundle */
export function getImageBundle(
  projectId: string,
  imageId: string,
  requestOptions: RequestOptions = {},
  params: BundleQuery = {},
) {
  const query = new URLSearchParams();
  if (params.priority !== undefined) query.set('priority', String(params.priority));
  if (params.enqueue !== undefined) query.set('enqueue', params.enqueue ? 'true' : 'false');
  if (params.includeAnnotations !== undefined) {
    query.set('include_annotations', params.includeAnnotations ? 'true' : 'false');
  }
  if (params.includePreview !== undefined) {
    query.set('include_preview', params.includePreview ? 'true' : 'false');
  }
  if (params.includeTileInfo !== undefined) {
    query.set('include_tile_info', params.includeTileInfo ? 'true' : 'false');
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return get<BundleResponse>(
    `/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/bundle${suffix}`,
    requestOptions,
  );
}

/** GET /api/projects/{id}/images/{imageId}/tiles/info */
export function getImageTilesInfo(
  projectId: string,
  imageId: string,
  requestOptions: RequestOptions = {},
  params: { priority?: string | number; enqueue?: boolean } = {},
) {
  const query = new URLSearchParams();
  if (params.priority !== undefined) query.set('priority', String(params.priority));
  if (params.enqueue !== undefined) query.set('enqueue', params.enqueue ? 'true' : 'false');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return get<TileInfo>(
    `/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/tiles/info${suffix}`,
    requestOptions,
  );
}

/** GET /api/projects/{id}/images/{imageId}/preview/info */
export function getImagePreviewInfo(projectId: string, imageId: string, requestOptions: RequestOptions = {}) {
  return get<PreviewInfo>(
    `/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/preview/info`,
    requestOptions,
  );
}

/** Original image file URL served by the backend. */
export function getImageFileUrl(projectId: string, imageId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/file`;
}

/** POST /api/projects/{id}/images/refresh */
export function refreshImages(projectId: string) {
  return post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/images/refresh`);
}

/** POST /api/projects/{id}/images/import */
export function importImages(projectId: string, sourceDir: string) {
  return post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/images/import`, {
    source_dir: sourceDir,
  });
}

/** DELETE /api/projects/{id}/images/{imageId} */
export function deleteImage(projectId: string, imageId: string) {
  return del<Record<string, unknown>>(
    `/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}`,
  );
}

/** POST /api/projects/{id}/images/upload (single file FormData) */
export function uploadImage(projectId: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return request<Record<string, unknown>>(
    'POST',
    `/projects/${encodeURIComponent(projectId)}/images/upload`,
    fd,
    true,
  );
}
