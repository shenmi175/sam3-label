from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.services.inference_results import _replace_by_classes  # noqa: E402
from app.services.inference_service import InferenceService  # noqa: E402
from app.services.inference_jobs import InferJobFatal  # noqa: E402
from app.sam3_client import Sam3ApiError  # noqa: E402
from app.schemas import InferBatchIn, InferJobResumeIn  # noqa: E402
from app.storage import Storage  # noqa: E402


class InferenceAnnotationConsumerTests(unittest.TestCase):
    def test_batch_schema_accepts_save_ai_features_without_422(self) -> None:
        payload = InferBatchIn.model_validate({
            'project_id': 'p1',
            'classes': ['chair'],
            'all_images': True,
            'save_ai_features': True,
        })

        self.assertTrue(payload.save_ai_features)
        self.assertEqual(payload.merge_mode, 'replace')

    def test_batch_schema_accepts_append_merge_mode(self) -> None:
        payload = InferBatchIn.model_validate({
            'project_id': 'p1',
            'classes': ['chair'],
            'merge_mode': 'append',
        })

        self.assertEqual(payload.merge_mode, 'append')

    def test_replace_by_classes_uses_canonical_class_and_source(self) -> None:
        old = [
            {'id': 'unknown', 'class_name': 'chair', 'bbox': [0, 0, 2, 2]},
            {'id': 'sam-alias', 'class_name': 'chair', 'bbox': [0, 0, 3, 3], 'source_model': 'SAM-3'},
            {'id': 'label-only', 'label': 'chair', 'bbox': [0, 0, 4, 4], 'source': 'sam'},
            {'id': 'la', 'class_name': 'chair', 'bbox': [0, 0, 5, 5], 'source_model': 'LA'},
            {'id': 'other-class', 'class_name': 'table', 'bbox': [0, 0, 6, 6], 'source_model': 'sam3'},
        ]
        new = [{'id': 'new', 'class_name': 'chair', 'bbox': [1, 1, 7, 7], 'source_model': 'sam3'}]

        merged = _replace_by_classes(
            old,
            impacted_classes=['Chair'],
            new_annotations=new,
            source_model='SAM3',
        )

        self.assertEqual([annotation['id'] for annotation in merged], ['unknown', 'la', 'other-class', 'new'])

    def test_la_box_grouping_uses_canonical_source_and_geometry(self) -> None:
        grouped = InferenceService._group_la_boxes_by_class([
            {'id': 'alias', 'label': 'chair', 'bbox_xyxy': [1, 2, 11, 12], 'source_model': 'LA'},
            {
                'id': 'polygon',
                'class_name': 'chair',
                'polygon': [[20, 30], [40, 30], [40, 50]],
                'source': 'locate anything',
            },
            {'id': 'unknown', 'class_name': 'chair', 'bbox': [0, 0, 9, 9]},
            {'id': 'sam', 'class_name': 'chair', 'bbox': [0, 0, 8, 8], 'source_model': 'sam3'},
            {'id': 'other', 'class_name': 'table', 'bbox': [0, 0, 7, 7], 'source_model': 'LA'},
        ], classes=['chair'])

        self.assertEqual(grouped, {
            'chair': [
                [1.0, 2.0, 11.0, 12.0, 1.0],
                [20.0, 30.0, 40.0, 50.0, 1.0],
            ]
        })

    def test_feature_failure_does_not_roll_back_successful_annotations(self) -> None:
        class FakeStorage:
            def __init__(self):
                self.saved = None
                self.indexed = None

            def get_project(self, project_id, **_kwargs):
                return {'id': project_id, 'project_type': 'image', 'classes': ['chair']}

            def get_project_images_for_infer_scope(self, _project_id, **_kwargs):
                return [{'id': 'image-1', 'rel_path': 'image.png', 'abs_path': '/tmp/image.png'}]

            def ai_feature_root(self, _project_id):
                return Path('/tmp/project/feature')

            def load_annotations(self, _project_id, _image_id):
                return []

            def save_annotations(self, _project_id, _image_id, annotations):
                self.saved = annotations

            def upsert_ai_feature(self, _project_id, _image_id, feature):
                self.indexed = feature

        class FakeSam3:
            def infer_batch(self, **_kwargs):
                return {
                    'items': [{
                        'ok': True,
                        'result': {'detections': []},
                        'feature_status': 'feature_failed',
                        'feature_error': 'disk full',
                    }]
                }

        storage = FakeStorage()
        service = InferenceService(
            get_storage=lambda: storage,
            sam3=FakeSam3(),
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )

        result = service.run_infer_batch(InferBatchIn(
            project_id='p1',
            classes=['chair'],
            all_images=True,
            save_ai_features=True,
        ))

        self.assertEqual(result['succeeded'], 1)
        self.assertEqual(result['failed'], 0)
        self.assertEqual(result['feature_failed'], 1)
        self.assertEqual(storage.saved, [])
        self.assertEqual(storage.indexed['feature_status'], 'feature_failed')

    def test_queued_feature_is_finalized_before_job_result(self) -> None:
        class FakeStorage:
            def __init__(self):
                self.indexed = []

            def get_project(self, project_id, **_kwargs):
                return {'id': project_id, 'project_type': 'image', 'classes': ['chair']}

            def get_project_images_for_infer_scope(self, _project_id, **_kwargs):
                return [{'id': 'image-1', 'rel_path': 'image.png', 'abs_path': '/tmp/image.png'}]

            def ai_feature_root(self, _project_id):
                return Path('/tmp/project/feature')

            def load_annotations(self, _project_id, _image_id):
                return []

            def save_annotations(self, _project_id, _image_id, _annotations):
                return None

            def upsert_ai_feature(self, _project_id, image_id, feature):
                self.indexed.append((image_id, dict(feature)))

        class FakeSam3:
            def __init__(self):
                self.waited = []

            def infer_batch(self, **_kwargs):
                return {'items': [{
                    'ok': True,
                    'result': {'detections': []},
                    'feature_status': 'queued',
                    'feature_write_id': 'write-1',
                    'feature_key': 'key-1',
                    'feature_relative_path': 'feature/key-1.safetensors',
                }]}

            def wait_feature_writes(self, **kwargs):
                self.waited = kwargs['write_ids']
                return {'items': [{
                    'feature_write_id': 'write-1',
                    'feature_status': 'saved',
                    'feature_key': 'key-1',
                    'feature_relative_path': 'feature/key-1.safetensors',
                    'feature_bytes': 123,
                }]}

        storage = FakeStorage()
        sam3 = FakeSam3()
        service = InferenceService(
            get_storage=lambda: storage,
            sam3=sam3,
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )

        result = service.run_infer_batch(InferBatchIn(
            project_id='p1', classes=['chair'], all_images=True, save_ai_features=True,
        ))

        self.assertEqual(sam3.waited, ['write-1'])
        self.assertEqual(storage.indexed[0][1]['feature_status'], 'saved')
        self.assertEqual(storage.indexed[0][1]['feature_bytes'], 123)
        self.assertEqual(result['image_results'][0]['feature_status'], 'saved')
        self.assertEqual(result['feature_failed'], 0)

    def test_first_507_stops_remaining_images_without_remote_retry(self) -> None:
        class FakeStorage:
            def get_project(self, project_id, **_kwargs):
                return {'id': project_id, 'project_type': 'image', 'classes': ['chair']}

            def get_project_images_for_infer_scope(self, _project_id, **_kwargs):
                return [
                    {'id': f'image-{index}', 'rel_path': f'{index}.png', 'abs_path': f'/tmp/{index}.png'}
                    for index in range(1, 4)
                ]

        class OomSam3:
            def __init__(self):
                self.calls = 0

            def infer_batch(self, **_kwargs):
                self.calls += 1
                raise Sam3ApiError(507, 'inference batch failed: CUDA out of memory')

        sam3 = OomSam3()
        service = InferenceService(
            get_storage=FakeStorage,
            sam3=sam3,
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )

        with self.assertRaises(InferJobFatal) as raised:
            service.run_infer_batch(InferBatchIn(
                project_id='p1', classes=['chair'], all_images=True, batch_size=1,
            ))

        partial = raised.exception.result
        self.assertEqual(sam3.calls, 1)
        self.assertTrue(partial['fatal'])
        self.assertEqual(partial['error_code'], 'CUDA_OOM')
        self.assertEqual(partial['processed_images'], 1)
        self.assertEqual(partial['failed_images'], 1)
        self.assertEqual(partial['unprocessed_images'], 2)
        self.assertEqual(partial['retry_image_ids'], ['image-1', 'image-2', 'image-3'])

    def test_append_preserves_all_existing_sources_and_assigns_unique_ids(self) -> None:
        class FakeSam3:
            def infer_batch(self, **_kwargs):
                return {'items': [{
                    'ok': True,
                    'result': {'detections': [{
                        'id': 'manual-old',
                        'label': 'chair',
                        'bbox': [10, 10, 20, 20],
                    }]},
                }]}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (32, 32), 'white').save(images / 'a.png')
            storage = Storage(root / 'data')
            project = storage.create_project(
                name='append', image_dir=str(images), save_dir=str(root / 'output'), classes_text='chair'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            storage.save_annotations(project_id, image_id, [
                {'id': 'manual-old', 'class_name': 'chair', 'bbox': [0, 0, 4, 4], 'source_model': 'manual'},
                {'id': 'sam-old', 'class_name': 'chair', 'bbox': [1, 1, 5, 5], 'source_model': 'sam3'},
                {'id': 'la-old', 'class_name': 'chair', 'bbox': [2, 2, 6, 6], 'source_model': 'locate-anything'},
            ])

            service = InferenceService(
                get_storage=lambda: storage,
                sam3=FakeSam3(),
                infer_jobs=None,
                default_api_base_url='http://sam3',
                max_batch_files=8,
                max_pending_image_ids=20,
            )
            result = service.run_infer_batch(InferBatchIn(
                project_id=project_id,
                classes=['chair'],
                all_images=True,
                merge_mode='append',
            ))

            annotations = storage.load_annotations(project_id, image_id)
            ids = [str(annotation['id']) for annotation in annotations]
            self.assertEqual(result['new_annotations'], 1)
            self.assertEqual(len(annotations), 4)
            self.assertTrue({'manual-old', 'sam-old', 'la-old'}.issubset(ids))
            self.assertEqual(len(ids), len(set(ids)))
            self.assertNotEqual(ids[-1], 'manual-old')

    def test_empty_append_does_not_save_or_bump_content_revision(self) -> None:
        class FakeSam3:
            def infer_batch(self, **_kwargs):
                return {'items': [{'ok': True, 'result': {'detections': []}}]}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (32, 32), 'white').save(images / 'a.png')
            storage = Storage(root / 'data')
            project = storage.create_project(
                name='empty-append', image_dir=str(images), save_dir=str(root / 'output'), classes_text='chair'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            storage.save_annotations(project_id, image_id, [
                {'id': 'manual-old', 'class_name': 'chair', 'bbox': [0, 0, 4, 4], 'source_model': 'manual'},
            ])
            before_annotations = storage.load_annotations(project_id, image_id)
            before_revision = int(storage.get_project(project_id, include_images=False)['content_rev'])

            service = InferenceService(
                get_storage=lambda: storage,
                sam3=FakeSam3(),
                infer_jobs=None,
                default_api_base_url='http://sam3',
                max_batch_files=8,
                max_pending_image_ids=20,
            )
            service.run_infer_batch(InferBatchIn(
                project_id=project_id,
                classes=['chair'],
                all_images=True,
                merge_mode='append',
            ))

            self.assertEqual(storage.load_annotations(project_id, image_id), before_annotations)
            self.assertEqual(
                int(storage.get_project(project_id, include_images=False)['content_rev']),
                before_revision,
            )

    def test_resume_payload_keeps_original_classes_and_merge_mode(self) -> None:
        service = InferenceService(
            get_storage=lambda: None,
            sam3=object(),
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )
        merged = service._merge_infer_resume_payload(
            'text_batch',
            {'classes': ['chair'], 'merge_mode': 'append', 'threshold': 0.4},
            {'classes': ['table'], 'threshold': 0.7},
        )

        self.assertEqual(merged['classes'], ['chair'])
        self.assertEqual(merged['merge_mode'], 'append')
        self.assertEqual(merged['threshold'], 0.7)

    def test_resumed_append_excludes_every_already_processed_image(self) -> None:
        class FakeStorage:
            def __init__(self):
                self.saved_image_ids = []

            def get_project(self, project_id, **_kwargs):
                return {'id': project_id, 'project_type': 'image', 'classes': ['chair']}

            def get_project_images_for_infer_scope(self, _project_id, **_kwargs):
                return [
                    {'id': 'already-failed', 'rel_path': 'failed.png', 'abs_path': '/tmp/failed.png'},
                    {'id': 'still-pending', 'rel_path': 'pending.png', 'abs_path': '/tmp/pending.png'},
                ]

            def load_annotations(self, _project_id, _image_id):
                return []

            def save_annotations(self, _project_id, image_id, _annotations):
                self.saved_image_ids.append(image_id)

        class FakeSam3:
            def infer_batch(self, **kwargs):
                self.image_paths = kwargs['image_paths']
                return {'items': [{
                    'ok': True,
                    'result': {'detections': [{
                        'label': 'chair',
                        'bbox': [0, 0, 5, 5],
                    }]},
                }]}

        storage = FakeStorage()
        sam3 = FakeSam3()
        service = InferenceService(
            get_storage=lambda: storage,
            sam3=sam3,
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )
        result = service.run_infer_batch(
            InferBatchIn(
                project_id='p1', classes=['chair'], all_images=True, merge_mode='append',
            ),
            resume_state={
                'failed': 1,
                'failed_image_ids': ['already-failed'],
                'progress_done': 1,
                'progress_total': 2,
                'image_results': [{
                    'image_id': 'already-failed',
                    'rel_path': 'failed.png',
                    'status': 'failed',
                }],
            },
        )

        self.assertEqual(sam3.image_paths, ['/tmp/pending.png'])
        self.assertEqual(storage.saved_image_ids, ['still-pending'])
        self.assertEqual(result['processed_images'], 2)
        self.assertEqual(result['failed_images'], 1)

    def test_large_paused_append_keeps_original_classes_merge_and_selector(self) -> None:
        class FakeStorage:
            def get_project(self, project_id, **_kwargs):
                return {'id': project_id, 'project_type': 'image'}

        class FakeJobs:
            def __init__(self):
                self.spawned_payload = None

            def get_latest_job_for_project(self, _project_id, **_kwargs):
                return {
                    'job_id': 'job-1',
                    'job_type': 'text_batch',
                    'pending_image_ids': ['image-3'],
                    'pending_image_count': 200,
                    'pending_image_ids_truncated': True,
                    'payload_dict': {
                        'project_id': 'p1',
                        'classes': ['chair'],
                        'merge_mode': 'append',
                        'scope_mode': 'all',
                        'retry_image_ids': ['image-1', 'image-2', 'image-3'],
                        'image_ids': [],
                        'all_images': False,
                    },
                }

            def spawn_job(self, **kwargs):
                self.spawned_payload = kwargs['payload_dict']
                return {'job_id': 'job-1', 'status': 'queued'}

        jobs = FakeJobs()
        service = InferenceService(
            get_storage=lambda: FakeStorage(),
            sam3=object(),
            infer_jobs=jobs,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )
        service.resume_infer_job(InferJobResumeIn(
            project_id='p1', classes=['current-global-class'], threshold=0.8,
        ))

        self.assertEqual(jobs.spawned_payload['classes'], ['chair'])
        self.assertEqual(jobs.spawned_payload['merge_mode'], 'append')
        self.assertEqual(jobs.spawned_payload['retry_image_ids'], ['image-1', 'image-2', 'image-3'])
        self.assertFalse(jobs.spawned_payload['all_images'])
        self.assertEqual(jobs.spawned_payload['threshold'], 0.8)

    def test_la_boxes_rejects_append_mode_before_dispatch(self) -> None:
        service = InferenceService(
            get_storage=lambda: None,
            sam3=object(),
            infer_jobs=None,
            default_api_base_url='http://sam3',
            max_batch_files=8,
            max_pending_image_ids=20,
        )

        with self.assertRaisesRegex(Exception, 'does not support append'):
            service.precheck_infer_batch(InferBatchIn(
                project_id='p1',
                mode='la_boxes',
                merge_mode='append',
            ))


if __name__ == '__main__':
    unittest.main()
