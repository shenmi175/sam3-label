from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.schemas import SmartFilterIn
from app.services.annotation_geometry import (
    _ann_bbox,
    _annotation_class_name,
    _annotation_cover_ratio,
    _annotation_metric_area,
)
from app.utils import new_id, norm_text, now_ts


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


def _analyze_smart_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    load_annotations: Callable[[str, str], list[dict[str, Any]]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    operation_mode = str(config.get('operation_mode') or 'merge').strip().lower()
    if operation_mode == 'delete_unlabeled':
        return _analyze_delete_unlabeled_filter_project(
            project=project,
            config=config,
            load_annotations=load_annotations,
            progress_cb=progress_cb,
        )
    if operation_mode == 'rule':
        return _analyze_rule_filter_project(
            project=project,
            config=config,
            load_annotations=load_annotations,
            progress_cb=progress_cb,
        )

    return _analyze_merge_filter_project(
        project=project,
        config=config,
        load_annotations=load_annotations,
        progress_cb=progress_cb,
    )


def _analyze_delete_unlabeled_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    load_annotations: Callable[[str, str], list[dict[str, Any]]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images', []), list) else []
    total = len(images)
    items: list[dict[str, Any]] = []
    apply_items: list[dict[str, Any]] = []

    if progress_cb:
        progress_cb(
            message=f'无标注图片扫描准备中，待扫描 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    project_id = str(config.get('project_id') or project.get('id') or '')
    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = load_annotations(project_id, image_id)
        if not annotations:
            item = {
                'image_id': image_id,
                'rel_path': rel_path,
                'candidate_count': 1,
                'relabel_count': 0,
                'pair_count': 0,
            }
            items.append(item)
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': 1,
                    'relabel_count': 0,
                }
            )

        if progress_cb:
            progress_cb(
                message=f'无标注图片扫描 {idx}/{total}: {rel_path}',
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    return {
        'image_count': len(items),
        'candidate_count': len(items),
        'relabel_count': 0,
        'items': items,
        'apply_items': apply_items,
    }


def _analyze_merge_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    load_annotations: Callable[[str, str], list[dict[str, Any]]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images', []), list) else []
    total = len(images)
    items: list[dict[str, Any]] = []
    apply_items: list[dict[str, Any]] = []
    total_candidates = 0
    total_images = 0
    total_relabels = 0

    if progress_cb:
        progress_cb(
            message=f'准备智能过滤分析，待扫描 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    need_image_metrics = bool(config.get('small_target_enabled')) or bool(config.get('position_enabled'))

    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = load_annotations(str(project.get('id') or ''), image_id)

        scoped_count = _smart_filter_image_scope_count(
            annotations,
            rule_classes=list(config.get('rule_classes') or []),
        )
        if bool(config.get('instance_count_enabled')):
            min_instances = max(0, int(config.get('min_instances') or 0))
            max_instances = max(0, int(config.get('max_instances') or 0))
            if scoped_count < min_instances or (max_instances > 0 and scoped_count > max_instances):
                if progress_cb:
                    progress_cb(
                        message=f'分析 {idx}/{total}: {rel_path}',
                        progress_done=idx,
                        progress_total=total,
                        current_image_id=image_id,
                        current_image_rel_path=rel_path,
                    )
                continue

        width, height = _get_image_dimensions(image) if need_image_metrics else (0, 0)
        filtered_annotations: list[dict[str, Any]] = []
        untouched_annotations: list[dict[str, Any]] = []
        for ann in annotations:
            if _smart_filter_annotation_allowed(
                ann,
                area_mode=str(config.get('area_mode') or 'instance'),
                rule_classes=list(config.get('rule_classes') or []),
                image_width=width,
                image_height=height,
                small_target_enabled=bool(config.get('small_target_enabled')),
                max_area_ratio=float(config.get('max_area_ratio') or 0.0),
                position_enabled=bool(config.get('position_enabled')),
                center_x_half_width=float(config.get('center_x_half_width') or 0.25),
                center_y_half_height=float(config.get('center_y_half_height') or 0.05),
                confidence_enabled=bool(config.get('confidence_enabled')),
                min_confidence=float(config.get('min_confidence') or 0.0),
                max_confidence=float(config.get('max_confidence') if config.get('max_confidence') is not None else 1.0),
                require_geometry=True,
            ):
                filtered_annotations.append(ann)
            else:
                untouched_annotations.append(ann)

        analysis = _analyze_smart_merge_annotations(
            filtered_annotations,
            merge_mode=str(config.get('merge_mode') or 'same_class'),
            spatial_mode=str(config.get('spatial_mode') or 'instance_cover'),
            coverage_threshold=float(config.get('coverage_threshold') or 0.98),
            canonical_class=str(config.get('canonical_class') or ''),
            source_classes=list(config.get('source_classes') or []),
            area_mode=str(config.get('area_mode') or 'instance'),
        )
        removed = analysis.get('removed_annotations', [])
        pairs = analysis.get('pairs', [])
        relabeled = analysis.get('relabeled_annotations', [])
        kept_filtered = analysis.get('kept_annotations', filtered_annotations)
        kept_annotations = list(untouched_annotations) + (
            kept_filtered if isinstance(kept_filtered, list) else filtered_annotations
        )
        remove_count = len(removed) if isinstance(removed, list) else 0
        relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
        if remove_count > 0 or relabel_count > 0:
            total_candidates += remove_count
            total_relabels += relabel_count
            total_images += 1
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'candidate_count': remove_count,
                    'relabel_count': relabel_count,
                    'pair_count': len(pairs) if isinstance(pairs, list) else 0,
                    'scoped_annotation_count': len(filtered_annotations),
                }
            )
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': remove_count,
                    'relabel_count': relabel_count,
                    'kept_annotations': kept_annotations,
                }
            )
        if progress_cb:
            progress_cb(
                message=f'分析 {idx}/{total}: {rel_path}',
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    items.sort(
        key=lambda x: (
            int(x.get('candidate_count') or 0),
            int(x.get('relabel_count') or 0),
            str(x.get('rel_path') or ''),
        ),
        reverse=True,
    )
    apply_items.sort(
        key=lambda x: (
            int(x.get('removed_count') or 0),
            int(x.get('relabel_count') or 0),
            str(x.get('rel_path') or ''),
        ),
        reverse=True,
    )
    return {
        'image_count': total_images,
        'candidate_count': total_candidates,
        'relabel_count': total_relabels,
        'items': items,
        'apply_items': apply_items,
    }


def _analyze_rule_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    load_annotations: Callable[[str, str], list[dict[str, Any]]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images', []), list) else []
    total = len(images)
    items: list[dict[str, Any]] = []
    apply_items: list[dict[str, Any]] = []
    total_candidates = 0
    total_images = 0

    if progress_cb:
        progress_cb(
            message=f'规则过滤预览准备中，待扫描 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    need_image_metrics = bool(config.get('small_target_enabled')) or bool(config.get('position_enabled'))

    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = load_annotations(str(project.get('id') or ''), image_id)

        scoped_count = _smart_filter_image_scope_count(
            annotations,
            rule_classes=list(config.get('rule_classes') or []),
        )
        if bool(config.get('instance_count_enabled')):
            min_instances = max(0, int(config.get('min_instances') or 0))
            max_instances = max(0, int(config.get('max_instances') or 0))
            if scoped_count < min_instances or (max_instances > 0 and scoped_count > max_instances):
                if progress_cb:
                    progress_cb(
                        message=f'规则过滤 {idx}/{total}: {rel_path}',
                        progress_done=idx,
                        progress_total=total,
                        current_image_id=image_id,
                        current_image_rel_path=rel_path,
                    )
                continue

        width, height = _get_image_dimensions(image) if need_image_metrics else (0, 0)
        matched_annotations: list[dict[str, Any]] = []
        kept_annotations: list[dict[str, Any]] = []
        for ann in annotations:
            if _smart_filter_annotation_allowed(
                ann,
                area_mode=str(config.get('area_mode') or 'instance'),
                rule_classes=list(config.get('rule_classes') or []),
                image_width=width,
                image_height=height,
                small_target_enabled=bool(config.get('small_target_enabled')),
                max_area_ratio=float(config.get('max_area_ratio') or 0.0),
                position_enabled=bool(config.get('position_enabled')),
                center_x_half_width=float(config.get('center_x_half_width') or 0.25),
                center_y_half_height=float(config.get('center_y_half_height') or 0.05),
                confidence_enabled=bool(config.get('confidence_enabled')),
                min_confidence=float(config.get('min_confidence') or 0.0),
                max_confidence=float(config.get('max_confidence') if config.get('max_confidence') is not None else 1.0),
                require_geometry=False,
            ):
                matched_annotations.append(ann)
            else:
                kept_annotations.append(ann)

        matched_count = len(matched_annotations)
        if matched_count > 0:
            total_candidates += matched_count
            total_images += 1
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'candidate_count': matched_count,
                    'relabel_count': 0,
                    'pair_count': 0,
                }
            )
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': matched_count,
                    'relabel_count': 0,
                    'kept_annotations': kept_annotations,
                }
            )

        if progress_cb:
            progress_cb(
                message=f'规则过滤 {idx}/{total}: {rel_path}',
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    items.sort(key=lambda x: (int(x.get('candidate_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    apply_items.sort(key=lambda x: (int(x.get('removed_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    return {
        'image_count': total_images,
        'candidate_count': total_candidates,
        'relabel_count': 0,
        'items': items,
        'apply_items': apply_items,
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


class SmartFilterJobService:
    def __init__(self, *, get_storage: Callable[[], Any], logger: logging.Logger) -> None:
        self._get_storage = get_storage
        self._logger = logger
        self._lock = threading.Lock()
        self._threads: dict[str, dict[str, Any]] = {}
        self._states: dict[str, dict[str, Any]] = {}
        self._project_active: dict[str, str] = {}
        self._preview_cache: dict[str, dict[str, Any]] = {}

    def _state_default(self, *, job_id: str, project_id: str, job_type: str) -> dict[str, Any]:
        return {
            'job_id': job_id,
            'project_id': project_id,
            'job_type': job_type,
            'status': 'queued',
            'running': False,
            'message': 'waiting',
            'progress_done': 0,
            'progress_total': 0,
            'progress_pct': 0.0,
            'current_image_id': '',
            'current_image_rel_path': '',
            'started_at': '',
            'updated_at': now_ts(),
            'finished_at': '',
            'error': '',
            'params': {},
            'payload_dict': {},
            'result': {},
        }

    def _cleanup_project_slot(self, project_id: str) -> None:
        active_job_id = str(self._project_active.get(project_id) or '').strip()
        if not active_job_id:
            return
        holder = self._threads.get(active_job_id) or {}
        thread = holder.get('thread')
        if thread and thread.is_alive():
            return
        self._threads.pop(active_job_id, None)
        if self._project_active.get(project_id) == active_job_id:
            self._project_active.pop(project_id, None)
        state = self._states.get(active_job_id)
        if isinstance(state, dict):
            state['running'] = False
            state['updated_at'] = now_ts()

    def _update_job_state(self, job_id: str, **updates: Any) -> None:
        with self._lock:
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                return
            state.update(updates)
            progress_total = int(state.get('progress_total') or 0)
            progress_done = int(state.get('progress_done') or 0)
            if progress_total > 0 and 'progress_pct' not in updates:
                state['progress_pct'] = float(
                    max(0, min(progress_done, progress_total)) * 100.0 / max(progress_total, 1)
                )
            state['updated_at'] = now_ts()

    def get_job_state_or_404(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                raise HTTPException(status_code=404, detail='smart filter job not found')
            holder = self._threads.get(job_id) or {}
            thread = holder.get('thread')
            running = bool(thread and thread.is_alive())
            out = dict(state)
            out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
            return out

    def get_active_job_for_project(self, project_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._cleanup_project_slot(project_id)
            job_id = str(self._project_active.get(project_id) or '').strip()
            if not job_id:
                return None
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                self._project_active.pop(project_id, None)
                return None
            holder = self._threads.get(job_id) or {}
            thread = holder.get('thread')
            running = bool(thread and thread.is_alive())
            out = dict(state)
            out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
            return out

    def run_preview_job(self, payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
        payload = SmartFilterIn(**payload_dict)
        config = _normalize_smart_filter_payload(payload)
        storage = self._get_storage()
        project = storage.get_project(config['project_id'], enrich=False, include_images=True)
        if not project:
            raise RuntimeError('project not found')
        if project.get('project_type') != 'image':
            raise RuntimeError('only image project is supported')

        analysis = _analyze_smart_filter_project(
            project=project,
            config=config,
            load_annotations=storage.load_annotations,
            progress_cb=progress_cb,
        )
        preview_token = new_id('sfp_')
        project_rev = int(project.get('content_rev', 1) or 1)
        operation_mode = str(config.get('operation_mode') or 'merge')
        preview_entry = {
            'preview_token': preview_token,
            'project_id': config['project_id'],
            'project_content_rev': project_rev,
            'signature': str(config['signature']),
            'config': {
                'operation_mode': operation_mode,
                'merge_mode': config['merge_mode'],
                'spatial_mode': config['spatial_mode'],
                'coverage_threshold': float(config['coverage_threshold']),
                'canonical_class': config['canonical_class'],
                'source_classes': list(config['source_classes']),
                'area_mode': config['area_mode'],
                'rule_classes': list(config['rule_classes']),
                'small_target_enabled': bool(config['small_target_enabled']),
                'max_area_ratio': float(config['max_area_ratio']),
                'instance_count_enabled': bool(config['instance_count_enabled']),
                'min_instances': int(config['min_instances']),
                'max_instances': int(config['max_instances']),
                'position_enabled': bool(config['position_enabled']),
                'center_x_half_width': float(config['center_x_half_width']),
                'center_y_half_height': float(config['center_y_half_height']),
                'confidence_enabled': bool(config['confidence_enabled']),
                'min_confidence': float(config['min_confidence']),
                'max_confidence': float(config['max_confidence']),
            },
            'result': analysis,
        }
        with self._lock:
            self._preview_cache[config['project_id']] = preview_entry

        candidate_count = int(analysis.get('candidate_count') or 0)
        relabel_count = int(analysis.get('relabel_count') or 0)
        if operation_mode == 'delete_unlabeled':
            preview_message = (
                f'无标注图片预览完成：命中 {candidate_count} 张待删除图片'
                if candidate_count > 0
                else '无标注图片预览完成：没有命中待删除图片'
            )
        elif operation_mode == 'merge':
            preview_message = (
                f'合并过滤预览完成：可删除 {candidate_count} 个标注'
                + (f'，可改类 {relabel_count} 个标注' if relabel_count > 0 else '')
                if candidate_count > 0 or relabel_count > 0
                else '合并过滤预览完成：没有命中可处理标注'
            )
        else:
            preview_message = (
                f'规则过滤预览完成：命中 {candidate_count} 个待删除标注'
                if candidate_count > 0
                else '规则过滤预览完成：没有命中标注'
            )
        return {
            'project_id': config['project_id'],
            'operation_mode': operation_mode,
            'preview_token': preview_token,
            'project_content_rev': project_rev,
            'image_count': int(analysis.get('image_count') or 0),
            'candidate_count': candidate_count,
            'relabel_count': relabel_count,
            'items': analysis.get('items', []),
            'rule': {
                'operation_mode': operation_mode,
                'merge_mode': config['merge_mode'],
                'spatial_mode': config['spatial_mode'],
                'same_class': config['merge_mode'] == 'same_class',
                'canonical_class': config['canonical_class'],
                'source_classes': list(config['source_classes']),
                'area_mode': config['area_mode'],
                'rule_classes': list(config['rule_classes']),
                'small_target_enabled': bool(config['small_target_enabled']),
                'max_area_ratio': float(config['max_area_ratio']),
                'instance_count_enabled': bool(config['instance_count_enabled']),
                'min_instances': int(config['min_instances']),
                'max_instances': int(config['max_instances']),
                'position_enabled': bool(config['position_enabled']),
                'center_x_half_width': float(config['center_x_half_width']),
                'center_y_half_height': float(config['center_y_half_height']),
                'confidence_enabled': bool(config['confidence_enabled']),
                'min_confidence': float(config['min_confidence']),
                'max_confidence': float(config['max_confidence']),
                'small_box_covered_by_large_gte': float(config['coverage_threshold']),
                'keep': 'larger_area',
            },
            'message': preview_message,
        }

    def run_apply_job(self, payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
        payload = SmartFilterIn(**payload_dict)
        config = _normalize_smart_filter_payload(payload)
        job_id = str(payload_dict.get('_job_id') or '').strip()
        preview_token = str(config.get('preview_token') or '').strip()
        if not preview_token:
            raise RuntimeError('preview_token is required; please run preview first')

        storage = self._get_storage()
        project = storage.get_project(config['project_id'], enrich=False, include_images=False)
        if not project:
            raise RuntimeError('project not found')
        if project.get('project_type') != 'image':
            raise RuntimeError('only image project is supported')
        current_rev = int(project.get('content_rev', 1) or 1)

        with self._lock:
            preview_entry = dict(self._preview_cache.get(config['project_id']) or {})
        if not preview_entry:
            raise RuntimeError('preview cache is missing; please rerun preview')
        if str(preview_entry.get('preview_token') or '') != preview_token:
            raise RuntimeError('preview token is stale; please rerun preview')
        if int(preview_entry.get('project_content_rev') or 0) != current_rev:
            raise RuntimeError('project annotations changed after preview; please rerun preview')
        if str(preview_entry.get('signature') or '') != str(config.get('signature') or ''):
            raise RuntimeError('filter config changed after preview; please rerun preview')

        cached_result = preview_entry.get('result', {}) if isinstance(preview_entry.get('result', {}), dict) else {}
        apply_items = list(cached_result.get('apply_items', [])) if isinstance(cached_result.get('apply_items', []), list) else []
        total = len(apply_items)
        operation_mode = str(config.get('operation_mode') or 'merge')

        def clear_preview_cache() -> None:
            with self._lock:
                current_entry = self._preview_cache.get(config['project_id'])
                if isinstance(current_entry, dict) and str(current_entry.get('preview_token') or '') == preview_token:
                    self._preview_cache.pop(config['project_id'], None)

        if operation_mode == 'delete_unlabeled':
            if progress_cb:
                progress_cb(
                    message=f'准备删除无标注图片，待删除 {total} 张',
                    progress_done=0,
                    progress_total=total,
                )
            image_ids = [
                str(item.get('image_id') or '').strip()
                for item in apply_items
                if str(item.get('image_id') or '').strip()
            ]
            delete_result = storage.delete_project_images(config['project_id'], image_ids)
            deleted_images = int(delete_result.get('deleted_images') or 0)
            failed_deletes = delete_result.get('failed_deletes', [])
            if progress_cb:
                progress_cb(
                    message=f'无标注图片删除完成：删除 {deleted_images} 张',
                    progress_done=total,
                    progress_total=total,
                )
            clear_preview_cache()
            result_items = []
            for item in delete_result.get('items', []):
                if not isinstance(item, dict):
                    continue
                result_items.append(
                    {
                        **item,
                        'removed_count': 1,
                        'relabel_count': 0,
                    }
                )
            return {
                'project_id': config['project_id'],
                'operation_mode': operation_mode,
                'rollback_run_id': '',
                'changed_images': deleted_images,
                'deleted_images': deleted_images,
                'deleted_annotation_files': int(delete_result.get('deleted_annotation_files') or 0),
                'deleted_image_files': int(delete_result.get('deleted_image_files') or 0),
                'failed_deletes': failed_deletes if isinstance(failed_deletes, list) else [],
                'removed_annotations': 0,
                'relabeled_annotations': 0,
                'items': result_items,
                'message': (
                    f'无标注图片删除完成：删除 {deleted_images} 张图片'
                    + (
                        f'，{len(failed_deletes)} 个文件删除失败'
                        if isinstance(failed_deletes, list) and failed_deletes
                        else ''
                    )
                ),
            }

        changed_images = 0
        removed_annotations = 0
        relabeled_annotations = 0
        items: list[dict[str, Any]] = []
        rollback_run_id = ''
        if total > 0:
            rollback_run_id = storage.begin_smart_filter_run(
                project_id=config['project_id'],
                job_id=job_id,
                operation_mode=operation_mode,
                rule=dict(preview_entry.get('config') or {}),
            )

        if progress_cb:
            progress_cb(
                message=(
                    f'准备执行合并过滤，待写回 {total} 张'
                    if operation_mode == 'merge'
                    else f'准备执行规则过滤删除，待写回 {total} 张'
                ),
                progress_done=0,
                progress_total=total,
            )

        for idx, item in enumerate(apply_items, start=1):
            image_id = str(item.get('image_id') or '')
            rel_path = str(item.get('rel_path') or image_id)
            kept_annotations = item.get('kept_annotations', [])
            original_annotations = storage.load_annotations(config['project_id'], image_id)
            if rollback_run_id:
                storage.add_smart_filter_snapshot(
                    run_id=rollback_run_id,
                    project_id=config['project_id'],
                    image_id=image_id,
                    annotations=original_annotations,
                )
            storage.save_annotations(
                config['project_id'],
                image_id,
                kept_annotations if isinstance(kept_annotations, list) else [],
            )
            remove_count = int(item.get('removed_count') or 0)
            relabel_count = int(item.get('relabel_count') or 0)
            changed_images += 1
            removed_annotations += remove_count
            relabeled_annotations += relabel_count
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': remove_count,
                    'relabel_count': relabel_count,
                }
            )
            if progress_cb:
                progress_cb(
                    message=(
                        f'合并过滤写回 {idx}/{total}: {rel_path}'
                        if operation_mode == 'merge'
                        else f'规则过滤删除 {idx}/{total}: {rel_path}'
                    ),
                    progress_done=idx,
                    progress_total=total,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                )

        clear_preview_cache()

        items.sort(
            key=lambda x: (
                int(x.get('removed_count') or 0),
                int(x.get('relabel_count') or 0),
                str(x.get('rel_path') or ''),
            ),
            reverse=True,
        )
        result = {
            'project_id': config['project_id'],
            'operation_mode': operation_mode,
            'rollback_run_id': rollback_run_id,
            'changed_images': changed_images,
            'removed_annotations': removed_annotations,
            'relabeled_annotations': relabeled_annotations,
            'rule': {
                'operation_mode': operation_mode,
                'merge_mode': config['merge_mode'],
                'spatial_mode': config['spatial_mode'],
                'canonical_class': config['canonical_class'],
                'source_classes': list(config['source_classes']),
                'area_mode': config['area_mode'],
                'small_box_covered_by_large_gte': float(config['coverage_threshold']),
            },
            'items': items,
            'message': (
                f'合并过滤已应用：修改 {changed_images} 张图片，删除 {removed_annotations} 个标注'
                + (f'，改类 {relabeled_annotations} 个标注' if relabeled_annotations > 0 else '')
                if operation_mode == 'merge'
                else f'规则过滤已应用：修改 {changed_images} 张图片，删除 {removed_annotations} 个命中标注'
            ),
        }
        if rollback_run_id:
            storage.finish_smart_filter_run(run_id=rollback_run_id, summary=result)
        return result

    def spawn_job(
        self,
        *,
        project_id: str,
        job_type: str,
        payload_dict: dict[str, Any],
        worker: Callable[[dict[str, Any], Callable[..., None]], dict[str, Any]],
    ) -> dict[str, Any]:
        with self._lock:
            self._cleanup_project_slot(project_id)
            active_job_id = str(self._project_active.get(project_id) or '').strip()
            if active_job_id:
                raise HTTPException(status_code=409, detail='another smart filter job is already running for this project')

            job_id = new_id('sfjob_')
            worker_payload = dict(payload_dict)
            worker_payload['_job_id'] = job_id
            state = self._state_default(job_id=job_id, project_id=project_id, job_type=job_type)
            operation_mode = str(worker_payload.get('operation_mode') or 'merge').strip().lower()
            if operation_mode == 'delete_unlabeled':
                mode_label = '无标注图片删除预览' if job_type == 'preview' else '无标注图片确认删除'
            else:
                mode_label = '智能过滤分析预览' if job_type == 'preview' else '智能过滤确认合并'
            state['payload_dict'] = dict(worker_payload)
            state['params'] = {
                'mode_label': mode_label,
                'scope_label': '全部图片',
            }
            self._states[job_id] = state
            self._project_active[project_id] = job_id

            def _worker_entry() -> None:
                self._update_job_state(
                    job_id,
                    status='running',
                    running=True,
                    started_at=now_ts(),
                    message='job started',
                )
                try:
                    result = worker(worker_payload, lambda **kw: self._update_job_state(job_id, **kw))
                    total = int(state.get('progress_total') or result.get('image_count') or result.get('changed_images') or 0)
                    done = int(state.get('progress_done') or total)
                    self._update_job_state(
                        job_id,
                        status='done',
                        running=False,
                        finished_at=now_ts(),
                        message=str(result.get('message') or 'done'),
                        result=result,
                        progress_done=done,
                        progress_total=total,
                        progress_pct=100.0 if total > 0 else 0.0,
                    )
                except Exception as exc:  # noqa: BLE001
                    self._logger.exception('smart filter job failed project=%s type=%s', project_id, job_type)
                    self._update_job_state(
                        job_id,
                        status='error',
                        running=False,
                        finished_at=now_ts(),
                        message=str(exc),
                        error=str(exc),
                    )
                finally:
                    with self._lock:
                        self._threads.pop(job_id, None)
                        if self._project_active.get(project_id) == job_id:
                            self._project_active.pop(project_id, None)

            thread = threading.Thread(target=_worker_entry, daemon=True)
            self._threads[job_id] = {'thread': thread, 'project_id': project_id}
            thread.start()
            return dict(state)

    def count_running_jobs(self) -> int:
        with self._lock:
            count = 0
            for holder in self._threads.values():
                thread = holder.get('thread')
                if thread and thread.is_alive():
                    count += 1
            return count
