from __future__ import annotations

import json
from threading import RLock
from typing import Any, Callable

from app.utils import new_id, now_ts


class AnnotationRecordRepository:
    def __init__(self, *, db_connect: Callable[[], Any], db_lock: RLock) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock

    @staticmethod
    def json_dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

    @staticmethod
    def json_loads(raw: Any, fallback: Any) -> Any:
        try:
            return json.loads(str(raw or ''))
        except Exception:
            return fallback

    def registered_ids(self, project_id: str, *, exclude_image_id: str = '') -> set[str]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                if exclude_image_id:
                    rows = conn.execute(
                        '''
                        SELECT annotation_id
                        FROM annotation_ids
                        WHERE project_id = ? AND image_id != ?
                        ''',
                        (str(project_id), str(exclude_image_id)),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        '''
                        SELECT annotation_id
                        FROM annotation_ids
                        WHERE project_id = ?
                        ''',
                        (str(project_id),),
                    ).fetchall()
            finally:
                conn.close()
        return {str(row['annotation_id']) for row in rows if str(row['annotation_id'] or '').strip()}

    def registered_id_conflicts(
        self,
        project_id: str,
        annotation_ids: list[str],
        *,
        exclude_image_id: str = '',
    ) -> set[str]:
        ids = [str(item).strip() for item in annotation_ids if str(item).strip()]
        if not ids:
            return set()

        out: set[str] = set()
        with self._db_lock:
            conn = self._db_connect()
            try:
                for start in range(0, len(ids), 500):
                    chunk = ids[start:start + 500]
                    placeholders = ','.join('?' for _ in chunk)
                    if exclude_image_id:
                        rows = conn.execute(
                            f'''
                            SELECT annotation_id
                            FROM annotation_ids
                            WHERE project_id = ?
                              AND image_id != ?
                              AND annotation_id IN ({placeholders})
                            ''',
                            [str(project_id), str(exclude_image_id), *chunk],
                        ).fetchall()
                    else:
                        rows = conn.execute(
                            f'''
                            SELECT annotation_id
                            FROM annotation_ids
                            WHERE project_id = ?
                              AND annotation_id IN ({placeholders})
                            ''',
                            [str(project_id), *chunk],
                        ).fetchall()
                    for row in rows:
                        value = str(row['annotation_id'] or '').strip()
                        if value:
                            out.add(value)
            finally:
                conn.close()
        return out

    def replace_ids(
        self,
        project_id: str,
        image_id: str,
        annotation_ids: list[str],
        *,
        conn: Any | None = None,
    ) -> None:
        rows = [str(x).strip() for x in annotation_ids if str(x).strip()]
        ts = now_ts()

        def write(target: Any) -> None:
            target.execute(
                'DELETE FROM annotation_ids WHERE project_id = ? AND image_id = ?',
                (str(project_id), str(image_id)),
            )
            target.executemany(
                '''
                INSERT OR REPLACE INTO annotation_ids (
                    project_id, image_id, annotation_id, created_at
                ) VALUES (?, ?, ?, ?)
                ''',
                [(str(project_id), str(image_id), item, ts) for item in rows],
            )

        if conn is not None:
            write(conn)
            return

        with self._db_lock:
            owned = self._db_connect()
            try:
                write(owned)
                owned.commit()
            finally:
                owned.close()

    def load(self, project_id: str, image_id: str) -> list[dict[str, Any]] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    '''
                    SELECT annotations_json
                    FROM image_annotations
                    WHERE project_id = ? AND image_id = ?
                    ''',
                    (str(project_id), str(image_id)),
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            return None
        data = self.json_loads(row['annotations_json'], [])
        return data if isinstance(data, list) else []

    def replace(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
        *,
        conn: Any | None = None,
        updated_at: str | None = None,
    ) -> None:
        rows = annotations if isinstance(annotations, list) else []
        ts = str(updated_at or now_ts())

        def write(target: Any) -> None:
            target.execute(
                '''
                INSERT OR REPLACE INTO image_annotations (
                    project_id, image_id, annotations_json, annotation_count, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ''',
                (
                    str(project_id),
                    str(image_id),
                    self.json_dumps(rows),
                    len(rows),
                    ts,
                ),
            )

        if conn is not None:
            write(conn)
            return

        with self._db_lock:
            owned = self._db_connect()
            try:
                write(owned)
                owned.commit()
            finally:
                owned.close()

    @staticmethod
    def looks_like_model_detection_id(raw: str) -> bool:
        text = str(raw or '').strip().lower()
        return text.startswith('det_')

    def normalize_ids(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        candidate_ids: list[str] = []
        for raw in annotations if isinstance(annotations, list) else []:
            if not isinstance(raw, dict):
                continue
            original_id = str(raw.get('id') or '').strip()
            if original_id and not self.looks_like_model_detection_id(original_id):
                candidate_ids.append(original_id)
        project_used = self.registered_id_conflicts(
            project_id,
            candidate_ids,
            exclude_image_id=image_id,
        )
        return self._normalize_ids_with_project_used(annotations, project_used, add_to_project_used=False)

    def normalize_ids_with_used_set(
        self,
        annotations: list[dict[str, Any]],
        project_used: set[str],
    ) -> list[dict[str, Any]]:
        return self._normalize_ids_with_project_used(annotations, project_used, add_to_project_used=True)

    def _normalize_ids_with_project_used(
        self,
        annotations: list[dict[str, Any]],
        project_used: set[str],
        *,
        add_to_project_used: bool,
    ) -> list[dict[str, Any]]:
        local_used: set[str] = set()
        normalized: list[dict[str, Any]] = []
        for raw in annotations if isinstance(annotations, list) else []:
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            original_id = str(item.get('id') or '').strip()
            needs_generated_id = (
                not original_id
                or original_id in local_used
                or original_id in project_used
                or self.looks_like_model_detection_id(original_id)
            )
            if self.looks_like_model_detection_id(original_id) and not item.get('model_det_id'):
                item['model_det_id'] = original_id

            next_id = original_id
            if needs_generated_id:
                next_id = new_id('ann_')
            while (not next_id) or next_id in local_used or next_id in project_used:
                next_id = new_id('ann_')

            item['id'] = next_id
            local_used.add(next_id)
            if add_to_project_used:
                project_used.add(next_id)
            normalized.append(item)

        return normalized
