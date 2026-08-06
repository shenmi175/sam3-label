import { get, post } from './client';
import type { JobState } from './types';

export interface BackendPayload {
  model_backend?: string;
  locate_api_base_url?: string;
  score_default?: number;
  contour_mode?: string;
}

export interface InferSinglePayload extends BackendPayload {
  project_id: string;
  image_id: string;
  mode: 'text' | 'points' | 'boxes';
  classes?: string[];
  active_class?: string;
  points?: number[][];
  boxes?: number[][];
  threshold?: number;
  api_base_url?: string;
}

export interface InferBatchPayload extends BackendPayload {
  project_id: string;
  mode?: 'text' | 'la_boxes';
  classes?: string[];
  image_ids?: string[];
  retry_image_ids?: string[];
  all_images?: boolean;
  scope_mode?: string;
  related_classes?: string[];
  batch_size?: number;
  threshold?: number;
  api_base_url?: string;
}

export interface InferExamplePreviewPayload {
  project_id: string;
  image_id: string;
  active_class?: string;
  boxes?: number[][];
  threshold?: number;
  api_base_url?: string;
}

export interface InferDetection {
  bbox?: number[];
  polygon?: unknown;
  polygons?: unknown;
  score?: number;
  class_name?: string;
  [key: string]: unknown;
}

export interface InferResponse {
  project_id?: string;
  image_id?: string;
  mode?: string;
  num_detections?: number;
  detections?: InferDetection[];
  saved_annotations?: unknown;
  impacted_classes?: unknown;
  raw?: unknown;
}

export interface InferJob extends JobState {
  job_id: string;
  job_type?: string;
  project_id?: string;
  status: string;
  progress_pct?: number;
  progress_done?: number;
  requested?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  new_annotations?: number;
  message?: string;
  payload_dict?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/** POST /api/infer — single image text inference (saves result server-side). */
export function infer(payload: InferSinglePayload) {
  return post<InferResponse>('/infer', payload);
}

/** POST /api/infer/preview — single image inference without saving. */
export function inferPreview(payload: InferSinglePayload) {
  return post<InferResponse>('/infer/preview', payload);
}

/** POST /api/infer/example_preview — SAM box-exemplar "find similar" preview. */
export function inferExample(payload: InferExamplePreviewPayload) {
  return post<InferResponse>('/infer/example_preview', payload);
}

/** POST /api/infer/jobs/start_batch — spawn a batch job, returns { job }. */
export function startBatchInfer(payload: InferBatchPayload) {
  return post<{ job: InferJob }>('/infer/jobs/start_batch', payload);
}

/** GET /api/infer/jobs/active?project_id= */
export function getInferActiveJob(projectId: string) {
  return get<{ job: InferJob | null }>(`/infer/jobs/active?project_id=${encodeURIComponent(projectId)}`);
}

/** GET /api/infer/jobs/{jobId} */
export function getInferJob(jobId: string) {
  return get<{ job: InferJob | null }>(`/infer/jobs/${encodeURIComponent(jobId)}`);
}

/** POST /api/infer/jobs/stop — request pause of the active job for a project. */
export function stopInferJob(projectId: string) {
  return post<{ job: InferJob | null }>('/infer/jobs/stop', { project_id: projectId });
}

/** POST /api/infer/jobs/resume */
export function resumeInferJob(payload: Record<string, unknown>) {
  return post<{ job: InferJob | null }>('/infer/jobs/resume', payload);
}

/** POST /api/infer/jobs/cancel */
export function cancelInferJob(projectId: string) {
  return post<{ job: InferJob | null }>('/infer/jobs/cancel', { project_id: projectId });
}

/** GET /api/filter/intelligent/jobs/active?project_id= (used by the global task widget). */
export function getFilterActiveJob(projectId: string) {
  return get<{ job: InferJob | null }>(
    `/filter/intelligent/jobs/active?project_id=${encodeURIComponent(projectId)}`,
  );
}
