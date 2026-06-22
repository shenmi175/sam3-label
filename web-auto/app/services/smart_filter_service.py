from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.schemas import SmartFilterIn
from app.services.annotation_geometry import (
    _ann_bbox,
    _annotation_class_name,
    _annotation_cover_ratio,
    _annotation_metric_area,
)
from app.utils import norm_text


def _annotation_score(ann: dict[str, Any]) -> float:
    try:
        return float(ann.get('score') or ann.get('confidence') or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _get_image_dimensions(image: dict[str, Any]) -> tuple[int, int]:
    image_path = str(image.get('abs_path') or '').strip()
    if not image_path:
        return 0, 0
    try:
        from PIL import Image  # type: ignore

        with Image.open(image_path) as im:
            width, height = im.size
        return max(0, int(width)), max(0, int(height))
    except Exception:
        return 0, 0


def _annotation_has_any_class(
    annotations: list[dict[str, Any]],
    class_names: list[str],
) -> bool:
    wanted = {norm_text(x) for x in class_names if norm_text(x)}
    if not wanted:
        return bool(annotations)
    for ann in annotations:
        if norm_text(str(ann.get('class_name') or '')) in wanted:
            return True
    return False


def _smart_filter_image_scope_count(
    annotations: list[dict[str, Any]],
    *,
    rule_classes: list[str],
) -> int:
    wanted = {norm_text(x) for x in rule_classes if norm_text(x)}
    if not wanted:
        return len([ann for ann in annotations if _annotation_class_name(ann)])
    count = 0
    for ann in annotations:
        cls_norm = norm_text(_annotation_class_name(ann))
        if cls_norm in wanted:
            count += 1
    return count


def _smart_filter_annotation_allowed(
    ann: dict[str, Any],
    *,
    area_mode: str,
    rule_classes: list[str],
    image_width: int,
    image_height: int,
    small_target_enabled: bool,
    max_area_ratio: float,
    position_enabled: bool,
    center_x_half_width: float,
    center_y_half_height: float,
    confidence_enabled: bool,
    min_confidence: float,
    max_confidence: float,
    require_geometry: bool = False,
) -> bool:
    cls = _annotation_class_name(ann)
    if not cls:
        return False
    wanted = {norm_text(x) for x in rule_classes if norm_text(x)}
    cls_norm = norm_text(cls)
    if wanted and cls_norm not in wanted:
        return False

    score = _annotation_score(ann)
    if confidence_enabled and not (float(min_confidence) <= score <= float(max_confidence)):
        return False

    bbox = _ann_bbox(ann)
    if require_geometry and not bbox:
        return False

    if small_target_enabled and image_width > 0 and image_height > 0:
        if not bbox:
            return False
        image_area = float(image_width * image_height)
        ann_area = _annotation_metric_area(ann, area_mode=area_mode)
        if image_area > 0.0 and (ann_area / image_area) > float(max_area_ratio):
            return False

    if position_enabled and image_width > 0 and image_height > 0:
        if not bbox:
            return False
        cx = ((bbox[0] + bbox[2]) / 2.0) / float(image_width)
        cy = ((bbox[1] + bbox[3]) / 2.0) / float(image_height)
        if abs(cx - 0.5) > float(center_x_half_width):
            return False
        if abs(cy - 0.5) > float(center_y_half_height):
            return False

    return True


def _smart_filter_signature(
    *,
    operation_mode: str,
    merge_mode: str,
    spatial_mode: str,
    coverage_threshold: float,
    canonical_class: str,
    source_classes: list[str],
    area_mode: str,
    rule_classes: list[str],
    small_target_enabled: bool,
    max_area_ratio: float,
    instance_count_enabled: bool,
    min_instances: int,
    max_instances: int,
    position_enabled: bool,
    center_x_half_width: float,
    center_y_half_height: float,
    confidence_enabled: bool,
    min_confidence: float,
    max_confidence: float,
) -> str:
    source = sorted(str(x).strip() for x in source_classes if str(x).strip())
    rules = sorted(str(x).strip() for x in rule_classes if str(x).strip())
    return '|'.join(
        [
            str(operation_mode or 'merge').strip().lower(),
            str(merge_mode or 'same_class').strip().lower(),
            str(spatial_mode or 'instance_cover').strip().lower(),
            f'{float(coverage_threshold):.6f}',
            str(canonical_class or '').strip(),
            ','.join(source),
            str(area_mode or 'instance').strip().lower(),
            ','.join(rules),
            '1' if small_target_enabled else '0',
            f'{float(max_area_ratio):.6f}',
            '1' if instance_count_enabled else '0',
            str(max(0, int(min_instances))),
            str(max(0, int(max_instances))),
            '1' if position_enabled else '0',
            f'{float(center_x_half_width):.6f}',
            f'{float(center_y_half_height):.6f}',
            '1' if confidence_enabled else '0',
            f'{float(min_confidence):.6f}',
            f'{float(max_confidence):.6f}',
        ]
    )


def _normalize_smart_filter_payload(payload: SmartFilterIn) -> dict[str, Any]:
    operation_mode = str(payload.operation_mode or 'merge').strip().lower()
    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
    spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
    canonical_class = str(payload.canonical_class or '').strip()
    source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
    area_mode = str(payload.area_mode or 'instance').strip().lower()
    rule_classes = [str(x).strip() for x in payload.rule_classes if str(x).strip()]
    small_target_enabled = bool(payload.small_target_enabled)
    max_area_ratio = max(0.0, min(1.0, float(payload.max_area_ratio or 0.0)))
    instance_count_enabled = bool(payload.instance_count_enabled)
    min_instances = max(0, int(payload.min_instances or 0))
    max_instances = max(0, int(payload.max_instances or 0))
    position_enabled = bool(payload.position_enabled)
    center_x_half_width = max(0.0, min(0.5, float(payload.center_x_half_width or 0.25)))
    center_y_half_height = max(0.0, min(0.5, float(payload.center_y_half_height or 0.05)))
    confidence_enabled = bool(payload.confidence_enabled)
    min_confidence = max(0.0, min(1.0, float(payload.min_confidence or 0.0)))
    max_confidence = max(0.0, min(1.0, float(payload.max_confidence if payload.max_confidence is not None else 1.0)))
    if operation_mode == 'merge' and merge_mode == 'canonical_class' and not canonical_class:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if operation_mode == 'merge' and merge_mode == 'canonical_class' and not source_classes:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')
    if instance_count_enabled and max_instances > 0 and max_instances < min_instances:
        raise HTTPException(status_code=400, detail='max_instances must be >= min_instances')
    if confidence_enabled and max_confidence < min_confidence:
        raise HTTPException(status_code=400, detail='max_confidence must be >= min_confidence')
    if operation_mode == 'rule' and not (
        small_target_enabled
        or instance_count_enabled
        or position_enabled
        or confidence_enabled
    ):
        raise HTTPException(status_code=400, detail='rule filter requires at least one enabled rule')
    return {
        'project_id': str(payload.project_id or '').strip(),
        'operation_mode': operation_mode,
        'merge_mode': merge_mode,
        'spatial_mode': spatial_mode,
        'coverage_threshold': coverage_threshold,
        'canonical_class': canonical_class,
        'source_classes': source_classes,
        'area_mode': area_mode,
        'rule_classes': rule_classes,
        'small_target_enabled': small_target_enabled,
        'max_area_ratio': max_area_ratio,
        'instance_count_enabled': instance_count_enabled,
        'min_instances': min_instances,
        'max_instances': max_instances,
        'position_enabled': position_enabled,
        'center_x_half_width': center_x_half_width,
        'center_y_half_height': center_y_half_height,
        'confidence_enabled': confidence_enabled,
        'min_confidence': min_confidence,
        'max_confidence': max_confidence,
        'preview_token': str(payload.preview_token or '').strip(),
        'signature': _smart_filter_signature(
            operation_mode=operation_mode,
            merge_mode=merge_mode,
            spatial_mode=spatial_mode,
            coverage_threshold=coverage_threshold,
            canonical_class=canonical_class,
            source_classes=source_classes,
            area_mode=area_mode,
            rule_classes=rule_classes,
            small_target_enabled=small_target_enabled,
            max_area_ratio=max_area_ratio,
            instance_count_enabled=instance_count_enabled,
            min_instances=min_instances,
            max_instances=max_instances,
            position_enabled=position_enabled,
            center_x_half_width=center_x_half_width,
            center_y_half_height=center_y_half_height,
            confidence_enabled=confidence_enabled,
            min_confidence=min_confidence,
            max_confidence=max_confidence,
        ),
    }


def _analyze_smart_merge_annotations(
    annotations: list[dict[str, Any]],
    *,
    merge_mode: str = 'same_class',
    spatial_mode: str = 'instance_cover',
    coverage_threshold: float = 0.98,
    canonical_class: str = '',
    source_classes: list[str] | None = None,
    area_mode: str = 'instance',
) -> dict[str, Any]:
    anns = [dict(a) for a in annotations if isinstance(a, dict)]
    if not anns:
        return {'pairs': [], 'remove_indices': set(), 'kept_annotations': [], 'removed_annotations': []}

    indexed: list[dict[str, Any]] = []
    for idx, ann in enumerate(anns):
        bbox = _ann_bbox(ann)
        cls = _annotation_class_name(ann)
        area = _annotation_metric_area(ann, area_mode=area_mode)
        if not bbox or not cls or area <= 0.0:
            continue
        indexed.append({'idx': idx, 'class_name': cls, 'bbox': bbox, 'area': area})

    use_canonical = str(merge_mode or 'same_class').strip().lower() == 'canonical_class'
    canonical = str(canonical_class or '').strip()
    selected_sources = [str(x).strip() for x in (source_classes or []) if str(x).strip()]
    selected_source_norm = {norm_text(x) for x in selected_sources if norm_text(x)}
    remove_indices: set[int] = set()
    relabel_indices: set[int] = set()
    pairs: list[dict[str, Any]] = []

    if use_canonical and not canonical:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if use_canonical and not selected_source_norm:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

    if use_canonical:
        canonical_norm = norm_text(canonical)
        candidate_items = []
        for item in indexed:
            item_norm = norm_text(str(item['class_name']))
            if not item_norm:
                continue
            if item_norm == canonical_norm or item_norm in selected_source_norm:
                candidate_items.append(item)
        items_sorted = sorted(candidate_items, key=lambda x: (float(x['area']), str(x['idx'])), reverse=True)
        for i, bigger in enumerate(items_sorted):
            keep_idx = int(bigger['idx'])
            if keep_idx in remove_indices:
                continue
            for smaller in items_sorted[i + 1:]:
                s_idx = int(smaller['idx'])
                if s_idx in remove_indices or s_idx == keep_idx:
                    continue
                smaller_area = max(float(smaller['area']), 0.0)
                if smaller_area <= 0.0:
                    continue
                cover = _annotation_cover_ratio(
                    anns[keep_idx],
                    anns[s_idx],
                    spatial_mode=spatial_mode,
                )
                if cover < float(coverage_threshold):
                    continue
                remove_indices.add(s_idx)
                if norm_text(str(bigger['class_name'])) != canonical_norm:
                    relabel_indices.add(keep_idx)
                pairs.append(
                    {
                        'keep_index': keep_idx,
                        'remove_index': s_idx,
                        'keep_class_name': str(bigger['class_name']),
                        'remove_class_name': str(smaller['class_name']),
                        'merged_class_name': canonical,
                        'coverage': round(cover, 6),
                        'kept_area': round(float(bigger['area']), 3),
                        'removed_area': round(smaller_area, 3),
                    }
                )
    else:
        by_class: dict[str, list[dict[str, Any]]] = {}
        for item in indexed:
            by_class.setdefault(norm_text(item['class_name']), []).append(item)

        for items in by_class.values():
            items_sorted = sorted(items, key=lambda x: (float(x['area']), str(x['idx'])), reverse=True)
            for i, bigger in enumerate(items_sorted):
                if int(bigger['idx']) in remove_indices:
                    continue
                for smaller in items_sorted[i + 1:]:
                    s_idx = int(smaller['idx'])
                    if s_idx in remove_indices:
                        continue
                    smaller_area = max(float(smaller['area']), 0.0)
                    if smaller_area <= 0.0:
                        continue
                    cover = _annotation_cover_ratio(
                        anns[int(bigger['idx'])],
                        anns[s_idx],
                        spatial_mode=spatial_mode,
                    )
                    if cover < float(coverage_threshold):
                        continue
                    remove_indices.add(s_idx)
                    pairs.append(
                        {
                            'keep_index': int(bigger['idx']),
                            'remove_index': s_idx,
                            'keep_class_name': str(bigger['class_name']),
                            'remove_class_name': str(smaller['class_name']),
                            'merged_class_name': str(bigger['class_name']),
                            'coverage': round(cover, 6),
                            'kept_area': round(float(bigger['area']), 3),
                            'removed_area': round(smaller_area, 3),
                        }
                    )

    kept_annotations: list[dict[str, Any]] = []
    relabeled_annotations: list[dict[str, Any]] = []
    for idx, ann in enumerate(anns):
        if idx in remove_indices:
            continue
        item = dict(ann)
        if use_canonical and idx in relabel_indices:
            item['class_name'] = canonical
            relabeled_annotations.append(dict(item))
        kept_annotations.append(item)
    removed_annotations = [ann for idx, ann in enumerate(anns) if idx in remove_indices]
    return {
        'pairs': pairs,
        'remove_indices': remove_indices,
        'kept_annotations': kept_annotations,
        'removed_annotations': removed_annotations,
        'relabel_indices': relabel_indices,
        'relabeled_annotations': relabeled_annotations,
    }
