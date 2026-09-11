from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.annotations import normalize_source  # noqa: E402
from app.repositories.analytics_index import ANALYTICS_INDEX_VERSION, build_analytics_rows  # noqa: E402
from app.routers.analytics import create_analytics_router  # noqa: E402
from app.services.analytics_service import AnalyticsService  # noqa: E402
from app.services.job_queue import PersistentJobQueue  # noqa: E402
from app.storage import Storage  # noqa: E402


class AnalyticsGeometryTests(unittest.TestCase):
    def test_analyze_image_normalizes_geometry_and_keeps_missing_score_null(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            image_path = Path(tmp_raw) / 'image.png'
            Image.new('RGB', (100, 50)).save(image_path)
            image, objects = build_analytics_rows('img', str(image_path), [{
                'id': 'ann',
                'class_name': 'Cat',
                'bbox': [10, 5, 30, 15],
            }])

            self.assertEqual(image['width'], 100)
            self.assertEqual(image['height'], 50)
            self.assertEqual(objects[0]['geometry_type'], 'bbox_only')
            self.assertAlmostEqual(objects[0]['bbox_area_ratio'], 0.04)
            self.assertAlmostEqual(objects[0]['bbox_cx_norm'], 0.2)
            self.assertIsNone(objects[0]['score'])

    def test_task_capabilities_source_and_fill_ratio_are_consistent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            image_path = Path(tmp_raw) / 'image.png'
            Image.new('RGB', (100, 100)).save(image_path)
            _image, objects = build_analytics_rows('img', str(image_path), [
                {'id': 'det', 'bbox': [0, 0, 20, 10], 'source_model': 'LA'},
                {'id': 'seg', 'bbox': [0, 0, 20, 20], 'polygon': [[0, 0], [10, 0], [10, 20]], 'source_model': 'SAM-3'},
                {'id': 'mask', 'bbox': [0, 0, 10, 10], 'mask_url': '/mask.png', 'area': 25, 'source_model': 'manual'},
                {'id': 'bad'},
            ])

            self.assertEqual([item['task_type'] for item in objects], [
                'detection', 'instance_segmentation', 'instance_segmentation', 'invalid',
            ])
            self.assertEqual([item['has_detection'] for item in objects], [1, 1, 1, 0])
            self.assertEqual([item['has_instance_segmentation'] for item in objects], [0, 1, 1, 0])
            self.assertEqual(objects[0]['source_model_norm'], 'locate-anything')
            self.assertEqual(objects[1]['source_model_norm'], 'sam3')
            self.assertAlmostEqual(objects[1]['bbox_fill_ratio'], 0.25)
            self.assertAlmostEqual(objects[2]['bbox_fill_ratio'], 0.25)
            self.assertEqual(objects[3]['source_model_norm'], 'unknown')
            self.assertEqual(normalize_source('not-a-model').source_id, 'not-a-model')


class AnalyticsStorageTests(unittest.TestCase):
    def test_dimensions_and_multi_source_task_overview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (100, 100)).save(image_dir / 'a.png')
            storage = Storage(tmp / 'cache')
            project = storage.create_project(
                name='dimensions', image_dir=str(image_dir), save_dir=str(tmp / 'save'), classes_text='cat,dog'
            )
            project_id = str(project['id'])
            items, *_ = storage.get_project_images_page(project_id, limit=10)
            image_id = str(items[0]['id'])
            storage.save_annotations(project_id, image_id, [
                {'id': 'sam-det', 'class_name': 'cat', 'bbox': [0, 0, 25, 100], 'source_model': 'sam3'},
                {'id': 'la-det', 'class_name': 'cat', 'bbox': [50, 0, 100, 25], 'source_model': 'locate-anything'},
                {'id': 'sam-mask', 'class_name': 'dog', 'bbox': [0, 0, 20, 20], 'mask_url': '/mask.png', 'area': 100, 'source_model': 'sam3'},
                {'id': 'manual-poly', 'class_name': 'dog', 'polygon': [[40, 40], [60, 40], [60, 60], [40, 60]], 'source_model': 'manual'},
                {'id': 'invalid', 'class_name': 'bad', 'source_model': 'mystery'},
            ])
            storage.rebuild_analytics_index(project_id)

            dimensions = storage.get_analytics_dimensions(project_id)
            assert dimensions is not None
            self.assertEqual(dimensions['index_version'], ANALYTICS_INDEX_VERSION)
            detection = next(item for item in dimensions['tasks'] if item['task'] == 'detection')
            segmentation = next(item for item in dimensions['tasks'] if item['task'] == 'instance_segmentation')
            self.assertEqual(detection['instance_count'], 4)
            self.assertEqual(segmentation['instance_count'], 2)
            self.assertEqual(dimensions['invalid_instance_count'], 1)
            self.assertIn('mystery', {item['source'] for item in dimensions['sources']})

            overview = storage.get_analytics_overview(
                project_id, task='detection', sources=['sam3', 'locate-anything']
            )
            assert overview is not None
            self.assertEqual(overview['scope']['instance_count'], 4)
            self.assertEqual(overview['scope']['hit_images'], 1)
            self.assertEqual([item['source'] for item in overview['class_distribution']['series']], [
                'sam3', 'locate-anything',
            ])
            self.assertEqual(overview['class_distribution']['categories'], ['cat', 'dog'])
            self.assertEqual([item['values'] for item in overview['class_distribution']['series']], [[1, 2], [1, 0]])
            self.assertIsNotNone(overview['center_heatmap'])
            # Segmentation geometry and detection capability are independent.
            self.assertEqual(sum(sum(item['values']) for item in overview['aspect_ratio_distribution']['series']), 4)
            aspect = overview['aspect_ratio_distribution']
            sam_aspect = dict(zip(aspect['categories'], aspect['series'][0]['values']))
            la_aspect = dict(zip(aspect['categories'], aspect['series'][1]['values']))
            self.assertEqual(sam_aspect['0.25-0.5'], 1)
            self.assertEqual(la_aspect['2-4'], 1)

            segmentation_overview = storage.get_analytics_overview(
                project_id, task='instance_segmentation', sources=['sam3', 'manual']
            )
            assert segmentation_overview is not None
            self.assertEqual(segmentation_overview['scope']['instance_count'], 2)
            self.assertIsNone(segmentation_overview['aspect_ratio_distribution'])
            self.assertIsNone(segmentation_overview['center_heatmap'])
            self.assertIsNotNone(segmentation_overview['geometry_distribution_by_source'])
            self.assertNotIn('fill_ratio_distribution', segmentation_overview)
            self.assertNotIn('component_distribution', segmentation_overview)

            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    conn.execute('UPDATE analytics_index_meta SET index_version=2 WHERE project_id=?', (project_id,))
                    conn.commit()
                finally:
                    conn.close()
            stale = storage.get_analytics_index_status(project_id)
            self.assertEqual(stale['status'], 'stale')
            self.assertTrue(stale['needs_rebuild'])

    def test_rebuild_overview_and_incremental_annotation_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (100, 50)).save(image_dir / 'a.png')
            Image.new('RGB', (40, 40)).save(image_dir / 'b.png')

            storage = Storage(tmp / 'cache')
            project = storage.create_project(
                name='analytics', image_dir=str(image_dir), save_dir=str(tmp / 'save'), classes_text='cat,dog'
            )
            project_id = str(project['id'])
            items, *_rest = storage.get_project_images_page(project_id, limit=10)
            first_id = str(items[0]['id'])
            storage.save_annotations(project_id, first_id, [{
                'id': 'cat-1', 'class_name': 'cat', 'bbox': [0, 0, 10, 10],
            }, {
                'id': 'dog-1', 'class_name': 'dog', 'polygon': [[20, 10], [40, 10], [40, 20], [20, 20]],
            }])

            self.assertEqual(storage.get_analytics_index_status(project_id)['status'], 'missing')
            result = storage.rebuild_analytics_index(project_id, batch_size=1)
            self.assertEqual(result['indexed_images'], 2)
            self.assertEqual(result['interpretation_summary']['raw_record_count'], 2)
            self.assertEqual(result['interpretation_summary']['canonical_instance_count'], 2)
            self.assertEqual(result['interpretation_summary']['detection_instance_count'], 2)
            self.assertEqual(result['interpretation_summary']['instance_segmentation_count'], 1)
            self.assertEqual(storage.get_analytics_index_status(project_id)['status'], 'ready')

            overview = storage.get_analytics_overview(project_id)
            assert overview is not None
            self.assertEqual(overview['summary']['total_images'], 2)
            self.assertEqual(overview['summary']['labeled_images'], 1)
            self.assertEqual(overview['summary']['total_annotations'], 2)
            self.assertEqual(overview['summary']['class_count'], 2)
            geometry = {row['type']: row['count'] for row in overview['geometry_distribution']}
            self.assertEqual(geometry['bbox_only'], 1)
            self.assertEqual(geometry['polygon'], 1)

            storage.save_annotations(project_id, first_id, [{
                'id': 'cat-2', 'class_name': 'cat', 'bbox': [0, 0, 20, 20], 'score': 0.8,
            }])
            status = storage.get_analytics_index_status(project_id)
            self.assertEqual(status['status'], 'ready')
            updated = storage.get_analytics_overview(project_id)
            assert updated is not None
            self.assertEqual(updated['summary']['total_annotations'], 1)
            self.assertEqual(updated['summary']['class_count'], 1)

    def test_analytics_api_queues_rebuild_and_serves_ready_overview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (32, 24)).save(image_dir / 'a.png')
            storage = Storage(tmp / 'cache')
            project = storage.create_project(
                name='analytics api', image_dir=str(image_dir), save_dir=str(tmp / 'save'), classes_text='cat'
            )
            project_id = str(project['id'])
            queue = PersistentJobQueue(tmp / 'jobs.sqlite3')
            service = AnalyticsService(get_storage=lambda: storage, queue=queue)
            app = FastAPI()
            app.include_router(create_analytics_router(service=service))
            self.assertEqual(service.status(project_id)['status'], 'missing')
            started = service.spawn_rebuild(project_id)
            job_id = str(started['job_id'])
            service.run_rebuild_job({'project_id': project_id}, lambda **updates: queue.update(job_id, **updates))
            queue.update(job_id, status='done', running=False)
            overview = service.overview(project_id)
            assert overview is not None
            self.assertEqual(overview['summary']['total_images'], 1)
            paths = app.openapi()['paths']
            self.assertIn('/api/projects/{project_id}/analytics/index', paths)
            self.assertIn('/api/projects/{project_id}/analytics/overview', paths)
            self.assertIn('/api/projects/{project_id}/analytics/dimensions', paths)


if __name__ == '__main__':
    unittest.main()
