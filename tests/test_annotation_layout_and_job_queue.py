from __future__ import annotations

import json
import logging
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.services.job_queue import PersistentJobQueue  # noqa: E402
from app.services.smart_filter_service import SmartFilterJobService  # noqa: E402
from app.storage import Storage  # noqa: E402


class AnnotationLayoutTest(unittest.TestCase):
    def test_nested_annotation_layout_and_collision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            images = tmp / 'images'
            (images / 'nested').mkdir(parents=True)
            (images / 'nested' / 'same.jpg').write_bytes(b'jpg')
            (images / 'nested' / 'same.png').write_bytes(b'png')
            storage = Storage(tmp / 'data')
            project = storage.create_project(
                name='nested', image_dir=str(images), save_dir=str(tmp / 'output'), classes_text='door'
            )
            project_id = str(project['id'])
            rows = storage.get_project(project_id, include_images=True)['images']
            for image in rows:
                storage.save_annotations(project_id, str(image['id']), [{'id': f"a_{image['id']}", 'class_name': 'door'}])

            annotation_dir = Path(storage.get_project(project_id, include_images=False)['annotation_dir'])
            self.assertTrue((annotation_dir / 'nested' / 'same.jpg.json').is_file())
            self.assertTrue((annotation_dir / 'nested' / 'same.png.json').is_file())

    def test_legacy_read_and_explicit_migration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            images = tmp / 'images'
            (images / 'a' / 'b').mkdir(parents=True)
            (images / 'a' / 'b' / 'image.jpg').write_bytes(b'jpg')
            storage = Storage(tmp / 'data')
            project = storage.create_project(
                name='legacy', image_dir=str(images), save_dir=str(tmp / 'output'), classes_text='door'
            )
            project_id = str(project['id'])
            image = storage.get_project(project_id, include_images=True)['images'][0]
            annotation_dir = Path(storage.get_project(project_id, include_images=False)['annotation_dir'])
            legacy = annotation_dir / f"{image['id']}.json"
            legacy.write_text(json.dumps([{'id': 'old', 'class_name': 'door'}]), encoding='utf-8')

            self.assertEqual(storage.load_annotations(project_id, str(image['id']))[0]['id'], 'old')
            preview = storage.migrate_annotation_layout(project_id, dry_run=True)
            self.assertEqual(preview['moved'], 1)
            result = storage.migrate_annotation_layout(project_id, dry_run=False)
            self.assertEqual(result['moved'], 1)
            self.assertFalse(legacy.exists())
            self.assertTrue((annotation_dir / 'a' / 'b' / 'image.json').is_file())


class PersistentJobQueueTest(unittest.TestCase):
    def test_status_transitions_are_audited(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text, self.assertLogs('web_auto.jobs', level='INFO') as captured:
            queue = PersistentJobQueue(Path(tmp_text) / 'queue.sqlite3')
            job = queue.enqueue(
                project_id='p1', job_type='infer:text_batch', resource_class='gpu',
                payload={}, state={'status': 'queued'},
            )
            queue.update(str(job['job_id']), status='paused', message='paused by user')
            queue.cancel(str(job['job_id']))

        audit = '\n'.join(captured.output)
        self.assertIn('job_enqueued', audit)
        self.assertIn('from=queued to=paused', audit)
        self.assertIn('from=paused to=cancelled', audit)

    def test_project_fifo_across_resource_lanes_and_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            db = Path(tmp_text) / 'queue.sqlite3'
            queue = PersistentJobQueue(db)
            cpu = queue.enqueue(
                project_id='p1', job_type='smart_filter:preview', resource_class='cpu',
                payload={}, state={'message': 'cpu'},
            )
            gpu = queue.enqueue(
                project_id='p1', job_type='infer:text_batch', resource_class='gpu',
                payload={}, state={'message': 'gpu'},
            )
            self.assertIsNone(queue.claim_next('gpu', 'gpu-worker'))
            claimed_cpu = queue.claim_next('cpu', 'cpu-worker')
            self.assertEqual(claimed_cpu['job_id'], cpu['job_id'])
            queue.update(str(cpu['job_id']), status='done', running=False)
            claimed_gpu = queue.claim_next('gpu', 'gpu-worker')
            self.assertEqual(claimed_gpu['job_id'], gpu['job_id'])

            reopened = PersistentJobQueue(db)
            self.assertEqual(reopened.get(str(gpu['job_id']))['status'], 'running')

    def test_terminal_details_are_externalized_and_cleaned_with_job(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            db = Path(tmp_text) / 'queue.sqlite3'
            queue = PersistentJobQueue(db)
            job = queue.enqueue(
                project_id='p1', job_type='infer:text_batch', resource_class='gpu',
                payload={}, state={'status': 'running', 'message': 'working'},
            )
            image_results = [
                {'image_id': f'image-{index}', 'status': 'saved', 'detail': 'x' * 200}
                for index in range(100)
            ]
            errors = [{'image_id': 'failed-1', 'error': 'boom'}]
            detailed = queue.update(
                str(job['job_id']),
                status='done',
                running=False,
                image_results=image_results,
                errors=errors,
                failed_image_ids=['failed-1'],
                result={
                    'succeeded': 100,
                    'failed': 1,
                    'image_results': image_results,
                    'errors': errors,
                    'failed_image_ids': ['failed-1'],
                },
            )
            self.assertEqual(detailed['image_results'], image_results)
            self.assertEqual(detailed['errors'], errors)
            self.assertNotIn('image_results', detailed['result'])

            conn = sqlite3.connect(str(db))
            try:
                raw = conn.execute(
                    'SELECT state_json FROM background_jobs WHERE job_id=?',
                    (str(job['job_id']),),
                ).fetchone()[0]
                compact = json.loads(raw)
                conn.execute(
                    'UPDATE background_jobs SET updated_epoch=0 WHERE job_id=?',
                    (str(job['job_id']),),
                )
                conn.commit()
            finally:
                conn.close()
            self.assertTrue(compact['details_available'])
            self.assertEqual(compact['image_results_count'], 100)
            self.assertEqual(compact['errors_count'], 1)
            self.assertNotIn('image_results', compact)
            self.assertLess(len(raw), 4096)

            listed = queue.list_jobs('p1')
            self.assertEqual(listed[0]['image_results_count'], 100)
            self.assertNotIn('image_results', listed[0])
            detail_files = list(queue.details_dir.glob('*.json'))
            self.assertEqual(len(detail_files), 1)
            self.assertEqual(queue.cleanup_terminal(retention_days=1), 1)
            self.assertFalse(detail_files[0].exists())

    def test_legacy_terminal_state_can_be_compacted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            db = Path(tmp_text) / 'queue.sqlite3'
            queue = PersistentJobQueue(db)
            job = queue.enqueue(
                project_id='p1', job_type='infer:text_batch', resource_class='gpu',
                payload={}, state={'status': 'queued'},
            )
            legacy = {'status': 'done', 'image_results': [{'image_id': 'a', 'detail': 'x' * 10000}]}
            conn = sqlite3.connect(str(db))
            try:
                conn.execute(
                    'UPDATE background_jobs SET status=?, state_json=? WHERE job_id=?',
                    ('done', json.dumps(legacy), str(job['job_id'])),
                )
                conn.commit()
            finally:
                conn.close()
            self.assertEqual(queue.compact_terminal_details(), 1)
            self.assertEqual(queue.get(str(job['job_id']))['image_results'][0]['image_id'], 'a')

    def test_smart_filter_preview_lookup_loads_externalized_details(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            queue = PersistentJobQueue(Path(tmp_text) / 'queue.sqlite3')
            job = queue.enqueue(
                project_id='p1', job_type='smart_filter:preview', resource_class='cpu',
                payload={}, state={'status': 'running'},
            )
            entry = {'preview_token': 'preview-1', 'change_sets': [{'image_id': 'image-1'}]}
            queue.update(
                str(job['job_id']),
                status='done',
                running=False,
                preview_entry=entry,
                result={'preview_token': 'preview-1', 'items': [{'image_id': 'image-1'}]},
            )
            service = SmartFilterJobService(
                get_storage=lambda: None,
                logger=logging.getLogger('test.smart-filter'),
                queue=queue,
            )
            self.assertEqual(service._find_preview('p1', 'preview-1'), entry)


class SmartFilterRetentionTest(unittest.TestCase):
    def test_count_and_age_retention_remove_rows_and_snapshot_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            storage = Storage(
                root / 'data',
                smart_filter_retention_max_runs=2,
                smart_filter_retention_days=3650,
            )
            runs: list[str] = []
            for index in range(3):
                run_id = storage.begin_smart_filter_run(project_id='p1')
                storage.add_smart_filter_snapshot(
                    run_id=run_id,
                    project_id='p1',
                    image_id=f'image-{index}',
                    annotations=[],
                )
                storage.finish_smart_filter_run(run_id=run_id, summary={'index': index})
                runs.append(run_id)

            conn = storage._db_connect()
            try:
                remaining = {
                    str(row['run_id'])
                    for row in conn.execute('SELECT run_id FROM smart_filter_runs').fetchall()
                }
            finally:
                conn.close()
            self.assertEqual(remaining, set(runs[-2:]))
            self.assertFalse((storage.base_dir / '.smart-filter-runs' / runs[0]).exists())

            conn = storage._db_connect()
            try:
                conn.execute(
                    "UPDATE smart_filter_runs SET created_at='2000-01-01 00:00:00', applied_at='2000-01-01 00:00:00'"
                )
                conn.commit()
            finally:
                conn.close()
            cleanup = storage.cleanup_smart_filter_runs(max_runs=10, retention_days=1)
            self.assertEqual(cleanup['deleted_runs'], 2)
            for run_id in runs[-2:]:
                self.assertFalse((storage.base_dir / '.smart-filter-runs' / run_id).exists())


if __name__ == '__main__':
    unittest.main()
