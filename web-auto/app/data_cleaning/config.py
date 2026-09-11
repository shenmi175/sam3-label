from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import HTTPException

from app.schemas import SmartFilterIn


EFFECT_TYPES = {
    'remove_small_components': 'geometry_replace',
    'remove_edge_spurs': 'geometry_replace',
    'shortest_bridge': 'geometry_replace',
    'morph_close': 'geometry_replace',
    'fill_small_holes': 'geometry_replace',
    'deduplicate_same_class': 'annotation_delete',
    'remove_small_instances': 'annotation_delete',
    'remove_confidence_range': 'annotation_delete',
    'remove_position_region': 'annotation_delete',
    'delete_by_box_count': 'annotation_delete',
    'normalize_classes': 'relabel',
    'delete_unlabeled_images': 'image_delete',
}


def _base_v2(payload: SmartFilterIn, task_type: str, params: dict[str, Any], *, scope_classes: list[str], scope_mode: str) -> dict[str, Any]:
    return {
        'schema_version': 2,
        'project_id': str(payload.project_id).strip(),
        'task_type': task_type,
        'effect_type': EFFECT_TYPES[task_type],
        'class_scope': {'mode': scope_mode, 'classes': scope_classes},
        'scope_classes': scope_classes,
        'params': params,
        'preview_token': str(payload.preview_token or '').strip(),
        'confirm_preview_failure': bool(payload.confirm_preview_failure),
    }


def _internal_flags(config: dict[str, Any]) -> None:
    """Expose the one selected task to the existing, well-tested analyzers."""
    task = config['task_type']
    params = config['params']
    config.update({
        'operation_mode': (
            'component_noise' if task in {
                'remove_small_components', 'remove_edge_spurs', 'shortest_bridge', 'morph_close', 'fill_small_holes'
            } else 'delete_unlabeled' if task == 'delete_unlabeled_images' else 'merge' if task in {
                'deduplicate_same_class', 'normalize_classes'
            } else 'rule'
        ),
        'rule_classes': list(config['scope_classes']),
        'component_abs_area_enabled': False,
        'component_relative_area_enabled': False,
        'component_opening_enabled': False,
        'component_gap_repair_enabled': False,
        'component_hole_fill_enabled': False,
        'small_target_enabled': False,
        'position_enabled': False,
        'confidence_enabled': False,
        'instance_count_enabled': False,
        'include_missing_confidence': False,
        'area_mode': 'instance',
    })
    if task == 'remove_small_components':
        config.update(
            component_abs_area_enabled=params['absolute_area_enabled'],
            component_max_area_px=params['max_area_px'],
            component_relative_area_enabled=params['relative_area_enabled'],
            component_max_main_ratio=params['max_main_ratio'],
            component_require_all_thresholds=params['threshold_mode'] == 'and',
        )
    elif task == 'remove_edge_spurs':
        config.update(
            component_opening_enabled=True,
            component_opening_radius_px=params['radius_px'],
            component_opening_iterations=params['iterations'],
        )
    elif task == 'shortest_bridge':
        config.update(
            component_gap_repair_enabled=True,
            component_gap_repair_method='shortest_bridge',
            component_bridge_max_gap_px=params['max_gap_px'],
            component_bridge_width_px=params['bridge_width_px'],
            component_bridge_topology=params['topology'],
            component_gap_avoid_other_instances=params['avoid_other_instances'],
        )
    elif task == 'morph_close':
        config.update(
            component_gap_repair_enabled=True,
            component_gap_repair_method='morph_close',
            component_closing_radius_px=params['radius_px'],
            component_closing_iterations=params['iterations'],
            component_gap_avoid_other_instances=params['avoid_other_instances'],
        )
    elif task == 'fill_small_holes':
        config.update(
            component_hole_fill_enabled=True,
            component_hole_abs_area_enabled=params['absolute_area_enabled'],
            component_max_hole_area_px=params['max_area_px'],
            component_hole_relative_area_enabled=params['relative_area_enabled'],
            component_max_hole_main_ratio=params['max_main_ratio'],
            component_hole_require_all_thresholds=params['threshold_mode'] == 'and',
        )
    elif task == 'deduplicate_same_class':
        config.update(
            merge_mode='same_class', spatial_mode=params['spatial_mode'],
            coverage_threshold=params['coverage_threshold'], area_mode='instance',
        )
    elif task == 'remove_small_instances':
        config.update(small_target_enabled=True, max_area_ratio=params['max_image_ratio'])
    elif task == 'remove_confidence_range':
        config.update(
            confidence_enabled=True, min_confidence=params['min_confidence'],
            max_confidence=params['max_confidence'], include_missing_confidence=False,
        )
    elif task == 'remove_position_region':
        config.update(
            position_enabled=True, center_x_half_width=params['center_x_half_width'],
            center_y_half_height=params['center_y_half_height'], position_match_mode=params['relation'],
        )
    elif task == 'delete_by_box_count':
        config.update(instance_count_enabled=True, min_instances=params['min_boxes'], max_instances=params['max_boxes'])
    elif task == 'normalize_classes':
        config.update(canonical_class=params['target_class'])


def _legacy_conflict(conflicts: list[str]) -> None:
    raise HTTPException(
        status_code=400,
        detail={
            'code': 'ambiguous_legacy_filter',
            'message': 'legacy request enables multiple cleaning tasks; submit one schema_version=2 task',
            'conflicts': conflicts,
        },
    )


def _from_legacy(payload: SmartFilterIn) -> dict[str, Any]:
    operation = str(payload.operation_mode or 'merge')
    scope = [str(value).strip() for value in payload.rule_classes if str(value).strip()]
    scope_mode = 'selected' if scope else 'all'
    candidates: list[tuple[str, dict[str, Any]]] = []
    if operation == 'delete_unlabeled':
        candidates.append(('delete_unlabeled_images', {}))
    elif operation == 'component_noise':
        if payload.component_abs_area_enabled or payload.component_relative_area_enabled:
            candidates.append(('remove_small_components', {
                'absolute_area_enabled': bool(payload.component_abs_area_enabled),
                'max_area_px': max(0, int(payload.component_max_area_px)),
                'relative_area_enabled': bool(payload.component_relative_area_enabled),
                'max_main_ratio': max(0.0, float(payload.component_max_main_ratio)),
                'threshold_mode': 'and' if payload.component_require_all_thresholds else 'or',
            }))
        if payload.component_opening_enabled:
            candidates.append(('remove_edge_spurs', {
                'radius_px': payload.component_opening_radius_px, 'iterations': payload.component_opening_iterations,
            }))
        if payload.component_gap_repair_enabled:
            if payload.component_gap_repair_method == 'morph_close':
                candidates.append(('morph_close', {
                    'radius_px': payload.component_closing_radius_px,
                    'iterations': payload.component_closing_iterations,
                    'avoid_other_instances': payload.component_gap_avoid_other_instances,
                }))
            else:
                candidates.append(('shortest_bridge', {
                    'max_gap_px': payload.component_bridge_max_gap_px,
                    'bridge_width_px': payload.component_bridge_width_px,
                    'topology': payload.component_bridge_topology,
                    'avoid_other_instances': payload.component_gap_avoid_other_instances,
                }))
        if payload.component_hole_fill_enabled:
            candidates.append(('fill_small_holes', {
                'absolute_area_enabled': payload.component_hole_abs_area_enabled,
                'max_area_px': payload.component_max_hole_area_px,
                'relative_area_enabled': payload.component_hole_relative_area_enabled,
                'max_main_ratio': payload.component_max_hole_main_ratio,
                'threshold_mode': 'and' if payload.component_hole_require_all_thresholds else 'or',
            }))
    elif operation == 'rule':
        if payload.small_target_enabled:
            candidates.append(('remove_small_instances', {'max_image_ratio': payload.max_area_ratio}))
        if payload.confidence_enabled:
            candidates.append(('remove_confidence_range', {
                'min_confidence': payload.min_confidence, 'max_confidence': payload.max_confidence,
            }))
        if payload.position_enabled:
            candidates.append(('remove_position_region', {
                'center_x_half_width': payload.center_x_half_width,
                'center_y_half_height': payload.center_y_half_height,
                'relation': payload.position_match_mode,
            }))
        if payload.instance_count_enabled:
            candidates.append(('delete_by_box_count', {
                'min_boxes': payload.min_instances, 'max_boxes': payload.max_instances,
            }))
    elif operation == 'merge':
        # v1 canonical merge combined relabel and spatial de-duplication, so it
        # cannot be migrated without changing the result.
        if payload.merge_mode == 'canonical_class':
            _legacy_conflict(['normalize_classes', 'deduplicate_same_class'])
        candidates.append(('deduplicate_same_class', {
            'spatial_mode': payload.spatial_mode, 'coverage_threshold': payload.coverage_threshold,
        }))
    if not candidates:
        raise HTTPException(status_code=400, detail={'code': 'legacy_filter_has_no_task', 'conflicts': []})
    if len(candidates) != 1:
        _legacy_conflict([task for task, _params in candidates])
    task, params = candidates[0]
    # Re-validate migrated values through the v2 request model.
    v2 = SmartFilterIn(
        schema_version=2, project_id=payload.project_id, task_type=task,
        class_scope={'mode': scope_mode, 'classes': scope}, params=params,
        preview_token=payload.preview_token,
        confirm_preview_failure=payload.confirm_preview_failure,
    )
    return _from_v2(v2)


def _from_v2(payload: SmartFilterIn) -> dict[str, Any]:
    assert payload.task_type and payload.class_scope is not None and payload.params is not None
    config = _base_v2(
        payload, payload.task_type, dict(payload.params),
        scope_classes=list(payload.class_scope.classes), scope_mode=payload.class_scope.mode,
    )
    _internal_flags(config)
    signed = {key: value for key, value in config.items() if key not in {'preview_token', 'signature', 'confirm_preview_failure'}}
    raw = json.dumps(signed, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    config['signature'] = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    return config


def normalize_config(payload: SmartFilterIn) -> dict[str, Any]:
    return _from_v2(payload) if payload.schema_version == 2 else _from_legacy(payload)
