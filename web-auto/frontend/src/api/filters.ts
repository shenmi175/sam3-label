import { get, post } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilterOperationMode = 'merge' | 'rule' | 'delete_unlabeled';
export type FilterMergeMode = 'same_class' | 'canonical_class';
export type FilterSpatialMode = 'instance_cover' | 'bbox_cover';
export type FilterAreaMode = 'instance' | 'bbox';

export interface SmartFilterPayload {
  project_id: string;
  operation_mode: FilterOperationMode;
  merge_mode: FilterMergeMode;
  spatial_mode: FilterSpatialMode;
  coverage_threshold: number;
  canonical_class: string;
  source_classes: string[];
  area_mode: FilterAreaMode;
  rule_classes: string[];
  small_target_enabled: boolean;
  max_area_ratio: number;
  instance_count_enabled: boolean;
  min_instances: number;
  max_instances: number;
  position_enabled: boolean;
  center_x_half_width: number;
  center_y_half_height: number;
  confidence_enabled: boolean;
  min_confidence: number;
  max_confidence: number;
  /** Only for start_apply: token returned by the preview job. */
  preview_token?: string;
}

export interface FilterResultItem {
  image_id?: string;
  rel_path?: string;
  candidate_count?: number;
  removed_count?: number;
  relabel_count?: number;
  scoped_annotation_count?: number | null;
  deleted_image_file?: boolean;
  deleted_annotation_file?: boolean;
  [key: string]: unknown;
}

export interface SmartFilterJobResult {
  operation_mode?: FilterOperationMode;
  preview_token?: string;
  rollback_run_id?: string;
  /** preview-mode counters */
  image_count?: number;
  candidate_count?: number;
  relabel_count?: number;
  /** apply-mode counters */
  changed_images?: number;
  removed_annotations?: number;
  relabeled_annotations?: number;
  /** delete_unlabeled apply counters */
  deleted_images?: number;
  deleted_image_files?: number;
  deleted_annotation_files?: number;
  failed_deletes?: unknown[];
  items?: FilterResultItem[];
  [key: string]: unknown;
}

export interface SmartFilterJob {
  job_id: string;
  status?: string;
  progress_pct?: number;
  message?: string;
  error?: string;
  result?: SmartFilterJobResult;
  [key: string]: unknown;
}

export interface FilterRunSummary {
  changed_images?: number;
  removed_annotations?: number;
  relabeled_annotations?: number;
  [key: string]: unknown;
}

export interface FilterRun {
  run_id: string;
  summary?: FilterRunSummary;
  snapshot_count?: number;
  [key: string]: unknown;
}

// ─── Endpoints (mirror legacy services/filter-api.js) ─────────────────────────

/** POST /api/filter/intelligent/jobs/start_preview */
export function startFilterPreviewJob(payload: SmartFilterPayload) {
  return post<{ job?: SmartFilterJob | null }>('/filter/intelligent/jobs/start_preview', payload);
}

/** POST /api/filter/intelligent/jobs/start_apply */
export function startFilterApplyJob(payload: SmartFilterPayload) {
  return post<{ job?: SmartFilterJob | null }>('/filter/intelligent/jobs/start_apply', payload);
}

/** GET /api/filter/intelligent/jobs/{job_id} */
export function getFilterJob(jobId: string) {
  return get<{ job?: SmartFilterJob | null }>(
    `/filter/intelligent/jobs/${encodeURIComponent(jobId)}`,
  );
}

/** GET /api/filter/intelligent/jobs/active */
export function getFilterActiveJob(projectId: string) {
  return get<{ job?: SmartFilterJob | null }>(
    `/filter/intelligent/jobs/active?project_id=${encodeURIComponent(projectId)}`,
  );
}

/** GET /api/filter/intelligent/runs/latest */
export function getLatestFilterRun(projectId: string) {
  return get<{ run?: FilterRun | null }>(
    `/filter/intelligent/runs/latest?project_id=${encodeURIComponent(projectId)}`,
  );
}

/** POST /api/filter/intelligent/runs/{run_id}/rollback */
export function rollbackFilterRun(projectId: string, runId: string) {
  return post<{ result?: { restored_images?: number; [key: string]: unknown } }>(
    `/filter/intelligent/runs/${encodeURIComponent(runId)}/rollback?project_id=${encodeURIComponent(projectId)}`,
  );
}
