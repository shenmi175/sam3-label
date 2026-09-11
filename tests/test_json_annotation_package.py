from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.exporting import ExportService  # noqa: E402
from app.exporting.writers.yolo import merge_multi_segment  # noqa: E402
from app.routers.export import create_export_router  # noqa: E402
from app.schemas import ExportIn, ExportPreflightIn  # noqa: E402


class _StorageStub:
    def __init__(self) -> None:
        self.project = {
            'id': 'project-1',
            'name': 'profile project',
            'content_rev': 8,
            'classes': ['door'],
            'image_dir': '/private/source/images',
            'images': [
                {'id': 'image-jpg', 'rel_path': 'nested/same.jpg', 'width': 100, 'height': 80},
                {'id': 'image-png', 'rel_path': 'nested/same.png', 'width': 100, 'height': 80},
                {'id': 'negative', 'rel_path': 'negative.jpg', 'width': 60, 'height': 40},
            ],
        }
        self.annotations = {
            'image-jpg': [{
                'id': 'multipart',
                'class_name': 'door',
                'source_model': 'sam3',
                'bbox': [0, 0, 99, 79],
                'area': 9999,
                'score': 0.7,
                'component_count': 2,
                'polygons': [
                    [[1, 2], [11, 2], [11, 12], [1, 12]],
                    [[30, 20], [40, 20], [40, 30], [30, 30]],
                ],
                'mask_url': '/private/mask.png',
            }],
            'image-png': [{
                'id': 'bbox-only', 'class_name': 'door', 'source_model': 'locate-anything',
                'bbox': [5, 5, 15, 25],
            }],
            'negative': [],
        }

    def get_project(self, project_id: str, **_kwargs):
        return self.project if project_id == self.project['id'] else None

    def all_annotations(self, project_id: str):
        if project_id != self.project['id']:
            raise ValueError('project not found')
        return self.annotations


class ExportProfilesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = _StorageStub()
        router = create_export_router(get_storage=lambda: self.storage)
        self.export = next(route.endpoint for route in router.routes if getattr(route, 'path', '') == '/api/export')
        self.preflight = next(route.endpoint for route in router.routes if getattr(route, 'path', '') == '/api/export/preflight')

    def payload(self, profile: str, output_dir: str | None = None, **overrides):
        values = {
            'project_id': 'project-1',
            'profile': profile,
            'output_dir': output_dir,
            'source_models': ['sam3'],
            'classes': ['door'],
            'val_ratio': 0.25,
            'yolo_multipart_policy': 'official_bridge',
        }
        values.update(overrides)
        return values

    def test_native_json_uses_the_shared_normalized_instances(self) -> None:
        with tempfile.TemporaryDirectory() as output:
            response = self.export(ExportIn(**self.payload('native_json_v2', output, expected_content_rev=8)))
            archive = Path(response['output'])
            with zipfile.ZipFile(archive) as bundle:
                annotation_files = [name for name in bundle.namelist() if name.startswith('annotations/')]
                self.assertEqual(len(annotation_files), 3)
                document = json.loads(bundle.read('annotations/nested/same.jpg.json'))
                instance = document['instances'][0]
                self.assertEqual(len(instance['regions']), 2)
                self.assertEqual(instance['bbox_xyxy'], [0.0, 0.0, 99.0, 79.0])
                self.assertEqual(instance['area'], 200.0)
                self.assertNotIn('/private', json.dumps(instance))
                self.assertEqual(json.loads(bundle.read('annotations/negative.json'))['instances'], [])
                self.assertFalse(any(name.endswith(('.jpg', '.png', '.webp')) for name in bundle.namelist()))

    def test_modern_multi_polygons_are_one_instance_in_every_profile(self) -> None:
        for profile in (
            'native_json_v2',
            'coco_detection',
            'coco_instance',
            'yolo_detection',
            'yolo_instance',
        ):
            with self.subTest(profile=profile):
                report = self.preflight(ExportPreflightIn(**self.payload(profile, source_models=['sam3'])))
                self.assertTrue(report['ok'])
                self.assertNotIn('INCOMPLETE_COMPONENT_GROUP', {item['code'] for item in report['blockers']})
                self.assertEqual(report['stats']['annotations_selected'], 1)
                self.assertEqual(report['stats']['instances_written'], 1)
                self.assertEqual(report['stats']['regions_written'], 2)
                self.assertEqual(report['stats']['output_records'], 3)

    def test_coco_profiles_keep_multipart_and_negative_images(self) -> None:
        with tempfile.TemporaryDirectory() as output:
            instance_response = self.export(ExportIn(**self.payload(
                'coco_instance', output, source_models=['sam3'], expected_content_rev=8,
            )))
            self.assertEqual(Path(instance_response['output']).suffix, '.zip')
            with zipfile.ZipFile(instance_response['output']) as bundle:
                annotation_files = sorted(name for name in bundle.namelist() if name.startswith('annotations/'))
                self.assertEqual(annotation_files, [
                    'annotations/negative.json',
                    'annotations/nested/same.jpg.json',
                    'annotations/nested/same.png.json',
                ])
                coco = json.loads(bundle.read('annotations/nested/same.jpg.json'))
                self.assertEqual(len(coco['images']), 1)
                self.assertEqual(len(coco['annotations']), 1)
                annotation = coco['annotations'][0]
                self.assertEqual(len(annotation['segmentation']), 2)
                self.assertEqual(annotation['bbox'], [0.0, 0.0, 99.0, 79.0])
                self.assertEqual(annotation['area'], 200.0)
                self.assertNotIn('score', annotation)
                self.assertEqual(coco['categories'], [{'id': 1, 'name': 'door'}])
                self.assertEqual(json.loads(bundle.read('annotations/negative.json'))['annotations'], [])
                self.assertTrue(json.loads(bundle.read('manifest.json'))['per_image_annotations'])
            self.assertEqual(instance_response['stats']['negative_images'], 2)

            detection_response = self.export(ExportIn(**self.payload(
                'coco_detection', output, source_models=['sam3', 'locate-anything'], expected_content_rev=8,
            )))
            with zipfile.ZipFile(detection_response['output']) as bundle:
                jpg_detection = json.loads(bundle.read('annotations/nested/same.jpg.json'))
                png_detection = json.loads(bundle.read('annotations/nested/same.png.json'))
                self.assertEqual(len(jpg_detection['annotations']), 1)
                self.assertEqual(len(png_detection['annotations']), 1)
                self.assertTrue(all('segmentation' not in item for item in jpg_detection['annotations'] + png_detection['annotations']))
            self.assertNotEqual(instance_response['output'], detection_response['output'])

    def test_segmentation_confirms_and_skips_bbox_only_instances_while_detection_keeps_them(self) -> None:
        self.storage.annotations['image-png'][0]['source_model'] = 'locate-anything'
        self.storage.annotations['negative'].append({
            'id': 'sam3-bbox-only',
            'class_name': 'door',
            'source_model': 'sam3',
            'bbox': [1, 1, 10, 10],
        })
        sources = ['sam3', 'locate-anything']

        for profile in ('coco_instance', 'yolo_instance'):
            with self.subTest(profile=profile):
                report = self.preflight(ExportPreflightIn(**self.payload(
                    profile,
                    source_models=sources,
                )))
                self.assertTrue(report['ok'])
                issue = next(
                    item for item in report['warnings']
                    if item['code'] == 'SEGMENTATION_REQUIRES_POLYGON'
                )
                self.assertEqual(issue['severity'], 'warning')
                self.assertEqual(issue['count'], 2)
                self.assertEqual(issue['details'], {
                    'profile': profile,
                    'by_source': {'locate-anything': 1, 'sam3': 1},
                    'selected_sources': sources,
                    'skipped_sources': ['locate-anything', 'sam3'],
                })
                self.assertEqual(
                    {sample['source_model'] for sample in issue['samples']},
                    {'locate-anything', 'sam3'},
                )
                self.assertTrue(all(sample['class_name'] == 'door' for sample in issue['samples']))
                self.assertIn('SEGMENTATION_REQUIRES_POLYGON', report['confirmation_required_codes'])
                self.assertEqual(report['stats']['instances_written'], 1)
                self.assertEqual(report['stats']['bbox_only_instances'], 2)

        for profile in ('coco_detection', 'yolo_detection'):
            with self.subTest(profile=profile):
                allowed = self.preflight(ExportPreflightIn(**self.payload(
                    profile,
                    source_models=sources,
                )))
                self.assertTrue(allowed['ok'])

        with tempfile.TemporaryDirectory() as output:
            with self.assertRaises(HTTPException) as context:
                self.export(ExportIn(**self.payload(
                    'coco_instance', output, source_models=sources, expected_content_rev=8,
                )))
            self.assertEqual(context.exception.status_code, 409)
            self.assertEqual(context.exception.detail['code'], 'EXPORT_CONFIRMATION_REQUIRED')

            response = self.export(ExportIn(**self.payload(
                'coco_instance', output, source_models=sources, expected_content_rev=8,
                confirmed_issue_codes=['SEGMENTATION_REQUIRES_POLYGON'],
            )))
            self.assertEqual(response['stats']['instances_written'], 1)
            with zipfile.ZipFile(response['output']) as bundle:
                self.assertEqual(json.loads(bundle.read('annotations/nested/same.png.json'))['annotations'], [])
                self.assertEqual(json.loads(bundle.read('annotations/negative.json'))['annotations'], [])

    def test_yolo_bridge_requires_confirmation_and_writes_one_line(self) -> None:
        preflight = self.preflight(ExportPreflightIn(**self.payload('yolo_instance', source_models=['sam3'])))
        self.assertTrue(preflight['ok'])
        self.assertEqual(preflight['confirmation_required_codes'], ['YOLO_MULTIPART_BRIDGE'])
        bridge = preflight['format_details']['multipart_bridge']
        self.assertEqual(bridge['affected_instances'], 1)
        self.assertEqual(bridge['connections'], 1)
        self.assertIn('added_pixels', bridge)
        self.assertIn('iou', bridge)

        with tempfile.TemporaryDirectory() as output:
            with self.assertRaises(HTTPException) as context:
                self.export(ExportIn(**self.payload(
                    'yolo_instance', output, source_models=['sam3'], expected_content_rev=8,
                )))
            self.assertEqual(context.exception.status_code, 409)
            self.assertEqual(context.exception.detail['code'], 'EXPORT_CONFIRMATION_REQUIRED')

            response = self.export(ExportIn(**self.payload(
                'yolo_instance', output, source_models=['sam3'], expected_content_rev=8,
                confirmed_issue_codes=['YOLO_MULTIPART_BRIDGE'],
            )))
            self.assertEqual(Path(response['output']).suffix, '.zip')
            with zipfile.ZipFile(response['output']) as bundle:
                names = bundle.namelist()
                labels = [name for name in names if name.startswith('labels/') and name.endswith('.txt')]
                self.assertEqual(len(labels), 3)
                index = json.loads(bundle.read('image_index.json'))['images']
                by_image_id = {item['image_id']: item for item in index}
                self.assertEqual(len(bundle.read(by_image_id['image-jpg']['label_path']).decode().splitlines()), 1)
                self.assertEqual(bundle.read(by_image_id['image-png']['label_path']), b'')
                self.assertEqual(bundle.read(by_image_id['negative']['label_path']), b'')
                self.assertTrue(all(item['label_path'].startswith(f"labels/{item['split']}/") for item in index))
                self.assertNotIn('data.yaml', names)
                self.assertNotIn('/private/', bundle.read('train.txt').decode())
                self.assertFalse(any(name.lower().endswith(('.jpg', '.png', '.webp')) for name in names))

    def test_yolo_can_publish_ready_to_train_directories_with_linked_or_copied_images(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source_root = Path(root) / 'source'
            output_root = Path(root) / 'exports'
            from PIL import Image
            for image in self.storage.project['images']:
                source = source_root / image['rel_path']
                source.parent.mkdir(parents=True, exist_ok=True)
                Image.new('RGB', (10, 10)).save(source)
                image['abs_path'] = str(source)

            legacy = ExportIn(**self.payload(
                'yolo_detection', str(output_root), expected_content_rev=8, link_images=True,
            ))
            self.assertEqual(legacy.image_mode, 'symlink')

            for image_mode in ('symlink', 'copy'):
                with self.subTest(image_mode=image_mode):
                    response = self.export(ExportIn(**self.payload(
                        'yolo_detection', str(output_root), source_models=['sam3'],
                        expected_content_rev=8, image_mode=image_mode,
                    )))
                    directory = Path(response['output'])
                    self.assertTrue(directory.is_dir())
                    self.assertFalse(directory.name.endswith('.zip'))
                    self.assertTrue((directory / 'data.yaml').is_file())
                    data_yaml = (directory / 'data.yaml').read_text(encoding='utf-8')
                    self.assertNotIn('path:', data_yaml)
                    self.assertIn('train: images/train', data_yaml)
                    self.assertIn('val: images/val', data_yaml)
                    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
                    self.assertFalse(manifest['annotation_only'])
                    self.assertEqual(manifest['image_mode'], image_mode)
                    self.assertEqual(manifest['image_symlinks_included'], image_mode == 'symlink')
                    self.assertEqual(manifest['image_binaries_included'], image_mode == 'copy')

                    index = json.loads((directory / 'image_index.json').read_text(encoding='utf-8'))['images']
                    self.assertEqual(len(index), 3)
                    self.assertEqual(len(list((directory / 'images').rglob('*.*'))), 3)
                    for item in index:
                        exported_image = directory / item['training_image_path']
                        self.assertEqual(exported_image.is_symlink(), image_mode == 'symlink')
                        self.assertTrue(exported_image.resolve().is_file())
                        self.assertTrue(item['training_image_path'].startswith(f"images/{item['split']}/"))
                        self.assertTrue(item['label_path'].startswith(f"labels/{item['split']}/"))
                        expected_label = directory / item['training_image_path'].replace('images/', 'labels/', 1)
                        expected_label = expected_label.with_suffix('.txt')
                        self.assertEqual(expected_label.as_posix(), (directory / item['label_path']).as_posix())
                        self.assertTrue(expected_label.is_file())
                    split_entries = (
                        (directory / 'train.txt').read_text(encoding='utf-8').splitlines()
                        + (directory / 'val.txt').read_text(encoding='utf-8').splitlines()
                    )
                    self.assertEqual(set(split_entries), {item['training_image_path'] for item in index})
                    self.assertTrue(all(item.startswith('images/') for item in split_entries))

    def test_native_and_coco_can_retain_linked_or_copied_images(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            from PIL import Image

            source_root = Path(root) / 'source'
            output_root = Path(root) / 'exports'
            for image in self.storage.project['images']:
                source = source_root / image['rel_path']
                source.parent.mkdir(parents=True, exist_ok=True)
                Image.new('RGB', (10, 10)).save(source)
                image['abs_path'] = str(source)

            for profile in ('native_json_v2', 'coco_detection', 'coco_instance'):
                for image_mode in ('symlink', 'copy'):
                    with self.subTest(profile=profile, image_mode=image_mode):
                        response = self.export(ExportIn(**self.payload(
                            profile,
                            str(output_root),
                            source_models=['sam3'],
                            expected_content_rev=8,
                            image_mode=image_mode,
                        )))
                        directory = Path(response['output'])
                        self.assertTrue(directory.is_dir())
                        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
                        self.assertEqual(manifest['image_mode'], image_mode)
                        flags = manifest['layout'] if profile == 'native_json_v2' else manifest
                        self.assertEqual(flags['image_symlinks_included'], image_mode == 'symlink')
                        self.assertEqual(flags['image_binaries_included'], image_mode == 'copy')

                        index = json.loads((directory / 'image_index.json').read_text(encoding='utf-8'))['images']
                        self.assertEqual(len(index), 3)
                        for item in index:
                            self.assertTrue(item['export_image_path'].startswith('images/'))
                            exported_image = directory / item['export_image_path']
                            self.assertTrue(exported_image.is_file())
                            self.assertEqual(exported_image.is_symlink(), image_mode == 'symlink')
                            document = json.loads((directory / item['annotation_path']).read_text(encoding='utf-8'))
                            if profile == 'native_json_v2':
                                self.assertEqual(document['image']['export_image_path'], item['export_image_path'])
                            else:
                                self.assertEqual(document['images'][0]['file_name'], item['export_image_path'])

    def test_yolo_reject_policy_blocks_multipart(self) -> None:
        report = self.preflight(ExportPreflightIn(**self.payload(
            'yolo_instance', source_models=['sam3'], yolo_multipart_policy='reject',
        )))
        self.assertFalse(report['ok'])
        self.assertIn('YOLO_MULTIPART_REJECTED', {item['code'] for item in report['blockers']})

    def test_split_components_block_until_migrated(self) -> None:
        project = {
            'id': 'split', 'name': 'split', 'content_rev': 1, 'classes': ['door'],
            'images': [{'id': 'i', 'rel_path': 'i.jpg', 'width': 50, 'height': 50}],
        }
        complete = {'i': [
            {'id': 'a', 'model_det_id': 'det', 'contour_index': 1, 'contour_count': 2, 'class_name': 'door', 'source_model': 'sam3', 'polygon': [[1, 1], [5, 1], [5, 5]]},
            {'id': 'b', 'model_det_id': 'det', 'contour_index': 2, 'contour_count': 2, 'class_name': 'door', 'source_model': 'sam3', 'polygon': [[20, 20], [25, 20], [25, 25]]},
        ]}
        service = ExportService()
        snapshot = service.preflight(profile='coco_instance', project=project, all_annotations=complete, source_models=['sam3'], classes=['door'])
        self.assertFalse(snapshot.ok)
        self.assertIn('UNSUPPORTED_SPLIT_ANNOTATION', {issue.code for issue in snapshot.blockers})
        incomplete = {'i': complete['i'][:1]}
        blocked = service.preflight(profile='coco_instance', project=project, all_annotations=incomplete, source_models=['sam3'], classes=['door'])
        self.assertFalse(blocked.ok)
        self.assertIn('UNSUPPORTED_SPLIT_ANNOTATION', {issue.code for issue in blocked.blockers})

    def test_self_intersection_missing_dimensions_and_stale_revision_block(self) -> None:
        project = {'id': 'bad', 'classes': ['door'], 'images': [{'id': 'i', 'rel_path': 'i.jpg'}]}
        annotations = {'i': [{
            'id': 'a', 'class_name': 'door', 'source_model': 'sam3',
            'bbox': [0, 0, 10, 10],
            'polygon': [[0, 0], [10, 10], [0, 10], [10, 0]],
        }]}
        snapshot = ExportService().preflight(profile='coco_instance', project=project, all_annotations=annotations, source_models=['sam3'], classes=['door'])
        codes = {issue.code for issue in snapshot.blockers}
        self.assertIn('IMAGE_DIMENSIONS_UNAVAILABLE', codes)
        self.assertIn('SELF_INTERSECTING_POLYGON', codes)

        detection_project = {
            **project,
            'images': [{'id': 'i', 'rel_path': 'i.jpg', 'width': 20, 'height': 20}],
        }
        for profile in ('coco_detection', 'yolo_detection'):
            with self.subTest(profile=profile):
                detection = ExportService().preflight(
                    profile=profile,
                    project=detection_project,
                    all_annotations=annotations,
                    source_models=['sam3'],
                    classes=['door'],
                )
                self.assertTrue(detection.ok)
                self.assertIn('INVALID_POLYGON_BBOX_FALLBACK', {issue.code for issue in detection.warnings})
                self.assertEqual(detection.images[0].instances[0].bbox_xyxy, [0.0, 0.0, 10.0, 10.0])
                self.assertEqual(detection.images[0].instances[0].regions, [])

        with tempfile.TemporaryDirectory() as output, self.assertRaises(HTTPException) as context:
            self.export(ExportIn(**self.payload('coco_detection', output, expected_content_rev=7)))
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.detail['code'], 'EXPORT_STALE')

    def test_official_bridge_fixed_output_and_schema_validation(self) -> None:
        merged = merge_multi_segment([
            [[1, 1], [5, 1], [5, 5]],
            [[10, 10], [15, 10], [15, 15]],
        ])
        self.assertEqual(merged, [
            [5.0, 5.0], [1.0, 1.0], [5.0, 1.0], [5.0, 5.0],
            [10.0, 10.0], [15.0, 10.0], [15.0, 15.0], [10.0, 10.0],
        ])
        with self.assertRaises(ValidationError):
            ExportPreflightIn(**self.payload('coco_detection', source_models=[]))
        with self.assertRaises(ValidationError):
            ExportPreflightIn(**self.payload('xml'))


if __name__ == '__main__':
    unittest.main()
