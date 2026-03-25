from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path
from typing import Any

try:
    import sqlite3
except Exception as exc:  # noqa: BLE001
    sqlite3 = None  # type: ignore[assignment]
    SQLITE_IMPORT_ERROR = exc
else:
    SQLITE_IMPORT_ERROR = None

from app.utils import (
    atomic_write_json,
    build_virtual_frames,
    ensure_dir,
    list_frames_from_dir,
    list_images_recursive,
    list_video_files_recursive,
    new_id,
    norm_text,
    now_ts,
    parse_classes_text,
    probe_video_info,
    read_json,
)


class Storage:
    def __init__(self, base_dir: Path):
        self.base_dir = ensure_dir(base_dir)
        self.projects_file = self.base_dir / 'projects.json'
        self.projects_root = ensure_dir(self.base_dir / 'projects')
        self.ui_state_global_file = self.base_dir / 'ui_state_global.json'
        self._video_state_lock = threading.RLock()
        self._db_lock = threading.RLock()
        self.index_db_file = self.base_dir / 'web_auto_index.sqlite3'
        self._init_index_db()

    def _load_projects(self) -> list[dict[str, Any]]:
        data = read_json(self.projects_file, [])
        return data if isinstance(data, list) else []

    def _save_projects(self, projects: list[dict[str, Any]]) -> None:
        atomic_write_json(self.projects_file, projects)

    def _init_index_db(self) -> None:
        if sqlite3 is None:
            raise RuntimeError(
                'sqlite3 is unavailable in the current Python environment. '
                'web-auto now requires Python with built-in sqlite3 support. '
                'Please install/enable SQLite in this environment first.'
            ) from SQLITE_IMPORT_ERROR
        with self._db_lock:
            conn = sqlite3.connect(str(self.index_db_file), timeout=30.0)
            try:
                conn.execute('PRAGMA journal_mode=WAL')
                conn.execute('PRAGMA synchronous=NORMAL')
                conn.executescript(
                    '''
                    CREATE TABLE IF NOT EXISTS project_images (
                        project_id TEXT NOT NULL,
                        sort_index INTEGER NOT NULL,
                        image_id TEXT NOT NULL,
                        rel_path TEXT NOT NULL,
                        abs_path TEXT NOT NULL DEFAULT '',
                        status TEXT NOT NULL DEFAULT 'unlabeled',
                        frame_index INTEGER,
                        PRIMARY KEY (project_id, image_id)
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_images_rel
                    ON project_images(project_id, rel_path);
                    CREATE INDEX IF NOT EXISTS idx_project_images_sort
                    ON project_images(project_id, sort_index);
                    '''
                )
                conn.commit()
            finally:
                conn.close()

    def _db_connect(self) -> sqlite3.Connection:
        if sqlite3 is None:
            raise RuntimeError(
                'sqlite3 is unavailable in the current Python environment. '
                'web-auto now requires Python with built-in sqlite3 support.'
            ) from SQLITE_IMPORT_ERROR
        conn = sqlite3.connect(str(self.index_db_file), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        return conn

    @staticmethod
    def _normalize_image_status(raw: Any) -> str:
        return 'labeled' if str(raw or '').strip().lower() == 'labeled' else 'unlabeled'

    def _normalize_image_rows(self, project_type: str, images: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for idx, img in enumerate(images):
            if not isinstance(img, dict):
                continue
            item = dict(img)
            rel_path = str(item.get('rel_path') or '').strip()
            image_id = str(item.get('id') or '').strip()
            if not rel_path or not image_id:
                continue
            row: dict[str, Any] = {
                'id': image_id,
                'rel_path': rel_path,
                'abs_path': str(item.get('abs_path') or '').strip(),
                'status': self._normalize_image_status(item.get('status')),
                'sort_index': idx,
                'frame_index': None,
            }
            if project_type == 'video':
                try:
                    row['frame_index'] = int(item.get('frame_index') if item.get('frame_index') is not None else idx)
                except Exception:
                    row['frame_index'] = idx
            out.append(row)
        return out

    def _replace_project_images_db(self, project_id: str, project_type: str, images: list[dict[str, Any]]) -> None:
        rows = self._normalize_image_rows(project_type, images)
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

    def _insert_project_images_db(self, project_id: str, project_type: str, images: list[dict[str, Any]], *, start_index: int) -> None:
        rows = self._normalize_image_rows(project_type, images)
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

    def _update_project_image_abs_path_db(self, project_id: str, image_id: str, abs_path: str) -> None:
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

    def _update_project_image_status_db(self, project_id: str, image_id: str, status: str) -> bool:
        with self._db_lock:
            conn = self._db_connect()
            try:
                cur = conn.execute(
                    'UPDATE project_images SET status = ? WHERE project_id = ? AND image_id = ?',
                    (self._normalize_image_status(status), str(project_id), str(image_id)),
                )
                conn.commit()
                return int(cur.rowcount or 0) > 0
            finally:
                conn.close()

    def _delete_project_image_db(self, project_id: str, image_id: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute(
                    'DELETE FROM project_images WHERE project_id = ? AND image_id = ?',
                    (str(project_id), str(image_id)),
                )
                conn.commit()
            finally:
                conn.close()

    def _delete_project_images_db(self, project_id: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM project_images WHERE project_id = ?', (str(project_id),))
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def _db_row_to_image(row: sqlite3.Row) -> dict[str, Any]:
        item: dict[str, Any] = {
            'id': str(row['image_id']),
            'rel_path': str(row['rel_path']),
            'abs_path': str(row['abs_path'] or ''),
            'status': str(row['status'] or 'unlabeled'),
        }
        if row['frame_index'] is not None:
            item['frame_index'] = int(row['frame_index'])
        return item

    def _load_project_images_db(self, project_id: str) -> list[dict[str, Any]]:
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
        return [self._db_row_to_image(row) for row in rows]

    def _load_project_images_page_db(self, project_id: str, *, offset: int, limit: int) -> list[dict[str, Any]]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                rows = conn.execute(
                    '''
                    SELECT image_id, rel_path, abs_path, status, frame_index
                    FROM project_images
                    WHERE project_id = ?
                    ORDER BY sort_index ASC
                    LIMIT ? OFFSET ?
                    ''',
                    (str(project_id), int(limit), int(offset)),
                ).fetchall()
            finally:
                conn.close()
        return [self._db_row_to_image(row) for row in rows]

    def _get_project_image_db(self, project_id: str, image_id: str) -> dict[str, Any] | None:
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
        return self._db_row_to_image(row)

    def _get_project_image_index_db(self, project_id: str, image_id: str) -> int:
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

    def _get_project_first_image_db(self, project_id: str) -> dict[str, Any] | None:
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
        return self._db_row_to_image(row)

    def _get_project_unlabeled_image_db(
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
        return self._db_row_to_image(row), int(row['sort_index'])

    def _iter_project_image_ids_db(self, project_id: str) -> list[str]:
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

    def _project_image_counts(self, images: list[dict[str, Any]]) -> tuple[int, int, int]:
        total = len(images)
        labeled = 0
        for img in images:
            if self._normalize_image_status(img.get('status')) == 'labeled':
                labeled += 1
        return total, labeled, max(0, total - labeled)

    def _ensure_project_images_sqlite(self, project: dict[str, Any], images: list[dict[str, Any]]) -> dict[str, Any]:
        q = dict(project)
        project_type = str(q.get('project_type') or 'image').strip().lower()
        image_store = str(q.get('image_store') or '').strip().lower()
        if images:
            self._replace_project_images_db(str(q.get('id') or ''), project_type, images)
            total, labeled, unlabeled = self._project_image_counts(images)
            q['num_images'] = total
            q['labeled_images'] = labeled
            q['unlabeled_images'] = unlabeled
            q['image_store'] = 'sqlite'
            q['images'] = []
            return q
        if image_store != 'sqlite':
            q['image_store'] = 'sqlite'
        q['images'] = []
        try:
            total = int(q.get('num_images', 0) or 0)
            labeled = int(q.get('labeled_images', 0) or 0)
        except Exception:
            total = 0
            labeled = 0
        total = max(0, total)
        labeled = max(0, min(total, labeled))
        q['num_images'] = total
        q['labeled_images'] = labeled
        q['unlabeled_images'] = max(0, total - labeled)
        return q

    @staticmethod
    def _content_rev(project: dict[str, Any]) -> int:
        try:
            return max(1, int(project.get('content_rev', 1) or 1))
        except Exception:
            return 1

    def _bump_content_rev(self, project: dict[str, Any]) -> int:
        next_rev = self._content_rev(project) + 1
        project['content_rev'] = next_rev
        return next_rev

    @staticmethod
    def _safe_resolve(raw: str) -> str:
        if not raw:
            return ''
        try:
            return str(Path(raw).expanduser().resolve())
        except Exception:
            return str(raw)

    def _normalize_project(self, p: dict[str, Any]) -> dict[str, Any]:
        q = dict(p)
        pid = str(q.get('id') or '')
        workspace_dir = ensure_dir(self.projects_root / pid)

        project_type = str(q.get('project_type') or 'image').strip().lower()
        if project_type not in {'image', 'video'}:
            project_type = 'image'

        image_dir = self._safe_resolve(str(q.get('image_dir') or ''))
        video_path = self._safe_resolve(str(q.get('video_path') or ''))
        video_name = str(q.get('video_name') or (Path(video_path).stem if video_path else 'video')).strip() or 'video'
        video_meta = q.get('video_meta', {}) if isinstance(q.get('video_meta', {}), dict) else {}

        save_dir = self._safe_resolve(str(q.get('save_dir') or ''))
        save_base_dir = self._safe_resolve(str(q.get('save_base_dir') or ''))
        project_save_dir = self._safe_resolve(str(q.get('project_save_dir') or ''))
        annotation_dir = self._safe_resolve(str(q.get('annotation_dir') or ''))
        export_dir = self._safe_resolve(str(q.get('export_dir') or ''))

        if not project_save_dir:
            if save_dir:
                project_save_dir = save_dir
            else:
                project_save_dir = str((workspace_dir / 'output').resolve())
        ensure_dir(Path(project_save_dir))

        if not save_base_dir:
            save_base_dir = str(Path(project_save_dir).parent.resolve())

        if not annotation_dir:
            annotation_dir = str((Path(project_save_dir) / 'annotations').resolve())
        ensure_dir(Path(annotation_dir))

        if not export_dir:
            export_dir = str((Path(project_save_dir) / 'exports').resolve())
        ensure_dir(Path(export_dir))

        images = q.get('images', []) if isinstance(q.get('images', []), list) else []
        normalized_images: list[dict[str, Any]] = []
        for i, img in enumerate(images):
            if not isinstance(img, dict):
                continue
            item = dict(img)
            if project_type == 'video':
                if 'frame_index' not in item:
                    item['frame_index'] = i
            normalized_images.append(item)

        q['id'] = pid
        q['name'] = str(q.get('name') or pid)
        q['project_type'] = project_type
        q['image_dir'] = image_dir
        q['video_path'] = video_path
        q['video_name'] = video_name
        q['video_meta'] = video_meta
        q['save_base_dir'] = save_base_dir
        q['project_save_dir'] = project_save_dir
        q['save_dir'] = project_save_dir
        q['annotation_dir'] = annotation_dir
        q['export_dir'] = export_dir
        q['workspace_dir'] = str(workspace_dir.resolve())
        q['cache_dir'] = str(ensure_dir(workspace_dir / 'cache').resolve())
        q['classes'] = q.get('classes', []) if isinstance(q.get('classes', []), list) else []
        q = self._ensure_project_images_sqlite(q, normalized_images)
        q['num_frames'] = int(q.get('num_images', 0) or 0) if project_type == 'video' else 0
        q['content_rev'] = self._content_rev(q)
        q['created_at'] = str(q.get('created_at') or now_ts())
        q['updated_at'] = str(q.get('updated_at') or now_ts())
        q['locked'] = True
        return q

    def _annotation_path(self, project: dict[str, Any], image_id: str) -> Path:
        ann_dir = ensure_dir(Path(project['annotation_dir']).expanduser().resolve())
        return ann_dir / f'{image_id}.json'

    @staticmethod
    def _annotation_has_items(path: Path) -> bool:
        if not path.exists():
            return False
        try:
            size = os.path.getsize(path)
            if size <= 2:
                return False
            if size > 64:
                return True
            with path.open('r', encoding='utf-8', errors='ignore') as f:
                content = f.read(256).strip()
            if not content or content == '[]':
                return False
            return True
        except Exception:
            return False

    def _image_status(self, project: dict[str, Any], image_id: str) -> str:
        path = self._annotation_path(project, image_id)
        if self._annotation_has_items(path):
            return 'labeled'
        return 'unlabeled'

    def _status_map(self, project: dict[str, Any]) -> dict[str, str]:
        out: dict[str, str] = {}
        for img in project.get('images', []):
            image_id = str(img.get('id') or '')
            if not image_id:
                continue
            out[image_id] = self._image_status(project, image_id)
        return out

    def _enrich_project(self, project: dict[str, Any]) -> dict[str, Any]:
        p = self._normalize_project(project)
        if str(p.get('image_store') or '').strip().lower() == 'sqlite':
            p['images'] = self._load_project_images_db(str(p.get('id') or ''))
            total, labeled, unlabeled = self._project_image_counts(p['images'])
            p['num_images'] = total
            p['labeled_images'] = labeled
            p['unlabeled_images'] = unlabeled
            if p.get('project_type') == 'video':
                p['num_frames'] = total
            return p
        status_map = self._status_map(p)

        images: list[dict[str, Any]] = []
        labeled = 0
        for img in p.get('images', []):
            item = dict(img)
            image_id = str(item.get('id') or '')
            st = status_map.get(image_id, 'unlabeled')
            item['status'] = st
            if st == 'labeled':
                labeled += 1
            images.append(item)

        p['images'] = images
        p['num_images'] = len(images)
        p['labeled_images'] = labeled
        p['unlabeled_images'] = max(0, len(images) - labeled)
        return p

    @staticmethod
    def _cached_stats_ready(project: dict[str, Any]) -> bool:
        images = project.get('images', []) if isinstance(project.get('images', []), list) else []
        try:
            num_images = int(project.get('num_images', -1))
            labeled_images = int(project.get('labeled_images', -1))
            unlabeled_images = int(project.get('unlabeled_images', -1))
        except Exception:
            return False
        if str(project.get('image_store') or '').strip().lower() == 'sqlite' and not images:
            if num_images < 0 or labeled_images < 0 or unlabeled_images < 0:
                return False
            return labeled_images + unlabeled_images == num_images
        if num_images != len(images):
            return False
        labeled = 0
        unlabeled = 0
        for img in images:
            if not isinstance(img, dict):
                return False
            st = str(img.get('status') or '').strip().lower()
            if st == 'labeled':
                labeled += 1
            elif st == 'unlabeled':
                unlabeled += 1
            else:
                return False
        return labeled_images == labeled and unlabeled_images == unlabeled

    def _prepare_project_cached(self, project: dict[str, Any]) -> dict[str, Any]:
        p = self._normalize_project(project)
        if self._cached_stats_ready(p):
            return p
        return self._enrich_project(p)

    @staticmethod
    def _set_image_status(project: dict[str, Any], image_id: str, status: str) -> bool:
        images = project.get('images', []) if isinstance(project.get('images', []), list) else []
        for img in images:
            if not isinstance(img, dict):
                continue
            if str(img.get('id') or '') != str(image_id):
                continue
            img['status'] = str(status or 'unlabeled')
            return True
        return False

    @staticmethod
    def _recount_project(project: dict[str, Any]) -> None:
        images = project.get('images', []) if isinstance(project.get('images', []), list) else []
        labeled = 0
        normalized_images: list[dict[str, Any]] = []
        for img in images:
            if not isinstance(img, dict):
                continue
            item = dict(img)
            st = str(item.get('status') or 'unlabeled').strip().lower()
            if st != 'labeled':
                st = 'unlabeled'
            item['status'] = st
            if st == 'labeled':
                labeled += 1
            normalized_images.append(item)
        project['images'] = normalized_images
        project['num_images'] = len(normalized_images)
        project['labeled_images'] = labeled
        project['unlabeled_images'] = max(0, len(normalized_images) - labeled)

    def list_projects(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        projects = self._load_projects()
        changed = False
        normalized: list[dict[str, Any]] = []
        for raw in projects:
            p = self._normalize_project(raw)
            normalized.append(p)
            if p != raw:
                changed = True
            ep = self._prepare_project_cached(p)
            first_img = self._get_project_first_image_db(str(ep.get('id') or '')) or {}
            out.append(
                {
                    'id': ep['id'],
                    'name': ep['name'],
                    'project_type': ep.get('project_type', 'image'),
                    'image_dir': ep['image_dir'],
                    'video_path': ep.get('video_path', ''),
                    'video_name': ep.get('video_name', ''),
                    'save_dir': ep['save_dir'],
                    'classes': ep.get('classes', []),
                    'num_images': ep.get('num_images', 0),
                    'num_frames': ep.get('num_frames', 0),
                    'labeled_images': ep.get('labeled_images', 0),
                    'unlabeled_images': ep.get('unlabeled_images', 0),
                    'first_image_id': first_img.get('id', ''),
                    'first_image_rel_path': first_img.get('rel_path', ''),
                    'created_at': ep['created_at'],
                    'updated_at': ep['updated_at'],
                }
            )
        if changed:
            self._save_projects(normalized)
        return out

    def get_project(self, project_id: str, *, enrich: bool = True, include_images: bool = True) -> dict[str, Any] | None:
        projects = self._load_projects()
        changed = False
        normalized: list[dict[str, Any]] = []
        target: dict[str, Any] | None = None
        for raw in projects:
            p = self._normalize_project(raw)
            normalized.append(p)
            if p != raw:
                changed = True
            if p.get('id') == project_id:
                target = p
        if changed:
            self._save_projects(normalized)
        if not target:
            return None
        prepared = self._enrich_project(target) if enrich else self._prepare_project_cached(target)
        if include_images:
            prepared['images'] = self._load_project_images_db(str(prepared.get('id') or ''))
        else:
            prepared['images'] = []
        return prepared

    def get_project_images_page(
        self,
        project_id: str,
        *,
        offset: int = 0,
        limit: int = 200,
        image_id: str = '',
    ) -> tuple[list[dict[str, Any]], int, int, int, int]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')

        total = max(0, int(project.get('num_images', 0) or 0))
        safe_limit = max(1, min(int(limit or 200), 1000))
        safe_offset = max(0, min(int(offset or 0), max(0, total)))
        image_index = self._get_project_image_index_db(project_id, image_id) if str(image_id or '').strip() else -1
        items = self._load_project_images_page_db(project_id, offset=safe_offset, limit=safe_limit)
        return items, total, safe_offset, safe_limit, image_index

    def find_unlabeled_image(
        self,
        project_id: str,
        *,
        after_image_id: str = '',
        direction: str = 'next',
    ) -> tuple[dict[str, Any] | None, int]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')
        after_sort_index = -1
        if str(after_image_id or '').strip():
            after_sort_index = self._get_project_image_index_db(project_id, after_image_id)
        return self._get_project_unlabeled_image_db(project_id, after_sort_index=after_sort_index, direction=direction)

    def create_project(
        self,
        *,
        name: str,
        image_dir: str,
        save_dir: str | None,
        classes_text: str,
        project_type: str = 'image',
        video_path: str | None = None,
    ) -> dict[str, Any]:
        ptype = str(project_type or 'image').strip().lower()
        if ptype not in {'image', 'video'}:
            raise ValueError('project_type must be image or video')

        project_id = new_id('prj_')
        workspace_dir = ensure_dir(self.projects_root / project_id)
        ensure_dir(workspace_dir / 'cache')

        if save_dir:
            save_base_dir = Path(save_dir).expanduser().resolve()
            ensure_dir(save_base_dir)
            project_save_dir = ensure_dir(save_base_dir / project_id)
        else:
            save_base_dir = ensure_dir(workspace_dir / 'output_base')
            project_save_dir = ensure_dir(workspace_dir / 'output')

        annotation_dir = ensure_dir(project_save_dir / 'annotations')
        export_dir = ensure_dir(project_save_dir / 'exports')

        images: list[dict[str, Any]] = []
        resolved_image_dir = ''
        resolved_video_path = ''
        video_name = ''
        video_meta: dict[str, Any] = {}

        if ptype == 'image':
            image_root = Path(image_dir).expanduser().resolve()
            if not image_root.exists() or not image_root.is_dir():
                raise ValueError(f'image_dir does not exist: {image_root}')
            images = list_images_recursive(image_root)
            resolved_image_dir = str(image_root)
            if not images:
                raise ValueError('no images found in image_dir')
        else:
            raw_video = str(video_path or image_dir or '').strip()
            if not raw_video:
                raise ValueError('video_path is required for video project')
            video_candidate = Path(raw_video).expanduser().resolve()
            if video_candidate.exists() and video_candidate.is_dir():
                videos = list_video_files_recursive(video_candidate)
                if len(videos) != 1:
                    raise ValueError(f'video directory must contain exactly one video: {video_candidate}')
                video_candidate = videos[0]
            if not video_candidate.exists() or not video_candidate.is_file():
                raise ValueError(f'video_path does not exist: {video_candidate}')
            video_meta = probe_video_info(video_candidate)
            video_name = str(video_meta.get('video_name') or video_candidate.stem).strip() or video_candidate.stem
            frame_total = int(video_meta.get('num_frames') or 0)
            if frame_total <= 0:
                raise ValueError('video has no frames')
            resolved_video_path = str(video_candidate)
            resolved_image_dir = ''
            images = build_virtual_frames(video_name, frame_total)

        project = {
            'id': project_id,
            'name': name.strip() or project_id,
            'project_type': ptype,
            'image_dir': resolved_image_dir,
            'video_path': resolved_video_path,
            'video_name': video_name,
            'video_meta': video_meta,
            'save_base_dir': str(save_base_dir),
            'project_save_dir': str(project_save_dir),
            'save_dir': str(project_save_dir),
            'annotation_dir': str(annotation_dir),
            'export_dir': str(export_dir),
            'workspace_dir': str(workspace_dir.resolve()),
            'cache_dir': str((workspace_dir / 'cache').resolve()),
            'classes': parse_classes_text(classes_text),
            'images': [{**dict(img), 'status': 'unlabeled'} for img in images],
            'num_images': len(images),
            'labeled_images': 0,
            'unlabeled_images': len(images),
            'created_at': now_ts(),
            'updated_at': now_ts(),
            'locked': True,
        }
        project = self._normalize_project(project)

        projects = self._load_projects()
        projects.append(project)
        self._save_projects(projects)
        return self.get_project(project_id, enrich=False, include_images=False) or self._prepare_project_cached(project)

    def refresh_project_images(self, project_id: str) -> int:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            return 0
        if project.get('project_type') != 'image':
            return 0
        image_dir = Path(project['image_dir'])
        if not image_dir.exists():
            return 0
        images = list_images_recursive(image_dir)
        # Update DB
        self._replace_project_images_db(project_id, 'image', images)
        # Recount and save to projects.json
        full_p = self._enrich_project(project)
        projects = self._load_projects()
        for p in projects:
            if p.get('id') == project_id:
                p['num_images'] = full_p['num_images']
                p['labeled_images'] = full_p['labeled_images']
                p['unlabeled_images'] = full_p['unlabeled_images']
        self._save_projects(projects)
        return len(images)

    def add_classes(self, project_id: str, classes_text: str) -> dict[str, Any]:
        incoming = parse_classes_text(classes_text)
        if not incoming:
            raise ValueError('no class to add')

        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                existing = [str(x).strip() for x in p.get('classes', []) if str(x).strip()]
                seen = {norm_text(x) for x in existing}
                merged = list(existing)
                for c in incoming:
                    key = norm_text(c)
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    merged.append(c)
                p['classes'] = merged
                self._bump_content_rev(p)
                p['updated_at'] = now_ts()
                updated = p
            out.append(p)
        if not updated:
            raise ValueError('project not found')
        self._save_projects(out)
        return self._prepare_project_cached(updated)

    def refresh_project_images(self, project_id: str) -> tuple[dict[str, Any], int]:
        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        added = 0
        changed = False

        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                if str(p.get('project_type') or 'image').strip().lower() != 'image':
                    raise ValueError('only image project is supported')

                image_root = Path(str(p.get('image_dir') or '')).expanduser().resolve()
                if not image_root.exists() or not image_root.is_dir():
                    raise ValueError(f'image_dir does not exist: {image_root}')

                scanned = list_images_recursive(image_root)
                if not scanned:
                    raise ValueError('no images found in image_dir')

                existing = self._load_project_images_db(project_id)
                existing_by_rel: dict[str, dict[str, Any]] = {}
                for img in existing:
                    rel = str(img.get('rel_path') or '').strip()
                    if not rel:
                        continue
                    existing_by_rel[rel] = dict(img)
                pending_insert: list[dict[str, Any]] = []
                next_index = len(existing)
                for img in scanned:
                    rel = str(img.get('rel_path') or '').strip()
                    if not rel:
                        continue
                    if rel in existing_by_rel:
                        current = existing_by_rel.get(rel)
                        if current is not None and str(current.get('abs_path') or '') != str(img.get('abs_path') or ''):
                            self._update_project_image_abs_path_db(project_id, str(current.get('id') or ''), str(img.get('abs_path') or ''))
                            changed = True
                        continue
                    pending_insert.append({**dict(img), 'status': 'unlabeled', 'sort_index': next_index})
                    next_index += 1
                    added += 1
                    changed = True

                if changed:
                    self._insert_project_images_db(project_id, 'image', pending_insert, start_index=len(existing))
                    p['num_images'] = max(0, int(p.get('num_images', 0) or 0) + int(added))
                    p['unlabeled_images'] = max(0, int(p.get('unlabeled_images', 0) or 0) + int(added))
                    self._bump_content_rev(p)
                    p['updated_at'] = now_ts()
                updated = p
            out.append(p)

        if not updated:
            raise ValueError('project not found')

        if changed:
            self._save_projects(out)
        return self._prepare_project_cached(updated), added

    def delete_image(self, project_id: str, image_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        deleted_image = self._get_project_image_db(project_id, image_id)

        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                if str(p.get('project_type') or 'image').strip().lower() != 'image':
                    raise ValueError('only image project is supported')
                if deleted_image is None:
                    raise ValueError('image not found')
                was_labeled = self._normalize_image_status(deleted_image.get('status')) == 'labeled'
                p['num_images'] = max(0, int(p.get('num_images', 0) or 0) - 1)
                if was_labeled:
                    p['labeled_images'] = max(0, int(p.get('labeled_images', 0) or 0) - 1)
                else:
                    p['unlabeled_images'] = max(0, int(p.get('unlabeled_images', 0) or 0) - 1)
                p['unlabeled_images'] = max(0, int(p.get('num_images', 0) or 0) - int(p.get('labeled_images', 0) or 0))
                self._bump_content_rev(p)
                p['updated_at'] = now_ts()
                updated = p
            out.append(p)

        if not updated:
            raise ValueError('project not found')

        ann_path = self._annotation_path(updated, image_id)
        try:
            ann_path.unlink(missing_ok=True)
        except Exception:
            pass

        image_root = Path(str(updated.get('image_dir') or '')).expanduser().resolve()
        abs_path = Path(str(deleted_image.get('abs_path') or '')).expanduser().resolve()
        try:
            if abs_path.exists() and abs_path.is_file() and abs_path.is_relative_to(image_root):
                abs_path.unlink(missing_ok=True)
        except Exception:
            pass

        self._delete_project_image_db(project_id, image_id)
        self._save_projects(out)
        return self.get_project(project_id, enrich=False, include_images=False) or self._prepare_project_cached(updated), deleted_image

    @staticmethod
    def _unique_import_target(root: Path, rel_path: str) -> Path:
        rel_obj = Path(rel_path)
        target = (root / rel_obj).resolve()
        ensure_dir(target.parent)
        if not target.exists():
            return target

        stem = target.stem
        suffix = target.suffix
        idx = 1
        while True:
            candidate = target.with_name(f'{stem}_import{idx}{suffix}')
            if not candidate.exists():
                return candidate
            idx += 1

    def import_images_from_dir(self, project_id: str, source_dir: str) -> tuple[dict[str, Any], int, int]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')
        if str(project.get('project_type') or 'image').strip().lower() != 'image':
            raise ValueError('only image project is supported')

        image_root = Path(str(project.get('image_dir') or '')).expanduser().resolve()
        if not image_root.exists() or not image_root.is_dir():
            raise ValueError(f'image_dir does not exist: {image_root}')

        source_root = Path(str(source_dir or '')).expanduser().resolve()
        if not source_root.exists() or not source_root.is_dir():
            raise ValueError(f'source_dir does not exist: {source_root}')
        if source_root == image_root:
            raise ValueError('source_dir must be different from project image_dir')
        if source_root.is_relative_to(image_root) or image_root.is_relative_to(source_root):
            raise ValueError('source_dir must not overlap with project image_dir')

        scanned = list_images_recursive(source_root)
        if not scanned:
            raise ValueError('no images found in source_dir')

        copied = 0
        for img in scanned:
            rel = str(img.get('rel_path') or '').strip()
            abs_path = str(img.get('abs_path') or '').strip()
            if not rel or not abs_path:
                continue
            src = Path(abs_path).expanduser().resolve()
            if not src.exists() or not src.is_file():
                continue
            target = self._unique_import_target(image_root, rel)
            ensure_dir(target.parent)
            shutil.copy2(src, target)
            copied += 1

        refreshed, added = self.refresh_project_images(project_id)
        return refreshed, copied, added

    def delete_class(self, project_id: str, class_name: str) -> dict[str, Any]:
        target = norm_text(class_name)
        if not target:
            raise ValueError('class_name is empty')

        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        found = False
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                existing = [str(x).strip() for x in p.get('classes', []) if str(x).strip()]
                kept = []
                for c in existing:
                    if norm_text(c) == target:
                        found = True
                        continue
                    kept.append(c)
                p['classes'] = kept
                self._bump_content_rev(p)
                p['updated_at'] = now_ts()
                updated = p
            out.append(p)

        if not updated:
            raise ValueError('project not found')
        if not found:
            raise ValueError('class not found')

        self._save_projects(out)
        return self._prepare_project_cached(updated)

    # Backward compatibility: old "update classes" route now behaves as "add classes".
    def update_classes(self, project_id: str, classes_text: str) -> dict[str, Any]:
        return self.add_classes(project_id, classes_text)

    @staticmethod
    def _safe_rmtree(path: Path, source_path: Path) -> None:
        if not path.exists() or not path.is_dir():
            return
        path = path.resolve()
        source_path = source_path.resolve()
        if path == source_path:
            return
        if source_path.is_relative_to(path):
            return
        shutil.rmtree(path, ignore_errors=True)

    @staticmethod
    def _safe_unlink(path: Path, source_path: Path) -> None:
        if not path.exists() or not path.is_file():
            return
        rp = path.resolve()
        source_path = source_path.resolve()
        if rp == source_path or source_path.is_relative_to(rp.parent):
            return
        try:
            rp.unlink(missing_ok=True)
        except Exception:
            pass

    def delete_project(self, project_id: str) -> None:
        projects = self._load_projects()
        kept: list[dict[str, Any]] = []
        victim: dict[str, Any] | None = None
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                victim = p
            else:
                kept.append(p)
        if victim is None:
            raise ValueError('project not found')

        source_raw = victim.get('video_path') if victim.get('project_type') == 'video' else victim.get('image_dir')
        source_path = Path(str(source_raw or '.')).expanduser().resolve()
        annotation_dir = Path(victim['annotation_dir']).expanduser().resolve()
        export_dir = Path(victim['export_dir']).expanduser().resolve()
        workspace_dir = Path(victim['workspace_dir']).expanduser().resolve()
        project_save_dir = Path(victim['project_save_dir']).expanduser().resolve()
        ui_state_file = workspace_dir / 'ui_state.json'

        self._safe_rmtree(annotation_dir, source_path)
        self._safe_rmtree(export_dir, source_path)
        self._safe_unlink(ui_state_file, source_path)
        self._safe_rmtree(workspace_dir, source_path)

        if project_save_dir.exists() and project_save_dir.is_dir():
            try:
                if not any(project_save_dir.iterdir()):
                    project_save_dir.rmdir()
            except Exception:
                pass

        self._delete_project_images_db(project_id)
        self._save_projects(kept)

    def load_annotations(self, project_id: str, image_id: str) -> list[dict[str, Any]]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')
        path = self._annotation_path(project, image_id)
        data = read_json(path, [])
        return data if isinstance(data, list) else []

    def save_annotations(self, project_id: str, image_id: str, annotations: list[dict[str, Any]]) -> None:
        image = self._get_project_image_db(project_id, image_id)
        if image is None:
            raise ValueError('image not found')
        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        project: dict[str, Any] | None = None
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                path = self._annotation_path(p, image_id)
                was_labeled = self._normalize_image_status(image.get('status')) == 'labeled'
                p['updated_at'] = now_ts()
                now_labeled = bool(isinstance(annotations, list) and len(annotations) > 0)
                if was_labeled != now_labeled:
                    if now_labeled:
                        p['labeled_images'] = max(0, int(p.get('labeled_images', 0) or 0) + 1)
                    else:
                        p['labeled_images'] = max(0, int(p.get('labeled_images', 0) or 0) - 1)
                    total = max(0, int(p.get('num_images', 0) or 0))
                    p['unlabeled_images'] = max(0, total - int(p.get('labeled_images', 0) or 0))
                self._bump_content_rev(p)
                project = p
            out.append(p)
        if not project:
            raise ValueError('project not found')
        path = self._annotation_path(project, image_id)
        atomic_write_json(path, annotations)
        self._update_project_image_status_db(project_id, image_id, 'labeled' if annotations else 'unlabeled')
        self._save_projects(out)

    def find_image(self, project: dict[str, Any], image_id: str) -> dict[str, Any] | None:
        for img in project.get('images', []):
            if img.get('id') == image_id:
                return img
        project_id = str(project.get('id') or '').strip()
        if not project_id:
            return None
        return self._get_project_image_db(project_id, image_id)

    def all_annotations(self, project_id: str) -> dict[str, list[dict[str, Any]]]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')
        out: dict[str, list[dict[str, Any]]] = {}
        for image_id in self._iter_project_image_ids_db(project_id):
            out[image_id] = self.load_annotations(project_id, image_id)
        return out

    def video_job_state_path(self, project_id: str) -> Path:
        project = self.get_project(project_id, include_images=False)
        if not project:
            raise ValueError('project not found')
        if project.get('project_type') != 'video':
            raise ValueError('project is not video type')
        return Path(project['workspace_dir']) / 'video_job_state.json'

    def get_video_job_state(self, project_id: str) -> dict[str, Any]:
        with self._video_state_lock:
            try:
                path = self.video_job_state_path(project_id)
            except ValueError:
                return {}
            data = read_json(path, {})
            return data if isinstance(data, dict) else {}

    def set_video_job_state(self, project_id: str, state: dict[str, Any]) -> None:
        with self._video_state_lock:
            path = self.video_job_state_path(project_id)
            payload = state if isinstance(state, dict) else {}
            atomic_write_json(path, payload)

    def video_annotation_json_path(self, project_id: str) -> Path:
        project = self.get_project(project_id, include_images=False)
        if not project:
            raise ValueError('project not found')
        video_name = str(project.get('video_name') or 'video')
        return Path(project['project_save_dir']) / f'{video_name}_annotations.json'

    def get_ui_state(self, project_id: str | None = None) -> dict[str, Any]:
        if project_id:
            project = self.get_project(project_id, include_images=False)
            if not project:
                return {}
            path = Path(project['workspace_dir']) / 'ui_state.json'
            data = read_json(path, {})
            return data if isinstance(data, dict) else {}
        data = read_json(self.ui_state_global_file, {})
        return data if isinstance(data, dict) else {}

    def set_ui_state(self, *, state: dict[str, Any], project_id: str | None = None) -> None:
        payload = state if isinstance(state, dict) else {}
        if project_id:
            project = self.get_project(project_id, include_images=False)
            if not project:
                return
            path = Path(project['workspace_dir']) / 'ui_state.json'
            atomic_write_json(path, payload)
            return
        atomic_write_json(self.ui_state_global_file, payload)
