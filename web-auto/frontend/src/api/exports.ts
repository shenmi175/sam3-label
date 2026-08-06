import { post } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportPreviewResponse {
  by_source?: Record<string, number>;
  no_polygon_by_source?: Record<string, number>;
  classes?: string[];
  by_class?: Record<string, number>;
  [key: string]: unknown;
}

export interface ExportPayload {
  project_id: string;
  format: 'coco' | 'yolo' | 'json' | string;
  include_bbox: boolean;
  include_mask: boolean;
  output_dir: string | null;
  source_models: string[];
  /** Empty array = all classes (legacy behavior). */
  classes: string[];
  val_ratio: number;
  write_data_yaml: boolean;
}

export interface ExportStats {
  annotations_written?: number;
  images_written?: number;
  skipped_source?: number;
  skipped_class?: number;
  skipped_no_polygon?: number;
  skipped_no_bbox?: number;
  images_missing?: number;
  [key: string]: unknown;
}

export interface ExportResponse {
  output?: string;
  stats?: ExportStats;
  [key: string]: unknown;
}

// ─── Endpoints (mirror legacy services/export-api.js) ─────────────────────────

/** POST /api/export/preview — per-source / per-class annotation counts. */
export function previewExport(data: { project_id: string }) {
  return post<ExportPreviewResponse>('/export/preview', data);
}

/** POST /api/export */
export function exportProject(data: ExportPayload) {
  return post<ExportResponse>('/export', data);
}
