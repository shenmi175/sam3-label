"""Read-only export preview helpers.

All profile normalization, validation and writers live in :mod:`app.exporting`.
"""

from __future__ import annotations

from typing import Any

from app.annotations import parse_image_annotations


def summarize_annotations(all_annotations: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    by_source: dict[str, int] = {}
    by_class: dict[str, int] = {}
    no_polygon_by_source: dict[str, int] = {}
    total = 0
    images_with_annotations = 0
    for annotations in all_annotations.values():
        if annotations:
            images_with_annotations += 1
        for annotation in parse_image_annotations(annotations).instances:
            total += 1
            source = annotation.provenance.producer.source_id
            class_name = annotation.class_name
            by_source[source] = by_source.get(source, 0) + 1
            by_class[class_name] = by_class.get(class_name, 0) + 1
            if not annotation.has_instance_segmentation:
                no_polygon_by_source[source] = no_polygon_by_source.get(source, 0) + 1
    return {
        'annotations_total': total,
        'images_with_annotations': images_with_annotations,
        'by_source': by_source,
        'by_class': by_class,
        'no_polygon_by_source': no_polygon_by_source,
    }
