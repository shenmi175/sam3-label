from __future__ import annotations

import hashlib
import base64
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.data_cleaning.component_noise import analyze_component_noise_image  # noqa: E402
from app.data_cleaning.changes import annotation_fingerprint  # noqa: E402
from app.data_cleaning.config import normalize_config  # noqa: E402
from app.data_cleaning.engine import analyze_project, apply_change_sets  # noqa: E402
from app.data_cleaning.rules import analyze_merge_annotations, annotation_matches_rules  # noqa: E402
from app.schemas import SmartFilterIn  # noqa: E402
from app.services.annotation_masks import annotation_mask_path  # noqa: E402
from app.services.smart_filter_service import SmartFilterJobService  # noqa: E402
from app.storage import Storage  # noqa: E402


def config(**overrides):
    out = {
        'component_abs_area_enabled': True,
        'component_max_area_px': 4,
        'component_relative_area_enabled': True,
        'component_max_main_ratio': 0.1,
        'component_require_all_thresholds': True,
    }
    out.update(overrides)
    return out


class ComponentNoiseTest(unittest.TestCase):
    def _case(self, mask: np.ndarray, *, cfg=None, annotation=None):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        image_path = root / 'image.png'
        Image.new('RGB', (mask.shape[1], mask.shape[0]), 'white').save(image_path)
        ann = {'id': 'ann_1', 'class_name': 'thing', 'component_count': 2, **(annotation or {})}
        sidecar = annotation_mask_path(root, 'project', 'image', 'ann_1')
        cv2.imwrite(str(sidecar), mask)
        result = analyze_component_noise_image(
            base_dir=root,
            preview_dir=root / 'preview',
            project_id='project',
            image={'id': 'image', 'abs_path': str(image_path), 'rel_path': 'image.png'},
            annotations=[ann],
            config=cfg or config(),
        )
        return temporary, root, result

    def test_single_region_has_no_change(self):
        mask = np.zeros((24, 24), np.uint8)
        mask[2:12, 2:12] = 255
        temporary, _root, result = self._case(mask)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'], [])

    def test_boundaries_and_largest_component_is_never_removed(self):
        mask = np.zeros((30, 30), np.uint8)
        mask[1:11, 1:11] = 255  # 100, main
        mask[15:17, 15:17] = 255  # 4, both thresholds exactly match
        temporary, root, result = self._case(mask, cfg=config(component_max_main_ratio=0.04))
        self.addCleanup(temporary.cleanup)
        update = result['updates'][0]
        self.assertEqual(update['removed_components'], 1)
        self.assertEqual(update['removed_pixels'], 4)
        cleaned = cv2.imread(str(root / 'preview' / update['staged_mask']), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int(np.count_nonzero(cleaned)), 100)

    def test_absolute_relative_and_or_modes(self):
        mask = np.zeros((50, 50), np.uint8)
        mask[1:21, 1:21] = 255  # 400
        mask[30:33, 30:33] = 255  # 9
        cases = [
            (config(component_abs_area_enabled=True, component_max_area_px=9, component_relative_area_enabled=False), 1),
            (config(component_abs_area_enabled=False, component_relative_area_enabled=True, component_max_main_ratio=0.01), 0),
            (config(component_max_area_px=4, component_max_main_ratio=0.03, component_require_all_thresholds=True), 0),
            (config(component_max_area_px=4, component_max_main_ratio=0.03, component_require_all_thresholds=False), 1),
        ]
        for cfg, expected in cases:
            temporary, _root, result = self._case(mask, cfg=cfg)
            self.addCleanup(temporary.cleanup)
            self.assertEqual(len(result['updates']), expected)

    def test_geometry_is_synchronized_and_hole_is_preserved(self):
        mask = np.zeros((32, 32), np.uint8)
        mask[2:22, 2:22] = 255
        mask[8:12, 8:12] = 0
        mask[27:29, 27:29] = 255
        temporary, root, result = self._case(mask)
        self.addCleanup(temporary.cleanup)
        update = result['updates'][0]
        patch = update['patch']
        cleaned = cv2.imread(str(root / 'preview' / update['staged_mask']), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int(cleaned[9, 9]), 0)
        self.assertEqual(patch['area'], float(np.count_nonzero(cleaned)))
        self.assertEqual(patch['component_count'], 1)
        self.assertEqual(len(patch['polygons']), 1)
        self.assertEqual(patch['polygon'], patch['polygons'][0])
        self.assertEqual(patch['bbox'], [2.0, 2.0, 22.0, 22.0])

    def test_missing_corrupt_single_polygon_and_bbox_are_safe_skips(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (20, 20)).save(image_path)
            annotations = [
                {'id': 'missing', 'polygons': []},
                {'id': 'single', 'polygons': [[[1, 1], [5, 1], [5, 5]]]},
                {'id': 'bbox', 'bbox': [1, 1, 5, 5]},
                {'id': 'broken', 'component_count': 2},
            ]
            annotation_mask_path(root, 'p', 'i', 'broken').write_bytes(b'not-png')
            result = analyze_component_noise_image(base_dir=root, preview_dir=root / 'preview', project_id='p', image={'id': 'i', 'abs_path': str(image_path)}, annotations=annotations, config=config())
            self.assertEqual(result['updates'], [])
            self.assertEqual(result['skipped'], 4)

    def test_sidecar_truth_overrides_legacy_contour_metadata(self):
        mask = np.zeros((20, 20), np.uint8)
        mask[1:11, 1:11] = 255
        mask[18, 18] = 255
        temporary, _root, result = self._case(mask, annotation={'component_count': 3})
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['removed_pixels'], 1)
        self.assertEqual(result['updates'][0]['patch']['component_count'], 1)

        temporary, _root, result = self._case(mask, annotation={'component_count': 1, 'polygons': []})
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['removed_pixels'], 1)

    def test_opening_removes_attached_spur_and_cannot_empty_instance(self):
        mask = np.zeros((32, 32), np.uint8)
        mask[5:25, 5:25] = 255
        mask[14, 25:31] = 255
        cfg = config(
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_opening_enabled=True,
            component_opening_radius_px=1,
            component_opening_iterations=1,
        )
        temporary, _root, result = self._case(mask, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        self.assertGreater(result['updates'][0]['opening_removed_pixels'], 0)

        tiny = np.zeros((8, 8), np.uint8)
        tiny[3, 3] = 255
        temporary, _root, result = self._case(tiny, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'], [])
        self.assertEqual(result['morphology_skipped_annotations'], 1)

    def test_shortest_bridge_respects_gap_and_reports_added_pixels(self):
        mask = np.zeros((24, 30), np.uint8)
        mask[5:15, 2:8] = 255
        mask[5:15, 11:17] = 255  # 3 empty columns between boundaries
        cfg = config(
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_gap_repair_enabled=True,
            component_gap_repair_method='shortest_bridge',
            component_bridge_max_gap_px=3,
            component_bridge_width_px=1,
            component_bridge_topology='mst',
        )
        temporary, _root, result = self._case(mask, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        update = result['updates'][0]
        self.assertEqual(update['bridges_added'], 1)
        self.assertEqual(update['patch']['component_count'], 1)
        self.assertEqual(update['bridge_pixels'], 3)

        temporary, _root, result = self._case(mask, cfg={**cfg, 'component_bridge_max_gap_px': 2})
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'], [])

    def test_mst_supports_chain_connections_and_main_only_is_conservative(self):
        mask = np.zeros((24, 40), np.uint8)
        mask[6:14, 2:8] = 255
        mask[6:14, 11:17] = 255
        mask[6:14, 20:26] = 255
        cfg = config(
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_gap_repair_enabled=True,
            component_bridge_max_gap_px=3,
            component_bridge_width_px=1,
            component_bridge_topology='mst',
        )
        temporary, _root, result = self._case(mask, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['bridges_added'], 2)
        self.assertEqual(result['updates'][0]['patch']['component_count'], 1)

        temporary, _root, result = self._case(mask, cfg={**cfg, 'component_bridge_topology': 'main_only'})
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['bridges_added'], 1)
        self.assertEqual(result['updates'][0]['patch']['component_count'], 2)

    def test_morphological_closing_only_accepts_component_bridges(self):
        mask = np.zeros((30, 40), np.uint8)
        mask[8:20, 3:12] = 255
        mask[8:20, 17:26] = 255
        cfg = config(
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_gap_repair_enabled=True,
            component_gap_repair_method='morph_close',
            component_closing_radius_px=3,
            component_closing_iterations=1,
        )
        temporary, _root, result = self._case(mask, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['patch']['component_count'], 1)
        self.assertGreater(result['updates'][0]['bridge_pixels'], 0)

    def test_hole_fill_rules_and_border_background(self):
        mask = np.zeros((30, 30), np.uint8)
        mask[3:25, 3:25] = 255
        mask[10:12, 10:12] = 0
        cfg = config(
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_hole_fill_enabled=True,
            component_hole_abs_area_enabled=True,
            component_max_hole_area_px=4,
            component_hole_relative_area_enabled=False,
        )
        temporary, root, result = self._case(mask, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        update = result['updates'][0]
        self.assertEqual(update['filled_holes'], 1)
        self.assertEqual(update['filled_pixels'], 4)
        cleaned = cv2.imread(str(root / 'preview' / update['staged_mask']), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int(cleaned[10, 10]), 255)

        border_open = mask.copy()
        border_open[0:11, 10:12] = 0
        temporary, _root, result = self._case(border_open, cfg=cfg)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'], [])

        larger_hole = mask.copy()
        larger_hole[10:13, 10:13] = 0
        threshold_cfg = {
            **cfg,
            'component_hole_abs_area_enabled': True,
            'component_max_hole_area_px': 4,
            'component_hole_relative_area_enabled': True,
            'component_max_hole_main_ratio': 0.02,
            'component_hole_require_all_thresholds': True,
        }
        temporary, _root, result = self._case(larger_hole, cfg=threshold_cfg)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'], [])
        temporary, _root, result = self._case(larger_hole, cfg={**threshold_cfg, 'component_hole_require_all_thresholds': False})
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result['updates'][0]['filled_pixels'], 9)

    def test_bridge_collision_with_other_annotation_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (32, 24), 'white').save(image_path)
            first = np.zeros((24, 32), np.uint8)
            first[4:12, 2:8] = 255
            first[4:12, 13:19] = 255
            obstacle = np.zeros_like(first)
            obstacle[:, 9:12] = 255
            cv2.imwrite(str(annotation_mask_path(root, 'p', 'i', 'first')), first)
            cv2.imwrite(str(annotation_mask_path(root, 'p', 'i', 'obstacle')), obstacle)
            cfg = config(
                component_abs_area_enabled=False,
                component_relative_area_enabled=False,
                component_gap_repair_enabled=True,
                component_bridge_max_gap_px=8,
                component_bridge_width_px=1,
                component_gap_avoid_other_instances=True,
            )
            result = analyze_component_noise_image(
                base_dir=root,
                preview_dir=root / 'preview',
                project_id='p',
                image={'id': 'i', 'abs_path': str(image_path)},
                annotations=[{'id': 'first'}, {'id': 'obstacle'}],
                config=cfg,
            )
            self.assertEqual(result['updates'], [])
            self.assertEqual(result['collision_rejected_bridges'], 1)

            result = analyze_component_noise_image(
                base_dir=root,
                preview_dir=root / 'preview-allowed',
                project_id='p',
                image={'id': 'i', 'abs_path': str(image_path)},
                annotations=[{'id': 'first'}, {'id': 'obstacle'}],
                config={**cfg, 'component_gap_avoid_other_instances': False},
            )
            first_update = next(update for update in result['updates'] if update['annotation_id'] == 'first')
            self.assertEqual(first_update['bridges_added'], 1)


class RuleSemanticsTest(unittest.TestCase):
    def test_merge_keeps_box_and_segmentation_geometry_independent(self):
        config = {
            'merge_mode': 'same_class', 'spatial_mode': 'bbox_cover',
            'coverage_threshold': 0.98, 'area_mode': 'instance',
        }
        bbox_only = {'id': 'box', 'class_name': 'chair', 'bbox': [0, 0, 100, 100], 'area': 10000, 'polygon': []}
        matching_segmentation = {
            'id': 'segment', 'class_name': 'chair', 'bbox': [0.2, 0.2, 99.8, 99.8], 'area': 8000,
            'polygon': [[0.2, 0.2], [99.8, 0.2], [99.8, 99.8], [0.2, 99.8]],
        }
        cross_type = analyze_merge_annotations([bbox_only, matching_segmentation], config)
        self.assertEqual(cross_type['delete_indices'], [])
        self.assertEqual(cross_type['pairs'], [])

        nested_but_not_equivalent = analyze_merge_annotations([
            bbox_only,
            {
                'id': 'tiny-segment', 'class_name': 'chair', 'bbox': [10, 10, 20, 20], 'area': 100,
                'polygon': [[10, 10], [20, 10], [20, 20], [10, 20]],
            },
        ], config)
        self.assertEqual(nested_but_not_equivalent['delete_indices'], [])

        nested_boxes = analyze_merge_annotations([
            bbox_only,
            {'id': 'small-box', 'class_name': 'chair', 'bbox': [10, 10, 20, 20], 'area': 100, 'polygon': []},
        ], config)
        self.assertEqual(nested_boxes['delete_indices'], [1])

    def test_all_any_position_and_missing_confidence(self):
        ann = {'class_name': 'chair', 'bbox': [40, 40, 60, 60], 'area': 400}
        base = {
            'rule_classes': ['chair'], 'small_target_enabled': True, 'max_area_ratio': 0.05,
            'position_enabled': True, 'center_x_half_width': 0.2, 'center_y_half_height': 0.2,
            'position_match_mode': 'inside', 'confidence_enabled': True, 'min_confidence': 0.5,
            'max_confidence': 1.0, 'include_missing_confidence': False, 'rule_match_mode': 'all',
        }
        self.assertFalse(annotation_matches_rules(ann, config=base, image_width=100, image_height=100)[0])
        self.assertTrue(annotation_matches_rules(ann, config={**base, 'include_missing_confidence': True}, image_width=100, image_height=100)[0])
        self.assertTrue(annotation_matches_rules(ann, config={**base, 'rule_match_mode': 'any'}, image_width=100, image_height=100)[0])
        self.assertTrue(annotation_matches_rules(ann, config={**base, 'confidence_enabled': False, 'position_match_mode': 'inside'}, image_width=100, image_height=100)[0])
        self.assertFalse(annotation_matches_rules(ann, config={**base, 'confidence_enabled': False, 'position_match_mode': 'outside'}, image_width=100, image_height=100)[0])

    def test_missing_dimensions_never_match(self):
        matched, skipped = annotation_matches_rules(
            {'class_name': 'chair', 'bbox': [1, 1, 2, 2]},
            config={'rule_classes': [], 'small_target_enabled': True, 'max_area_ratio': 1, 'position_enabled': False, 'confidence_enabled': False},
            image_width=0,
            image_height=0,
        )
        self.assertFalse(matched)
        self.assertTrue(skipped)

    def test_threshold_comparison_uses_raw_float_without_display_rounding(self):
        config = {
            'merge_mode': 'same_class', 'spatial_mode': 'bbox_cover',
            'coverage_threshold': 0.98, 'area_mode': 'instance',
        }
        result = analyze_merge_annotations([
            {'id': 'a', 'class_name': 'chair', 'bbox': [0, 0, 100, 100], 'area': 10000, 'polygon': []},
            {'id': 'b', 'class_name': 'chair', 'bbox': [2.2, 0, 102.2, 100], 'area': 10000, 'polygon': []},
        ], config)
        self.assertEqual(result['delete_indices'], [])


class SingleTaskV2Test(unittest.TestCase):
    def _normalized(self, task_type, params=None, *, scope=None):
        return normalize_config(SmartFilterIn(
            schema_version=2,
            project_id='p',
            task_type=task_type,
            class_scope=scope or {'mode': 'all', 'classes': []},
            params=params or {},
        ))

    def test_params_reject_fields_from_another_task(self):
        with self.assertRaisesRegex(Exception, 'max_area_px'):
            self._normalized('remove_edge_spurs', {'radius_px': 1, 'max_area_px': 8})

    def test_ambiguous_v1_request_lists_conflicting_tasks(self):
        with self.assertRaisesRegex(Exception, 'ambiguous_legacy_filter'):
            normalize_config(SmartFilterIn(
                project_id='p', operation_mode='rule',
                small_target_enabled=True, confidence_enabled=True,
            ))

    def test_class_normalization_is_pure_relabel(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (32, 24), 'white').save(image_path)
            annotations = [
                {'id': 'box', 'class_name': 'old-a', 'bbox': [1, 1, 8, 8], 'area': 49, 'polygon': []},
                {'id': 'seg', 'class_name': 'old-b', 'bbox': [10, 2, 18, 10], 'area': 64, 'polygon': [[10, 2], [18, 2], [18, 10]]},
            ]
            result = analyze_project(
                base_dir=root, preview_token='v2',
                project={'id': 'p', 'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}]},
                config=self._normalized('normalize_classes', {'target_class': 'canonical'}),
                load_annotations=lambda _project_id, _image_id: [dict(row) for row in annotations],
            )
            change = result['change_sets'][0]
            self.assertEqual(change['delete_annotation_ids'], [])
            self.assertEqual(change['removed_count'], 0)
            self.assertEqual(change['relabel_count'], 2)
            self.assertEqual({row['annotation_id'] for row in change['relabels']}, {'box', 'seg'})
            self.assertEqual(result['candidate_count'], 0)

    def test_box_count_task_never_counts_or_deletes_segmentations(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (32, 24), 'white').save(image_path)
            mixed = [
                {'id': 'box', 'class_name': 'chair', 'bbox': [1, 1, 8, 8], 'area': 49, 'polygon': []},
                {'id': 'seg', 'class_name': 'chair', 'bbox': [10, 2, 18, 10], 'area': 64, 'polygon': [[10, 2], [18, 2], [18, 10]]},
            ]
            project = {'id': 'p', 'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}]}
            config = self._normalized('delete_by_box_count', {'min_boxes': 1, 'max_boxes': 1})
            result = analyze_project(base_dir=root, preview_token='mixed', project=project, config=config, load_annotations=lambda *_args: [dict(row) for row in mixed])
            self.assertEqual(result['change_sets'][0]['delete_annotation_ids'], ['box'])
            only_seg = analyze_project(base_dir=root, preview_token='seg', project=project, config=config, load_annotations=lambda *_args: [dict(mixed[1])])
            self.assertEqual(only_seg['change_sets'], [])
            self.assertEqual(only_seg['warnings'][0]['code'], 'no_bounding_boxes')

    def test_typical_preview_uses_stable_impact_median(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            images = []
            rows = {}
            for count, name in ((1, 'a.png'), (2, 'b.png'), (3, 'c.png')):
                path = root / name
                Image.new('RGB', (48, 32), 'white').save(path)
                image_id = name[0]
                images.append({'id': image_id, 'rel_path': name, 'abs_path': str(path)})
                rows[image_id] = [
                    {'id': f'{image_id}-{index}', 'class_name': 'chair', 'score': 0.1, 'bbox': [index * 5, 1, index * 5 + 4, 5], 'area': 16, 'polygon': []}
                    for index in range(count)
                ]
            result = analyze_project(
                base_dir=root, preview_token='median', project={'id': 'p', 'images': images},
                config=self._normalized('remove_confidence_range', {'min_confidence': 0, 'max_confidence': 0.2}),
                load_annotations=lambda _project_id, image_id: [dict(row) for row in rows[image_id]],
            )
            self.assertEqual(result['preview_samples'][0]['rel_path'], 'b.png')


class CleaningConfigTest(unittest.TestCase):
    def test_old_payload_defaults_advanced_operations_off(self):
        normalized = normalize_config(SmartFilterIn(project_id='p', operation_mode='component_noise'))
        self.assertFalse(normalized['component_opening_enabled'])
        self.assertFalse(normalized['component_gap_repair_enabled'])
        self.assertFalse(normalized['component_hole_fill_enabled'])

    def test_advanced_only_mode_and_signature_are_supported(self):
        first = normalize_config(SmartFilterIn(
            project_id='p',
            operation_mode='component_noise',
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_gap_repair_enabled=True,
            component_bridge_max_gap_px=16,
        ))
        second = normalize_config(SmartFilterIn(
            project_id='p',
            operation_mode='component_noise',
            component_abs_area_enabled=False,
            component_relative_area_enabled=False,
            component_gap_repair_enabled=True,
            component_bridge_max_gap_px=17,
        ))
        self.assertNotEqual(first['signature'], second['signature'])

    def test_hole_fill_requires_a_threshold(self):
        with self.assertRaisesRegex(Exception, 'hole fill requires'):
            normalize_config(SmartFilterIn(
                project_id='p',
                operation_mode='component_noise',
                component_abs_area_enabled=False,
                component_relative_area_enabled=False,
                component_hole_fill_enabled=True,
                component_hole_abs_area_enabled=False,
                component_hole_relative_area_enabled=False,
            ))


class UnifiedCleaningPreviewTest(unittest.TestCase):
    def test_job_service_returns_one_unified_instance_sample(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (96, 72), 'white').save(image_path)
            annotations = [
                {'id': 'box', 'class_name': 'chair', 'score': 0.9, 'bbox': [5, 5, 35, 35], 'area': 900, 'polygon': []},
                {
                    'id': 'segment', 'class_name': 'chair', 'score': 0.1,
                    'bbox': [55, 5, 85, 35], 'area': 900,
                    'polygon': [[55, 5], [85, 5], [85, 35], [55, 35]],
                },
            ]

            class PreviewStorage:
                base_dir = root

                @staticmethod
                def get_project(_project_id, *, enrich=False, include_images=True):
                    return {
                        'id': 'p', 'project_type': 'image', 'content_rev': 1,
                        'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}],
                    }

                @staticmethod
                def load_annotations(_project_id, _image_id):
                    return [dict(row) for row in annotations]

            service = SmartFilterJobService(
                get_storage=lambda: PreviewStorage(),
                logger=logging.getLogger('test.data_cleaning'),
                queue=None,
            )
            result = service.run_preview_job({
                'project_id': 'p', 'operation_mode': 'rule', 'rule_classes': ['chair'],
                'confidence_enabled': True, 'min_confidence': 0.0, 'max_confidence': 0.2,
                'include_missing_confidence': False,
            }, lambda **_updates: None)
            self.assertEqual(len(result['preview_samples']), 1)
            self.assertEqual(result['preview_samples'][0]['geometry_type'], 'mixed')
            self.assertEqual(result['preview_samples'][0]['annotation_count'], 2)
            self.assertEqual(result['preview_samples'][0]['candidate_count'], 1)

    def test_merge_rule_and_image_delete_share_one_preview_shape(self):
        cases = [
            (
                'merge',
                [
                    {'id': 'keep', 'class_name': 'chair', 'bbox': [2, 2, 26, 20], 'area': 432, 'polygon': [[2, 2], [26, 2], [26, 20], [2, 20]]},
                    {'id': 'drop', 'class_name': 'chair', 'bbox': [6, 6, 14, 14], 'area': 64, 'polygon': [[6, 6], [14, 6], [14, 14], [6, 14]]},
                ],
                {'merge_mode': 'same_class', 'spatial_mode': 'bbox_cover', 'coverage_threshold': 0.98, 'area_mode': 'instance'},
                'annotation_change',
            ),
            (
                'rule',
                [{'id': 'drop', 'class_name': 'chair', 'score': 0.1, 'bbox': [6, 6, 14, 14], 'area': 64, 'polygon': [[6, 6], [14, 6], [14, 14], [6, 14]]}],
                {
                    'rule_classes': ['chair'], 'confidence_enabled': True, 'min_confidence': 0.0,
                    'max_confidence': 0.2, 'include_missing_confidence': False,
                    'small_target_enabled': False, 'position_enabled': False, 'rule_match_mode': 'all',
                },
                'annotation_change',
            ),
            ('delete_unlabeled', [], {}, 'image_delete'),
        ]
        for operation, annotations, extra_config, expected_kind in cases:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as tmp_text:
                root = Path(tmp_text)
                image_path = root / 'image.png'
                Image.new('RGB', (32, 24), '#d1d5db').save(image_path)
                result = analyze_project(
                    base_dir=root,
                    preview_token='preview',
                    project={'id': 'p', 'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}]},
                    config={'project_id': 'p', 'operation_mode': operation, **extra_config},
                    load_annotations=lambda _project_id, _image_id, rows=annotations: [dict(row) for row in rows],
                )
                self.assertEqual(len(result['preview_samples']), 1)
                self.assertEqual(result['preview_artwork'], {'version': 1, 'status': 'ready'})
                sample = result['preview_samples'][0]
                self.assertEqual(sample['kind'], expected_kind)
                self.assertEqual(sample['image_id'], 'i')
                self.assertEqual(result['sample_urls'], [])
                for key in ('before_url', 'after_url'):
                    prefix = '/api/filter/intelligent/artifacts/preview/'
                    self.assertTrue(sample[key].startswith(prefix))
                    target = root / '.smart-filter-previews' / 'preview' / sample[key][len(prefix):]
                    self.assertTrue(target.is_file())
                    with Image.open(target) as rendered:
                        self.assertEqual(rendered.format, 'WEBP')

    def test_unified_preview_preserves_box_outline_and_segmentation_fill(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            background = (209, 213, 219)
            Image.new('RGB', (96, 72), background).save(image_path)
            annotations = [
                {
                    'id': 'box-only', 'class_name': 'chair', 'score': 0.9,
                    'bbox': [5, 5, 35, 35], 'area': 900, 'polygon': [],
                },
                {
                    'id': 'segmentation', 'class_name': 'chair', 'score': 0.1,
                    'bbox': [55, 5, 85, 35], 'area': 900,
                    'polygon': [[55, 5], [85, 5], [85, 35], [55, 35]],
                },
            ]
            result = analyze_project(
                base_dir=root,
                preview_token='preview',
                project={'id': 'p', 'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}]},
                config={
                    'project_id': 'p', 'operation_mode': 'rule', 'rule_classes': ['chair'],
                    'confidence_enabled': True, 'min_confidence': 0.0, 'max_confidence': 0.2,
                    'include_missing_confidence': False, 'small_target_enabled': False,
                    'position_enabled': False, 'rule_match_mode': 'all',
                },
                load_annotations=lambda _project_id, _image_id: [dict(row) for row in annotations],
            )
            self.assertEqual(len(result['preview_samples']), 1)
            sample = result['preview_samples'][0]
            self.assertEqual(sample['geometry_type'], 'mixed')
            self.assertEqual(sample['annotation_count'], 2)
            self.assertEqual(sample['candidate_count'], 1)
            prefix = '/api/filter/intelligent/artifacts/preview/'
            before_path = root / '.smart-filter-previews' / 'preview' / sample['before_url'][len(prefix):]
            after_path = root / '.smart-filter-previews' / 'preview' / sample['after_url'][len(prefix):]
            with Image.open(before_path) as rendered:
                before = rendered.convert('RGB')
            with Image.open(after_path) as rendered:
                after = rendered.convert('RGB')

            self.assertTrue(all(abs(actual - expected) < 18 for actual, expected in zip(before.getpixel((20, 20)), background)))
            before_edge = [before.getpixel((x, y)) for x in range(4, 10) for y in range(10, 31)]
            self.assertTrue(any(pixel[0] > pixel[1] + 35 for pixel in before_edge))
            self.assertGreater(before.getpixel((70, 20))[0], before.getpixel((70, 20))[1] + 45)
            after_edge = [after.getpixel((x, y)) for x in range(4, 10) for y in range(10, 31)]
            self.assertTrue(any(pixel[1] > pixel[0] + 35 for pixel in after_edge))
            self.assertTrue(all(abs(actual - expected) < 18 for actual, expected in zip(after.getpixel((20, 20)), background)))
            self.assertTrue(all(abs(actual - expected) < 18 for actual, expected in zip(after.getpixel((70, 20)), background)))

    def test_unified_preview_draws_each_overlapping_segmentation_boundary(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (96, 72), (209, 213, 219)).save(image_path)
            annotations = [
                {
                    'id': 'kept-outer', 'class_name': 'chair', 'score': 0.9,
                    'bbox': [10, 10, 60, 60], 'area': 2500,
                    'polygon': [[10, 10], [60, 10], [60, 60], [10, 60]],
                },
                {
                    'id': 'kept-overlap', 'class_name': 'chair', 'score': 0.9,
                    'bbox': [35, 20, 85, 55], 'area': 1750,
                    'polygon': [[35, 20], [85, 20], [85, 55], [35, 55]],
                },
                {
                    'id': 'deleted', 'class_name': 'chair', 'score': 0.1,
                    'bbox': [3, 63, 14, 70], 'area': 77,
                    'polygon': [[3, 63], [14, 63], [14, 70], [3, 70]],
                },
            ]
            result = analyze_project(
                base_dir=root,
                preview_token='preview',
                project={'id': 'p', 'images': [{'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)}]},
                config={
                    'project_id': 'p', 'operation_mode': 'rule', 'rule_classes': ['chair'],
                    'confidence_enabled': True, 'min_confidence': 0.0, 'max_confidence': 0.2,
                    'include_missing_confidence': False, 'small_target_enabled': False,
                    'position_enabled': False, 'rule_match_mode': 'all',
                },
                load_annotations=lambda _project_id, _image_id: [dict(row) for row in annotations],
            )
            sample = result['preview_samples'][0]
            self.assertEqual(sample['annotation_count'], 3)
            prefix = '/api/filter/intelligent/artifacts/preview/'
            before_path = root / '.smart-filter-previews' / 'preview' / sample['before_url'][len(prefix):]
            after_path = root / '.smart-filter-previews' / 'preview' / sample['after_url'][len(prefix):]
            with Image.open(before_path) as rendered:
                before = rendered.convert('RGB')
            with Image.open(after_path) as rendered:
                after = rendered.convert('RGB')

            # x=35 is the second kept instance's left edge but lies inside the
            # first mask. A union-only fill has no edge here; the dark halo
            # proves that this overlapping instance is rendered separately.
            before_edge = [before.getpixel((x, y)) for x in range(31, 40) for y in range(27, 44)]
            after_edge = [after.getpixel((x, y)) for x in range(31, 40) for y in range(27, 44)]
            self.assertTrue(any(max(pixel) < 100 for pixel in before_edge))
            self.assertTrue(any(max(pixel) < 100 for pixel in after_edge))

    def test_preview_artwork_failure_does_not_fail_analysis(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            with self.assertLogs('web_auto.data_cleaning', level='ERROR') as captured:
                result = analyze_project(
                    base_dir=Path(tmp_text),
                    preview_token='preview',
                    project={'id': 'p', 'images': [{'id': 'i', 'rel_path': 'missing.png', 'abs_path': str(Path(tmp_text) / 'missing.png')}]},
                    config={'project_id': 'p', 'operation_mode': 'delete_unlabeled'},
                    load_annotations=lambda _project_id, _image_id: [],
                )
            self.assertEqual(result['image_count'], 1)
            self.assertEqual(result['preview_samples'], [])
            self.assertEqual(result['preview_artwork']['status'], 'failed')
            self.assertEqual(result['preview_artwork']['error_code'], 'source_unavailable')
            self.assertIn('failed to render smart-filter preview artwork', captured.output[0])


class TopologyAggregationTest(unittest.TestCase):
    def test_project_summary_and_change_set_include_topology_metrics(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            image_path = root / 'image.png'
            Image.new('RGB', (32, 24), 'white').save(image_path)
            second_image_path = root / 'image-2.png'
            Image.new('RGB', (32, 24), 'white').save(second_image_path)
            mask = np.zeros((24, 32), np.uint8)
            mask[5:15, 2:8] = 255
            mask[5:15, 11:17] = 255
            cv2.imwrite(str(annotation_mask_path(root, 'p', 'i', 'a')), mask)
            cv2.imwrite(str(annotation_mask_path(root, 'p', 'i2', 'a')), mask)
            cfg = {
                'project_id': 'p',
                'operation_mode': 'component_noise',
                'component_abs_area_enabled': False,
                'component_relative_area_enabled': False,
                'component_gap_repair_enabled': True,
                'component_gap_repair_method': 'shortest_bridge',
                'component_bridge_max_gap_px': 3,
                'component_bridge_width_px': 1,
                'component_bridge_topology': 'mst',
                'component_gap_avoid_other_instances': True,
            }
            result = analyze_project(
                base_dir=root,
                preview_token='preview',
                project={'id': 'p', 'images': [
                    {'id': 'i', 'rel_path': 'image.png', 'abs_path': str(image_path)},
                    {'id': 'i2', 'rel_path': 'image-2.png', 'abs_path': str(second_image_path)},
                ]},
                config=cfg,
                load_annotations=lambda _project_id, _image_id: [{'id': 'a', 'class_name': 'thing'}],
            )
            self.assertEqual(result['bridges_added'], 2)
            self.assertEqual(result['bridge_pixels'], 6)
            self.assertEqual(result['modified_annotations'], 2)
            self.assertEqual(result['change_sets'][0]['bridges_added'], 1)
            self.assertEqual(len(result['sample_urls']), 2)
            self.assertEqual(len(result['preview_samples']), 2)
            self.assertEqual(result['preview_samples'][0]['kind'], 'annotation_change')
            self.assertEqual(sum('sample_before_url' in item for item in result['items']), 2)
            self.assertEqual(sum('sample_after_url' in item for item in result['items']), 2)
            sample_dir = root / '.smart-filter-previews' / 'preview' / 'samples'
            self.assertEqual(len(list(sample_dir.glob('*_before.webp'))), 2)
            self.assertEqual(len(list(sample_dir.glob('*_after.webp'))), 2)
            sample = result['preview_samples'][0]
            self.assertEqual(sample['added_pixels'], 3)
            self.assertEqual(sample['removed_pixels'], 0)
            self.assertIsNotNone(sample['change_bbox'])
            self.assertTrue(sample['diff_detail_url'].endswith('.png'))
            diff = Image.open(sample_dir / sample['diff_url'].rsplit('/', 1)[-1]).convert('RGB')
            pixels = np.asarray(diff).astype(int)
            self.assertEqual(int((pixels[:, :, 2] > pixels[:, :, 0] + 100).sum()), 3)


class FakeStorage:
    def __init__(self, root: Path, annotations: list[dict], fail_once: bool = False):
        self.base_dir = root
        self.annotations = annotations
        self.fail_once = fail_once

    def load_annotations(self, _project_id, _image_id):
        return [dict(item) for item in self.annotations]

    def save_annotations(self, _project_id, _image_id, annotations):
        if self.fail_once:
            self.fail_once = False
            raise OSError('injected write failure')
        self.annotations = [dict(item) for item in annotations]


class ApplySafetyTest(unittest.TestCase):
    def test_batch_apply_and_failed_batch_restore_real_storage(self):
        from app.services.job_queue import PersistentJobQueue
        for fail, geometry in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(fail=fail, geometry=geometry), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                images = root / 'images'
                images.mkdir()
                for index in range(3):
                    Image.new('RGB', (32, 24), 'white').save(images / f'{index}.png')
                storage = Storage(root / 'data')
                project = storage.create_project(name='batch', image_dir=str(images), save_dir=str(root / 'out'), classes_text='chair')
                pid = project['id']
                rows = storage.get_project(pid, include_images=True)['images']
                original_masks = {}
                for index, row in enumerate(rows):
                    annotation = {'id': f'ann_{index}', 'class_name': 'chair', 'bbox': [2, 2, 10, 10], 'score': 0.1}
                    if geometry:
                        mask = np.zeros((24, 32), np.uint8)
                        mask[2:12, 2:12] = 255
                        mask[20, 20] = 255
                        ok, encoded = cv2.imencode('.png', mask)
                        self.assertTrue(ok)
                        annotation['mask_png_base64'] = base64.b64encode(encoded.tobytes()).decode('ascii')
                    storage.save_annotations(pid, row['id'], [annotation])
                    if geometry:
                        path = annotation_mask_path(storage.base_dir, pid, row['id'], annotation['id'])
                        original_masks[path] = path.read_bytes()
                queue = PersistentJobQueue(root / 'queue.sqlite3')
                service = SmartFilterJobService(get_storage=lambda: storage, logger=logging.getLogger('test'), queue=queue)
                payload = SmartFilterIn(project_id=pid, schema_version=2, task_type='remove_confidence_range', class_scope={'mode': 'all', 'classes': []}, params={'min_confidence': 0, 'max_confidence': 0.2})
                if geometry:
                    payload = SmartFilterIn(project_id=pid, schema_version=2, task_type='remove_small_components', class_scope={'mode': 'all', 'classes': []}, params={'absolute_area_enabled': True, 'max_area_px': 4, 'relative_area_enabled': False})
                preview = service.run_sync_preview(payload)
                data = payload.model_dump(exclude_unset=True)
                data['preview_token'] = preview['preview_token']
                original_replace = storage._replace_annotation_index_db
                calls = 0

                def replace(*args, **kwargs):
                    nonlocal calls
                    calls += 1
                    if fail and calls == 2:
                        raise OSError('injected batch failure')
                    return original_replace(*args, **kwargs)

                with patch.object(storage, '_replace_annotation_index_db', side_effect=replace), patch.object(storage, '_save_projects', wraps=storage._save_projects) as save_catalog:
                    if fail:
                        with self.assertRaisesRegex(OSError, 'injected batch failure'):
                            service.run_apply_job(data, lambda **_: None)
                    else:
                        result = service.run_apply_job(data, lambda **_: None)
                        self.assertEqual(result['changed_images'], 3)
                        self.assertEqual(save_catalog.call_count, 1)
                        self.assertIn('persistence_seconds', result['timings'])
                for row in rows:
                    self.assertEqual(len(storage.load_annotations(pid, row['id'])), 1 if fail or geometry else 0)
                for path, original in original_masks.items():
                    if fail:
                        self.assertEqual(path.read_bytes(), original)
                    else:
                        self.assertNotEqual(path.read_bytes(), original)
                if not fail:
                    storage.rollback_smart_filter_run(project_id=pid, run_id=result['rollback_run_id'])
                    self.assertTrue(all(len(storage.load_annotations(pid, row['id'])) == 1 for row in rows))
                    for path, original in original_masks.items():
                        self.assertEqual(path.read_bytes(), original)

    def test_apply_reuses_versioned_preview_change_sets_without_reanalysis(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            payload = SmartFilterIn(
                project_id='p',
                schema_version=2,
                task_type='remove_confidence_range',
                class_scope={'mode': 'all', 'classes': []},
                params={'min_confidence': 0.0, 'max_confidence': 0.2},
                preview_token='preview-token',
            )
            normalized = normalize_config(payload)

            class ApplyStorage:
                base_dir = root

                @staticmethod
                def get_project(_project_id, *, enrich=False, include_images=False):
                    return {'id': 'p', 'project_type': 'image', 'content_rev': 7}

                @staticmethod
                def load_annotations(_project_id, _image_id):
                    raise AssertionError('apply must not rescan project annotations')

            service = SmartFilterJobService(
                get_storage=lambda: ApplyStorage(),
                logger=logging.getLogger('test.data_cleaning'),
                queue=None,
            )
            service._find_preview = lambda _project_id, _token: {
                'preview_token': 'preview-token',
                'project_content_rev': 7,
                'signature': normalized['signature'],
                'config': service._public_rule(normalized),
                'change_sets': [],
                'preview_artwork': {'version': 1, 'status': 'not_needed'},
            }

            with patch(
                'app.services.smart_filter_service.analyze_project',
                side_effect=AssertionError('apply must not rerun project analysis'),
            ):
                result = service.run_apply_job(payload.model_dump(exclude_unset=True), lambda **_updates: None)

            self.assertTrue(result['analysis_reused'])
            self.assertEqual(result['preview_token'], 'preview-token')
            self.assertEqual(result['changed_images'], 0)

    def test_annotation_id_targets_survive_array_reordering(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            original = [
                {'id': 'keep', 'class_name': 'chair', 'bbox': [0, 0, 10, 10]},
                {'id': 'drop', 'class_name': 'chair', 'bbox': [1, 1, 4, 4]},
            ]
            storage = FakeStorage(root, list(reversed(original)))
            change = {
                'image_id': 'i', 'rel_path': 'i.png',
                'delete_indices': [1],
                'delete_annotation_ids': ['drop'],
                'delete_fingerprints': {'drop': annotation_fingerprint(original[1])},
                'relabels': [], 'geometry_updates': [], 'removed_count': 1,
            }
            apply_change_sets(storage=storage, project_id='p', artifact_dir=root / 'preview', change_sets=[change])
            self.assertEqual([row['id'] for row in storage.annotations], ['keep'])

    def test_mask_hash_validation_and_write_failure_restore(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            target = annotation_mask_path(root, 'p', 'i', 'a')
            target.write_bytes(b'original-mask')
            staged = root / 'preview' / 'masks' / 'i' / 'a.png'
            staged.parent.mkdir(parents=True)
            staged.write_bytes(b'cleaned-mask')
            digest = hashlib.sha256(b'original-mask').hexdigest()
            change = {
                'image_id': 'i', 'rel_path': 'i.png', 'delete_indices': [], 'relabels': [],
                'geometry_updates': [{'annotation_index': 0, 'annotation_id': 'a', 'original_mask_sha256': digest, 'staged_mask': 'masks/i/a.png', 'patch': {'area': 1}}],
            }
            storage = FakeStorage(root, [{'id': 'a', 'area': 2}], fail_once=True)
            with self.assertRaises(OSError):
                apply_change_sets(storage=storage, project_id='p', artifact_dir=root / 'preview', change_sets=[change])
            self.assertEqual(target.read_bytes(), b'original-mask')
            self.assertEqual(storage.annotations[0]['area'], 2)
            target.write_bytes(b'changed-externally')
            with self.assertRaisesRegex(RuntimeError, 'mask changed'):
                apply_change_sets(storage=storage, project_id='p', artifact_dir=root / 'preview', change_sets=[change])

    def test_storage_rollback_restores_annotation_json_and_mask_hash(self):
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (20, 20), 'white').save(images / 'one.png')
            storage = Storage(root / 'data')
            project = storage.create_project(name='rollback', image_dir=str(images), save_dir=str(root / 'output'), classes_text='thing')
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            mask = np.zeros((20, 20), np.uint8)
            mask[2:10, 2:10] = 255
            ok, encoded = cv2.imencode('.png', mask)
            self.assertTrue(ok)
            storage.save_annotations(project_id, image_id, [{
                'id': 'stable_id', 'class_name': 'thing', 'score': 0.7,
                'mask_png_base64': base64.b64encode(encoded.tobytes()).decode('ascii'),
            }])
            original_annotations = storage.load_annotations(project_id, image_id)
            mask_path = annotation_mask_path(storage.base_dir, project_id, image_id, 'stable_id')
            original_hash = hashlib.sha256(mask_path.read_bytes()).hexdigest()
            run_id = storage.begin_smart_filter_run(project_id=project_id, operation_mode='component_noise')
            storage.add_smart_filter_snapshot(run_id=run_id, project_id=project_id, image_id=image_id, annotations=original_annotations)

            changed = np.zeros((20, 20), np.uint8)
            changed[2:8, 2:8] = 255
            changed_path = mask_path.with_suffix('.changed.png')
            cv2.imwrite(str(changed_path), changed)
            changed_path.replace(mask_path)
            modified = [dict(original_annotations[0], area=36.0, bbox=[2, 2, 8, 8])]
            storage.save_annotations(project_id, image_id, modified)
            storage.finish_smart_filter_run(run_id=run_id, summary={'changed_images': 1})
            result = storage.rollback_smart_filter_run(project_id=project_id, run_id=run_id)

            self.assertEqual(result['restored_images'], 1)
            self.assertEqual(result['skipped_images'], 0)
            self.assertEqual(hashlib.sha256(mask_path.read_bytes()).hexdigest(), original_hash)
            self.assertEqual(
                json.dumps(storage.load_annotations(project_id, image_id), sort_keys=True),
                json.dumps(original_annotations, sort_keys=True),
            )


if __name__ == '__main__':
    unittest.main()
