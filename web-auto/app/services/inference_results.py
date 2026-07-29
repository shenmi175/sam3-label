from __future__ import annotations

from typing import Any

from app.services.annotation_geometry import _bbox_from_polygon, _mask_components_from_base64
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
    source_model: str = 'sam3',
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, det in enumerate(detections, start=1):
        bbox = det.get('bbox_xyxy') or det.get('bbox') or []
        if not isinstance(bbox, list) or len(bbox) != 4:
            bbox = []

        class_name = forced_class or _resolve_class_for_detection(det, classes)
        metadata: dict[str, Any] = {}
        for key in ('model_det_id', 'contour_index', 'contour_count'):
            if det.get(key) is not None:
                metadata[key] = det.get(key)

        polygon = det.get('polygon') if isinstance(det.get('polygon'), list) else []
        if len(polygon) >= 3:
            if (not bbox) and len(polygon) >= 3:
                bbox = _bbox_from_polygon(polygon)

            if not bbox:
                continue

            out.append(
                {
                    'id': str(det.get('id') or f'det_{i:04d}'),
                    'class_name': class_name,
                    'raw_label': str(det.get('label') or ''),
                    'score': float(det.get('score') or 0.0),
                    'bbox': [float(v) for v in bbox] if bbox else [],
                    'polygon': polygon,
                    'area': float(det.get('area') or 0.0),
                    'mask_png_base64': det.get('mask_png_base64') or '',
                    'source_model': source_model,
                    **metadata,
                }
            )
            continue

        mask_b64 = det.get('mask_png_base64') or det.get('mask_png') or ''
        if isinstance(mask_b64, str) and mask_b64:
            components = _mask_components_from_base64(mask_b64)
            if not components:
                continue
            model_det_id = str(det.get('model_det_id') or det.get('id') or f'det_{i:04d}')
            contour_count = len(components)
            for contour_idx, component in enumerate(components, start=1):
                component_polygon = component.get('polygon') if isinstance(component, dict) else []
                if not isinstance(component_polygon, list) or len(component_polygon) < 3:
                    continue
                component_bbox = bbox
                if not component_bbox:
                    component_bbox = _bbox_from_polygon(component_polygon)
                if not component_bbox:
                    continue
                component_metadata = dict(metadata)
                component_metadata.setdefault('model_det_id', model_det_id)
                component_metadata['contour_index'] = contour_idx
                component_metadata['contour_count'] = contour_count
                out.append(
                    {
                        'id': f'{model_det_id}_c{contour_idx:03d}',
                        'class_name': class_name,
                        'raw_label': str(det.get('label') or ''),
                        'score': float(det.get('score') or 0.0),
                        'bbox': [float(v) for v in component_bbox] if component_bbox else [],
                        'polygon': component_polygon,
                        'area': float(component.get('area') or 0.0),
                        'mask_png_base64': component.get('mask_png_base64') or '',
                        'source_model': source_model,
                        **component_metadata,
                    }
                )
            continue

        # bbox-only branch: polygon < 3 points AND no mask, but a valid bbox is
        # present. Used by locate-anything-api and any future detector that
        # emits bounding boxes without a segmentation polygon/mask.
        if bbox and len(bbox) == 4:
            out.append(
                {
                    'id': str(det.get('id') or f'det_{i:04d}'),
                    'class_name': class_name,
                    'raw_label': str(det.get('label') or ''),
                    'score': float(det.get('score') or 0.0),
                    'bbox': [float(v) for v in bbox],
                    'polygon': [],
                    'area': float(det.get('area') or 0.0)
                        or max(0.0, (float(bbox[2]) - float(bbox[0])) * (float(bbox[3]) - float(bbox[1]))),
                    'mask_png_base64': '',
                    'source_model': source_model,
                    **metadata,
                }
            )
            continue

        if not bbox and len(polygon) < 3:
            continue

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
                'source_model': source_model,
                **metadata,
            }
        )
    return out


def _replace_by_classes(
    old_annotations: list[dict[str, Any]],
    *,
    impacted_classes: list[str],
    new_annotations: list[dict[str, Any]],
    source_model: str = 'sam3',
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
        ann_source = str(a.get('source_model') or '').strip()
        if cls_norm in impacted_norm and (not ann_source or ann_source == source_model):
            continue
        kept.append(a)

    kept.extend(new_annotations)
    return kept
