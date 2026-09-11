import { get, post } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilterOperationMode = 'merge' | 'rule' | 'component_noise' | 'delete_unlabeled';
export type FilterTaskType =
  | 'remove_small_components' | 'remove_edge_spurs' | 'shortest_bridge' | 'morph_close' | 'fill_small_holes'
  | 'deduplicate_same_class' | 'remove_small_instances' | 'remove_confidence_range'
  | 'remove_position_region' | 'delete_by_box_count' | 'normalize_classes' | 'delete_unlabeled_images';
export type FilterMergeMode = 'same_class' | 'canonical_class';
export type FilterSpatialMode = 'instance_cover' | 'bbox_cover';
export type FilterAreaMode = 'instance' | 'bbox';

export interface SmartFilterPayload {
  schema_version: 2;
  project_id: string;
  task_type: FilterTaskType;
  class_scope: { mode: 'all' | 'selected'; classes: string[] };
  params: Record<string, string | number | boolean>;
  /** Only for start_apply: token returned by the preview job. */
  preview_token?: string;
  confirm_preview_failure?: boolean;
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

export interface FilterPreviewSample {
  image_id: string;
  rel_path: string;
  kind: 'annotation_change' | 'image_delete';
  /** Geometry is rendered in independent samples so boxes never share a canvas with masks. */
  geometry_type?: 'bbox' | 'segmentation' | 'mixed' | 'image';
  annotation_count?: number;
  candidate_count?: number;
  relabel_count?: number;
  before_url: string;
  after_url: string;
  diff_url?: string;
  before_detail_url?: string;
  after_detail_url?: string;
  diff_detail_url?: string;
  removed_pixels?: number;
  added_pixels?: number;
}

export interface FilterPreviewArtwork {
  version: 1;
  status: 'ready' | 'not_needed' | 'failed';
  error_code?: 'source_unavailable' | 'render_failed' | 'selection_unavailable' | string;
}

export interface SmartFilterJobResult {
  schema_version?: 2;
  task_type?: FilterTaskType;
  effect_type?: 'annotation_delete' | 'geometry_replace' | 'relabel' | 'image_delete';
  operation_mode?: FilterOperationMode;
  preview_token?: string;
  /** Apply jobs set this when they used the version-checked preview change set. */
  analysis_reused?: boolean;
  rollback_run_id?: string;
  /** preview-mode counters */
  image_count?: number;
  candidate_count?: number;
  relabel_count?: number;
  /** apply-mode counters */
  changed_images?: number;
  removed_annotations?: number;
  relabeled_annotations?: number;
  modified_annotations?: number;
  removed_components?: number;
  removed_pixels?: number;
  opening_removed_pixels?: number;
  bridges_added?: number;
  bridge_pixels?: number;
  filled_holes?: number;
  filled_pixels?: number;
  collision_rejected_bridges?: number;
  morphology_skipped_annotations?: number;
  incomplete_collision_checks?: number;
  skipped_annotations?: number;
  sample_urls?: string[];
  /** Canonical before/after artwork shared by every cleaning mode. */
  preview_samples?: FilterPreviewSample[];
  /** Versioned preview rendering status, including best-effort failure diagnostics. */
  preview_artwork?: FilterPreviewArtwork;
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

/** Pause at the next per-image checkpoint. */
export function pauseFilterJob(jobId: string) {
  return post<{ job?: SmartFilterJob | null }>(`/jobs/${encodeURIComponent(jobId)}/pause`, {});
}

/** Requeue a paused cleaning stage. */
export function resumeFilterJob(jobId: string) {
  return post<{ job?: SmartFilterJob | null }>(`/jobs/${encodeURIComponent(jobId)}/resume`, {});
}

/** Permanently stop a queued, running or paused cleaning job. */
export function cancelFilterJob(jobId: string) {
  return post<{ job?: SmartFilterJob | null }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {});
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
