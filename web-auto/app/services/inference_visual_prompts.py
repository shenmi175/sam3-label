from __future__ import annotations

from typing import Any

from app.annotations.operations import (
    _ann_bbox,
    _bbox_center,
    _bbox_iou,
    _norm_bbox_xyxy,
    _point_in_bbox,
)


def _split_visual_prompts(
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> tuple[list[list[float]], list[list[float]], list[list[float]], list[list[float]]]:
    pos_points: list[list[float]] = []
    neg_points: list[list[float]] = []
    for item in points or []:
        if not isinstance(item, list) or len(item) < 2:
            continue
        try:
            x = float(item[0])
            y = float(item[1])
            label = 0 if (len(item) >= 3 and int(item[2]) == 0) else 1
        except (TypeError, ValueError):
            continue
        if label == 0:
            neg_points.append([x, y])
        else:
            pos_points.append([x, y])

    pos_boxes: list[list[float]] = []
    neg_boxes: list[list[float]] = []
    for item in boxes or []:
        if not isinstance(item, list) or len(item) < 4:
            continue
        b = _norm_bbox_xyxy(item[:4])
        if not b:
            continue
        try:
            label = 0 if (len(item) >= 5 and int(item[4]) == 0) else 1
        except (TypeError, ValueError):
            label = 1
        if label == 0:
            neg_boxes.append(b)
        else:
            pos_boxes.append(b)

    return pos_points, neg_points, pos_boxes, neg_boxes


def _has_positive_visual_prompt(
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> bool:
    pos_points, _, pos_boxes, _ = _split_visual_prompts(points, boxes)
    return bool(pos_points or pos_boxes)


def _match_positive_prompt(
    bbox: list[float],
    pos_points: list[list[float]],
    pos_boxes: list[list[float]],
) -> bool:
    for p in pos_points:
        if _point_in_bbox(float(p[0]), float(p[1]), bbox):
            return True
    cx, cy = _bbox_center(bbox)
    for pb in pos_boxes:
        if _point_in_bbox(cx, cy, pb):
            return True
        if _bbox_iou(bbox, pb) >= 0.1:
            return True
    return False


def _match_negative_prompt(
    bbox: list[float],
    neg_points: list[list[float]],
    neg_boxes: list[list[float]],
) -> bool:
    for p in neg_points:
        if _point_in_bbox(float(p[0]), float(p[1]), bbox):
            return True
    cx, cy = _bbox_center(bbox)
    for nb in neg_boxes:
        if _point_in_bbox(cx, cy, nb):
            return True
        if _bbox_iou(bbox, nb) >= 0.2:
            return True
    return False


def _filter_visual_detections(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    pos_points, neg_points, pos_boxes, neg_boxes = _split_visual_prompts(points, boxes)
    has_positive = bool(pos_points or pos_boxes)
    out: list[dict[str, Any]] = []
    for det in detections:
        bbox = _ann_bbox(det)
        if not bbox:
            continue
        if has_positive and (not _match_positive_prompt(bbox, pos_points, pos_boxes)):
            continue
        if _match_negative_prompt(bbox, neg_points, neg_boxes):
            continue
        out.append(det)
    return out


def _filter_negative_only(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    _, neg_points, _, neg_boxes = _split_visual_prompts(points, boxes)
    if not neg_points and not neg_boxes:
        return list(detections)
    out: list[dict[str, Any]] = []
    for det in detections:
        bbox = _ann_bbox(det)
        if not bbox:
            continue
        if _match_negative_prompt(bbox, neg_points, neg_boxes):
            continue
        out.append(det)
    return out


def _positive_points_only(points: list[list[float | int]]) -> list[list[float]]:
    pos_points, _, _, _ = _split_visual_prompts(points, [])
    return pos_points


def _distance_sq(x1: float, y1: float, x2: float, y2: float) -> float:
    dx = x1 - x2
    dy = y1 - y2
    return dx * dx + dy * dy


def _pick_by_positive_points(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
) -> list[dict[str, Any]]:
    pos_points = _positive_points_only(points)
    if not detections or not pos_points:
        return []

    out: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for px, py in pos_points:
        best: dict[str, Any] | None = None
        best_dist = float('inf')
        # Prefer detections that contain the clicked point.
        for det in detections:
            det_id = str(det.get('id') or '')
            if det_id and det_id in used_ids:
                continue
            bbox = _ann_bbox(det)
            if not bbox:
                continue
            if not _point_in_bbox(float(px), float(py), bbox):
                continue
            cx, cy = _bbox_center(bbox)
            d = _distance_sq(float(px), float(py), cx, cy)
            if d < best_dist:
                best_dist = d
                best = det

        # If none contains the point, fallback to nearest bbox center.
        if best is None:
            for det in detections:
                det_id = str(det.get('id') or '')
                if det_id and det_id in used_ids:
                    continue
                bbox = _ann_bbox(det)
                if not bbox:
                    continue
                cx, cy = _bbox_center(bbox)
                d = _distance_sq(float(px), float(py), cx, cy)
                if d < best_dist:
                    best_dist = d
                    best = det

        if best is not None:
            det_id = str(best.get('id') or '')
            if det_id:
                used_ids.add(det_id)
            out.append(best)
    return out


def _reduce_points_to_single_instance(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
) -> list[dict[str, Any]]:
    if not detections:
        return []
    picked = _pick_by_positive_points(detections, points=points)
    if picked:
        return [picked[0]]
    best = max(detections, key=lambda d: float(d.get('score') or 0.0))
    return [best]


def _merge_visual_annotations(
    old_annotations: list[dict[str, Any]],
    *,
    new_annotations: list[dict[str, Any]],
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    if not old_annotations:
        return list(new_annotations)
    if not new_annotations:
        return list(old_annotations)

    pos_points, _, pos_boxes, _ = _split_visual_prompts(points, boxes)
    new_bboxes = [_ann_bbox(a) for a in new_annotations]
    new_bboxes = [b for b in new_bboxes if b]
    kept: list[dict[str, Any]] = []
    for old in old_annotations:
        old_bbox = _ann_bbox(old)
        if not old_bbox:
            kept.append(old)
            continue

        drop = False
        if pos_points or pos_boxes:
            if _match_positive_prompt(old_bbox, pos_points, pos_boxes):
                drop = True
        if not drop:
            for nb in new_bboxes:
                if _bbox_iou(old_bbox, nb) >= 0.6:
                    drop = True
                    break
        if not drop:
            kept.append(old)
    kept.extend(new_annotations)
    return kept
