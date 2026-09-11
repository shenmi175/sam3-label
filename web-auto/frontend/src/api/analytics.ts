import { get, post, type RequestOptions } from './client';

export type AnalyticsIndexState = 'missing' | 'building' | 'ready' | 'stale' | 'failed';
export type AnalyticsTask = 'detection' | 'instance_segmentation';
export type AnalyticsSource = string;

export interface AnalyticsJob {
  job_id?: string;
  status?: string;
  progress_done?: number;
  progress_total?: number;
  progress_pct?: number;
  message?: string;
  error?: string;
}

export interface AnalyticsIndexStatus {
  project_id: string;
  status: AnalyticsIndexState;
  index_version: number;
  indexed_content_rev: number;
  content_rev: number;
  indexed_images: number;
  total_images: number;
  last_error?: string;
  updated_at?: string;
  needs_rebuild: boolean;
  job?: AnalyticsJob | null;
}

export interface AnalyticsDimensionCount {
  source: AnalyticsSource;
  display_name?: string;
  image_count: number;
  instance_count: number;
}

export interface AnalyticsDimensions {
  project_id: string;
  index_version: number;
  tasks: Array<{
    task: AnalyticsTask;
    image_count: number;
    instance_count: number;
    sources: AnalyticsDimensionCount[];
  }>;
  sources: AnalyticsDimensionCount[];
  invalid_instance_count: number;
}

export interface AnalyticsSeries {
  source: AnalyticsSource;
  values: number[];
  image_values?: number[];
}

export interface AnalyticsDistribution {
  categories: string[];
  series: AnalyticsSeries[];
}

export interface AnalyticsHeatmap {
  x_edges: number[];
  y_edges: number[];
  series: Array<{
    source: AnalyticsSource;
    cells: Array<{ x: number; y: number; count: number }>;
  }>;
}

export interface AnalyticsOverview {
  project_id: string;
  index_version: number;
  content_rev: number;
  generated_at: string;
  scope: {
    task: AnalyticsTask;
    sources: AnalyticsSource[];
    project_total_images: number;
    hit_images: number;
    instance_count: number;
    class_count: number;
    anomaly_count: number;
  };
  source_summary: Array<{
    source: AnalyticsSource;
    image_count: number;
    instance_count: number;
    class_count: number;
  }>;
  class_distribution: AnalyticsDistribution;
  class_distribution_truncated: number;
  density_distribution: AnalyticsDistribution;
  area_distribution: AnalyticsDistribution & { missing_by_source: Record<AnalyticsSource, number> };
  aspect_ratio_distribution: AnalyticsDistribution | null;
  geometry_distribution_by_source: AnalyticsDistribution | null;
  center_heatmap: AnalyticsHeatmap | null;
  resolution_distribution: AnalyticsHeatmap;
}

export function getAnalyticsIndex(projectId: string, options?: RequestOptions) {
  return get<{ index: AnalyticsIndexStatus }>(`/projects/${encodeURIComponent(projectId)}/analytics/index`, options);
}

export function rebuildAnalyticsIndex(projectId: string) {
  return post<{ job: AnalyticsJob }>(`/projects/${encodeURIComponent(projectId)}/analytics/index/rebuild`);
}

export function getAnalyticsDimensions(projectId: string, options?: RequestOptions) {
  return get<{ dimensions: AnalyticsDimensions }>(`/projects/${encodeURIComponent(projectId)}/analytics/dimensions`, options);
}

export function getAnalyticsOverview(
  projectId: string,
  task: AnalyticsTask,
  sources: AnalyticsSource[],
  options?: RequestOptions,
) {
  const query = new URLSearchParams({ task });
  sources.forEach((source) => query.append('source', source));
  return get<{ overview: AnalyticsOverview }>(
    `/projects/${encodeURIComponent(projectId)}/analytics/overview?${query.toString()}`,
    options,
  );
}
