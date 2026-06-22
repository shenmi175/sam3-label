from __future__ import annotations

from typing import Any

from app.services.annotation_geometry import _bbox_from_polygon, _polygon_from_mask
from app.utils import norm_text


def _build_class_maps(classes: list[str]) -> tuple[dict[str, str], list[str]]:
    canonical: list[str] = []
    norm_to_real: dict[str, str] = {}
    for c in classes:
        real = str(c).strip()
        if not real:
            continue
        key = norm_text(real)
        if key in norm_to_real:
            continue
        norm_to_real[key] = real
        canonical.append(real)
    return norm_to_real, canonical


def _resolve_class_for_detection(det: dict[str, Any], classes: list[str]) -> str:
    raw_label = str(det.get('label') or '').strip()
    if raw_label:
        # Keep API label as-is; do not remap to project classes.
        return raw_label

    if not classes:
        return 'unknown'

    _, ordered = _build_class_maps(classes)

    cid = det.get('class_id')
    if isinstance(cid, int):
        if 0 <= cid < len(ordered):
            return ordered[cid]
        if 1 <= cid <= len(ordered):
            return ordered[cid - 1]

    if len(ordered) == 1:
        return ordered[0]
    return 'unknown'


def _convert_detections(
    *,
    detections: list[dict[str, Any]],
    classes: list[str],
    forced_class: str = '',
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, det in enumerate(detections, start=1):
        bbox = det.get('bbox_xyxy') or det.get('bbox') or []
        if not isinstance(bbox, list) or len(bbox) != 4:
            bbox = []

        polygon = det.get('polygon') if isinstance(det.get('polygon'), list) else []
        if len(polygon) < 3:
            polygon = _polygon_from_mask(det.get('mask_png_base64') or det.get('mask_png') or '')
        if (not bbox) and len(polygon) >= 3:
            bbox = _bbox_from_polygon(polygon)

        if not bbox and len(polygon) < 3:
            continue

        class_name = forced_class or _resolve_class_for_detection(det, classes)
        out.append(
            {
                'id': str(det.get('id') or f'det_{i:04d}'),
                'class_name': class_name,
                'raw_label': str(det.get('label') or ''),
                'score': float(det.get('score') or 0.0),
                'bbox': [float(v) for v in bbox] if bbox else [],
                'polygon': polygon if len(polygon) >= 3 else [],
                'area': float(det.get('area') or 0.0),
                'mask_png_base64': det.get('mask_png_base64') or '',
            }
        )
    return out


def _replace_by_classes(
    old_annotations: list[dict[str, Any]],
    *,
    impacted_classes: list[str],
    new_annotations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    impacted_norm: set[str] = set()
    for c in impacted_classes:
        raw = str(c).strip()
        if not raw:
            continue
        n = norm_text(raw)
        if n:
            impacted_norm.add(n)

    if not impacted_norm:
        return new_annotations

    kept: list[dict[str, Any]] = []
    for a in old_annotations:
        cls = str(a.get('class_name') or '').strip()
        cls_norm = norm_text(cls)
        if not cls_norm:
            kept.append(a)
            continue
        if cls_norm in impacted_norm:
            continue
        kept.append(a)

    kept.extend(new_annotations)
    return kept
