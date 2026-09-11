import { get, post, del, request } from './client';

export { uploadDatasetFile } from './client';

export interface ProjectInfo {
  id: string;
  name?: string;
  project_type?: string;
  image_dir?: string;
  save_dir?: string;
  num_images?: number;
  labeled_images?: number;
  created_at?: number | string;
  [key: string]: unknown;
}

export interface ProjectDiscoverySummary {
  imported?: unknown[];
  skipped?: number;
  errors?: unknown[];
  cached?: boolean;
  auto_discover?: boolean;
  [key: string]: unknown;
}

export interface DiscoveryCandidate {
  kind: 'manifest' | 'legacy' | string;
  project_id: string;
  name: string;
  project_type: string;
  image_dir: string;
  output_dir: string;
  manifest_path: string;
  annotation_count: number;
  imported: boolean;
  requires_image_dir: boolean;
}

export interface ScanRootInfo {
  path: string;
  exists?: boolean;
  is_dir?: boolean;
}

export interface DiscoverResponse {
  candidates: DiscoveryCandidate[];
  discovery?: ProjectDiscoverySummary;
  scan_roots?: ScanRootInfo[];
  allowed_data_roots?: string[];
  max_depth?: number;
}

export interface CreateProjectPayload {
  name: string;
  project_type: string;
  image_dir: string;
  classes_text: string;
  save_dir?: string;
}

export interface ImportExistingPayload {
  output_dir: string;
  manifest_path: string;
  image_dir: string;
  name: string;
  classes_text: string;
  project_type: string;
}

export interface UploadConfig {
  host_data_root: string;
  allowed_data_roots: string[];
  default_target_dir: string;
}

/** GET /api/projects */
export function getProjects(options: { autoDiscover?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.autoDiscover) params.set('auto_discover', 'true');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return get<{ projects: ProjectInfo[]; discovery?: ProjectDiscoverySummary }>(`/projects${suffix}`);
}

/** GET /api/projects/{id} */
export function getProject(id: string, includeImages = false) {
  return get<{ project: ProjectInfo }>(`/projects/${encodeURIComponent(id)}?include_images=${includeImages}`);
}

/** PATCH /api/projects/{id} */
export function updateProject(id: string, data: { name: string }) {
  return request<{ project: ProjectInfo }>(
    'PATCH',
    `/projects/${encodeURIComponent(id)}`,
    data,
  );
}

/** POST /api/projects/open */
export function createProject(data: CreateProjectPayload) {
  return post<{ project: ProjectInfo }>('/projects/open', data);
}

/** GET /api/projects/discover */
export function discoverProjects(scanRoot = '', maxDepth = 8) {
  const params = new URLSearchParams();
  if (scanRoot) params.set('scan_root', scanRoot);
  if (maxDepth) params.set('max_depth', String(maxDepth));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return get<DiscoverResponse>(`/projects/discover${suffix}`);
}

/** POST /api/projects/import_existing */
export function importExistingProject(data: ImportExistingPayload) {
  return post<Record<string, unknown>>('/projects/import_existing', data);
}

/** DELETE /api/projects/{id} */
export function deleteProject(id: string) {
  return del<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}`);
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

/** DELETE /api/projects/{projectId}/images/{imageId} */
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

/** GET /api/uploads/config */
export function getUploadConfig() {
  return get<UploadConfig>('/uploads/config');
}
