import { post } from './client';

export interface PoseAnnotation {
  id?: string;
  type?: string;
  label?: string;
  class_name?: string;
  /** [[x, y, visibility, score], ...] in image pixels */
  keypoints?: number[][];
  /** [[fromIndex, toIndex], ...] */
  skeleton_links?: number[][];
  /** [x1, y1, x2, y2] */
  bbox?: number[];
  score?: number;
  [key: string]: unknown;
}

export interface PoseInferPayload {
  project_id: string;
  image_id: string;
  bbox_threshold: number;
  keypoint_threshold: number;
  nms_threshold: number;
}

/** POST /api/pose/infer — runs sapiens pose estimation and saves annotations. */
export function inferPose(data: PoseInferPayload) {
  return post<{ saved_annotations?: PoseAnnotation[]; annotations?: PoseAnnotation[] }>(
    '/pose/infer',
    data,
  );
}
