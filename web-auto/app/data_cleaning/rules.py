from __future__ import annotations

import math
from typing import Any, Iterable

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageDraw

from app.annotations import CanonicalAnnotation, parse_image_annotations
from app.utils import norm_text


def _canonical(annotation: CanonicalAnnotation | dict[str, Any]) -> CanonicalAnnotation:
    if isinstance(annotation, CanonicalAnnotation):
        return annotation
    return parse_image_annotations([annotation]).instances[0]


def _annotation_geometry_type(annotation: CanonicalAnnotation | dict[str, Any]) -> str:
    annotation = _canonical(annotation)
    if annotation.has_instance_segmentation:
        return 'segmentation'
    return 'bbox' if annotation.has_detection else 'invalid'


def image_scope_count(annotations: Iterable[CanonicalAnnotation], rule_classes: list[str]) -> int:
    wanted = {norm_text(x) for x in rule_classes if norm_text(x)}
    return sum(1 for ann in annotations if ann.class_name and (not wanted or norm_text(ann.class_name) in wanted))


def _metric_area(annotation: CanonicalAnnotation, area_mode: str) -> float:
    geometry = annotation.geometry
    if str(area_mode or 'instance') == 'bbox':
        return geometry.bbox_area_px or 0.0
    return geometry.segmentation_area_px or geometry.bbox_area_px or 0.0


def annotation_matches_rules(
    ann: CanonicalAnnotation | dict[str, Any],
    *,
    config: dict[str, Any],
    image_width: int,
    image_height: int,
) -> tuple[bool, bool]:
    """Return (matched, skipped_due_to_unavailable_input)."""
    ann = _canonical(ann)
    cls = ann.class_name
    wanted = {norm_text(x) for x in config.get('rule_classes', []) if norm_text(x)}
    if not cls or (wanted and norm_text(cls) not in wanted):
        return False, False

    checks: list[bool] = []
    bbox = ann.geometry.bbox
    if config.get('small_target_enabled'):
        if image_width <= 0 or image_height <= 0 or bbox is None:
            return False, True
        ratio = _metric_area(ann, str(config.get('area_mode') or 'instance')) / float(image_width * image_height)
        checks.append(ratio <= float(config.get('max_area_ratio') or 0.0))

    if config.get('position_enabled'):
        if image_width <= 0 or image_height <= 0 or bbox is None:
            return False, True
        cx, cy = bbox.center[0] / float(image_width), bbox.center[1] / float(image_height)
        inside = (
            abs(cx - 0.5) <= float(config.get('center_x_half_width') or 0.25)
            and abs(cy - 0.5) <= float(config.get('center_y_half_height') or 0.05)
        )
        checks.append(inside if config.get('position_match_mode', 'inside') == 'inside' else not inside)

    if config.get('confidence_enabled'):
        if ann.score is None:
            checks.append(bool(config.get('include_missing_confidence', False)))
        else:
            checks.append(
                float(config.get('min_confidence') or 0.0)
                <= ann.score
                <= float(config.get('max_confidence', 1.0))
            )

    if not checks:
        return bool(config.get('instance_count_enabled')), False
    return (all(checks) if config.get('rule_match_mode', 'all') == 'all' else any(checks)), False


def _bbox_cover(outer: CanonicalAnnotation, inner: CanonicalAnnotation) -> float:
    first, second = outer.geometry.bbox, inner.geometry.bbox
    if first is None or second is None or second.area <= 0:
        return 0.0
    width = max(0.0, min(first.x2, second.x2) - max(first.x1, second.x1))
    height = max(0.0, min(first.y2, second.y2) - max(first.y1, second.y1))
    return width * height / second.area


def _instance_cover(
    outer: CanonicalAnnotation,
    inner: CanonicalAnnotation,
    resolved_masks: dict[str, Image.Image] | None = None,
) -> float:
    if resolved_masks:
        outer_mask = resolved_masks.get(outer.instance_id)
        inner_mask = resolved_masks.get(inner.instance_id)
        if outer_mask is not None and inner_mask is not None and outer_mask.size == inner_mask.size:
            inner_binary = inner_mask.convert('1')
            inner_area = sum(inner_binary.histogram()[1:])
            if inner_area:
                intersection = ImageChops.logical_and(outer_mask.convert('1'), inner_binary)
                return float(sum(intersection.histogram()[1:])) / float(inner_area)
    outer_regions, inner_regions = outer.geometry.regions, inner.geometry.regions
    if not outer_regions or not inner_regions:
        return _bbox_cover(outer, inner)
    points = [point for region in (*outer_regions, *inner_regions) for point in region]
    min_x, min_y = math.floor(min(p[0] for p in points)) - 1, math.floor(min(p[1] for p in points)) - 1
    max_x, max_y = math.ceil(max(p[0] for p in points)) + 1, math.ceil(max(p[1] for p in points)) + 1
    size = (max(1, max_x - min_x + 1), max(1, max_y - min_y + 1))

    def raster(regions: Any) -> Image.Image:
        mask = Image.new('1', size, 0)
        draw = ImageDraw.Draw(mask)
        for region in regions:
            draw.polygon([(x - min_x, y - min_y) for x, y in region], fill=1)
        return mask

    outer_mask, inner_mask = raster(outer_regions), raster(inner_regions)
    inner_area = sum(inner_mask.histogram()[1:])
    return float(sum(ImageChops.logical_and(outer_mask, inner_mask).histogram()[1:])) / float(inner_area) if inner_area else 0.0


def analyze_merge_annotations(
    annotations: list[CanonicalAnnotation] | list[dict[str, Any]],
    config: dict[str, Any],
    *,
    resolved_masks: dict[str, Image.Image] | None = None,
) -> dict[str, Any]:
    canonical_annotations = (
        list(annotations)
        if all(isinstance(item, CanonicalAnnotation) for item in annotations)
        else list(parse_image_annotations(annotations).instances)
    )
    indexed: list[dict[str, Any]] = []
    for index, ann in enumerate(canonical_annotations):
        bbox, cls = ann.geometry.bbox, ann.class_name
        resolved = resolved_masks.get(ann.instance_id) if resolved_masks else None
        area = (
            float(sum(resolved.convert('L').histogram()[128:]))
            if resolved is not None and str(config.get('area_mode') or 'instance') != 'bbox'
            else _metric_area(ann, str(config.get('area_mode') or 'instance'))
        )
        if bbox is not None and cls and area > 0:
            indexed.append({
                'index': index, 'class_name': cls, 'area': area,
                'geometry_type': _annotation_geometry_type(ann),
            })

    canonical_mode = config.get('merge_mode') == 'canonical_class'
    canonical = str(config.get('canonical_class') or '').strip()
    sources = {norm_text(x) for x in config.get('source_classes', []) if norm_text(x)}
    if canonical_mode and (not canonical or not sources):
        raise HTTPException(status_code=400, detail='canonical_class and source_classes are required')

    remove: set[int] = set()
    relabel: set[int] = set()
    pairs: list[dict[str, Any]] = []
    if canonical_mode:
        family = sources | {norm_text(canonical)}
        groups = [[item for item in indexed if norm_text(item['class_name']) in family]]
    else:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for item in indexed:
            grouped.setdefault(norm_text(item['class_name']), []).append(item)
        groups = list(grouped.values())

    for group in groups:
        for geometry_type in ('segmentation', 'bbox'):
            same_geometry = [item for item in group if item['geometry_type'] == geometry_type]
            ordered = sorted(same_geometry, key=lambda item: (float(item['area']), -int(item['index'])), reverse=True)
            for pos, larger in enumerate(ordered):
                keep_index = int(larger['index'])
                if keep_index in remove:
                    continue
                for smaller in ordered[pos + 1:]:
                    remove_index = int(smaller['index'])
                    if remove_index in remove:
                        continue
                    coverage = (
                        _bbox_cover(canonical_annotations[keep_index], canonical_annotations[remove_index])
                        if str(config.get('spatial_mode') or 'instance_cover') == 'bbox_cover'
                        else _instance_cover(
                            canonical_annotations[keep_index], canonical_annotations[remove_index], resolved_masks,
                        )
                    )
                    if coverage < float(config.get('coverage_threshold') or 0.98):
                        continue
                    remove.add(remove_index)
                    if canonical_mode and norm_text(larger['class_name']) != norm_text(canonical):
                        relabel.add(keep_index)
                    pairs.append({'keep_index': keep_index, 'remove_index': remove_index, 'coverage': round(coverage, 6)})

    return {
        'delete_indices': sorted(remove),
        'relabels': [{'annotation_index': index, 'class_name': canonical} for index in sorted(relabel)],
        'pairs': pairs,
    }
