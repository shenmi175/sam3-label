from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Any

from app.repositories.annotation_index import AnnotationIndexRepository
from app.repositories.annotation_records import AnnotationRecordRepository
from app.repositories.project_catalog import ProjectCatalogRepository
from app.repositories.project_files import ProjectFileRepository
from app.repositories.project_images import ProjectImageRepository
from app.repositories.project_manifests import ProjectManifestRepository
from app.repositories.smart_filter_runs import SmartFilterRunRepository
from app.repositories.ui_state import UIStateRepository

try:
    import sqlite3
except Exception as exc:  # noqa: BLE001
    sqlite3 = None  # type: ignore[assignment]
    SQLITE_IMPORT_ERROR = exc
else:
    SQLITE_IMPORT_ERROR = None

from app.utils import (
    atomic_write_json,
    ensure_dir,
    list_images_recursive,
    new_id,
    norm_text,
    now_ts,
    parse_classes_text,
    read_json,
)


class Storage:
    PROJECT_MANIFEST_NAME = ProjectManifestRepository.MANIFEST_NAME
    PROJECT_MANIFEST_SCHEMA = ProjectManifestRepository.MANIFEST_SCHEMA

    def __init__(self, base_dir: Path):
        self.base_dir = ensure_dir(base_dir)
        self.projects_file = self.base_dir / 'projects.json'
        self.projects_root = ensure_dir(self.base_dir / 'projects')
        self.ui_state_global_file = self.base_dir / 'ui_state_global.json'
        self._project_catalog = ProjectCatalogRepository(projects_file=self.projects_file)
        self._db_lock = threading.RLock()
        self.index_db_file = self.base_dir / 'web_auto_index.sqlite3'
        self._init_index_db()
        self._project_images = ProjectImageRepository(db_connect=self._db_connect, db_lock=self._db_lock)
        self._annotation_index = AnnotationIndexRepository(db_connect=self._db_connect, db_lock=self._db_lock)
        self._annotation_records = AnnotationRecordRepository(db_connect=self._db_connect, db_lock=self._db_lock)
        self._project_manifests = ProjectManifestRepository(normalize_project=self._normalize_project)
        self._project_files = ProjectFileRepository(annotation_class_name=self._annotation_class_name)
        self._smart_filter_runs = SmartFilterRunRepository(
            db_connect=self._db_connect,
            db_lock=self._db_lock,
            save_annotations=self.save_annotations,
        )
        self._ui_state = UIStateRepository(
            global_state_file=self.ui_state_global_file,
            get_project=lambda project_id: self.get_project(project_id, include_images=False),
        )

    def _load_projects(self) -> list[dict[str, Any]]:
        return self._project_catalog.load()

    def _save_projects(self, projects: list[dict[str, Any]]) -> None:
        self._project_catalog.save(projects)

    def _project_manifest_payload(self, project: dict[str, Any]) -> dict[str, Any]:
        return self._project_manifests.payload(project)

    def _write_project_manifest(self, project: dict[str, Any]) -> None:
        self._project_manifests.write(project)

    def _read_project_manifest(self, manifest_path: Path) -> dict[str, Any] | None:
        return self._project_manifests.read(manifest_path)

    def _known_project_ids(self) -> set[str]:
        return self._project_catalog.known_ids()

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
                    CREATE INDEX IF NOT EXISTS idx_project_images_status_sort
                    ON project_images(project_id, status, sort_index);
                    CREATE TABLE IF NOT EXISTS annotation_ids (
                        project_id TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        annotation_id TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (project_id, annotation_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_annotation_ids_image
                    ON annotation_ids(project_id, image_id);
                    CREATE TABLE IF NOT EXISTS image_annotations (
                        project_id TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        annotations_json TEXT NOT NULL DEFAULT '[]',
                        annotation_count INTEGER NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (project_id, image_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_image_annotations_project
                    ON image_annotations(project_id, annotation_count);
                    CREATE TABLE IF NOT EXISTS image_annotation_stats (
                        project_id TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        annotation_count INTEGER NOT NULL DEFAULT 0,
                        total_area REAL NOT NULL DEFAULT 0,
                        avg_confidence REAL NOT NULL DEFAULT 0,
                        min_confidence REAL NOT NULL DEFAULT 0,
                        max_confidence REAL NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (project_id, image_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_image_annotation_stats_project
                    ON image_annotation_stats(project_id, annotation_count);
                    CREATE TABLE IF NOT EXISTS image_class_index (
                        project_id TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        class_name_norm TEXT NOT NULL,
                        class_name TEXT NOT NULL,
                        ann_count INTEGER NOT NULL DEFAULT 0,
                        total_area REAL NOT NULL DEFAULT 0,
                        avg_confidence REAL NOT NULL DEFAULT 0,
                        min_confidence REAL NOT NULL DEFAULT 0,
                        max_confidence REAL NOT NULL DEFAULT 0,
                        PRIMARY KEY (project_id, image_id, class_name_norm)
                    );
                    CREATE INDEX IF NOT EXISTS idx_image_class_index_class
                    ON image_class_index(project_id, class_name_norm, image_id);
                    CREATE INDEX IF NOT EXISTS idx_image_class_index_image
                    ON image_class_index(project_id, image_id);
                    CREATE TABLE IF NOT EXISTS smart_filter_runs (
                        run_id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL,
                        job_id TEXT NOT NULL DEFAULT '',
                        operation_mode TEXT NOT NULL DEFAULT '',
                        rule_json TEXT NOT NULL DEFAULT '{}',
                        summary_json TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL,
                        applied_at TEXT NOT NULL DEFAULT '',
                        undone_at TEXT NOT NULL DEFAULT ''
                    );
                    CREATE INDEX IF NOT EXISTS idx_smart_filter_runs_project
                    ON smart_filter_runs(project_id, created_at);
                    CREATE TABLE IF NOT EXISTS smart_filter_snapshots (
                        run_id TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        annotations_json TEXT NOT NULL,
                        PRIMARY KEY (run_id, image_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_smart_filter_snapshots_project
                    ON smart_filter_snapshots(project_id, run_id);
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
        return ProjectImageRepository.normalize_status(raw)

    @staticmethod
    def _annotation_class_name(ann: dict[str, Any]) -> str:
        return AnnotationIndexRepository.annotation_class_name(ann)

    @staticmethod
    def _annotation_score(ann: dict[str, Any]) -> float:
        return AnnotationIndexRepository.annotation_score(ann)

    @staticmethod
    def _annotation_area(ann: dict[str, Any]) -> float:
        return AnnotationIndexRepository.annotation_area(ann)

    @classmethod
    def _annotation_index_payload(cls, annotations: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return AnnotationIndexRepository.payload(annotations)

    def _replace_annotation_index_db(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
        *,
        conn: sqlite3.Connection | None = None,
        updated_at: str | None = None,
    ) -> None:
        self._annotation_index.replace(project_id, image_id, annotations, conn=conn, updated_at=updated_at)

    def _normalize_image_rows(self, project_type: str, images: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return ProjectImageRepository.normalize_rows(project_type, images)

    def _replace_project_images_db(self, project_id: str, project_type: str, images: list[dict[str, Any]]) -> None:
        self._project_images.replace(project_id, project_type, images)

    def _insert_project_images_db(self, project_id: str, project_type: str, images: list[dict[str, Any]], *, start_index: int) -> None:
        self._project_images.insert(project_id, project_type, images, start_index=start_index)

    def _update_project_image_abs_path_db(self, project_id: str, image_id: str, abs_path: str) -> None:
        self._project_images.update_abs_path(project_id, image_id, abs_path)

    def _update_project_image_status_db(
        self,
        project_id: str,
        image_id: str,
        status: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> bool:
        return self._project_images.update_status(project_id, image_id, status, conn=conn)

    def _delete_project_image_db(self, project_id: str, image_id: str) -> None:
        self._project_images.delete_one(project_id, image_id)

    def _delete_project_images_by_ids_db(self, project_id: str, image_ids: list[str]) -> None:
        self._project_images.delete_many(project_id, image_ids)

    def _delete_project_images_db(self, project_id: str) -> None:
        self._project_images.delete_project(project_id)

    @staticmethod
    def _json_dumps_db(value: Any) -> str:
        return AnnotationRecordRepository.json_dumps(value)

    @staticmethod
    def _json_loads_db(raw: Any, fallback: Any) -> Any:
        return AnnotationRecordRepository.json_loads(raw, fallback)

    def begin_smart_filter_run(
        self,
        *,
        project_id: str,
        job_id: str = '',
        operation_mode: str = '',
        rule: dict[str, Any] | None = None,
    ) -> str:
        return self._smart_filter_runs.begin(
            project_id=project_id,
            job_id=job_id,
            operation_mode=operation_mode,
            rule=rule,
        )

    def add_smart_filter_snapshot(
        self,
        *,
        run_id: str,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
    ) -> None:
        self._smart_filter_runs.add_snapshot(
            run_id=run_id,
            project_id=project_id,
            image_id=image_id,
            annotations=annotations,
        )

    def finish_smart_filter_run(self, *, run_id: str, summary: dict[str, Any] | None = None) -> None:
        self._smart_filter_runs.finish(run_id=run_id, summary=summary)

    def get_smart_filter_run(self, *, project_id: str, run_id: str) -> dict[str, Any] | None:
        return self._smart_filter_runs.get(project_id=project_id, run_id=run_id)

    def get_latest_smart_filter_run(self, *, project_id: str) -> dict[str, Any] | None:
        return self._smart_filter_runs.get_latest(project_id=project_id)

    def rollback_smart_filter_run(self, *, project_id: str, run_id: str) -> dict[str, Any]:
        return self._smart_filter_runs.rollback(project_id=project_id, run_id=run_id)

    def _registered_annotation_ids_db(self, project_id: str, *, exclude_image_id: str = '') -> set[str]:
        return self._annotation_records.registered_ids(project_id, exclude_image_id=exclude_image_id)

    def _registered_annotation_id_conflicts_db(
        self,
        project_id: str,
        annotation_ids: list[str],
        *,
        exclude_image_id: str = '',
    ) -> set[str]:
        return self._annotation_records.registered_id_conflicts(
            project_id,
            annotation_ids,
            exclude_image_id=exclude_image_id,
        )

    def _replace_annotation_ids_db(
        self,
        project_id: str,
        image_id: str,
        annotation_ids: list[str],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        self._annotation_records.replace_ids(project_id, image_id, annotation_ids, conn=conn)

    def _load_annotations_db(self, project_id: str, image_id: str) -> list[dict[str, Any]] | None:
        return self._annotation_records.load(project_id, image_id)

    def _replace_annotations_db(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
        *,
        conn: sqlite3.Connection | None = None,
        updated_at: str | None = None,
    ) -> None:
        self._annotation_records.replace(project_id, image_id, annotations, conn=conn, updated_at=updated_at)

    @staticmethod
    def _looks_like_model_detection_id(raw: str) -> bool:
        return AnnotationRecordRepository.looks_like_model_detection_id(raw)

    def _normalize_annotation_ids(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return self._annotation_records.normalize_ids(project_id, image_id, annotations)

    def _normalize_annotation_ids_with_used_set(
        self,
        annotations: list[dict[str, Any]],
        project_used: set[str],
    ) -> list[dict[str, Any]]:
        return self._annotation_records.normalize_ids_with_used_set(annotations, project_used)

    @staticmethod
    def _db_row_to_image(row: sqlite3.Row) -> dict[str, Any]:
        return ProjectImageRepository.row_to_image(row)

    def _load_project_images_db(self, project_id: str) -> list[dict[str, Any]]:
        return self._project_images.load_all(project_id)

    def _project_images_filter_query(
        self,
        project_id: str,
        *,
        status: str = '',
        class_name: str = '',
    ) -> tuple[str, list[Any], str]:
        return ProjectImageRepository.filter_query(project_id, status=status, class_name=class_name)

    def _count_project_images_db(self, project_id: str, *, status: str = '', class_name: str = '') -> int:
        return self._project_images.count(project_id, status=status, class_name=class_name)

    def _get_project_image_filtered_index_db(
        self,
        project_id: str,
        image_id: str,
        *,
        status: str = '',
        class_name: str = '',
    ) -> int:
        return self._project_images.filtered_index(
            project_id,
            image_id,
            status=status,
            class_name=class_name,
        )

    def _load_project_images_page_db(
        self,
        project_id: str,
        *,
        offset: int,
        limit: int,
        status: str = '',
        class_name: str = '',
    ) -> list[dict[str, Any]]:
        return self._project_images.page(
            project_id,
            offset=offset,
            limit=limit,
            status=status,
            class_name=class_name,
        )

    def _load_project_images_by_ids_db(self, project_id: str, image_ids: list[str]) -> list[dict[str, Any]]:
        return self._project_images.by_ids(project_id, image_ids)

    def _load_project_images_filtered_list_db(
        self,
        project_id: str,
        *,
        status: str = '',
    ) -> list[dict[str, Any]]:
        return self._project_images.filtered_list(project_id, status=status)

    def _load_project_images_with_any_classes_db(
        self,
        project_id: str,
        class_names: list[str],
    ) -> list[dict[str, Any]]:
        return self._project_images.with_any_classes(project_id, class_names)

    def _load_project_images_without_any_classes_db(
        self,
        project_id: str,
        class_names: list[str],
    ) -> list[dict[str, Any]]:
        return self._project_images.without_any_classes(project_id, class_names)

    def _get_project_image_db(self, project_id: str, image_id: str) -> dict[str, Any] | None:
        return self._project_images.get(project_id, image_id)

    def _get_project_image_index_db(self, project_id: str, image_id: str) -> int:
        return self._project_images.index(project_id, image_id)

    def _get_project_first_image_db(self, project_id: str) -> dict[str, Any] | None:
        return self._project_images.first(project_id)

    def _get_project_unlabeled_image_db(
        self,
        project_id: str,
        *,
        after_sort_index: int = -1,
        direction: str = 'next',
    ) -> tuple[dict[str, Any] | None, int]:
        return self._project_images.unlabeled(
            project_id,
            after_sort_index=after_sort_index,
            direction=direction,
        )

    def _iter_project_image_ids_db(self, project_id: str) -> list[str]:
        return self._project_images.iter_ids(project_id)

    def _project_image_counts(self, images: list[dict[str, Any]]) -> tuple[int, int, int]:
        return ProjectImageRepository.counts(images)

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

        raw_project_type = str(q.get('project_type') or '').strip().lower()
        project_type = raw_project_type or 'image'
        if project_type not in {'image', 'pose'}:
            project_type = 'unsupported'

        image_dir = self._safe_resolve(str(q.get('image_dir') or ''))

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
            normalized_images.append(item)

        q['id'] = pid
        q['name'] = str(q.get('name') or pid)
        q['project_type'] = project_type
        q['image_dir'] = image_dir
        q['save_base_dir'] = save_base_dir
        q['project_save_dir'] = project_save_dir
        q['save_dir'] = project_save_dir
        q['annotation_dir'] = annotation_dir
        q['export_dir'] = export_dir
        q['workspace_dir'] = str(workspace_dir.resolve())
        q['cache_dir'] = str(ensure_dir(workspace_dir / 'cache').resolve())
        q['classes'] = q.get('classes', []) if isinstance(q.get('classes', []), list) else []
        q = self._ensure_project_images_sqlite(q, normalized_images)
        q['content_rev'] = self._content_rev(q)
        q['created_at'] = str(q.get('created_at') or now_ts())
        q['updated_at'] = str(q.get('updated_at') or now_ts())
        q['locked'] = True
        return q

    def _annotation_path(self, project: dict[str, Any], image_id: str) -> Path:
        return self._project_files.annotation_path(project, image_id)

    def _annotation_has_items(self, path: Path) -> bool:
        return self._project_files.annotation_has_items(path)

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

    def _annotation_json_count(self, annotation_dir: Path) -> int:
        return self._project_files.annotation_json_count(annotation_dir)

    def _legacy_annotation_dir(self, project_dir: Path) -> Path | None:
        return self._project_files.legacy_annotation_dir(project_dir)

    def _existing_project_save_dir(self, project_dir: Path, base: dict[str, Any]) -> Path:
        return self._project_files.existing_project_save_dir(project_dir, base)

    def _infer_classes_from_annotations(self, annotation_dir: Path, *, max_files: int = 2000) -> list[str]:
        return self._project_files.infer_classes_from_annotations(annotation_dir, max_files=max_files)

    def _project_candidate_dirs(self, roots: list[Path], *, max_depth: int = 3) -> list[Path]:
        candidates: list[Path] = []
        seen: set[str] = set()

        def add_candidate(path: Path) -> None:
            key = str(path)
            if key in seen:
                return
            seen.add(key)
            candidates.append(path)

        def walk(path: Path, depth: int) -> None:
            try:
                current = path.expanduser().resolve()
            except Exception:
                return
            if not current.exists() or not current.is_dir():
                return

            has_manifest = (current / self.PROJECT_MANIFEST_NAME).is_file()
            has_legacy_annotations = current.name.startswith('prj_') and self._legacy_annotation_dir(current) is not None
            if has_manifest or has_legacy_annotations:
                add_candidate(current)

            if depth <= 0:
                return
            try:
                children = list(current.iterdir())
            except OSError:
                return
            for child in children:
                if not child.is_dir():
                    continue
                if child.name.startswith('.') or child.name in {'annotations', 'exports', 'cache', '__pycache__'}:
                    continue
                walk(child, depth - 1)

        for root in roots:
            walk(root, max_depth)
        return candidates

    def discover_existing_projects(self, roots: list[Path], *, max_depth: int = 3) -> list[dict[str, Any]]:
        known = self._known_project_ids()
        out: list[dict[str, Any]] = []
        for project_dir in self._project_candidate_dirs(roots, max_depth=max_depth):
            manifest_path = project_dir / self.PROJECT_MANIFEST_NAME
            if manifest_path.is_file():
                manifest = self._read_project_manifest(manifest_path)
                if not manifest:
                    continue
                project = manifest.get('project', {})
                project_id = str(project.get('id') or '').strip()
                ptype = str(project.get('project_type') or 'image').strip().lower()
                if ptype not in {'image', 'pose'}:
                    continue
                out.append(
                    {
                        'kind': 'manifest',
                        'project_id': project_id,
                        'name': str(project.get('name') or project_id),
                        'project_type': ptype if ptype in {'image', 'pose'} else 'image',
                        'image_dir': str(project.get('image_dir') or ''),
                        'output_dir': str(project_dir),
                        'manifest_path': str(manifest_path),
                        'annotation_count': self._annotation_json_count(self._existing_project_save_dir(project_dir, project) / 'annotations'),
                        'imported': project_id in known,
                        'requires_image_dir': False,
                    }
                )
                continue

            project_id = project_dir.name if project_dir.name.startswith('prj_') else ''
            if not project_id:
                continue
            legacy_annotation_dir = self._legacy_annotation_dir(project_dir) or (project_dir / 'annotations')
            out.append(
                {
                    'kind': 'legacy',
                    'project_id': project_id,
                    'name': project_id,
                    'project_type': 'image',
                    'image_dir': '',
                    'output_dir': str(project_dir),
                    'manifest_path': '',
                    'annotation_count': self._annotation_json_count(legacy_annotation_dir),
                    'imported': project_id in known,
                    'requires_image_dir': True,
                }
            )
        out.sort(key=lambda item: (bool(item.get('imported')), str(item.get('name') or ''), str(item.get('output_dir') or '')))
        return out

    def auto_import_manifests(self, roots: list[Path], *, max_depth: int = 3) -> dict[str, Any]:
        imported: list[str] = []
        skipped = 0
        errors: list[dict[str, str]] = []
        known = self._known_project_ids()
        for project_dir in self._project_candidate_dirs(roots, max_depth=max_depth):
            manifest_path = project_dir / self.PROJECT_MANIFEST_NAME
            if not manifest_path.is_file():
                continue
            manifest = self._read_project_manifest(manifest_path)
            project = manifest.get('project', {}) if isinstance(manifest, dict) else {}
            ptype = str(project.get('project_type') or 'image').strip().lower() if isinstance(project, dict) else 'image'
            if ptype not in {'image', 'pose'}:
                skipped += 1
                continue
            project_id = str(project.get('id') or '').strip() if isinstance(project, dict) else ''
            if not project_id or project_id in known:
                skipped += 1
                continue
            try:
                result = self.import_existing_project(manifest_path=str(manifest_path))
                imported_id = str((result.get('project') or {}).get('id') or project_id)
                imported.append(imported_id)
                known.add(imported_id)
            except Exception as exc:  # noqa: BLE001
                errors.append({'manifest_path': str(manifest_path), 'error': str(exc)})
        return {'imported': imported, 'skipped': skipped, 'errors': errors}

    def import_existing_project(
        self,
        *,
        output_dir: str = '',
        manifest_path: str = '',
        image_dir: str = '',
        name: str = '',
        classes_text: str = '',
        project_type: str = '',
    ) -> dict[str, Any]:
        manifest: dict[str, Any] | None = None
        manifest_file: Path | None = None
        if str(manifest_path or '').strip():
            manifest_file = Path(manifest_path).expanduser().resolve()
            manifest = self._read_project_manifest(manifest_file)
            if not manifest:
                raise ValueError(f'invalid project manifest: {manifest_file}')
            project_output_dir = manifest_file.parent
        else:
            if not str(output_dir or '').strip():
                raise ValueError('output_dir is required')
            project_output_dir = Path(output_dir).expanduser().resolve()
            candidate_manifest = project_output_dir / self.PROJECT_MANIFEST_NAME
            if candidate_manifest.is_file():
                manifest_file = candidate_manifest
                manifest = self._read_project_manifest(candidate_manifest)

        base = manifest.get('project', {}) if isinstance(manifest, dict) and isinstance(manifest.get('project'), dict) else {}
        project_output_dir = project_output_dir.expanduser().resolve()
        if not project_output_dir.exists() or not project_output_dir.is_dir():
            raise ValueError(f'output_dir does not exist: {project_output_dir}')
        project_save_dir = ensure_dir(self._existing_project_save_dir(project_output_dir, base))
        annotation_dir = ensure_dir(project_save_dir / 'annotations')
        export_dir = ensure_dir(project_save_dir / 'exports')

        project_id = str(base.get('id') or '').strip()
        if not project_id:
            project_id = project_output_dir.name if project_output_dir.name.startswith('prj_') else new_id('prj_')

        ptype = str(project_type or base.get('project_type') or 'image').strip().lower()
        if ptype not in {'image', 'pose'}:
            raise ValueError('unsupported project type; supported project types: image, pose')

        classes = parse_classes_text(classes_text)
        if not classes:
            raw_classes = base.get('classes', [])
            classes = [str(item).strip() for item in raw_classes if str(item).strip()] if isinstance(raw_classes, list) else []
        if not classes:
            classes = self._infer_classes_from_annotations(annotation_dir)

        resolved_image_dir = ''
        images: list[dict[str, Any]] = []

        raw_image_dir = str(image_dir or base.get('image_dir') or '').strip()
        if not raw_image_dir:
            raise ValueError('image_dir is required for legacy project import')
        image_root = Path(raw_image_dir).expanduser().resolve()
        if not image_root.exists() or not image_root.is_dir():
            raise ValueError(f'image_dir does not exist: {image_root}')
        images = list_images_recursive(image_root)
        if not images:
            raise ValueError('no images found in image_dir')
        for img in images:
            image_id = str(img.get('id') or '')
            img['status'] = 'labeled' if self._annotation_has_items(annotation_dir / f'{image_id}.json') else 'unlabeled'
        resolved_image_dir = str(image_root)

        total = len(images)
        labeled = sum(1 for img in images if self._normalize_image_status(img.get('status')) == 'labeled')
        ts = now_ts()
        project = {
            'id': project_id,
            'name': str(name or base.get('name') or project_id).strip() or project_id,
            'project_type': ptype,
            'image_dir': resolved_image_dir,
            'save_base_dir': str(project_save_dir.parent),
            'project_save_dir': str(project_save_dir),
            'save_dir': str(project_save_dir),
            'annotation_dir': str(annotation_dir),
            'export_dir': str(export_dir),
            'workspace_dir': str((self.projects_root / project_id).resolve()),
            'cache_dir': str(ensure_dir(self.projects_root / project_id / 'cache').resolve()),
            'classes': classes,
            'images': images,
            'num_images': total,
            'labeled_images': labeled,
            'unlabeled_images': max(0, total - labeled),
            'created_at': str(base.get('created_at') or ts),
            'updated_at': ts,
            'locked': True,
        }
        project = self._normalize_project(project)

        projects = self._load_projects()
        replaced = False
        out: list[dict[str, Any]] = []
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                out.append(project)
                replaced = True
            else:
                out.append(p)
        if not replaced:
            out.append(project)
        self._save_projects(out)
        rebuild = self.rebuild_annotation_index(project_id)
        project = self.get_project(project_id, enrich=False, include_images=False) or project
        self._write_project_manifest(project)
        return {
            'project': project,
            'imported': not replaced,
            'updated_existing': replaced,
            'manifest_path': str(manifest_file or (project_output_dir / self.PROJECT_MANIFEST_NAME)),
            'rebuild': rebuild,
        }

    def list_projects(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        projects = self._load_projects()
        changed = False
        normalized: list[dict[str, Any]] = []
        for raw in projects:
            p = self._normalize_project(raw)
            ep = self._prepare_project_cached(p)
            normalized.append(ep)
            if ep != raw:
                changed = True
            if str(ep.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
                continue
            out.append(
                {
                    'id': ep['id'],
                    'name': ep['name'],
                    'project_type': ep.get('project_type', 'image'),
                    'image_dir': ep['image_dir'],
                    'save_dir': ep['save_dir'],
                    'classes': ep.get('classes', []),
                    'num_images': ep.get('num_images', 0),
                    'labeled_images': ep.get('labeled_images', 0),
                    'unlabeled_images': ep.get('unlabeled_images', 0),
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
        status: str = '',
        class_name: str = '',
    ) -> tuple[list[dict[str, Any]], int, int, int, int]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')

        has_filter = bool(str(status or '').strip()) or bool(norm_text(class_name))
        total = self._count_project_images_db(project_id, status=status, class_name=class_name) if has_filter else max(0, int(project.get('num_images', 0) or 0))
        safe_limit = max(1, min(int(limit or 200), 1000))
        safe_offset = max(0, min(int(offset or 0), max(0, total)))
        image_index = self._get_project_image_filtered_index_db(
            project_id,
            image_id,
            status=status,
            class_name=class_name,
        ) if str(image_id or '').strip() else -1
        items = self._load_project_images_page_db(
            project_id,
            offset=safe_offset,
            limit=safe_limit,
            status=status,
            class_name=class_name,
        )
        return items, total, safe_offset, safe_limit, image_index

    def get_project_images_for_infer_scope(
        self,
        project_id: str,
        *,
        scope_mode: str = 'all',
        image_ids: list[str] | None = None,
        related_classes: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')

        ids = [str(item).strip() for item in (image_ids or []) if str(item).strip()]
        if ids:
            return self._load_project_images_by_ids_db(project_id, ids)

        scope = str(scope_mode or 'all').strip().lower()
        if scope == 'unlabeled':
            return self._load_project_images_filtered_list_db(project_id, status='unlabeled')
        if scope == 'class_related':
            return self._load_project_images_with_any_classes_db(project_id, related_classes or [])
        if scope == 'class_related_unlabeled':
            return self._load_project_images_without_any_classes_db(project_id, related_classes or [])
        return self._load_project_images_filtered_list_db(project_id)

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

    def rebuild_annotation_index(self, project_id: str) -> dict[str, Any]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')

        image_ids = self._iter_project_image_ids_db(project_id)
        indexed_images = 0
        labeled_images = 0
        annotation_count = 0
        ts = now_ts()

        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM image_annotations WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM annotation_ids WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_annotation_stats WHERE project_id = ?', (str(project_id),))
                conn.execute('DELETE FROM image_class_index WHERE project_id = ?', (str(project_id),))
                used_annotation_ids: set[str] = set()
                for image_id in image_ids:
                    data = read_json(self._annotation_path(project, image_id), [])
                    raw_annotations = data if isinstance(data, list) else []
                    annotations = self._normalize_annotation_ids_with_used_set(raw_annotations, used_annotation_ids)
                    self._replace_annotations_db(project_id, image_id, annotations, conn=conn, updated_at=ts)
                    self._replace_annotation_ids_db(
                        project_id,
                        image_id,
                        [str(item.get('id') or '').strip() for item in annotations if isinstance(item, dict)],
                        conn=conn,
                    )
                    self._replace_annotation_index_db(project_id, image_id, annotations, conn=conn, updated_at=ts)
                    status = 'labeled' if annotations else 'unlabeled'
                    self._update_project_image_status_db(project_id, image_id, status, conn=conn)
                    indexed_images += 1
                    if annotations:
                        labeled_images += 1
                        annotation_count += len(annotations)
                conn.commit()
            finally:
                conn.close()

        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                p['labeled_images'] = labeled_images
                p['unlabeled_images'] = max(0, int(p.get('num_images', len(image_ids)) or len(image_ids)) - labeled_images)
                p['updated_at'] = ts
                self._bump_content_rev(p)
            out.append(p)
        self._save_projects(out)
        for p in out:
            if p.get('id') == project_id:
                self._write_project_manifest(p)
                break

        return {
            'project_id': project_id,
            'indexed_images': indexed_images,
            'annotation_store_images': indexed_images,
            'labeled_images': labeled_images,
            'unlabeled_images': max(0, len(image_ids) - labeled_images),
            'annotation_count': annotation_count,
            'rebuilt_at': ts,
        }

    def get_annotation_dashboard(self, project_id: str) -> dict[str, Any]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')

        total_images = max(0, int(project.get('num_images', 0) or 0))
        labeled_images = max(0, int(project.get('labeled_images', 0) or 0))
        unlabeled_images = max(0, int(project.get('unlabeled_images', 0) or 0))
        return self._annotation_index.dashboard(
            project_id,
            total_images=total_images,
            labeled_images=labeled_images,
            unlabeled_images=unlabeled_images,
        )

    def create_project(
        self,
        *,
        name: str,
        image_dir: str,
        save_dir: str | None,
        classes_text: str,
        project_type: str = 'image',
    ) -> dict[str, Any]:
        ptype = str(project_type or 'image').strip().lower()
        if ptype not in {'image', 'pose'}:
            raise ValueError('unsupported project type; supported project types: image, pose')

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
        image_root = Path(image_dir).expanduser().resolve()
        if not image_root.exists() or not image_root.is_dir():
            raise ValueError(f'image_dir does not exist: {image_root}')
        images = list_images_recursive(image_root)
        resolved_image_dir = str(image_root)
        if not images:
            raise ValueError('no images found in image_dir')

        project = {
            'id': project_id,
            'name': name.strip() or project_id,
            'project_type': ptype,
            'image_dir': resolved_image_dir,
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
        self._write_project_manifest(project)
        return self.get_project(project_id, enrich=False, include_images=False) or self._prepare_project_cached(project)

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
        self._write_project_manifest(updated)
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
                if str(p.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
                    raise ValueError('only image or pose project is supported')

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
                    self._insert_project_images_db(project_id, str(p.get('project_type') or 'image'), pending_insert, start_index=len(existing))
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
        self._write_project_manifest(updated)
        return self._prepare_project_cached(updated), added

    def delete_image(self, project_id: str, image_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        deleted_image = self._get_project_image_db(project_id, image_id)

        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                if str(p.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
                    raise ValueError('only image or pose project is supported')
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
        self._write_project_manifest(updated)
        return self.get_project(project_id, enrich=False, include_images=False) or self._prepare_project_cached(updated), deleted_image

    def delete_project_images(self, project_id: str, image_ids: list[str]) -> dict[str, Any]:
        requested_ids = list(dict.fromkeys(str(item).strip() for item in image_ids if str(item).strip()))
        if not requested_ids:
            project = self.get_project(project_id, enrich=False, include_images=False)
            if not project:
                raise ValueError('project not found')
            return {
                'project': project,
                'deleted_images': 0,
                'deleted_annotation_files': 0,
                'deleted_image_files': 0,
                'failed_deletes': [],
                'items': [],
            }

        images = self._load_project_images_by_ids_db(project_id, requested_ids)
        images_by_id = {str(img.get('id') or ''): img for img in images if str(img.get('id') or '').strip()}
        delete_ids = [image_id for image_id in requested_ids if image_id in images_by_id]
        if not delete_ids:
            project = self.get_project(project_id, enrich=False, include_images=False)
            if not project:
                raise ValueError('project not found')
            return {
                'project': project,
                'deleted_images': 0,
                'deleted_annotation_files': 0,
                'deleted_image_files': 0,
                'failed_deletes': [],
                'items': [],
            }

        projects = self._load_projects()
        out: list[dict[str, Any]] = []
        updated: dict[str, Any] | None = None
        for raw in projects:
            p = self._normalize_project(raw)
            if p.get('id') == project_id:
                if str(p.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
                    raise ValueError('only image or pose project is supported')
                deleted_labeled = sum(
                    1
                    for image_id in delete_ids
                    if self._normalize_image_status(images_by_id[image_id].get('status')) == 'labeled'
                )
                current_total = max(0, int(p.get('num_images', 0) or 0))
                current_labeled = max(0, int(p.get('labeled_images', 0) or 0))
                p['num_images'] = max(0, current_total - len(delete_ids))
                p['labeled_images'] = max(0, current_labeled - deleted_labeled)
                p['unlabeled_images'] = max(0, int(p.get('num_images', 0) or 0) - int(p.get('labeled_images', 0) or 0))
                self._bump_content_rev(p)
                p['updated_at'] = now_ts()
                updated = p
            out.append(p)

        if not updated:
            raise ValueError('project not found')

        deleted_annotation_files = 0
        deleted_image_files = 0
        failed_deletes: list[dict[str, str]] = []
        items: list[dict[str, Any]] = []
        image_root = Path(str(updated.get('image_dir') or '')).expanduser().resolve()

        for image_id in delete_ids:
            image = images_by_id[image_id]
            rel_path = str(image.get('rel_path') or image_id)
            ann_path = self._annotation_path(updated, image_id)
            image_file_deleted = False
            annotation_file_deleted = False

            try:
                if ann_path.exists():
                    ann_path.unlink(missing_ok=True)
                    deleted_annotation_files += 1
                    annotation_file_deleted = True
            except Exception as exc:  # noqa: BLE001
                failed_deletes.append(
                    {
                        'image_id': image_id,
                        'rel_path': rel_path,
                        'kind': 'annotation',
                        'path': str(ann_path),
                        'error': str(exc),
                    }
                )

            raw_abs_path = str(image.get('abs_path') or '').strip()
            if raw_abs_path:
                try:
                    abs_path = Path(raw_abs_path).expanduser().resolve()
                    if abs_path.exists() and abs_path.is_file():
                        if abs_path.is_relative_to(image_root):
                            abs_path.unlink(missing_ok=True)
                            deleted_image_files += 1
                            image_file_deleted = True
                        else:
                            failed_deletes.append(
                                {
                                    'image_id': image_id,
                                    'rel_path': rel_path,
                                    'kind': 'image',
                                    'path': str(abs_path),
                                    'error': 'image path is outside project image_dir',
                                }
                            )
                except Exception as exc:  # noqa: BLE001
                    failed_deletes.append(
                        {
                            'image_id': image_id,
                            'rel_path': rel_path,
                            'kind': 'image',
                            'path': raw_abs_path,
                            'error': str(exc),
                        }
                    )

            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'deleted_image_file': image_file_deleted,
                    'deleted_annotation_file': annotation_file_deleted,
                }
            )

        self._delete_project_images_by_ids_db(project_id, delete_ids)
        self._save_projects(out)
        self._write_project_manifest(updated)
        project = self.get_project(project_id, enrich=False, include_images=False) or self._prepare_project_cached(updated)
        return {
            'project': project,
            'deleted_images': len(delete_ids),
            'deleted_annotation_files': deleted_annotation_files,
            'deleted_image_files': deleted_image_files,
            'failed_deletes': failed_deletes,
            'items': items,
        }

    def _unique_import_target(self, root: Path, rel_path: str) -> Path:
        return self._project_files.unique_import_target(root, rel_path)

    def import_images_from_dir(self, project_id: str, source_dir: str) -> tuple[dict[str, Any], int, int]:
        project = self.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise ValueError('project not found')
        if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
            raise ValueError('only image or pose project is supported')

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
        self._write_project_manifest(updated)
        return self._prepare_project_cached(updated)

    # Backward compatibility: old "update classes" route now behaves as "add classes".
    def update_classes(self, project_id: str, classes_text: str) -> dict[str, Any]:
        return self.add_classes(project_id, classes_text)

    def _safe_rmtree(self, path: Path, source_path: Path) -> None:
        self._project_files.safe_rmtree(path, source_path)

    def _safe_unlink(self, path: Path, source_path: Path) -> None:
        self._project_files.safe_unlink(path, source_path)

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

        source_raw = victim.get('image_dir')
        source_path = Path(str(source_raw or '.')).expanduser().resolve()
        annotation_dir = Path(victim['annotation_dir']).expanduser().resolve()
        export_dir = Path(victim['export_dir']).expanduser().resolve()
        workspace_dir = Path(victim['workspace_dir']).expanduser().resolve()
        project_save_dir = Path(victim['project_save_dir']).expanduser().resolve()
        ui_state_file = workspace_dir / 'ui_state.json'
        manifest_file = project_save_dir / self.PROJECT_MANIFEST_NAME
        workspace_manifest_file = workspace_dir / self.PROJECT_MANIFEST_NAME

        self._safe_rmtree(annotation_dir, source_path)
        self._safe_rmtree(export_dir, source_path)
        self._safe_unlink(ui_state_file, source_path)
        self._safe_unlink(manifest_file, source_path)
        self._safe_unlink(workspace_manifest_file, source_path)
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
        annotations_db = self._load_annotations_db(project_id, image_id)
        if annotations_db is not None:
            return annotations_db
        path = self._annotation_path(project, image_id)
        data = read_json(path, [])
        annotations = data if isinstance(data, list) else []
        return self._normalize_annotation_ids(project_id, image_id, annotations)

    def save_annotations(self, project_id: str, image_id: str, annotations: list[dict[str, Any]]) -> None:
        image = self._get_project_image_db(project_id, image_id)
        if image is None:
            raise ValueError('image not found')
        annotations = self._normalize_annotation_ids(project_id, image_id, annotations)
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
        self._replace_annotations_db(project_id, image_id, annotations)
        self._replace_annotation_ids_db(
            project_id,
            image_id,
            [str(item.get('id') or '').strip() for item in annotations if isinstance(item, dict)],
        )
        self._replace_annotation_index_db(project_id, image_id, annotations)
        self._update_project_image_status_db(project_id, image_id, 'labeled' if annotations else 'unlabeled')
        self._save_projects(out)
        self._write_project_manifest(project)

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

    def get_ui_state(self, project_id: str | None = None) -> dict[str, Any]:
        return self._ui_state.get(project_id)

    def set_ui_state(self, *, state: dict[str, Any], project_id: str | None = None) -> None:
        self._ui_state.set(state=state, project_id=project_id)
