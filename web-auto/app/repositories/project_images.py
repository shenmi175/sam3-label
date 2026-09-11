from __future__ import annotations

from threading import RLock
from typing import Any, Callable

from app.annotations import normalize_source
from app.utils import norm_text


class ProjectImageRepository:
    def __init__(self, *, db_connect: Callable[[], Any], db_lock: RLock) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock

    @staticmethod
    def normalize_status(raw: Any) -> str:
        return 'labeled' if str(raw or '').strip().lower() == 'labeled' else 'unlabeled'

    @classmethod
    def normalize_rows(cls, project_type: str, images: list[dict[str, Any]]) -> list[dict[str, Any]]:
        del project_type
        out: list[dict[str, Any]] = []
        for idx, img in enumerate(images):
            if not isinstance(img, dict):
                continue
            item = dict(img)
            rel_path = str(item.get('rel_path') or '').strip()
            image_id = str(item.get('id') or '').strip()
            if not rel_path or not image_id:
                continue
            out.append(
                {
                    'id': image_id,
                    'rel_path': rel_path,
                    'abs_path': str(item.get('abs_path') or '').strip(),
                    'status': cls.normalize_status(item.get('status')),
                    'sort_index': idx,
                    'frame_index': None,
                }
            )
        return out

    def replace(self, project_id: str, project_type: str, images: list[dict[str, Any]]) -> None:
        rows = self.normalize_rows(project_type, images)
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM project_images WHERE project_id = ?', (str(project_id),))
                conn.executemany(
                    '''
                    INSERT INTO project_images (
                        project_id, sort_index, image_id, rel_path, abs_path, status, frame_index
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''',
                    [
                        (
                            str(project_id),
                            int(row['sort_index']),
                            str(row['id']),
                            str(row['rel_path']),
                            str(row['abs_path']),
                            str(row['status']),
                            row['frame_index'],
                        )
                        for row in rows
                    ],
                )
                conn.commit()
            finally:
                conn.close()

    def insert(self, project_id: str, project_type: str, images: list[dict[str, Any]], *, start_index: int) -> None:
        rows = self.normalize_rows(project_type, images)
        for offset, row in enumerate(rows):
            row['sort_index'] = int(start_index + offset)
        if not rows:
            return
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.executemany(
                    '''
                    INSERT OR REPLACE INTO project_images (
                        project_id, sort_index, image_id, rel_path, abs_path, status, frame_index
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''',
                    [
                        (
                            str(project_id),
                            int(row['sort_index']),
                            str(row['id']),
                            str(row['rel_path']),
                            str(row['abs_path']),
                            str(row['status']),
                            row['frame_index'],
                        )
                        for row in rows
                    ],
                )
                conn.commit()
            finally:
                conn.close()

    def update_abs_path(self, project_id: str, image_id: str, abs_path: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    'UPDATE project_images SET abs_path = ? WHERE project_id = ? AND image_id = ?',
                    (str(abs_path or ''), str(project_id), str(image_id)),
                )
                conn.commit()
            finally:
                conn.close()

    def update_status(self, project_id: str, image_id: str, status: str, *, conn: Any | None = None) -> bool:
        def write(target: Any) -> bool:
            cur = target.execute(
                'UPDATE project_images SET status = ? WHERE project_id = ? AND image_id = ?',
                (self.normalize_status(status), str(project_id), str(image_id)),
            )
            return int(cur.rowcount or 0) > 0

        if conn is not None:
            return write(conn)

        with self._db_lock:
            owned = self._db_connect()
            try:
                updated = write(owned)
                owned.commit()
                return updated
            finally:
                owned.close()

    def delete_one(self, project_id: str, image_id: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    'DELETE FROM project_images WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.execute(
                    'DELETE FROM annotation_ids WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.execute(
                    'DELETE FROM image_annotations WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.execute(
                    'DELETE FROM image_annotation_stats WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.execute(
                    'DELETE FROM image_class_index WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.execute(
                    'DELETE FROM image_source_class_index WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.commit()
            finally:
                conn.close()

    def delete_many(self, project_id: str, image_ids: list[str]) -> None:
        ids = list(dict.fromkeys(str(item).strip() for item in image_ids if str(item).strip()))
        if not ids:
            return
        tables = [
            'project_images',
            'annotation_ids',
            'image_annotations',
            'image_annotation_stats',
            'image_class_index',
            'image_source_class_index',
        ]
        with self._db_lock:
            conn = self._db_connect()
            try:
                for table in tables:
                    for start in range(0, len(ids), 500):
                        chunk = ids[start:start + 500]
                        placeholders = ','.join('?' for _ in chunk)
                        conn.execute(
                            f'DELETE FROM {table} WHERE project_id = ? AND image_id IN ({placeholders})',
                            [str(project_id), *chunk],
                        )
                conn.commit()
            finally:
                conn.close()

    def delete_project(self, project_id: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM project_images WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM annotation_ids WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_annotations WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_annotation_stats WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_class_index WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_source_class_index WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM smart_filter_snapshots WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM smart_filter_runs WHERE project_id = ?', (str(project_id),))
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def row_to_image(row: Any) -> dict[str, Any]:
        item: dict[str, Any] = {
            'id': str(row['image_id']),
            'rel_path': str(row['rel_path']),
            'abs_path': str(row['abs_path'] or ''),
            'status': str(row['status'] or 'unlabeled'),
        }
        if row['frame_index'] is not None:
            item['frame_index'] = int(row['frame_index'])
        return item

    def load_all(self, project_id: str) -> list[dict[str, Any]]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    '''
                    SELECT image_id, rel_path, abs_path, status, frame_index
                    FROM project_images
                    WHERE project_id = ?
                    ORDER BY sort_index ASC
                    ''',
                    (str(project_id),),
                ).fetchall()
            finally:
                conn.close()
        return [self.row_to_image(row) for row in rows]

    @classmethod
    def filter_query(
        cls,
        project_id: str,
        *,
        status: str = '',
        class_name: str = '',
        source_model: str = '',
    ) -> tuple[str, list[Any], str]:
        class_norm = norm_text(class_name)
        source_norm = normalize_source(source_model).source_id if str(source_model or '').strip() else ''
        status_norm = cls.normalize_status(status) if str(status or '').strip().lower() in {'labeled', 'unlabeled'} else ''
        join_sql = ''
        where_parts = ['pi.project_id = ?']
        params: list[Any] = [str(project_id)]
        if class_norm and not source_norm:
            join_sql = '''
            INNER JOIN image_class_index ci
            ON ci.project_id = pi.project_id AND ci.image_id = pi.image_id
            '''
            where_parts.append('ci.class_name_norm = ?')
            params.append(class_norm)
        if source_norm:
            source_where = [
                'sci.project_id = pi.project_id',
                'sci.image_id = pi.image_id',
                'sci.source_model_norm = ?',
            ]
            params.append(source_norm)
            if class_norm:
                source_where.append('sci.class_name_norm = ?')
                params.append(class_norm)
            where_parts.append(
                'EXISTS (SELECT 1 FROM image_source_class_index sci WHERE '
                + ' AND '.join(source_where)
                + ')'
            )
        if status_norm:
            where_parts.append('pi.status = ?')
            params.append(status_norm)
        return join_sql, params, ' AND '.join(where_parts)

    def count(self, project_id: str, *, status: str = '', class_name: str = '', source_model: str = '') -> int:
        join_sql, params, where_sql = self.filter_query(
            project_id, status=status, class_name=class_name, source_model=source_model,
        )
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    f'''
                    SELECT COUNT(*) AS total
                    FROM project_images pi
                    {join_sql}
                    WHERE {where_sql}
                    ''',
                    params,
                ).fetchone()
            finally:
                conn.close()
        return int(row['total'] if row is not None else 0)

    def filtered_index(
        self,
        project_id: str,
        image_id: str,
        *,
        status: str = '',
        class_name: str = '',
        source_model: str = '',
    ) -> int:
        if not str(image_id or '').strip():
            return -1
        selected_index = self.index(project_id, image_id)
        if selected_index < 0:
            return -1
        join_sql, params, where_sql = self.filter_query(
            project_id, status=status, class_name=class_name, source_model=source_model,
        )
        params = list(params) + [int(selected_index)]
        with self._db_lock:
            conn = self._db_connect()
            try:
                selected = conn.execute(
                    f'''
                    SELECT pi.image_id
                    FROM project_images pi
                    {join_sql}
                    WHERE {where_sql} AND pi.image_id = ?
                    LIMIT 1
                    ''',
                    params[:-1] + [str(image_id)],
                ).fetchone()
                if selected is None:
                    return -1
                row = conn.execute(
                    f'''
                    SELECT COUNT(*) AS idx
                    FROM project_images pi
                    {join_sql}
                    WHERE {where_sql} AND pi.sort_index < ?
                    ''',
                    params,
                ).fetchone()
            finally:
                conn.close()
        return int(row['idx'] if row is not None else -1)

    def page(
        self,
        project_id: str,
        *,
        offset: int,
        limit: int,
        status: str = '',
        class_name: str = '',
        source_model: str = '',
    ) -> list[dict[str, Any]]:
        join_sql, params, where_sql = self.filter_query(
            project_id, status=status, class_name=class_name, source_model=source_model,
        )
        params = list(params) + [int(limit), int(offset)]
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    f'''
                    SELECT pi.image_id, pi.rel_path, pi.abs_path, pi.status, pi.frame_index
                    FROM project_images pi
                    {join_sql}
                    WHERE {where_sql}
                    ORDER BY pi.sort_index ASC
                    LIMIT ? OFFSET ?
                    ''',
                    params,
                ).fetchall()
            finally:
                conn.close()
        return [self.row_to_image(row) for row in rows]

    def by_ids(self, project_id: str, image_ids: list[str]) -> list[dict[str, Any]]:
        ids = [str(item).strip() for item in image_ids if str(item).strip()]
        if not ids:
            return []

        rows: list[Any] = []
        with self._db_lock:
            conn = self._db_connect()
            try:
                for start in range(0, len(ids), 500):
                    chunk = ids[start:start + 500]
                    placeholders = ','.join('?' for _ in chunk)
                    rows.extend(
                        conn.execute(
                            f'''
                            SELECT image_id, rel_path, abs_path, status, frame_index, sort_index
                            FROM project_images
                            WHERE project_id = ? AND image_id IN ({placeholders})
                            ORDER BY sort_index ASC
                            ''',
                            [str(project_id), *chunk],
                        ).fetchall()
                    )
            finally:
                conn.close()

        rows.sort(key=lambda row: int(row['sort_index']))
        return [self.row_to_image(row) for row in rows]

    def filtered_list(
        self,
        project_id: str,
        *,
        status: str = '',
    ) -> list[dict[str, Any]]:
        join_sql, params, where_sql = self.filter_query(project_id, status=status)
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    f'''
                    SELECT pi.image_id, pi.rel_path, pi.abs_path, pi.status, pi.frame_index
                    FROM project_images pi
                    {join_sql}
                    WHERE {where_sql}
                    ORDER BY pi.sort_index ASC
                    ''',
                    params,
                ).fetchall()
            finally:
                conn.close()
        return [self.row_to_image(row) for row in rows]

    def with_any_classes(self, project_id: str, class_names: list[str]) -> list[dict[str, Any]]:
        class_norms = sorted({norm_text(item) for item in class_names if norm_text(item)})
        if not class_norms:
            return []
        placeholders = ','.join('?' for _ in class_norms)
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    f'''
                    SELECT DISTINCT pi.image_id, pi.rel_path, pi.abs_path, pi.status, pi.frame_index, pi.sort_index
                    FROM project_images pi
                    INNER JOIN image_class_index ci
                    ON ci.project_id = pi.project_id AND ci.image_id = pi.image_id
                    WHERE pi.project_id = ? AND ci.class_name_norm IN ({placeholders})
                    ORDER BY pi.sort_index ASC
                    ''',
                    [str(project_id), *class_norms],
                ).fetchall()
            finally:
                conn.close()
        return [self.row_to_image(row) for row in rows]

    def without_any_classes(self, project_id: str, class_names: list[str]) -> list[dict[str, Any]]:
        class_norms = sorted({norm_text(item) for item in class_names if norm_text(item)})
        if not class_norms:
            return []
        placeholders = ','.join('?' for _ in class_norms)
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    f'''
                    SELECT pi.image_id, pi.rel_path, pi.abs_path, pi.status, pi.frame_index
                    FROM project_images pi
                    WHERE pi.project_id = ?
                      AND NOT EXISTS (
                        SELECT 1
                        FROM image_class_index ci
                        WHERE ci.project_id = pi.project_id
                          AND ci.image_id = pi.image_id
                          AND ci.class_name_norm IN ({placeholders})
                      )
                    ORDER BY pi.sort_index ASC
                    ''',
                    [str(project_id), *class_norms],
                ).fetchall()
            finally:
                conn.close()
        return [self.row_to_image(row) for row in rows]

    def get(self, project_id: str, image_id: str) -> dict[str, Any] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    '''
                    SELECT image_id, rel_path, abs_path, status, frame_index
                    FROM project_images
                    WHERE project_id = ? AND image_id = ?
                    ''',
                    (str(project_id), str(image_id)),
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            return None
        return self.row_to_image(row)

    def index(self, project_id: str, image_id: str) -> int:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    'SELECT sort_index FROM project_images WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            return -1
        return int(row['sort_index'])

    def first(self, project_id: str) -> dict[str, Any] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute(
                    '''
                    SELECT image_id, rel_path, abs_path, status, frame_index
                    FROM project_images
                    WHERE project_id = ?
                    ORDER BY sort_index ASC
                    LIMIT 1
                    ''',
                    (str(project_id),),
                ).fetchone()
            finally:
                conn.close()
        if row is None:
            return None
        return self.row_to_image(row)

    def unlabeled(
        self,
        project_id: str,
        *,
        after_sort_index: int = -1,
        direction: str = 'next',
    ) -> tuple[dict[str, Any] | None, int]:
        nav_dir = 'prev' if str(direction or '').strip().lower() == 'prev' else 'next'
        with self._db_lock:
            conn = self._db_connect()
            try:
                if nav_dir == 'prev':
                    row = conn.execute(
                        '''
                        SELECT image_id, rel_path, abs_path, status, frame_index, sort_index
                        FROM project_images
                        WHERE project_id = ? AND status = 'unlabeled' AND sort_index < ?
                        ORDER BY sort_index DESC
                        LIMIT 1
                        ''',
                        (str(project_id), int(after_sort_index)),
                    ).fetchone()
                else:
                    row = conn.execute(
                        '''
                        SELECT image_id, rel_path, abs_path, status, frame_index, sort_index
                        FROM project_images
                        WHERE project_id = ? AND status = 'unlabeled' AND sort_index > ?
                        ORDER BY sort_index ASC
                        LIMIT 1
                        ''',
                        (str(project_id), int(after_sort_index)),
                    ).fetchone()
                if row is None and int(after_sort_index) >= 0:
                    if nav_dir == 'prev':
                        row = conn.execute(
                            '''
                            SELECT image_id, rel_path, abs_path, status, frame_index, sort_index
                            FROM project_images
                            WHERE project_id = ? AND status = 'unlabeled'
                            ORDER BY sort_index DESC
                            LIMIT 1
                            ''',
                            (str(project_id),),
                        ).fetchone()
                    else:
                        row = conn.execute(
                            '''
                            SELECT image_id, rel_path, abs_path, status, frame_index, sort_index
                            FROM project_images
                            WHERE project_id = ? AND status = 'unlabeled'
                            ORDER BY sort_index ASC
                            LIMIT 1
                            ''',
                            (str(project_id),),
                        ).fetchone()
            finally:
                conn.close()
        if row is None:
            return None, -1
        return self.row_to_image(row), int(row['sort_index'])

    def iter_ids(self, project_id: str) -> list[str]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    'SELECT image_id FROM project_images WHERE project_id = ? ORDER BY sort_index ASC',
                    (str(project_id),),
                ).fetchall()
            finally:
                conn.close()
        return [str(row['image_id']) for row in rows]

    @classmethod
    def counts(cls, images: list[dict[str, Any]]) -> tuple[int, int, int]:
        total = len(images)
        labeled = 0
        for img in images:
            if cls.normalize_status(img.get('status')) == 'labeled':
                labeled += 1
        return total, labeled, max(0, total - labeled)
