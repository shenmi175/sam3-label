import OpenSeadragon from 'openseadragon';

export type AnnotationShape = 'bbox' | 'polygon' | 'polygons';

export interface Annotation {
  schema_version?: number;
  id: string;
  class_name?: string;
  raw_label?: string;
  class_id?: number;
  shape?: AnnotationShape;
  /** [x1, y1, x2, y2] in image pixels */
  bbox?: [number, number, number, number];
  /** single polygon: [[x,y], ...] */
  polygon?: [number, number][];
  /** multi-contour mask polygons */
  polygons?: [number, number][][];
  area?: number | null;
  mask_url?: string;
  overlay_url?: string;
  source_model?: string;
  source?: string;
  score?: number;
  component_count?: number;
  edited?: boolean;
  modified_by?: string;
  accepted_by?: string;
  ai_assisted_by?: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  /** display color override (any CSS color) */
  color?: string;
  /** fallback display label */
  label?: string;
  /** legacy bbox aliases accepted by the viewer */
  box?: number[];
  bbox_xyxy?: number[];
  /** legacy polygon points: flat [x,y,x,y,...] or paired [[x,y],...] */
  points?: number[] | [number, number][];
  [key: string]: unknown;
}

export interface TileInfo {
  status?: string;
  dzi_url?: string;
  tiles_url?: string;
  width?: number;
  height?: number;
  tile_size?: number;
  [key: string]: unknown;
}

export interface PreviewInfo {
  preview_url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  /** full-resolution source dimensions (fallback chain used by the viewer) */
  source_width?: number;
  source_height?: number;
  preview_width?: number;
  preview_height?: number;
  [key: string]: unknown;
}

export interface ImageInfo {
  id: string;
  rel_path?: string;
  image_id?: string;
  status?: string;
  annotation_count?: number;
  [key: string]: unknown;
}

export interface ImageBundle {
  id: string;
  relPath?: string;
  imageInfo?: ImageInfo;
  previewInfo?: PreviewInfo;
  annotations?: Annotation[];
  tileInfo?: TileInfo;
  annotationsLoaded?: boolean;
  previewLoaded?: boolean;
  tileInfoLoaded?: boolean;
  cachedAt?: number;
}

export interface Prompt {
  type: 'point';
  /** Flat coordinate payload used by the viewer: [x,y,label?]. */
  data: number[];
  label?: 0 | 1;
  bbox?: [number, number, number, number];
  point?: [number, number];
}

export interface JobState {
  job_id: string;
  status: string;
  progress?: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface ProjectInfo {
  id: string;
  name?: string;
  type?: string;
  image_count?: number;
  [key: string]: unknown;
}

export interface ClassInfo {
  id?: number;
  name: string;
  color?: string;
  [key: string]: unknown;
}

export interface ServiceStatus {
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export { OpenSeadragon };
