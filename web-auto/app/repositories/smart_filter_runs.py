from __future__ import annotations

import json
from threading import RLock
from typing import Any, Callable

from app.utils import new_id, now_ts


class SmartFilterRunRepository:
    def __init__(
        self,
        *,
        db_connect: Callable[[], Any],
        db_lock: RLock,
        save_annotations: Callable[[str, str, list[dict[str, Any]]], None],
    ) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock
        self._save_annotations = save_annotations

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
                conn.commit()
            finally:
                conn.close()

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
                self._save_annotations(str(project_id), image_id, annotations)
                restored += 1
            except Exception:
                skipped += 1

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
