from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.annotations import parse_image_annotations  # noqa: E402
from app.annotations.migration import cleanup_model_det_ids, migrate_all_projects  # noqa: E402
from app.annotations.schema_migration import migrate_annotation_schema  # noqa: E402
from app.storage import Storage  # noqa: E402
from app.utils import atomic_write_json  # noqa: E402


class AnnotationMigrationTest(unittest.TestCase):
    def test_schema_migration_is_dry_run_first_and_leaves_indexes_for_the_script(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (32, 32), 'white').save(images / 'a.png')
            storage = Storage(root / 'data')
            project = storage.create_project(
                name='schema-migration', image_dir=str(images), save_dir=str(root / 'output'), classes_text='chair'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            legacy = [{
                'id': 'legacy-manual', 'label': 'chair', 'source': 'manual',
                'bbox': [1, 2, 20, 22], 'score': 1,
            }]
            atomic_write_json(storage._annotation_path(project, image_id), legacy)
            storage._replace_annotations_db(project_id, image_id, legacy)
            before_rev = int(storage.get_project(project_id, include_images=False)['content_rev'])

            preview = migrate_annotation_schema(storage, apply=False, project_ids=[project_id])
            self.assertEqual(preview['active_images_changed'], 1)
            self.assertEqual(preview['failures'], [])
            self.assertEqual(storage._load_annotations_db(project_id, image_id), legacy)

            applied = migrate_annotation_schema(storage, apply=True, project_ids=[project_id])
            self.assertEqual(applied['active_images_changed'], 1)
            self.assertTrue(Path(applied['backup_dir']).is_dir())
            normalized = storage.load_annotations(project_id, image_id)[0]
            self.assertEqual(normalized['source_model'], 'sam3')
            self.assertNotIn('source', normalized)
            self.assertNotIn('label', normalized)
            self.assertEqual(normalized['mask_url'], '')
            self.assertEqual(
                int(storage.get_project(project_id, include_images=False)['content_rev']),
                before_rev + 1,
            )

            repeated = migrate_annotation_schema(storage, apply=False, project_ids=[project_id])
            self.assertEqual(repeated['active_images_changed'], 0)

    def test_all_project_apply_backs_up_and_rewrites_split_records(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (32, 32), 'white').save(images / 'a.png')
            storage = Storage(root / 'data')
            project = storage.create_project(
                name='migration', image_dir=str(images), save_dir=str(root / 'output'), classes_text='chair'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            storage.save_annotations(project_id, image_id, [
                {
                    'id': 'ann_a', 'model_det_id': 'det_1', 'contour_index': 1, 'contour_count': 3,
                    'class_name': 'chair', 'source_model': 'sam3',
                    'polygon': [[1, 1], [8, 1], [8, 8]],
                },
                {
                    'id': 'ann_b', 'model_det_id': 'det_1', 'contour_index': 1, 'contour_count': 2,
                    'class_name': 'seat', 'source_model': 'sam3',
                    'polygon': [[16, 16], [24, 16], [24, 24]],
                },
            ])

            preview = migrate_all_projects(storage, apply=False)
            self.assertEqual(preview['changed_images'], 1)
            applied = migrate_all_projects(storage, apply=True)
            self.assertEqual(applied['changed_images'], 1)
            self.assertTrue(Path(applied['backup_dir']).is_dir())

            annotations = storage.load_annotations(project_id, image_id)
            self.assertEqual(len(annotations), 1)
            self.assertEqual(annotations[0]['component_count'], 2)
            self.assertNotIn('contour_index', annotations[0])
            self.assertNotIn('contour_count', annotations[0])
            parsed = parse_image_annotations(annotations)
            self.assertEqual(len(parsed.instances), 1)
            self.assertFalse(any(issue.severity == 'error' for issue in parsed.issues))

    def test_model_det_cleanup_preserves_semantics_indexes_and_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / 'images'
            images.mkdir()
            Image.new('RGB', (32, 32), 'white').save(images / 'a.png')
            storage = Storage(root / 'data')
            project = storage.create_project(
                name='model-det-cleanup', image_dir=str(images), save_dir=str(root / 'output'), classes_text='chair'
            )
            project_id = str(project['id'])
            image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
            annotations = [{
                'id': 'ann_a',
                'model_det_id': 'det_1',
                'class_name': 'chair',
                'source_model': 'SAM-3',
                'bbox': [1, 2, 20, 22],
            }]
            storage.save_annotations(project_id, image_id, annotations)
            run_id = storage.begin_smart_filter_run(project_id=project_id)
            storage.add_smart_filter_snapshot(
                run_id=run_id,
                project_id=project_id,
                image_id=image_id,
                annotations=annotations,
            )
            legacy_backup = storage.base_dir / '.legacy-split-backups' / 'keep' / 'original.json'
            legacy_backup.parent.mkdir(parents=True)
            legacy_backup.write_text('{"model_det_id":"keep"}', encoding='utf-8')

            before_project = storage.get_project(project_id, include_images=False)
            before_canonical = parse_image_annotations(storage.load_annotations(project_id, image_id))
            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    before_indexes = {
                        table: [tuple(row) for row in conn.execute(
                            f'SELECT * FROM {table} WHERE project_id=? ORDER BY image_id', (project_id,)
                        )]
                        for table in ('annotation_ids', 'image_annotation_stats', 'image_class_index', 'image_source_class_index')
                    }
                finally:
                    conn.close()

            preview = cleanup_model_det_ids(storage, apply=False)
            self.assertEqual(preview['active_candidate_images'], 1)
            self.assertEqual(preview['snapshot_candidate_rows'], 1)
            self.assertEqual(preview['failure_count'], 0)
            self.assertIn('model_det_id', storage.load_annotations(project_id, image_id)[0])

            applied = cleanup_model_det_ids(storage, apply=True)
            self.assertEqual(applied['active_annotations_cleaned'], 1)
            self.assertEqual(applied['snapshot_annotations_cleaned'], 1)
            self.assertEqual(applied['residual_active_rows'], 0)
            self.assertEqual(applied['residual_snapshot_rows'], 0)
            self.assertEqual(applied['failure_count'], 0)
            self.assertTrue(Path(applied['backup_dir']).is_dir())
            self.assertNotIn('model_det_id', storage.load_annotations(project_id, image_id)[0])
            self.assertEqual(before_canonical, parse_image_annotations(storage.load_annotations(project_id, image_id)))
            self.assertEqual(legacy_backup.read_text(encoding='utf-8'), '{"model_det_id":"keep"}')
            self.assertEqual(
                int(storage.get_project(project_id, include_images=False)['content_rev']),
                int(before_project['content_rev']) + 1,
            )

            with storage._db_lock:
                conn = storage._db_connect()
                try:
                    snapshot_json = str(conn.execute(
                        'SELECT annotations_json FROM smart_filter_snapshots WHERE run_id=? AND image_id=?',
                        (run_id, image_id),
                    ).fetchone()['annotations_json'])
                    after_indexes = {
                        table: [tuple(row) for row in conn.execute(
                            f'SELECT * FROM {table} WHERE project_id=? ORDER BY image_id', (project_id,)
                        )]
                        for table in ('annotation_ids', 'image_annotation_stats', 'image_class_index', 'image_source_class_index')
                    }
                finally:
                    conn.close()
            self.assertNotIn('model_det_id', snapshot_json)
            self.assertEqual(before_indexes, after_indexes)

            repeated = cleanup_model_det_ids(storage, apply=True)
            self.assertEqual(repeated['active_candidate_images'], 0)
            self.assertEqual(repeated['snapshot_candidate_rows'], 0)


if __name__ == '__main__':
    unittest.main()
