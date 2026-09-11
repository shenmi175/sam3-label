from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.annotations import (  # noqa: E402
    ParseContext,
    annotation_core_fields,
    normalize_annotation_record,
    normalize_source,
    parse_annotation,
    parse_image_annotations,
)
from app.annotations.migration import migrate_split_records  # noqa: E402


class AnnotationParserTests(unittest.TestCase):
    def test_fixed_record_schema_maps_manual_into_a_result_layer(self) -> None:
        normalized = normalize_annotation_record({
            'id': 'legacy-manual',
            'label': 'chair',
            'source_model': 'manual',
            'source': 'manual',
            'bbox': [1, 2, 11, 12],
            'edited': True,
        })

        self.assertTrue(set(annotation_core_fields()).issubset(normalized))
        self.assertEqual(normalized['source_model'], 'sam3')
        self.assertEqual(normalized['class_name'], 'chair')
        self.assertEqual(normalized['polygon'], [])
        self.assertEqual(normalized['polygons'], [])
        self.assertEqual(normalized['mask_url'], '')
        self.assertIsNone(normalized['area'])
        self.assertNotIn('source', normalized)
        self.assertNotIn('label', normalized)

    def test_bbox_only_record_does_not_claim_segmentation_area(self) -> None:
        normalized = normalize_annotation_record({
            'id': 'bbox-only', 'class_name': 'chair', 'source_model': 'locate-anything',
            'bbox': [1, 2, 11, 12], 'area': 100,
        })

        self.assertIsNone(normalized['area'])

    def test_bbox_and_segmentation_are_independent_capabilities(self) -> None:
        parsed = parse_annotation({
            'id': 'sam-mask',
            'class_name': 'chair',
            'bbox': [0, 0, 20, 20],
            'polygon': [[0, 0], [10, 0], [10, 20]],
            'mask_url': '/mask.png',
            'area': 100,
            'source_model': 'SAM-3',
        }, ParseContext(image_width=100, image_height=100))

        self.assertTrue(parsed.has_detection)
        self.assertTrue(parsed.has_instance_segmentation)
        self.assertEqual(parsed.geometry.primary_geometry, 'mask')
        self.assertEqual(parsed.geometry.bbox_origin, 'provided')
        self.assertEqual(parsed.provenance.producer.source_id, 'sam3')
        self.assertAlmostEqual(parsed.geometry.bbox_fill_ratio or 0, 0.25)

    def test_empty_polygon_is_bbox_only_and_bbox_aliases_are_supported(self) -> None:
        for key in ('bbox', 'bbox_xyxy', 'box'):
            parsed = parse_annotation({'id': key, key: [1, 2, 11, 12], 'polygon': [], 'source_model': 'LA'})
            self.assertTrue(parsed.has_detection)
            self.assertFalse(parsed.has_instance_segmentation)
            self.assertEqual(parsed.geometry.primary_geometry, 'bbox_only')
            self.assertEqual(parsed.provenance.producer.source_id, 'locate-anything')

        fallback = parse_annotation({
            'id': 'fallback', 'bbox': [1, 2, 1, 2], 'bbox_xyxy': [1, 2, 11, 12], 'source_model': 'LA',
        })
        self.assertTrue(fallback.has_detection)
        self.assertIn('DEGENERATE_BBOX', {issue.code for issue in fallback.issues})

    def test_polygon_derives_detection_bbox_and_mask_only_stays_segmentation_only(self) -> None:
        polygon = parse_annotation({
            'id': 'poly', 'polygon': [[2, 3], [8, 3], [8, 9]], 'source_model': 'manual',
        })
        mask = parse_annotation({'id': 'mask', 'mask_url': '/mask.png', 'source_model': 'sam3'})

        self.assertEqual(polygon.capabilities, frozenset({'detection', 'instance_segmentation'}))
        self.assertEqual(polygon.geometry.bbox_origin, 'derived_polygon')
        self.assertEqual(mask.capabilities, frozenset({'instance_segmentation'}))
        self.assertIsNone(mask.geometry.bbox)

    def test_missing_and_future_sources_are_not_guessed(self) -> None:
        self.assertEqual(normalize_source(None).source_id, 'unknown')
        self.assertEqual(normalize_source('YOLO v11').source_id, 'yolo-v11')
        parsed = parse_annotation({'id': 'ann', 'bbox': [0, 0, 1, 1]})
        self.assertEqual(parsed.provenance.producer.source_id, 'unknown')
        self.assertIn('SOURCE_MISSING', {issue.code for issue in parsed.issues})

        legacy_mask = parse_annotation({'id': 'legacy-mask', 'mask_url': '/mask.png'})
        self.assertEqual(legacy_mask.provenance.producer.source_id, 'sam3')
        self.assertNotIn('SOURCE_MISSING', {issue.code for issue in legacy_mask.issues})

    def test_malformed_geometry_returns_issues_without_hiding_valid_capability(self) -> None:
        parsed = parse_annotation({
            'id': 'ann',
            'bbox': [0, 0, 20, 10],
            'polygon': [[0, 0], [1, 1], [2, 2]],
            'source_model': 'sam3',
        })
        self.assertTrue(parsed.has_detection)
        self.assertFalse(parsed.has_instance_segmentation)
        self.assertIn('DEGENERATE_POLYGON', {issue.code for issue in parsed.issues})

    def test_split_components_are_rejected_until_explicit_migration(self) -> None:
        parsed = parse_image_annotations([
            {
                'id': 'det_c001', 'model_det_id': 'det', 'contour_index': 1, 'contour_count': 2,
                'class_name': 'chair', 'bbox': [0, 0, 20, 20],
                'polygon': [[1, 1], [5, 1], [5, 5]], 'area': 8, 'source_model': 'sam3',
            },
            {
                'id': 'det_c002', 'model_det_id': 'det', 'contour_index': 2, 'contour_count': 2,
                'class_name': 'chair', 'bbox': [0, 0, 20, 20],
                'polygon': [[10, 10], [15, 10], [15, 15]], 'area': 12.5, 'source_model': 'sam3',
            },
        ])

        self.assertEqual(parsed.raw_record_count, 2)
        self.assertEqual(len(parsed.instances), 2)
        self.assertTrue(all(
            'UNSUPPORTED_SPLIT_ANNOTATION' in {issue.code for issue in instance.issues}
            for instance in parsed.instances
        ))

        migrated, report = migrate_split_records([
            {
                'id': 'det_c001', 'model_det_id': 'det', 'contour_index': 1, 'contour_count': 3,
                'class_name': 'chair', 'bbox': [0, 0, 20, 20],
                'polygon': [[1, 1], [5, 1], [5, 5]], 'area': 8, 'source_model': 'sam3',
            },
            {
                'id': 'det_c002', 'model_det_id': 'det', 'contour_index': 1, 'contour_count': 2,
                'class_name': 'seat', 'bbox': [0, 0, 20, 20],
                'polygon': [[10, 10], [15, 10], [15, 15]], 'area': 12.5, 'source_model': 'sam3',
            },
        ])
        self.assertEqual(report['merged_group_count'], 1)
        self.assertEqual(len(report['conflicts']), 1)
        reparsed = parse_image_annotations(migrated)
        self.assertEqual(len(reparsed.instances), 1)
        self.assertEqual(reparsed.instances[0].geometry.component_count, 2)
        self.assertNotIn('UNSUPPORTED_SPLIT_ANNOTATION', {i.code for i in reparsed.issues})

    def test_incomplete_component_group_is_not_merged(self) -> None:
        parsed = parse_image_annotations([
            {
                'id': 'det_c001', 'model_det_id': 'det', 'contour_index': 1, 'contour_count': 2,
                'class_name': 'chair', 'polygon': [[0, 0], [5, 0], [5, 5]], 'source_model': 'sam3',
            },
        ])
        self.assertEqual(len(parsed.instances), 1)
        self.assertIn('UNSUPPORTED_SPLIT_ANNOTATION', {issue.code for issue in parsed.instances[0].issues})

    def test_duplicate_ids_remain_distinct_and_are_reported(self) -> None:
        parsed = parse_image_annotations([
            {'id': 'same', 'bbox': [0, 0, 5, 5], 'source_model': 'manual'},
            {'id': 'same', 'bbox': [5, 5, 10, 10], 'source_model': 'manual'},
        ])
        self.assertEqual([item.instance_id for item in parsed.instances], ['same', 'same#2'])
        self.assertIn('DUPLICATE_INSTANCE_ID', {issue.code for issue in parsed.instances[1].issues})


if __name__ == '__main__':
    unittest.main()
