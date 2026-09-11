from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

from PIL import Image

from app.annotations import CanonicalAnnotation, ParseContext, ParsedImageAnnotations, parse_image_annotations, resolve_annotation_mask
from app.data_cleaning.artifacts import preview_dir
from app.data_cleaning.changes import ChangeSet, annotation_fingerprint
from app.data_cleaning.component_noise import analyze_component_noise_image, sha256_file
from app.data_cleaning.preview_renderer import geometry_preview_plan, render_comparison_sample
from app.data_cleaning.registry import task_definition
from app.data_cleaning.rules import _annotation_geometry_type, analyze_merge_annotations, annotation_matches_rules
from app.services.annotation_masks import annotation_mask_path
from app.utils import ensure_dir, norm_text


logger = logging.getLogger('web_auto.data_cleaning')


def _compat_task_type(config: dict[str, Any]) -> str:
    operation = str(config.get('operation_mode') or 'merge')
    if operation == 'delete_unlabeled':
        return 'delete_unlabeled_images'
    if operation == 'component_noise':
        if config.get('component_gap_repair_enabled'):
            return 'morph_close' if config.get('component_gap_repair_method') == 'morph_close' else 'shortest_bridge'
        if config.get('component_opening_enabled'):
            return 'remove_edge_spurs'
        if config.get('component_hole_fill_enabled'):
            return 'fill_small_holes'
        return 'remove_small_components'
    if operation == 'merge':
        return 'normalize_classes' if config.get('merge_mode') == 'canonical_class' else 'deduplicate_same_class'
    if config.get('instance_count_enabled'):
        return 'delete_by_box_count'
    if config.get('small_target_enabled'):
        return 'remove_small_instances'
    if config.get('position_enabled'):
        return 'remove_position_region'
    return 'remove_confidence_range'


def _image_dimensions(image: dict[str, Any]) -> tuple[int, int]:
    try:
        with Image.open(str(image.get('abs_path') or '')) as source:
            return int(source.width), int(source.height)
    except Exception:
        return 0, 0


def _in_scope(annotation: CanonicalAnnotation, config: dict[str, Any]) -> bool:
    wanted = {norm_text(str(name)) for name in config.get('scope_classes', []) if norm_text(str(name))}
    name = norm_text(annotation.class_name)
    return bool(name) and (not wanted or name in wanted)


def _true_instance_area(
    *, base_dir: Path, project_id: str, image_id: str, annotation: CanonicalAnnotation,
    image_size: tuple[int, int],
) -> float:
    if _annotation_geometry_type(annotation) == 'bbox':
        return annotation.geometry.bbox_area_px or 0.0
    ann_id = annotation.source_annotation_ids[0] if len(annotation.source_annotation_ids) == 1 else ''
    sidecar = annotation_mask_path(base_dir, project_id, image_id, ann_id)
    resolved = resolve_annotation_mask(annotation, size=image_size, sidecar_path=sidecar)
    if resolved is not None:
        return float(resolved.area_px)
    return annotation.geometry.segmentation_area_px or 0.0


_UNSAFE_WRITE_ISSUES = frozenset({
    'MISSING_ANNOTATION_ID', 'DUPLICATE_INSTANCE_ID', 'UNSUPPORTED_SPLIT_ANNOTATION',
})


def _writable_entries(
    parsed: ParsedImageAnnotations,
    annotations: list[dict[str, Any]],
) -> tuple[list[tuple[int, CanonicalAnnotation]], list[dict[str, Any]]]:
    raw_indices: dict[str, list[int]] = {}
    for index, raw in enumerate(annotations):
        ann_id = str(raw.get('id') or '').strip() if isinstance(raw, dict) else ''
        if ann_id:
            raw_indices.setdefault(ann_id, []).append(index)
    entries: list[tuple[int, CanonicalAnnotation]] = []
    warnings: list[dict[str, Any]] = []
    for instance in parsed.instances:
        codes = sorted({issue.code for issue in instance.issues if issue.code in _UNSAFE_WRITE_ISSUES})
        source_ids = instance.source_annotation_ids
        indices = raw_indices.get(source_ids[0], []) if len(source_ids) == 1 else []
        if codes or len(indices) != 1:
            warnings.append({
                'code': 'annotation_not_writable',
                'message': 'annotation was skipped because it has no unambiguous modern storage identity',
                'annotation_id': instance.instance_id,
                'issue_codes': codes or ['AMBIGUOUS_SOURCE_ANNOTATION_ID'],
            })
            continue
        entries.append((indices[0], instance))
    return entries, warnings


def _attach_change_identity(change: ChangeSet, annotations: list[dict[str, Any]]) -> None:
    change.delete_annotation_ids = [
        str(annotations[index].get('id') or '')
        for index in change.delete_indices
        if 0 <= index < len(annotations) and str(annotations[index].get('id') or '')
    ]
    for index in change.delete_indices:
        if 0 <= index < len(annotations):
            # Kept in a separate map for backwards-compatible plan readers.
            pass
    for relabel in change.relabels:
        index = int(relabel.get('annotation_index', -1))
        if 0 <= index < len(annotations):
            relabel['annotation_id'] = str(annotations[index].get('id') or '')
            relabel['annotation_fingerprint'] = annotation_fingerprint(annotations[index])
    for update in change.geometry_updates:
        index = int(update.get('annotation_index', -1))
        if 0 <= index < len(annotations):
            update['annotation_fingerprint'] = annotation_fingerprint(annotations[index])
    # IDs are the operation targets; the fingerprint map validates their exact
    # preview-time state without depending on array positions.
    change.delete_fingerprints = {
        str(annotations[index].get('id') or ''): annotation_fingerprint(annotations[index])
        for index in change.delete_indices
        if 0 <= index < len(annotations) and str(annotations[index].get('id') or '')
    }


def analyze_project(
    *,
    base_dir: Path,
    preview_token: str,
    project: dict[str, Any],
    config: dict[str, Any],
    load_annotations: Callable[[str, str], list[dict[str, Any]]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images'), list) else []
    project_id = str(config.get('project_id') or project.get('id') or '')
    operation = str(config.get('operation_mode') or 'merge')
    task = str(config.get('task_type') or _compat_task_type(config))
    definition = task_definition(task)
    changes: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    totals = {
        'candidate_count': 0,
        'relabel_count': 0,
        'modified_annotations': 0,
        'removed_components': 0,
        'removed_pixels': 0,
        'opening_removed_pixels': 0,
        'bridges_added': 0,
        'bridge_pixels': 0,
        'filled_holes': 0,
        'filled_pixels': 0,
        'collision_rejected_bridges': 0,
        'morphology_skipped_annotations': 0,
        'incomplete_collision_checks': 0,
        'skipped_annotations': 0,
    }
    artifact_dir = preview_dir(base_dir, preview_token)
    total_images = len(images)

    for current, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = load_annotations(project_id, image_id)
        width, height = _image_dimensions(image)
        parsed = parse_image_annotations(
            annotations,
            ParseContext(image_id=image_id, image_width=width or None, image_height=height or None),
        )
        canonical_entries, parse_warnings = _writable_entries(parsed, annotations)
        change = ChangeSet(image_id=image_id, rel_path=rel_path)
        item: dict[str, Any] = {'image_id': image_id, 'rel_path': rel_path}
        if parse_warnings:
            item['warnings'] = list(parse_warnings)
            totals['skipped_annotations'] += len(parse_warnings)

        if operation == 'delete_unlabeled':
            if not annotations:
                change.removed_count = 1
                changes.append(change.to_dict())
                item.update(candidate_count=1, relabel_count=0, pair_count=0)
                items.append(item)
                totals['candidate_count'] += 1
        elif operation == 'component_noise':
            result = analyze_component_noise_image(
                base_dir=base_dir,
                preview_dir=artifact_dir,
                project_id=project_id,
                image=image,
                annotations=canonical_entries,
                config=config,
            )
            updates = result.get('updates', [])
            totals['skipped_annotations'] += int(result.get('skipped') or 0)
            totals['morphology_skipped_annotations'] += int(result.get('morphology_skipped_annotations') or 0)
            totals['incomplete_collision_checks'] += int(result.get('incomplete_collision_checks') or 0)
            totals['collision_rejected_bridges'] += int(result.get('collision_rejected_bridges') or 0)
            component_warnings: list[dict[str, Any]] = list(parse_warnings)
            if int(result.get('morphology_skipped_annotations') or 0):
                component_warnings.append({
                    'code': 'opening_would_empty_mask',
                    'message': 'opening was skipped because it would empty an instance mask',
                    'count': int(result.get('morphology_skipped_annotations') or 0),
                })
            if int(result.get('incomplete_collision_checks') or 0):
                component_warnings.append({
                    'code': 'incomplete_collision_check',
                    'message': 'some other-instance geometry was unavailable for collision checks',
                    'count': int(result.get('incomplete_collision_checks') or 0),
                })
            if updates:
                change.geometry_updates = updates
                change.removed_components = sum(int(update.get('removed_components') or 0) for update in updates)
                change.removed_pixels = sum(int(update.get('removed_pixels') or 0) for update in updates)
                change.opening_removed_pixels = sum(int(update.get('opening_removed_pixels') or 0) for update in updates)
                change.bridges_added = sum(int(update.get('bridges_added') or 0) for update in updates)
                change.bridge_pixels = sum(int(update.get('bridge_pixels') or 0) for update in updates)
                change.filled_holes = sum(int(update.get('filled_holes') or 0) for update in updates)
                change.filled_pixels = sum(int(update.get('filled_pixels') or 0) for update in updates)
                change.collision_rejected_bridges = sum(int(update.get('collision_rejected_bridges') or 0) for update in updates)
                _attach_change_identity(change, annotations)
                changes.append(change.to_dict())
                totals['modified_annotations'] += len(updates)
                totals['removed_components'] += change.removed_components
                totals['removed_pixels'] += change.removed_pixels
                totals['opening_removed_pixels'] += change.opening_removed_pixels
                totals['bridges_added'] += change.bridges_added
                totals['bridge_pixels'] += change.bridge_pixels
                totals['filled_holes'] += change.filled_holes
                totals['filled_pixels'] += change.filled_pixels
                item.update(
                    candidate_count=0,
                    modified_annotations=len(updates),
                    removed_components=change.removed_components,
                    removed_pixels=change.removed_pixels,
                    opening_removed_pixels=change.opening_removed_pixels,
                    bridges_added=change.bridges_added,
                    bridge_pixels=change.bridge_pixels,
                    filled_holes=change.filled_holes,
                    filled_pixels=change.filled_pixels,
                    collision_rejected_bridges=change.collision_rejected_bridges,
                    components_before=sum(int(update.get('components_before') or 0) for update in updates),
                    components_after=sum(int(update.get('components_after') or 0) for update in updates),
                    component_decisions=[
                        {
                            'annotation_id': str(update.get('annotation_id') or ''),
                            'decisions': list(update.get('decisions') or [])[:100],
                        }
                        for update in updates
                    ],
                    warnings=component_warnings,
                )
                component_layers = result.get('preview_layers')
                if isinstance(component_layers, dict) and component_layers:
                    item['_component_layers'] = dict(component_layers)
                items.append(item)
            elif component_warnings:
                item['warnings'] = component_warnings
                items.append(item)
        elif task == 'deduplicate_same_class':
            eligible = [(index, ann) for index, ann in canonical_entries if _in_scope(ann, config)]
            resolved_masks = {}
            if width > 0 and height > 0:
                for _index, ann in eligible:
                    if not ann.has_instance_segmentation or len(ann.source_annotation_ids) != 1:
                        continue
                    resolved = resolve_annotation_mask(
                        ann,
                        size=(width, height),
                        sidecar_path=annotation_mask_path(
                            base_dir, project_id, image_id, ann.source_annotation_ids[0],
                        ),
                    )
                    if resolved is not None:
                        resolved_masks[ann.instance_id] = resolved.image
            analysis = analyze_merge_annotations(
                [ann for _index, ann in eligible], config, resolved_masks=resolved_masks,
            )
            change.delete_indices = [eligible[int(index)][0] for index in analysis['delete_indices']]
            change.removed_count = len(change.delete_indices)
            if change.removed_count:
                _attach_change_identity(change, annotations)
                changes.append(change.to_dict())
                totals['candidate_count'] += change.removed_count
                item.update(candidate_count=change.removed_count, relabel_count=0, pair_count=len(analysis['pairs']))
                items.append(item)
        elif task == 'normalize_classes':
            target = str(config.get('canonical_class') or '')
            for ann_index, ann in canonical_entries:
                if _in_scope(ann, config) and norm_text(ann.class_name) != norm_text(target):
                    change.relabels.append({'annotation_index': ann_index, 'class_name': target})
            change.relabel_count = len(change.relabels)
            if change.relabel_count:
                _attach_change_identity(change, annotations)
                changes.append(change.to_dict())
                totals['relabel_count'] += change.relabel_count
                item.update(candidate_count=0, relabel_count=change.relabel_count, pair_count=0)
                items.append(item)
        elif task == 'delete_by_box_count':
            scoped_boxes = [
                index for index, ann in canonical_entries
                if _annotation_geometry_type(ann) == 'bbox' and _in_scope(ann, config)
            ]
            if not any(_annotation_geometry_type(ann) == 'bbox' for _index, ann in canonical_entries):
                item.setdefault('warnings', []).append(
                    {'code': 'no_bounding_boxes', 'message': 'image has no bounding-box annotations'}
                )
                items.append(item)
            else:
                minimum = int(config.get('min_instances') or 0)
                maximum = int(config.get('max_instances') or 0)
                count = len(scoped_boxes)
                if count >= minimum and (maximum == 0 or count <= maximum):
                    change.delete_indices = scoped_boxes
                    change.removed_count = len(scoped_boxes)
                if change.removed_count:
                    _attach_change_identity(change, annotations)
                    changes.append(change.to_dict())
                    totals['candidate_count'] += change.removed_count
                    item.update(candidate_count=change.removed_count, relabel_count=0, box_count=count)
                    items.append(item)
        else:
            for ann_index, ann in canonical_entries:
                if not _in_scope(ann, config):
                    continue
                if task == 'remove_small_instances':
                    if width <= 0 or height <= 0:
                        totals['skipped_annotations'] += 1
                        continue
                    matched = _true_instance_area(
                        base_dir=base_dir, project_id=project_id, image_id=image_id, annotation=ann,
                        image_size=(width, height),
                    ) / float(width * height) <= float(config.get('max_area_ratio') or 0)
                    skipped = False
                else:
                    matched, skipped = annotation_matches_rules(
                        ann, config=config, image_width=width, image_height=height
                    )
                if skipped:
                    totals['skipped_annotations'] += 1
                if matched:
                    change.delete_indices.append(ann_index)
            change.removed_count = len(change.delete_indices)
            if change.removed_count:
                _attach_change_identity(change, annotations)
                changes.append(change.to_dict())
                totals['candidate_count'] += change.removed_count
                item.update(candidate_count=change.removed_count, relabel_count=0, pair_count=0)
                items.append(item)

        if parse_warnings and not any(existing is item for existing in items):
            items.append(item)

        if progress_cb:
            progress_cb(
                message=f'数据清洗分析 {current}/{total_images}: {rel_path}',
                progress_done=current,
                progress_total=total_images,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    if definition.impact_metric == 'changed_pixels':
        impact = lambda row: (
            int(row.get('removed_pixels') or 0)
            + int(row.get('bridge_pixels') or 0)
            + int(row.get('filled_pixels') or 0)
        )
    elif definition.impact_metric == 'affected_annotations':
        impact = lambda row: int(row.get('candidate_count') or 0) + int(row.get('relabel_count') or 0)
    else:
        impact = lambda _row: 0
    items.sort(key=lambda row: (impact(row), str(row.get('rel_path') or '')))
    preview_samples: list[dict[str, Any]] = []
    preview_artwork: dict[str, Any] = {'version': 1, 'status': 'not_needed'}
    impacted_items = [row for row in items if impact(row) > 0 or task == 'delete_unlabeled_images']
    # A typical sample first, then high and low impact examples, deduplicated.
    sample_indices = list(dict.fromkeys([len(impacted_items) // 2, len(impacted_items) - 1, 0])) if impacted_items else []
    for sample_index in sample_indices:
        selected_sample = impacted_items[sample_index]
        selected_image_id = str(selected_sample.get('image_id') or '')
        selected_image = next((row for row in images if str(row.get('id') or '') == selected_image_id), None)
        selected_change = next((row for row in changes if str(row.get('image_id') or '') == selected_image_id), None)
        if selected_image and selected_change:
            try:
                selected_annotations = load_annotations(project_id, selected_image_id)
                if operation == 'delete_unlabeled':
                    geometry_plan = [{'geometry_type': 'image'}]
                elif operation == 'component_noise':
                    geometry_plan = [{'geometry_type': 'segmentation'}]
                else:
                    layers = geometry_preview_plan(
                        base_dir=base_dir,
                        project_id=project_id,
                        image_id=selected_image_id,
                        annotations=selected_annotations,
                        change_set=selected_change,
                    )
                    geometry_plan = [{
                        'geometry_type': 'mixed',
                        'annotation_count': sum(int(layer['annotation_count']) for layer in layers),
                        'candidate_count': sum(int(layer['candidate_count']) for layer in layers),
                        'relabel_count': sum(int(layer['relabel_count']) for layer in layers),
                    }] if layers else []
                if not geometry_plan:
                    raise ValueError('preview change set has no renderable geometry')
                for layer in geometry_plan:
                    geometry_type = str(layer['geometry_type'])
                    rendered = render_comparison_sample(
                        base_dir=base_dir,
                        artifact_dir=artifact_dir,
                        project_id=project_id,
                        operation_mode=operation,
                        image=selected_image,
                        annotations=selected_annotations,
                        change_set=selected_change,
                        component_layers=(
                            selected_sample.get('_component_layers')
                            if isinstance(selected_sample.get('_component_layers'), dict)
                            else None
                        ),
                        geometry_type=geometry_type,
                    )
                    before_url = f'/api/filter/intelligent/artifacts/{preview_token}/{rendered["before_rel"]}'
                    after_url = f'/api/filter/intelligent/artifacts/{preview_token}/{rendered["after_rel"]}'
                    preview_samples.append({
                        'image_id': selected_image_id,
                        'rel_path': str(selected_sample.get('rel_path') or selected_image_id),
                        'kind': 'image_delete' if operation == 'delete_unlabeled' else 'annotation_change',
                        'geometry_type': geometry_type,
                        **{key: int(layer[key]) for key in ('annotation_count', 'candidate_count', 'relabel_count') if key in layer},
                        'before_url': before_url,
                        'after_url': after_url,
                        'diff_url': f'/api/filter/intelligent/artifacts/{preview_token}/{rendered["diff_rel"]}',
                        **{f'{label}_detail_url': f'/api/filter/intelligent/artifacts/{preview_token}/{rendered[f"{label}_detail_rel"]}'
                           for label in ('before', 'after', 'diff') if f'{label}_detail_rel' in rendered},
                        **{key: rendered[key] for key in ('change_bbox', 'source_width', 'source_height', 'removed_pixels', 'added_pixels')},
                    })
                if preview_artwork.get('status') != 'failed':
                    preview_artwork = {'version': 1, 'status': 'ready'}
                if operation == 'component_noise' and preview_samples:
                    before_url = preview_samples[-1]['before_url']
                    after_url = preview_samples[-1]['after_url']
                    selected_sample['sample_before_url'] = before_url
                    selected_sample['sample_after_url'] = after_url
                    selected_sample['sample_url'] = after_url
            except Exception as exc:
                error_code = 'source_unavailable' if isinstance(exc, FileNotFoundError) else 'render_failed'
                preview_artwork = {'version': 1, 'status': 'failed', 'error_code': error_code}
                logger.exception(
                    'failed to render smart-filter preview artwork for project=%s image=%s operation=%s',
                    project_id,
                    selected_image_id,
                    operation,
                )
        else:
            preview_artwork = {'version': 1, 'status': 'failed', 'error_code': 'selection_unavailable'}
            logger.error(
                'smart-filter preview selection is unavailable for project=%s image=%s operation=%s',
                project_id,
                selected_image_id,
                operation,
            )
    for item in items:
        component_layers = item.pop('_component_layers', {})
        if isinstance(component_layers, dict):
            for relative_name in component_layers.values():
                if relative_name:
                    (artifact_dir / str(relative_name)).unlink(missing_ok=True)
    samples = [sample['after_url'] for sample in preview_samples] if operation == 'component_noise' else []
    warnings = [
        {**warning, 'image_id': str(item.get('image_id') or ''), 'rel_path': str(item.get('rel_path') or '')}
        for item in items for warning in item.get('warnings', []) if isinstance(warning, dict)
    ]
    if preview_artwork.get('status') == 'failed':
        warnings.append({
            'code': 'preview_artwork_failed',
            'message': 'comparison artwork could not be generated',
            'requires_confirmation': True,
            'error_code': str(preview_artwork.get('error_code') or 'render_failed'),
        })
    return {
        'schema_version': 2,
        'task_type': task,
        'effect_type': definition.effect_type,
        'image_count': len(changes),
        **totals,
        'items': items,
        'change_sets': changes,
        'sample_urls': samples,
        'preview_samples': preview_samples,
        'preview_artwork': preview_artwork,
        'warnings': warnings,
    }


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    ensure_dir(path.parent)
    fd, temporary = tempfile.mkstemp(prefix='.smart_filter_', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def validate_change_sets(*, storage: Any, project_id: str, artifact_dir: Path, change_sets: list[dict[str, Any]]) -> None:
    """Validate every external mask input before the first image is changed."""
    artifact_root = artifact_dir.resolve()
    for change in change_sets:
        image_id = str(change.get('image_id') or '')
        annotations = storage.load_annotations(project_id, image_id)
        by_id = {str(ann.get('id') or ''): ann for ann in annotations if str(ann.get('id') or '')}
        for ann_id, expected in dict(change.get('delete_fingerprints') or {}).items():
            current = by_id.get(str(ann_id))
            if current is None or annotation_fingerprint(current) != str(expected):
                raise RuntimeError('annotation changed after preview; please rerun preview')
        for relabel in change.get('relabels', []):
            ann_id = str(relabel.get('annotation_id') or '')
            expected = str(relabel.get('annotation_fingerprint') or '')
            if ann_id and (ann_id not in by_id or (expected and annotation_fingerprint(by_id[ann_id]) != expected)):
                raise RuntimeError('annotation changed after preview; please rerun preview')
        for update in change.get('geometry_updates', []):
            ann_id = str(update.get('annotation_id') or '')
            expected_ann = str(update.get('annotation_fingerprint') or '')
            if ann_id not in by_id or (expected_ann and annotation_fingerprint(by_id[ann_id]) != expected_ann):
                raise RuntimeError('annotation changed after preview; please rerun preview')
            target = annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)
            expected = str(update.get('original_mask_sha256') or '')
            if expected and (not target.is_file() or sha256_file(target) != expected):
                raise RuntimeError('annotation mask changed after preview; please rerun preview')
            if not expected and target.exists():
                raise RuntimeError('annotation mask changed after preview; please rerun preview')
            staged = (artifact_dir / str(update.get('staged_mask') or '')).resolve()
            try:
                staged.relative_to(artifact_root)
            except ValueError as exc:
                raise RuntimeError('invalid preview mask artifact') from exc
            if not staged.is_file():
                raise RuntimeError('preview mask artifact is missing; please rerun preview')


def apply_change_sets(
    *,
    storage: Any,
    project_id: str,
    artifact_dir: Path,
    change_sets: list[dict[str, Any]],
    snapshot_cb: Callable[[str, list[dict[str, Any]]], None] | None = None,
    progress_cb: Optional[Callable[..., None]] = None,
    batch_save: Callable[[list[tuple[str, list[dict[str, Any]]]]], None] | None = None,
) -> dict[str, Any]:
    totals = {
        'changed_images': 0, 'removed_annotations': 0, 'relabeled_annotations': 0,
        'modified_annotations': 0, 'removed_components': 0, 'removed_pixels': 0,
        'opening_removed_pixels': 0, 'bridges_added': 0, 'bridge_pixels': 0,
        'filled_holes': 0, 'filled_pixels': 0, 'collision_rejected_bridges': 0,
    }
    output_items: list[dict[str, Any]] = []
    pending: list[tuple[str, list[dict[str, Any]]]] = []
    for position, change in enumerate(change_sets, start=1):
        image_id = str(change.get('image_id') or '')
        original = storage.load_annotations(project_id, image_id)
        if snapshot_cb:
            snapshot_cb(image_id, original)
        annotations = [dict(ann) for ann in original]
        index_by_id = {str(ann.get('id') or ''): index for index, ann in enumerate(annotations) if str(ann.get('id') or '')}
        touched_paths: dict[Path, bytes | None] = {}

        for update in change.get('geometry_updates', []):
            ann_id = str(update.get('annotation_id') or '')
            index = index_by_id.get(ann_id, -1)
            expected_ann = str(update.get('annotation_fingerprint') or '')
            if index < 0 or (expected_ann and annotation_fingerprint(annotations[index]) != expected_ann):
                raise RuntimeError('annotation changed after preview; please rerun preview')
            target = annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)
            expected = str(update.get('original_mask_sha256') or '')
            if expected:
                if not target.is_file() or sha256_file(target) != expected:
                    raise RuntimeError('annotation mask changed after preview; please rerun preview')
            elif target.exists():
                raise RuntimeError('annotation mask changed after preview; please rerun preview')
            staged = (artifact_dir / str(update.get('staged_mask') or '')).resolve()
            try:
                staged.relative_to(artifact_dir.resolve())
            except ValueError as exc:
                raise RuntimeError('invalid preview mask artifact') from exc
            if not staged.is_file():
                raise RuntimeError('preview mask artifact is missing; please rerun preview')
            touched_paths[target] = target.read_bytes() if target.is_file() else None
            annotations[index].update(dict(update.get('patch') or {}))

        delete_ids = {str(value) for value in change.get('delete_annotation_ids', []) if str(value)}
        delete_indices = {
            index_by_id[ann_id] for ann_id in delete_ids if ann_id in index_by_id
        } if delete_ids else {int(index) for index in change.get('delete_indices', [])}
        for index in delete_indices:
            if 0 <= index < len(original):
                ann_id = str(original[index].get('id') or '')
                if ann_id:
                    target = annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)
                    touched_paths.setdefault(target, target.read_bytes() if target.is_file() else None)
        for relabel in change.get('relabels', []):
            ann_id = str(relabel.get('annotation_id') or '')
            index = index_by_id.get(ann_id, int(relabel.get('annotation_index', -1)))
            if index < 0 or index >= len(annotations):
                raise RuntimeError('annotation changed after preview; please rerun preview')
            expected_ann = str(relabel.get('annotation_fingerprint') or '')
            if expected_ann and annotation_fingerprint(annotations[index]) != expected_ann:
                raise RuntimeError('annotation changed after preview; please rerun preview')
            annotations[index]['class_name'] = str(relabel.get('class_name') or '')
        annotations = [ann for index, ann in enumerate(annotations) if index not in delete_indices]

        try:
            for update in change.get('geometry_updates', []):
                target = annotation_mask_path(storage.base_dir, project_id, image_id, str(update.get('annotation_id') or ''))
                _atomic_write_bytes(target, (artifact_dir / str(update.get('staged_mask') or '')).read_bytes())
            for index in delete_indices:
                if 0 <= index < len(original):
                    ann_id = str(original[index].get('id') or '')
                    if ann_id:
                        annotation_mask_path(storage.base_dir, project_id, image_id, ann_id).unlink(missing_ok=True)
            if batch_save is None:
                storage.save_annotations(project_id, image_id, annotations)
            else:
                pending.append((image_id, annotations))
                if len(pending) >= 32 or position == len(change_sets):
                    batch_save(pending)
                    pending.clear()
        except Exception:
            for path, prior in touched_paths.items():
                if prior is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write_bytes(path, prior)
            try:
                storage.save_annotations(project_id, image_id, original)
            except Exception:
                pass
            raise

        item = {
            'image_id': image_id,
            'rel_path': str(change.get('rel_path') or image_id),
            'removed_count': int(change.get('removed_count') or 0),
            'relabel_count': int(change.get('relabel_count') or 0),
            'modified_annotations': len(change.get('geometry_updates', [])),
            'removed_components': int(change.get('removed_components') or 0),
            'removed_pixels': int(change.get('removed_pixels') or 0),
            'opening_removed_pixels': int(change.get('opening_removed_pixels') or 0),
            'bridges_added': int(change.get('bridges_added') or 0),
            'bridge_pixels': int(change.get('bridge_pixels') or 0),
            'filled_holes': int(change.get('filled_holes') or 0),
            'filled_pixels': int(change.get('filled_pixels') or 0),
            'collision_rejected_bridges': int(change.get('collision_rejected_bridges') or 0),
        }
        output_items.append(item)
        totals['changed_images'] += 1
        totals['removed_annotations'] += item['removed_count']
        totals['relabeled_annotations'] += item['relabel_count']
        totals['modified_annotations'] += item['modified_annotations']
        totals['removed_components'] += item['removed_components']
        totals['removed_pixels'] += item['removed_pixels']
        totals['opening_removed_pixels'] += item['opening_removed_pixels']
        totals['bridges_added'] += item['bridges_added']
        totals['bridge_pixels'] += item['bridge_pixels']
        totals['filled_holes'] += item['filled_holes']
        totals['filled_pixels'] += item['filled_pixels']
        totals['collision_rejected_bridges'] += item['collision_rejected_bridges']
        if progress_cb and not pending:
            progress_cb(message=f'数据清洗写回 {position}/{len(change_sets)}: {item["rel_path"]}', progress_done=position, progress_total=len(change_sets), current_image_id=image_id, current_image_rel_path=item['rel_path'])
    return {**totals, 'items': output_items}
