from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TaskDefinition:
    task_type: str
    effect_type: str
    geometry_types: tuple[str, ...]
    impact_metric: str


TASK_REGISTRY = {
    row.task_type: row
    for row in (
        TaskDefinition('remove_small_components', 'geometry_replace', ('segmentation',), 'changed_pixels'),
        TaskDefinition('remove_edge_spurs', 'geometry_replace', ('segmentation',), 'changed_pixels'),
        TaskDefinition('shortest_bridge', 'geometry_replace', ('segmentation',), 'changed_pixels'),
        TaskDefinition('morph_close', 'geometry_replace', ('segmentation',), 'changed_pixels'),
        TaskDefinition('fill_small_holes', 'geometry_replace', ('segmentation',), 'changed_pixels'),
        TaskDefinition('deduplicate_same_class', 'annotation_delete', ('bbox', 'segmentation'), 'affected_annotations'),
        TaskDefinition('remove_small_instances', 'annotation_delete', ('bbox', 'segmentation'), 'affected_annotations'),
        TaskDefinition('remove_confidence_range', 'annotation_delete', ('bbox', 'segmentation'), 'affected_annotations'),
        TaskDefinition('remove_position_region', 'annotation_delete', ('bbox', 'segmentation'), 'affected_annotations'),
        TaskDefinition('delete_by_box_count', 'annotation_delete', ('bbox',), 'affected_annotations'),
        TaskDefinition('normalize_classes', 'relabel', ('bbox', 'segmentation'), 'affected_annotations'),
        TaskDefinition('delete_unlabeled_images', 'image_delete', ('image',), 'stable_path'),
    )
}


def task_definition(task_type: str) -> TaskDefinition:
    try:
        return TASK_REGISTRY[task_type]
    except KeyError as exc:
        raise ValueError(f'unknown cleaning task: {task_type}') from exc
