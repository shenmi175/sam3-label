from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.services.job_queue import PersistentJobQueue  # noqa: E402
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


if __name__ == '__main__':
    unittest.main()
