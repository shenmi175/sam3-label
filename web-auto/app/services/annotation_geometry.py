from __future__ import annotations

import base64
import math
import re
from typing import Any

from app.utils import norm_text


def _bbox_from_polygon(polygon: list[list[float]]) -> list[float]:
    if not isinstance(polygon, list) or len(polygon) < 3:
        return []
    xs, ys = [], []
    for p in polygon:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            xs.append(float(p[0]))
            ys.append(float(p[1]))
        except (TypeError, ValueError):
            continue
    if not xs or not ys:
        return []
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)
    if x2 <= x1 or y2 <= y1:
        return []
    return [x1, y1, x2, y2]


def _mask_components_from_base64(mask_b64: str, min_contour_area: float = 1.0) -> list[dict[str, Any]]:
    if not isinstance(mask_b64, str) or not mask_b64:
        return []
    try:
        import cv2
        import numpy as np

        raw = base64.b64decode(mask_b64)
        arr = np.frombuffer(raw, dtype=np.uint8)
        mask = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            return []
        _, binary = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return []
        contours = sorted(contours, key=lambda c: cv2.boundingRect(c)[:2][::-1])
        components: list[dict[str, Any]] = []
        for contour in contours:
            if float(cv2.contourArea(contour)) < float(min_contour_area):
                continue
            peri = cv2.arcLength(contour, True)
            epsilon = max(1.0, 0.003 * peri)
            approx = cv2.approxPolyDP(contour, epsilon, True)
            if (approx is None or len(approx) < 3) and len(contour) >= 3:
                approx = contour
            if approx is None or len(approx) < 3:
                continue
            component_region = np.zeros_like(binary, dtype=np.uint8)
            cv2.drawContours(component_region, [contour], -1, 255, thickness=cv2.FILLED)
            component_mask = np.where((component_region > 0) & (binary > 0), 255, 0).astype(np.uint8)
            area = int(np.count_nonzero(component_mask))
            if area <= 0:
                continue
            ok, encoded = cv2.imencode('.png', component_mask)
            if not ok:
                continue
            polygon: list[list[float]] = []
            for pt in approx.reshape(-1, 2):
                polygon.append([float(pt[0]), float(pt[1])])
            components.append(
                {
                    'polygon': polygon,
                    'area': float(area),
                    'mask_png_base64': base64.b64encode(encoded.tobytes()).decode('utf-8'),
                }
            )
        return components
    except Exception:
        return []


def _polygon_from_mask(mask_b64: str) -> list[list[float]]:
    components = _mask_components_from_base64(mask_b64)
    if not components:
        return []
    component = max(components, key=lambda item: float(item.get('area') or 0.0))
    polygon = component.get('polygon') if isinstance(component, dict) else []
    return polygon if isinstance(polygon, list) else []


def _norm_bbox_xyxy(raw: Any) -> list[float]:
    if not isinstance(raw, list) or len(raw) < 4:
        return []
    try:
        x1 = float(raw[0])
        y1 = float(raw[1])
        x2 = float(raw[2])
        y2 = float(raw[3])
    except (TypeError, ValueError):
        return []
    x_min = min(x1, x2)
    y_min = min(y1, y2)
    x_max = max(x1, x2)
    y_max = max(y1, y2)
    if x_max <= x_min or y_max <= y_min:
        return []
    return [x_min, y_min, x_max, y_max]


def _bbox_center(bbox: list[float]) -> tuple[float, float]:
    return (float((bbox[0] + bbox[2]) / 2.0), float((bbox[1] + bbox[3]) / 2.0))


def _point_in_bbox(x: float, y: float, bbox: list[float]) -> bool:
    # Small tolerance for post-processing coordinate jitter.
    margin = 6.0
    return (bbox[0] - margin) <= x <= (bbox[2] + margin) and (bbox[1] - margin) <= y <= (bbox[3] + margin)


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(0.0, (b[2] - b[0]) * (b[3] - b[1]))
    union = area_a + area_b - inter
    if union <= 0.0:
        return 0.0
    return inter / union


def _bbox_intersection_area(a: list[float], b: list[float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    return iw * ih


def _polygon_area(poly: list[list[float]]) -> float:
    if not isinstance(poly, list) or len(poly) < 3:
        return 0.0
    area = 0.0
    pts: list[tuple[float, float]] = []
    for p in poly:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            pts.append((float(p[0]), float(p[1])))
        except (TypeError, ValueError):
            continue
    if len(pts) < 3:
        return 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        area += (x1 * y2) - (x2 * y1)
    return abs(area) * 0.5


def _ann_bbox(ann: dict[str, Any]) -> list[float]:
    bbox = _norm_bbox_xyxy(ann.get('bbox') or [])
    if bbox:
        return bbox
    return _bbox_from_polygon(ann.get('polygon') or [])


def _annotation_area_value(ann: dict[str, Any]) -> float:
    try:
        raw_area = float(ann.get('area') or 0.0)
    except (TypeError, ValueError):
        raw_area = 0.0
    if raw_area > 0.0:
        return raw_area
    poly_area = _polygon_area(ann.get('polygon') or [])
    if poly_area > 0.0:
        return poly_area
    bbox = _ann_bbox(ann)
    if bbox:
        return max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    return 0.0


def _bbox_area_value(bbox: list[float]) -> float:
    if not bbox or len(bbox) != 4:
        return 0.0
    return max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))


def _annotation_metric_area(ann: dict[str, Any], *, area_mode: str) -> float:
    bbox = _ann_bbox(ann)
    if str(area_mode or 'instance').strip().lower() == 'bbox':
        return _bbox_area_value(bbox)
    metric = _annotation_area_value(ann)
    if metric > 0.0:
        return metric
    return _bbox_area_value(bbox)


def _ann_polygon(ann: dict[str, Any]) -> list[list[float]]:
    raw = ann.get('polygon') or []
    out: list[list[float]] = []
    if isinstance(raw, list):
        for p in raw:
            if not isinstance(p, (list, tuple)) or len(p) < 2:
                continue
            try:
                out.append([float(p[0]), float(p[1])])
            except (TypeError, ValueError):
                continue
    if len(out) >= 3:
        return out
    mask_poly = _polygon_from_mask(str(ann.get('mask_png_base64') or ann.get('mask_png') or ''))
    if len(mask_poly) >= 3:
        return [[float(p[0]), float(p[1])] for p in mask_poly]
    return []


def _polygon_cover_ratio(outer_poly: list[list[float]], inner_poly: list[list[float]]) -> float | None:
    if len(outer_poly) < 3 or len(inner_poly) < 3:
        return None
    try:
        from PIL import Image, ImageChops, ImageDraw  # type: ignore

        xs = [float(p[0]) for p in outer_poly] + [float(p[0]) for p in inner_poly]
        ys = [float(p[1]) for p in outer_poly] + [float(p[1]) for p in inner_poly]
        min_x = math.floor(min(xs)) - 2
        min_y = math.floor(min(ys)) - 2
        max_x = math.ceil(max(xs)) + 2
        max_y = math.ceil(max(ys)) + 2
        width = max(1, int(max_x - min_x + 1))
        height = max(1, int(max_y - min_y + 1))

        def _shift(poly: list[list[float]]) -> list[tuple[float, float]]:
            return [(float(p[0]) - min_x, float(p[1]) - min_y) for p in poly]

        outer_mask = Image.new('L', (width, height), 0)
        inner_mask = Image.new('L', (width, height), 0)
        ImageDraw.Draw(outer_mask).polygon(_shift(outer_poly), fill=255)
        ImageDraw.Draw(inner_mask).polygon(_shift(inner_poly), fill=255)
        inter_mask = ImageChops.multiply(outer_mask, inner_mask)
        inner_area = inner_mask.tobytes().count(255)
        if inner_area <= 0:
            return None
        inter_area = inter_mask.tobytes().count(255)
        return float(inter_area) / float(inner_area)
    except Exception:
        return None


def _annotation_cover_ratio(
    bigger_ann: dict[str, Any],
    smaller_ann: dict[str, Any],
    *,
    spatial_mode: str,
) -> float:
    bigger_bbox = _ann_bbox(bigger_ann)
    smaller_bbox = _ann_bbox(smaller_ann)
    smaller_bbox_area = _bbox_area_value(smaller_bbox)
    if not bigger_bbox or not smaller_bbox or smaller_bbox_area <= 0.0:
        return 0.0

    bbox_cover = _bbox_intersection_area(bigger_bbox, smaller_bbox) / smaller_bbox_area
    if str(spatial_mode or 'instance_cover').strip().lower() == 'bbox_cover':
        return bbox_cover

    bigger_poly = _ann_polygon(bigger_ann)
    smaller_poly = _ann_polygon(smaller_ann)
    poly_cover = _polygon_cover_ratio(bigger_poly, smaller_poly)
    if poly_cover is not None:
        return poly_cover
    return bbox_cover


def _annotation_class_name(ann: dict[str, Any]) -> str:
    return str(ann.get('class_name') or ann.get('label') or '').strip()


def _class_tokens(raw: str) -> set[str]:
    return {norm_text(p) for p in re.split(r'[\s_\-]+', str(raw or '').strip()) if norm_text(p)}


def _class_matches_canonical_family(class_name: str, canonical_class: str) -> bool:
    cls_norm = norm_text(class_name)
    canon_norm = norm_text(canonical_class)
    if not cls_norm or not canon_norm:
        return False
    if cls_norm == canon_norm:
        return True
    cls_tokens = _class_tokens(class_name)
    canon_tokens = _class_tokens(canonical_class)
    if not cls_tokens or not canon_tokens:
        return False
    return cls_tokens.issubset(canon_tokens) or canon_tokens.issubset(cls_tokens)
