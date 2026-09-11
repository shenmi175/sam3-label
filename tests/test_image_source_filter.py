from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.storage import Storage  # noqa: E402
from app.repositories.annotation_index import AnnotationIndexRepository, SOURCE_CLASS_INDEX_VERSION  # noqa: E402


class ImageSourceFilterTests(unittest.TestCase):
    def test_class_filter_is_scoped_to_annotation_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (16, 16)).save(image_dir / 'a.png')
            Image.new('RGB', (16, 16)).save(image_dir / 'b.png')

            storage = Storage(tmp / 'cache')
            project = storage.create_project(
                name='source-filter',
                image_dir=str(image_dir),
                save_dir=str(tmp / 'save'),
                classes_text='cat,dog',
            )
            project_id = str(project['id'])
            images, *_ = storage.get_project_images_page(project_id, limit=10)
            image_ids = {str(item['rel_path']): str(item['id']) for item in images}

            storage.save_annotations(project_id, image_ids['a.png'], [
                {
                    'id': 'la-dog',
                    'class_name': 'dog',
                    'bbox': [0, 0, 8, 8],
                    'source_model': 'LA',
                },
                {
                    'id': 'sam-cat',
                    'class_name': 'cat',
                    'bbox': [0, 0, 4, 4],
                    'source_model': 'sam3',
                },
            ])
            storage.save_annotations(project_id, image_ids['b.png'], [{
                'id': 'sam-dog',
                'class_name': 'dog',
                'bbox': [0, 0, 8, 8],
                'source_model': 'SAM-3',
            }])

            sam_items, sam_total, *_ = storage.get_project_images_page(
                project_id, limit=10, class_name='dog', source_model='sam3',
            )
            la_items, la_total, *_ = storage.get_project_images_page(
                project_id, limit=10, class_name='dog', source_model='locate-anything',
            )
            all_items, all_total, *_ = storage.get_project_images_page(
                project_id, limit=10, class_name='dog',
            )

            self.assertEqual(sam_total, 1)
            self.assertEqual([item['rel_path'] for item in sam_items], ['b.png'])
            self.assertEqual(la_total, 1)
            self.assertEqual([item['rel_path'] for item in la_items], ['a.png'])
            self.assertEqual(all_total, 2)
            self.assertEqual([item['rel_path'] for item in all_items], ['a.png', 'b.png'])

    def test_existing_annotation_store_backfills_source_index_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (16, 16)).save(image_dir / 'a.png')
            cache_dir = tmp / 'cache'

            storage = Storage(cache_dir)
            project = storage.create_project(
                name='source-backfill',
                image_dir=str(image_dir),
                save_dir=str(tmp / 'save'),
                classes_text='dog',
            )
            project_id = str(project['id'])
            images, *_ = storage.get_project_images_page(project_id, limit=10)
            storage.save_annotations(project_id, str(images[0]['id']), [{
                'id': 'la-dog',
                'class_name': 'dog',
                'bbox': [0, 0, 8, 8],
                'source_model': 'locate-anything',
            }])

            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    conn.execute('DELETE FROM image_source_class_index')
                    conn.execute(
                        "DELETE FROM app_index_meta WHERE meta_key = 'source_class_index_version'"
                    )
                    conn.commit()
                finally:
                    conn.close()

            migrated = Storage(cache_dir)
            items, total, *_ = migrated.get_project_images_page(
                project_id, limit=10, class_name='dog', source_model='LA',
            )
            self.assertEqual(total, 1)
            self.assertEqual([item['rel_path'] for item in items], ['a.png'])

    def test_source_rows_use_canonical_class_and_source(self) -> None:
        rows = AnnotationIndexRepository.source_class_rows([
            {'id': 'a', 'label': 'Chair', 'bbox': [0, 0, 4, 4], 'source_model': 'LA'},
            {'id': 'b', 'class_name': 'chair', 'bbox': [0, 0, 4, 4], 'source': 'locate anything'},
            {'id': 'c', 'class_name': 'chair', 'bbox': [0, 0, 4, 4]},
            {'id': 'd', 'class_name': 'chair', 'polygon': [[0, 0], [4, 0], [4, 4]]},
        ])
        keyed = {(row['class_name_norm'], row['source_model_norm']): row['ann_count'] for row in rows}
        self.assertEqual(keyed, {
            ('chair', 'locate-anything'): 2,
            ('chair', 'unknown'): 1,
            ('chair', 'sam3'): 1,
        })

    def test_version_one_source_index_is_rebuilt_on_normal_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_dir = tmp / 'images'
            image_dir.mkdir()
            Image.new('RGB', (16, 16)).save(image_dir / 'a.png')
            cache_dir = tmp / 'cache'
            storage = Storage(cache_dir)
            project = storage.create_project(
                name='source-v2', image_dir=str(image_dir), save_dir=str(tmp / 'save'), classes_text='dog'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project_images_page(project_id, limit=10)[0][0]['id'])
            storage.save_annotations(project_id, image_id, [{
                'id': 'la-dog', 'class_name': 'dog', 'bbox': [0, 0, 8, 8], 'source_model': 'LA',
            }])
            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    conn.execute('DELETE FROM image_source_class_index')
                    conn.execute(
                        "UPDATE app_index_meta SET meta_value='1' WHERE meta_key='source_class_index_version'"
                    )
                    conn.commit()
                finally:
                    conn.close()

            Storage(cache_dir, defer_source_index_upgrade=True)
            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    deferred_version = conn.execute(
                        "SELECT meta_value FROM app_index_meta WHERE meta_key='source_class_index_version'"
                    ).fetchone()['meta_value']
                    deferred_count = conn.execute(
                        'SELECT COUNT(*) n FROM image_source_class_index WHERE project_id=?', (project_id,)
                    ).fetchone()['n']
                finally:
                    conn.close()
            self.assertEqual(int(deferred_version), 1)
            self.assertEqual(int(deferred_count), 0)

            Storage(cache_dir)
            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    version = conn.execute(
                        "SELECT meta_value FROM app_index_meta WHERE meta_key='source_class_index_version'"
                    ).fetchone()['meta_value']
                    count = conn.execute(
                        'SELECT SUM(ann_count) n FROM image_source_class_index WHERE project_id=?', (project_id,)
                    ).fetchone()['n']
                finally:
                    conn.close()
            self.assertEqual(int(version), SOURCE_CLASS_INDEX_VERSION)
            self.assertEqual(int(count), 1)


if __name__ == '__main__':
    unittest.main()
