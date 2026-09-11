from __future__ import annotations

import math
from typing import Any, Mapping

from app.annotations.geometry import bbox_from_polygons, finite_number, parse_bbox, parse_polygon, polygon_area
from app.annotations.sources import infer_annotation_source, normalize_source


ANNOTATION_SCHEMA_VERSION = 3

_CORE_FIELDS = (
    'schema_version',
    'id',
    'class_name',
    'raw_label',
    'score',
    'bbox',
    'polygon',
    'polygons',
    'area',
    'mask_url',
    'overlay_url',
    'source_model',
    'component_count',
    'edited',
    'modified_by',
    'accepted_by',
    'ai_assisted_by',
    'created_at',
    'updated_at',
)

_LEGACY_OR_INTERNAL_FIELDS = {
    'source',
    'label',
    'confidence',
    'bbox_xyxy',
    'box',
    'points',
    'mask_png',
    'mask_png_base64',
    '__invalidate_mask',
    '__geometry_edited',
}


def _string(value: Any) -> str:
    return str(value or '').strip()


def _number(value: Any) -> float | None:
    parsed = finite_number(value)
    return float(parsed) if parsed is not None else None


def _bbox(raw: Mapping[str, Any]) -> list[float]:
    for field in ('bbox', 'bbox_xyxy', 'box'):
        value = raw.get(field)
        if value in (None, []):
            continue
        parsed, _issue = parse_bbox(value, field=field)
        if parsed:
            return [parsed.x1, parsed.y1, parsed.x2, parsed.y2]
    return []


def _polygon(value: Any) -> list[list[float]]:
    if value in (None, []):
        return []
    parsed, _issue = parse_polygon(value, field='polygon')
    if not parsed:
        return []
    return [[float(x), float(y)] for x, y in parsed]


def _polygons(raw: Mapping[str, Any]) -> tuple[list[list[float]], list[list[list[float]]]]:
    regions: list[list[list[float]]] = []
    multi = raw.get('polygons')
    if isinstance(multi, list):
        regions = [candidate for value in multi if (candidate := _polygon(value))]
    primary = _polygon(raw.get('polygon') if raw.get('polygon') not in (None, []) else raw.get('points'))
    if primary and not regions:
        regions = [primary]
    if regions and not primary:
        primary = max(
            regions,
            key=lambda region: polygon_area(tuple((point[0], point[1]) for point in region)),
        )
    return primary, regions


def _source(raw: Mapping[str, Any], *, manual_source: str) -> str:
    producer = infer_annotation_source(raw).source_id
    if producer == 'manual':
        replacement = normalize_source(manual_source).source_id
        return replacement if replacement not in {'manual', 'unknown'} else 'sam3'
    return producer


def normalize_annotation_record(
    raw: Mapping[str, Any],
    *,
    manual_source: str = 'sam3',
) -> dict[str, Any]:
    """Return one source-neutral, fixed-field annotation record.

    ``source_model`` identifies the result layer. Human interaction is retained
    only in the audit fields and never becomes a producer source. Legacy aliases
    remain accepted at ingestion but are not emitted.
    """
    geometry_edited = bool(raw.get('__geometry_edited'))
    class_name = _string(raw.get('class_name') or raw.get('label'))
    primary, regions = _polygons(raw)
    bbox = _bbox(raw)
    parsed_regions = tuple(
        tuple((float(point[0]), float(point[1])) for point in region)
        for region in regions
    )
    if (geometry_edited or not bbox) and parsed_regions:
        derived = bbox_from_polygons(parsed_regions)
        if derived:
            bbox = [derived.x1, derived.y1, derived.x2, derived.y2]

    mask_url = _string(raw.get('mask_url'))
    area = _number(raw.get('area'))
    if geometry_edited:
        area = sum(polygon_area(region) for region in parsed_regions) or None
    elif area is not None and (not math.isfinite(area) or area <= 0):
        area = None
    if area is None and parsed_regions:
        area = sum(polygon_area(region) for region in parsed_regions) or None
    if not parsed_regions and not mask_url:
        area = None

    component_count = len(regions) if regions else (1 if mask_url else 0)
    score = _number(raw.get('score') if raw.get('score') is not None else raw.get('confidence'))
    normalized: dict[str, Any] = {
        'schema_version': ANNOTATION_SCHEMA_VERSION,
        'id': _string(raw.get('id')),
        'class_name': class_name,
        'raw_label': _string(raw.get('raw_label')) or class_name,
        'score': score,
        'bbox': bbox,
        'polygon': primary,
        'polygons': regions,
        'area': area,
        'mask_url': mask_url,
        'overlay_url': _string(raw.get('overlay_url')),
        'source_model': _source(raw, manual_source=manual_source),
        'component_count': component_count,
        'edited': bool(raw.get('edited')),
        'modified_by': _string(raw.get('modified_by')),
        'accepted_by': _string(raw.get('accepted_by')),
        'ai_assisted_by': _string(raw.get('ai_assisted_by')),
        'created_at': _string(raw.get('created_at')),
        'updated_at': _string(raw.get('updated_at')),
    }
    for key, value in raw.items():
        if key in normalized or key in _LEGACY_OR_INTERNAL_FIELDS:
            continue
        normalized[str(key)] = value
    return normalized


def normalize_annotation_records(
    records: Any,
    *,
    manual_source: str = 'sam3',
) -> list[dict[str, Any]]:
    if not isinstance(records, list):
        return []
    return [
        normalize_annotation_record(raw, manual_source=manual_source)
        for raw in records
        if isinstance(raw, Mapping)
    ]


def annotation_core_fields() -> tuple[str, ...]:
    return _CORE_FIELDS
