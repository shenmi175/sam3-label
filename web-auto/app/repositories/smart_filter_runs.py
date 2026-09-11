from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Any, Callable

from app.services.annotation_masks import annotation_mask_path
from app.utils import atomic_write_json, ensure_dir, new_id, now_ts, read_json


class SmartFilterRunRepository:
    def __init__(
        self,
        *,
        db_connect: Callable[[], Any],
        db_lock: RLock,
        save_annotations: Callable[[str, str, list[dict[str, Any]]], None],
        load_annotations: Callable[[str, str], list[dict[str, Any]]],
        base_dir: Path,
        retention_max_runs: int = 10,
        retention_days: int = 30,
    ) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock
        self._save_annotations = save_annotations
        self._load_annotations = load_annotations
        self._base_dir = base_dir
        self._retention_max_runs = max(1, int(retention_max_runs))
        self._retention_days = max(1, int(retention_days))

    def _snapshot_dir(self, run_id: str, image_id: str) -> Path:
        return self._base_dir / '.smart-filter-runs' / str(run_id) / str(image_id)

    @staticmethod
    def _json_dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

    @staticmethod
    def _json_loads(raw: Any, fallback: Any) -> Any:
        try:
            return json.loads(str(raw or ''))
        except Exception:
            return fallback

    def begin(
        self,
        *,
        project_id: str,
        job_id: str = '',
        operation_mode: str = '',
        rule: dict[str, Any] | None = None,
    ) -> str:
        run_id = new_id('sfr_')
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    '''
                    INSERT INTO smart_filter_runs (
                        run_id, project_id, job_id, operation_mode, rule_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ''',
                    (
                        run_id,
                        str(project_id),
                        str(job_id or ''),
                        str(operation_mode or ''),
                        self._json_dumps(rule or {}),
                        now_ts(),
                    ),
                )
                conn.commit()
            finally:
                conn.close()
        return run_id

    def add_snapshot(
        self,
        *,
        run_id: str,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
    ) -> None:
        snapshot_dir = self._snapshot_dir(run_id, image_id)
        mask_dir = ensure_dir(snapshot_dir / 'masks')
        mask_names: list[str] = []
        for ann in annotations if isinstance(annotations, list) else []:
            ann_id = str(ann.get('id') or '').strip() if isinstance(ann, dict) else ''
            if not ann_id:
                continue
            source = annotation_mask_path(self._base_dir, project_id, image_id, ann_id)
            if not source.is_file():
                continue
            destination = mask_dir / source.name
            try:
                os.link(source, destination)
            except OSError:
                shutil.copy2(source, destination)
            mask_names.append(source.name)
        atomic_write_json(snapshot_dir / 'masks.json', sorted(mask_names))
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    '''
                    INSERT OR REPLACE INTO smart_filter_snapshots (
                        run_id, project_id, image_id, annotations_json
                    ) VALUES (?, ?, ?, ?)
                    ''',
                    (
                        str(run_id),
                        str(project_id),
                        str(image_id),
                        self._json_dumps(annotations if isinstance(annotations, list) else []),
                    ),
                )
                conn.commit()
            finally:
                conn.close()

    def finish(self, *, run_id: str, summary: dict[str, Any] | None = None) -> None:
        project_id = ''
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    '''
                    UPDATE smart_filter_runs
                    SET summary_json = ?, applied_at = ?
                    WHERE run_id = ?
                    ''',
                    (self._json_dumps(summary or {}), now_ts(), str(run_id)),
                )
                row = conn.execute(
                    'SELECT project_id FROM smart_filter_runs WHERE run_id = ?',
                    (str(run_id),),
                ).fetchone()
                project_id = str(row['project_id'] or '') if row is not None else ''
                conn.commit()
            finally:
                conn.close()
        if project_id:
            self.cleanup_retained(project_id=project_id)

    def cleanup_retained(
        self,
        *,
        project_id: str = '',
        max_runs: int | None = None,
        retention_days: int | None = None,
    ) -> dict[str, Any]:
        """Delete applied snapshots outside the configured count or age limits."""
        keep_count = max(1, int(max_runs if max_runs is not None else self._retention_max_runs))
        keep_days = max(1, int(retention_days if retention_days is not None else self._retention_days))
        cutoff = (datetime.now() - timedelta(days=keep_days)).strftime('%Y-%m-%d %H:%M:%S')
        clauses = ["applied_at != ''"]
        params: list[Any] = []
        if str(project_id or '').strip():
            clauses.append('project_id = ?')
            params.append(str(project_id))

        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    f'''
                    SELECT run_id, project_id, created_at, applied_at
                    FROM smart_filter_runs
                    WHERE {' AND '.join(clauses)}
                    ORDER BY project_id ASC, applied_at DESC, created_at DESC, rowid DESC
                    ''',
                    params,
                ).fetchall()
                candidates: list[tuple[str, str]] = []
                rank_by_project: dict[str, int] = {}
                for row in rows:
                    pid = str(row['project_id'])
                    rank = rank_by_project.get(pid, 0)
                    rank_by_project[pid] = rank + 1
                    timestamp = str(row['applied_at'] or row['created_at'] or '')
                    if rank >= keep_count or (timestamp and timestamp < cutoff):
                        candidates.append((str(row['run_id']), pid))

                for start in range(0, len(candidates), 200):
                    chunk = candidates[start:start + 200]
                    run_ids = [run_id for run_id, _pid in chunk]
                    placeholders = ','.join('?' for _ in run_ids)
                    conn.execute(
                        f'DELETE FROM smart_filter_snapshots WHERE run_id IN ({placeholders})',
                        run_ids,
                    )
                    conn.execute(
                        f'DELETE FROM smart_filter_runs WHERE run_id IN ({placeholders})',
                        run_ids,
                    )
                conn.commit()
            finally:
                conn.close()

        removed_directories = 0
        for run_id, _pid in candidates:
            directory = self._base_dir / '.smart-filter-runs' / run_id
            existed = directory.exists() or directory.is_symlink()
            if directory.is_symlink():
                try:
                    directory.unlink()
                except OSError:
                    pass
            else:
                shutil.rmtree(directory, ignore_errors=True)
            if existed and not directory.exists():
                removed_directories += 1
        return {
            'deleted_runs': len(candidates),
            'removed_directories': removed_directories,
            'retention_max_runs': keep_count,
            'retention_days': keep_days,
        }

    def abort(self, *, project_id: str, run_id: str) -> None:
        """Remove an unapplied run after its per-image changes were restored."""
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    'DELETE FROM smart_filter_snapshots WHERE project_id = ? AND run_id = ?',
                    (str(project_id), str(run_id)),
                )
                conn.execute(
                    "DELETE FROM smart_filter_runs WHERE project_id = ? AND run_id = ? AND applied_at = ''",
                    (str(project_id), str(run_id)),
                )
                conn.commit()
            finally:
                conn.close()
        shutil.rmtree(self._base_dir / '.smart-filter-runs' / str(run_id), ignore_errors=True)

    def get(self, *, project_id: str, run_id: str) -> dict[str, Any] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    '''
                    SELECT run_id, project_id, job_id, operation_mode, rule_json, summary_json,
                           created_at, applied_at, undone_at
                    FROM smart_filter_runs
                    WHERE project_id = ? AND run_id = ?
                    ''',
                    (str(project_id), str(run_id)),
                ).fetchone()
                if row is None:
                    return None
                snap_row = conn.execute(
                    '''
                    SELECT COUNT(*) AS snapshot_count
                    FROM smart_filter_snapshots
                    WHERE project_id = ? AND run_id = ?
                    ''',
                    (str(project_id), str(run_id)),
                ).fetchone()
            finally:
                conn.close()
        snapshot_count = int(snap_row['snapshot_count']) if snap_row is not None else 0
        item = dict(row)
        item['rule'] = self._json_loads(item.pop('rule_json', '{}'), {})
        item['summary'] = self._json_loads(item.pop('summary_json', '{}'), {})
        item['snapshot_count'] = snapshot_count
        return item

    def get_latest(self, *, project_id: str) -> dict[str, Any] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    '''
                    SELECT run_id
                    FROM smart_filter_runs
                    WHERE project_id = ? AND applied_at != '' AND undone_at = ''
                    ORDER BY applied_at DESC, created_at DESC
                    LIMIT 1
                    ''',
                    (str(project_id),),
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            return None
        return self.get(project_id=project_id, run_id=str(row['run_id']))

    def rollback(self, *, project_id: str, run_id: str) -> dict[str, Any]:
        run = self.get(project_id=project_id, run_id=run_id)
        if not run:
            raise ValueError('smart filter run not found')
        if str(run.get('undone_at') or '').strip():
            raise ValueError('smart filter run already rolled back')

        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    '''
                    SELECT image_id, annotations_json
                    FROM smart_filter_snapshots
                    WHERE project_id = ? AND run_id = ?
                    ORDER BY image_id ASC
                    ''',
                    (str(project_id), str(run_id)),
                ).fetchall()
            finally:
                conn.close()

        restored = 0
        skipped = 0
        for row in rows:
            image_id = str(row['image_id'])
            annotations = self._json_loads(row['annotations_json'], [])
            if not isinstance(annotations, list):
                annotations = []
            try:
                snapshot_dir = self._snapshot_dir(run_id, image_id)
                snapshot_names = {
                    str(name) for name in read_json(snapshot_dir / 'masks.json', []) if str(name).endswith('.png')
                }
                current = self._load_annotations(str(project_id), image_id)
                for ann in current:
                    ann_id = str(ann.get('id') or '').strip() if isinstance(ann, dict) else ''
                    if not ann_id:
                        continue
                    target = annotation_mask_path(self._base_dir, project_id, image_id, ann_id)
                    if target.name not in snapshot_names:
                        target.unlink(missing_ok=True)
                for name in snapshot_names:
                    source = snapshot_dir / 'masks' / Path(name).name
                    target = annotation_mask_path(self._base_dir, project_id, image_id, Path(name).stem)
                    if not source.is_file():
                        raise OSError(f'mask snapshot missing: {name}')
                    ensure_dir(target.parent)
                    fd, tmp_name = tempfile.mkstemp(prefix='.rollback_', suffix='.png', dir=str(target.parent))
                    os.close(fd)
                    try:
                        shutil.copy2(source, tmp_name)
                        os.replace(tmp_name, target)
                    finally:
                        try:
                            os.unlink(tmp_name)
                        except OSError:
                            pass
                self._save_annotations(str(project_id), image_id, annotations)
                restored += 1
            except Exception:
                skipped += 1

        if skipped == 0:
            with self._db_lock:
                conn = self._db_connect()
                try:
                    conn.execute(
                        '''
                        UPDATE smart_filter_runs
                        SET undone_at = ?
                        WHERE project_id = ? AND run_id = ?
                        ''',
                        (now_ts(), str(project_id), str(run_id)),
                    )
                    conn.commit()
                finally:
                    conn.close()

        return {
            'run_id': str(run_id),
            'project_id': str(project_id),
            'restored_images': restored,
            'skipped_images': skipped,
        }
