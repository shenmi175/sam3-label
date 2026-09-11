import { post } from './client';


export type ExportProfile =
  | 'native_json_v2'
  | 'coco_detection'
  | 'coco_instance'
  | 'yolo_detection'
  | 'yolo_instance';

export type YoloMultipartPolicy = 'official_bridge' | 'reject';
export type ImageExportMode = 'none' | 'symlink' | 'copy';

export interface ExportPreviewResponse {
  by_source?: Record<string, number>;
  no_polygon_by_source?: Record<string, number>;
  classes?: string[];
  by_class?: Record<string, number>;
  [key: string]: unknown;
}

export interface ExportOptions {
  project_id: string;
  profile: ExportProfile;
  output_dir: string | null;
  source_models: string[];
  classes: string[];
  val_ratio: number;
  yolo_multipart_policy: YoloMultipartPolicy;
  image_mode: ImageExportMode;
  confirmed_issue_codes: string[];
}

export interface ExportPayload extends ExportOptions {
  expected_content_rev: number;
}

export interface ExportStats {
  images_total?: number;
  images_written?: number;
  negative_images?: number;
  annotations_selected?: number;
  instances_written?: number;
  regions_written?: number;
  multipart_instances?: number;
  regrouped_instances?: number;
  regrouped_components?: number;
  bbox_only_instances?: number;
  output_records?: number;
  [key: string]: unknown;
}

export interface ExportResponse {
  output?: string;
  profile?: ExportProfile;
  stats?: ExportStats;
  warnings?: ExportIssue[];
  format_details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExportIssue {
  code: string;
  message: string;
  severity: 'warning' | 'blocker';
  count: number;
  samples: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface ExportPreflight {
  ok: boolean;
  profile: ExportProfile;
  schema?: string;
  project_id: string;
  project_content_rev: number;
  stats: ExportStats;
  warnings: ExportIssue[];
  blockers: ExportIssue[];
  confirmation_required_codes: string[];
  format_details: Record<string, unknown>;
}

export function previewExport(data: { project_id: string }) {
  return post<ExportPreviewResponse>('/export/preview', data);
}

export function preflightExport(data: ExportOptions) {
  return post<ExportPreflight>('/export/preflight', data);
}

export function exportProject(data: ExportPayload) {
  return post<ExportResponse>('/export', data);
}
