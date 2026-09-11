from __future__ import annotations

from dataclasses import replace
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from app.annotations.geometry import bbox_from_polygons, finite_number, parse_bbox, parse_polygon, polygon_area
from app.annotations.models import (
    AnnotationGeometry,
    AnnotationIssue,
    AnnotationProvenance,
    CanonicalAnnotation,
    ParseContext,
    ParsedImageAnnotations,
)
from app.annotations.sources import infer_annotation_source


_MASK_FIELDS = ('mask_url', 'mask_png_base64', 'mask_png')
_CONSUMED_FIELDS = {
    'id', 'class_name', 'label', 'score', 'confidence', 'bbox', 'bbox_xyxy', 'box',
    'polygon', 'polygons', 'mask_url', 'mask_png_base64', 'mask_png', 'area',
    'source_model', 'source', 'model_det_id', 'contour_index', 'contour_count',
    'component_count', '__mask_refs',
}


def _issue(code: str, severity: str = 'warning', field: str = '', **details: Any) -> AnnotationIssue:
    return AnnotationIssue(code, severity, field, MappingProxyType(details))  # type: ignore[arg-type]


def _raw_polygons(raw: Mapping[str, Any], issues: list[AnnotationIssue]) -> tuple[tuple[tuple[float, float], ...], ...]:
    regions: list[tuple[tuple[float, float], ...]] = []
    multi = raw.get('polygons')
    if isinstance(multi, list) and multi:
        for index, candidate in enumerate(multi):
            polygon, problem = parse_polygon(candidate, field=f'polygons[{index}]')
            if problem:
                issues.append(problem)
            elif polygon:
                regions.append(polygon)
        return tuple(regions)
    if multi not in (None, []) and not isinstance(multi, list):
        issues.append(_issue('INVALID_POLYGONS', 'error', 'polygons'))
    primary = raw.get('polygon')
    if primary in (None, []):
        return ()
    polygon, problem = parse_polygon(primary, field='polygon')
    if problem:
        issues.append(problem)
    elif polygon:
        regions.append(polygon)
    return tuple(regions)


def _mask_refs(raw: Mapping[str, Any]) -> tuple[str, ...]:
    explicit = raw.get('__mask_refs')
    values = [str(item).strip() for item in explicit] if isinstance(explicit, list) else []
    values.extend(str(raw.get(field) or '').strip() for field in _MASK_FIELDS)
    return tuple(dict.fromkeys(value for value in values if value))


def parse_annotation(
    raw: Mapping[str, Any],
    context: ParseContext | None = None,
    *,
    record_index: int = 0,
    source_annotation_ids: Iterable[str] | None = None,
    raw_record_count: int = 1,
    initial_issues: Iterable[AnnotationIssue] = (),
) -> CanonicalAnnotation:
    context = context or ParseContext()
    issues = list(initial_issues)
    raw_id = str(raw.get('id') or '').strip()
    instance_id = raw_id or f'{context.image_id or "image"}:ann:{record_index + 1}'
    if not raw_id:
        issues.append(_issue('MISSING_ANNOTATION_ID', 'warning', 'id'))

    class_name = str(raw.get('class_name') or raw.get('label') or '').strip()
    if not class_name:
        issues.append(_issue('MISSING_CLASS_NAME', 'warning', 'class_name'))

    score_value = raw.get('score') if raw.get('score') is not None else raw.get('confidence')
    score = finite_number(score_value)
    if score_value is not None and score is None:
        issues.append(_issue('INVALID_SCORE', 'warning', 'score'))

    producer = infer_annotation_source(raw)
    if producer.is_unknown:
        issues.append(_issue('SOURCE_UNKNOWN' if producer.raw_value else 'SOURCE_MISSING', 'warning', 'source_model'))

    regions = _raw_polygons(raw, issues)
    mask_refs = _mask_refs(raw)
    bbox = None
    bbox_origin = 'none'
    for key in ('bbox', 'bbox_xyxy', 'box'):
        if raw.get(key) not in (None, []):
            bbox, problem = parse_bbox(raw.get(key), field=key)
            if problem:
                issues.append(problem)
            if bbox:
                bbox_origin = 'provided'
                break
    if bbox is None and regions:
        bbox = bbox_from_polygons(regions)
        if bbox:
            bbox_origin = 'derived_polygon'

    out_of_bounds = False
    if bbox and context.image_width and context.image_height:
        out_of_bounds = bbox.x1 < 0 or bbox.y1 < 0 or bbox.x2 > context.image_width or bbox.y2 > context.image_height
        if out_of_bounds:
            issues.append(_issue('BBOX_OUT_OF_BOUNDS', 'warning', 'bbox'))

    raw_area_value = raw.get('area')
    raw_area = finite_number(raw_area_value)
    if raw_area_value is not None and (raw_area is None or raw_area <= 0):
        issues.append(_issue('INVALID_SEGMENTATION_AREA', 'warning', 'area'))
        raw_area = None
    computed_polygon_area = sum(polygon_area(region) for region in regions)
    if mask_refs:
        segmentation_area = raw_area if raw_area and raw_area > 0 else (computed_polygon_area or None)
    else:
        segmentation_area = computed_polygon_area or None

    if mask_refs:
        primary_geometry = 'mask'
    elif len(regions) > 1:
        primary_geometry = 'multi_polygon'
    elif regions:
        primary_geometry = 'polygon'
    elif bbox:
        primary_geometry = 'bbox_only'
    else:
        primary_geometry = 'invalid'
        issues.append(_issue('MISSING_VALID_GEOMETRY', 'error'))

    capabilities = set()
    if bbox:
        capabilities.add('detection')
    if regions or mask_refs:
        capabilities.add('instance_segmentation')

    raw_component_count = finite_number(raw.get('component_count')) or 0
    component_count = max(len(regions), int(raw_component_count), 1 if mask_refs else 0)
    bbox_area = bbox.area if bbox else None
    fill_ratio = segmentation_area / bbox_area if segmentation_area is not None and bbox_area else None
    if fill_ratio is not None and (fill_ratio < 0 or fill_ratio > 1.000001):
        issues.append(_issue('BBOX_FILL_RATIO_OUT_OF_RANGE', 'warning', 'area', value=fill_ratio))

    ids = tuple(str(value).strip() for value in (source_annotation_ids or (raw_id,)) if str(value).strip())
    attributes = MappingProxyType({key: value for key, value in raw.items() if key not in _CONSUMED_FIELDS})
    return CanonicalAnnotation(
        instance_id=instance_id,
        source_annotation_ids=ids,
        class_name=class_name,
        score=score,
        capabilities=frozenset(capabilities),  # type: ignore[arg-type]
        geometry=AnnotationGeometry(
            bbox=bbox,
            bbox_origin=bbox_origin,  # type: ignore[arg-type]
            regions=regions,
            mask_refs=mask_refs,
            primary_geometry=primary_geometry,  # type: ignore[arg-type]
            bbox_area_px=bbox_area,
            segmentation_area_px=segmentation_area,
            bbox_fill_ratio=fill_ratio,
            component_count=component_count,
            is_out_of_bounds=out_of_bounds,
        ),
        provenance=AnnotationProvenance(
            producer=producer,
        ),
        issues=tuple(issues),
        raw_record_count=max(1, int(raw_record_count)),
        attributes=attributes,
    )


def parse_image_annotations(records: Any, context: ParseContext | None = None) -> ParsedImageAnnotations:
    context = context or ParseContext()
    source_records = records if isinstance(records, list) else []
    mappings: list[tuple[int, Mapping[str, Any]]] = []
    for index, raw in enumerate(source_records):
        mappings.append((index, raw if isinstance(raw, Mapping) else {}))

    singles: list[tuple[int, Mapping[str, Any], tuple[AnnotationIssue, ...]]] = []
    for index, raw in mappings:
        initial: tuple[AnnotationIssue, ...] = () if raw else (_issue('INVALID_ANNOTATION_RECORD', 'error'),)
        if raw.get('contour_index') is not None or raw.get('contour_count') is not None:
            initial = (*initial, _issue(
                'UNSUPPORTED_SPLIT_ANNOTATION',
                'error',
                'contour_index' if raw.get('contour_index') is not None else 'contour_count',
            ))
        singles.append((index, raw, initial))

    instances: list[CanonicalAnnotation] = []
    instances.extend(parse_annotation(raw, context, record_index=index, initial_issues=issues) for index, raw, issues in singles)
    source_order: dict[str, int] = {}
    for index, raw in mappings:
        source_order.setdefault(str(raw.get('id') or '').strip(), index)
    instances.sort(key=lambda item: min(
        (source_order[source_id] for source_id in item.source_annotation_ids if source_id in source_order),
        default=len(mappings),
    ))
    seen_ids: dict[str, int] = {}
    unique_instances: list[CanonicalAnnotation] = []
    for instance in instances:
        sequence = seen_ids.get(instance.instance_id, 0) + 1
        seen_ids[instance.instance_id] = sequence
        if sequence == 1:
            unique_instances.append(instance)
            continue
        unique_instances.append(replace(
            instance,
            instance_id=f'{instance.instance_id}#{sequence}',
            issues=(*instance.issues, _issue('DUPLICATE_INSTANCE_ID', 'error', 'id')),
        ))
    return ParsedImageAnnotations(tuple(unique_instances), len(source_records))
