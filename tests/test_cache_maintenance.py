from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path

from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.services.cache_maintenance import CacheMaintenanceService  # noqa: E402


class CacheMaintenanceTests(unittest.TestCase):
    def _service(
        self,
        data_dir: Path,
        *,
        active_jobs: bool = False,
        active_tiles: bool = False,
    ) -> CacheMaintenanceService:
        def ensure_idle() -> None:
            if active_jobs:
                raise HTTPException(status_code=409, detail='background job active')

        return CacheMaintenanceService(
            get_current_data_dir=lambda: data_dir,
            ensure_no_active_jobs=ensure_idle,
            has_active_tile_jobs=lambda: active_tiles,
            maintenance_lock=threading.RLock(),
        )

    def test_status_and_selected_cleanup_preserve_non_cache_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            data_dir = Path(tmp_raw)
            preview = data_dir / '.preview-cache' / 'p1'
            tile = data_dir / '.tile-cache' / 'p1'
            composite = data_dir / '.annotation-masks' / 'p1' / 'img1' / '_composite'
            preview.mkdir(parents=True)
            tile.mkdir(parents=True)
            composite.mkdir(parents=True)
            (preview / 'preview.jpg').write_bytes(b'p' * 11)
            (tile / 'tile.jpg').write_bytes(b't' * 13)
            (composite / 'semantic.png').write_bytes(b'c' * 17)

            active_mask = composite.parent / 'annotation-1.png'
            rollback = data_dir / '.smart-filter-runs' / 'run-1' / 'snapshot.json'
            database = data_dir / 'annotation_index.sqlite3'
            active_mask.write_bytes(b'mask')
            rollback.parent.mkdir(parents=True)
            rollback.write_text('{}', encoding='utf-8')
            database.write_bytes(b'sqlite')

            service = self._service(data_dir)
            status = service.status()
            self.assertEqual(status['scopes']['previews']['file_count'], 1)
            self.assertEqual(status['scopes']['tiles']['file_count'], 1)
            self.assertEqual(status['scopes']['composites']['file_count'], 1)
            self.assertEqual(status['scopes']['previews']['logical_bytes'], 11)

            result = service.cleanup(['previews', 'composites'])
            self.assertTrue(result['ok'])
            self.assertEqual(result['released']['file_count'], 2)
            self.assertTrue((data_dir / '.preview-cache').is_dir())
            self.assertFalse((data_dir / '.preview-cache' / 'p1').exists())
            self.assertTrue((tile / 'tile.jpg').is_file())
            self.assertFalse(composite.exists())
            self.assertEqual(active_mask.read_bytes(), b'mask')
            self.assertEqual(rollback.read_text(encoding='utf-8'), '{}')
            self.assertEqual(database.read_bytes(), b'sqlite')

    def test_cleanup_rejects_empty_scope_and_active_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            data_dir = Path(tmp_raw)
            with self.assertRaises(HTTPException) as empty_error:
                self._service(data_dir).cleanup([])
            self.assertEqual(empty_error.exception.status_code, 400)

            with self.assertRaises(HTTPException) as job_error:
                self._service(data_dir, active_jobs=True).cleanup(['previews'])
            self.assertEqual(job_error.exception.status_code, 409)

            with self.assertRaises(HTTPException) as tile_error:
                self._service(data_dir, active_tiles=True).cleanup(['tiles'])
            self.assertEqual(tile_error.exception.status_code, 409)

    def test_cache_root_symlink_is_never_followed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw, tempfile.TemporaryDirectory() as outside_raw:
            data_dir = Path(tmp_raw)
            outside = Path(outside_raw)
            protected = outside / 'protected.txt'
            protected.write_text('keep', encoding='utf-8')
            (data_dir / '.preview-cache').symlink_to(outside, target_is_directory=True)

            with self.assertRaises(HTTPException):
                self._service(data_dir).cleanup(['previews'])
            self.assertEqual(protected.read_text(encoding='utf-8'), 'keep')


if __name__ == '__main__':
    unittest.main()
