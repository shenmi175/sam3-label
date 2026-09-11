from __future__ import annotations

import json
from pathlib import Path
from threading import RLock
from typing import Any, Callable

from PIL import Image

from app.annotations import ParseContext, normalize_source, parse_image_annotations
from app.utils import new_id, norm_text, now_ts


ANALYTICS_INDEX_VERSION = 4
DENSITY_BUCKETS = (
    ('0', 0, 0),
    ('1', 1, 1),
    ('2', 2, 2),
    ('3-5', 3, 5),
    ('6-10', 6, 10),
    ('11-20', 11, 20),
    ('>20', 21, None),
)
BBOX_AREA_EDGES = (0.0, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0)
GEOMETRY_TYPES = ('bbox_only', 'polygon', 'multi_polygon', 'mask', 'invalid')
TASK_TYPES = ('detection', 'instance_segmentation')
KNOWN_SOURCE_MODELS = ('sam3', 'locate-anything', 'unknown')
ASPECT_RATIO_BUCKETS = ('<0.25', '0.25-0.5', '0.5-1', '1-2', '2-4', '>4')


def build_analytics_rows(
    image_id: str,
    image_path: str,
    annotations: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Project canonical annotations into the rebuildable Analytics index."""
    width = height = file_size = 0
    image_error = 0
    path = Path(str(image_path or ''))
    try:
        file_size = int(path.stat().st_size)
        with Image.open(path) as image:
            width, height = (int(value) for value in image.size)
    except Exception:
        image_error = 1

    image_area = float(width * height) if width > 0 and height > 0 else 0.0
    parsed = parse_image_annotations(
        annotations,
        ParseContext(image_id=str(image_id), image_width=width or None, image_height=height or None),
    )
    objects: list[dict[str, Any]] = []
    for instance in parsed.instances:
        geometry = instance.geometry
        box = geometry.bbox
        bbox_area = bbox_width = bbox_height = None
        bbox_area_ratio = bbox_width_norm = bbox_height_norm = bbox_cx_norm = bbox_cy_norm = bbox_aspect_ratio = None
        if box is not None:
            bbox_width, bbox_height = box.width, box.height
            bbox_area = box.area
            bbox_aspect_ratio = bbox_width / bbox_height
            if image_area > 0:
                bbox_area_ratio = bbox_area / image_area
                bbox_width_norm = bbox_width / width
                bbox_height_norm = bbox_height / height
                bbox_cx_norm = box.center[0] / width
                bbox_cy_norm = box.center[1] / height
        instance_area = geometry.segmentation_area_px
        producer = instance.provenance.producer
        issue_codes = [issue.code for issue in instance.issues]
        error_count = sum(1 for issue in instance.issues if issue.severity == 'error')
        legacy_task_type = (
            'instance_segmentation' if instance.has_instance_segmentation
            else ('detection' if instance.has_detection else 'invalid')
        )
        objects.append({
            'image_id': str(image_id),
            'annotation_id': instance.instance_id,
            'class_name_norm': norm_text(instance.class_name),
            'class_name': instance.class_name,
            'geometry_type': geometry.primary_geometry,
            'primary_geometry': geometry.primary_geometry,
            'task_type': legacy_task_type,
            'has_detection': int(instance.has_detection),
            'has_instance_segmentation': int(instance.has_instance_segmentation),
            'bbox_origin': geometry.bbox_origin,
            'raw_record_count': instance.raw_record_count,
            'issue_count': len(instance.issues),
            'error_count': error_count,
            'issue_codes': json.dumps(issue_codes, ensure_ascii=False),
            'component_count': geometry.component_count,
            'has_mask': int(bool(geometry.mask_refs)),
            'bbox_area_px': bbox_area,
            'bbox_area_ratio': bbox_area_ratio,
            'bbox_width_norm': bbox_width_norm,
            'bbox_height_norm': bbox_height_norm,
            'bbox_cx_norm': bbox_cx_norm,
            'bbox_cy_norm': bbox_cy_norm,
            'bbox_aspect_ratio': bbox_aspect_ratio,
            'instance_area_px': instance_area,
            'instance_area_ratio': instance_area / image_area if image_area > 0 and instance_area is not None else None,
            'bbox_fill_ratio': geometry.bbox_fill_ratio,
            'score': instance.score,
            'source_model': producer.raw_value,
            'source_model_norm': producer.source_id,
            'source_display_name': producer.display_name,
            'is_out_of_bounds': int(geometry.is_out_of_bounds),
        })

    return ({
        'image_id': str(image_id),
        'width': width,
        'height': height,
        'aspect_ratio': width / height if width > 0 and height > 0 else None,
        'file_size': file_size,
        'annotation_count': len(objects),
        'raw_annotation_count': parsed.raw_record_count,
        'image_error': image_error,
    }, objects)


class AnalyticsIndexRepository:
    def __init__(self, *, db_connect: Callable[[], Any], db_lock: RLock) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock
        self._init_db()

    def _init_db(self) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.executescript('''
                    CREATE TABLE IF NOT EXISTS analytics_index_meta (
                        project_id TEXT PRIMARY KEY,
                        index_version INTEGER NOT NULL DEFAULT 1,
                        status TEXT NOT NULL DEFAULT 'missing',
                        active_generation TEXT NOT NULL DEFAULT '',
                        build_generation TEXT NOT NULL DEFAULT '',
                        indexed_content_rev INTEGER NOT NULL DEFAULT 0,
                        indexed_images INTEGER NOT NULL DEFAULT 0,
                        total_images INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL DEFAULT ''
                    );
                    CREATE TABLE IF NOT EXISTS analytics_image_stats (
                        project_id TEXT NOT NULL,
                        generation TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        width INTEGER NOT NULL DEFAULT 0,
                        height INTEGER NOT NULL DEFAULT 0,
                        aspect_ratio REAL,
                        file_size INTEGER NOT NULL DEFAULT 0,
                        annotation_count INTEGER NOT NULL DEFAULT 0,
                        raw_annotation_count INTEGER NOT NULL DEFAULT 0,
                        image_error INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (project_id, generation, image_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_analytics_images_project
                    ON analytics_image_stats(project_id, generation, annotation_count);
                    CREATE TABLE IF NOT EXISTS analytics_object_stats (
                        project_id TEXT NOT NULL,
                        generation TEXT NOT NULL,
                        image_id TEXT NOT NULL,
                        annotation_id TEXT NOT NULL,
                        class_name_norm TEXT NOT NULL DEFAULT '',
                        class_name TEXT NOT NULL DEFAULT '',
                        geometry_type TEXT NOT NULL DEFAULT 'invalid',
                        primary_geometry TEXT NOT NULL DEFAULT 'invalid',
                        task_type TEXT NOT NULL DEFAULT 'invalid',
                        has_detection INTEGER NOT NULL DEFAULT 0,
                        has_instance_segmentation INTEGER NOT NULL DEFAULT 0,
                        bbox_origin TEXT NOT NULL DEFAULT 'none',
                        raw_record_count INTEGER NOT NULL DEFAULT 1,
                        issue_count INTEGER NOT NULL DEFAULT 0,
                        error_count INTEGER NOT NULL DEFAULT 0,
                        issue_codes TEXT NOT NULL DEFAULT '[]',
                        component_count INTEGER NOT NULL DEFAULT 0,
                        has_mask INTEGER NOT NULL DEFAULT 0,
                        bbox_area_px REAL,
                        bbox_area_ratio REAL,
                        bbox_width_norm REAL,
                        bbox_height_norm REAL,
                        bbox_cx_norm REAL,
                        bbox_cy_norm REAL,
                        bbox_aspect_ratio REAL,
                        instance_area_px REAL,
                        instance_area_ratio REAL,
                        bbox_fill_ratio REAL,
                        score REAL,
                        source_model TEXT NOT NULL DEFAULT '',
                        source_model_norm TEXT NOT NULL DEFAULT 'unknown',
                        source_display_name TEXT NOT NULL DEFAULT '',
                        is_out_of_bounds INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (project_id, generation, image_id, annotation_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_class
                    ON analytics_object_stats(project_id, generation, class_name_norm, image_id);
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_area
                    ON analytics_object_stats(project_id, generation, bbox_area_ratio);
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_geometry
                    ON analytics_object_stats(project_id, generation, geometry_type);
                ''')
                # SQLite has no CREATE TABLE ... ADD COLUMN variant. Keep upgrades
                # additive so old projects remain readable until their v3 rebuild.
                object_columns = {
                    str(row['name']) for row in conn.execute('PRAGMA table_info(analytics_object_stats)').fetchall()
                }
                for name, definition in (
                    ('task_type', "TEXT NOT NULL DEFAULT 'invalid'"),
                    ('source_model_norm', "TEXT NOT NULL DEFAULT 'unknown'"),
                    ('bbox_fill_ratio', 'REAL'),
                    ('primary_geometry', "TEXT NOT NULL DEFAULT 'invalid'"),
                    ('has_detection', 'INTEGER NOT NULL DEFAULT 0'),
                    ('has_instance_segmentation', 'INTEGER NOT NULL DEFAULT 0'),
                    ('bbox_origin', "TEXT NOT NULL DEFAULT 'none'"),
                    ('raw_record_count', 'INTEGER NOT NULL DEFAULT 1'),
                    ('issue_count', 'INTEGER NOT NULL DEFAULT 0'),
                    ('error_count', 'INTEGER NOT NULL DEFAULT 0'),
                    ('issue_codes', "TEXT NOT NULL DEFAULT '[]'"),
                    ('source_display_name', "TEXT NOT NULL DEFAULT ''"),
                ):
                    if name not in object_columns:
                        conn.execute(f'ALTER TABLE analytics_object_stats ADD COLUMN {name} {definition}')
                image_columns = {
                    str(row['name']) for row in conn.execute('PRAGMA table_info(analytics_image_stats)').fetchall()
                }
                if 'raw_annotation_count' not in image_columns:
                    conn.execute('ALTER TABLE analytics_image_stats ADD COLUMN raw_annotation_count INTEGER NOT NULL DEFAULT 0')
                conn.executescript('''
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_detection_source
                    ON analytics_object_stats(project_id, generation, has_detection, source_model_norm, image_id);
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_segmentation_source
                    ON analytics_object_stats(project_id, generation, has_instance_segmentation, source_model_norm, image_id);
                    CREATE INDEX IF NOT EXISTS idx_analytics_objects_source_capability_class
                    ON analytics_object_stats(project_id, generation, source_model_norm,
                        has_detection, has_instance_segmentation, class_name_norm);
                ''')
                conn.commit()
            finally:
                conn.close()

    def status(self, project_id: str, *, content_rev: int, total_images: int) -> dict[str, Any]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                row = conn.execute('SELECT * FROM analytics_index_meta WHERE project_id = ?', (str(project_id),)).fetchone()
            finally:
                conn.close()
        if row is None:
            return {
                'project_id': project_id, 'status': 'missing', 'index_version': ANALYTICS_INDEX_VERSION,
                'indexed_content_rev': 0, 'content_rev': content_rev, 'indexed_images': 0,
                'total_images': total_images, 'last_error': '', 'needs_rebuild': True,
            }
        status = str(row['status'] or 'missing')
        needs_rebuild = (
            int(row['index_version'] or 0) != ANALYTICS_INDEX_VERSION
            or int(row['indexed_content_rev'] or 0) != int(content_rev)
            or int(row['indexed_images'] or 0) != int(total_images)
            or not str(row['active_generation'] or '')
        )
        if status == 'ready' and needs_rebuild:
            status = 'stale'
        return {
            'project_id': project_id,
            'status': status,
            'index_version': int(row['index_version'] or 0),
            'indexed_content_rev': int(row['indexed_content_rev'] or 0),
            'content_rev': int(content_rev),
            'indexed_images': int(row['indexed_images'] or 0),
            'total_images': int(total_images),
            'last_error': str(row['last_error'] or ''),
            'updated_at': str(row['updated_at'] or ''),
            'needs_rebuild': needs_rebuild,
        }

    def begin_build(self, project_id: str, *, total_images: int) -> str:
        generation = new_id('agen_')
        with self._db_lock:
            conn = self._db_connect()
            try:
                previous = conn.execute(
                    'SELECT build_generation FROM analytics_index_meta WHERE project_id=?',
                    (str(project_id),),
                ).fetchone()
                abandoned = str(previous['build_generation'] or '') if previous else ''
                if abandoned:
                    conn.execute(
                        'DELETE FROM analytics_object_stats WHERE project_id=? AND generation=?',
                        (str(project_id), abandoned),
                    )
                    conn.execute(
                        'DELETE FROM analytics_image_stats WHERE project_id=? AND generation=?',
                        (str(project_id), abandoned),
                    )
                conn.execute('''
                    INSERT INTO analytics_index_meta (
                        project_id, index_version, status, build_generation, total_images, last_error, updated_at
                    ) VALUES (?, ?, 'building', ?, ?, '', ?)
                    ON CONFLICT(project_id) DO UPDATE SET
                        index_version=excluded.index_version, status='building', build_generation=excluded.build_generation,
                        total_images=excluded.total_images, last_error='', updated_at=excluded.updated_at
                ''', (str(project_id), ANALYTICS_INDEX_VERSION, generation, int(total_images), now_ts()))
                conn.commit()
            finally:
                conn.close()
        return generation

    @staticmethod
    def _insert_rows(conn: Any, project_id: str, generation: str, image_rows: list[dict[str, Any]], object_rows: list[dict[str, Any]]) -> None:
        conn.executemany('''
            INSERT OR REPLACE INTO analytics_image_stats (
                project_id, generation, image_id, width, height, aspect_ratio, file_size,
                annotation_count, raw_annotation_count, image_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', [(
            project_id, generation, row['image_id'], row['width'], row['height'], row['aspect_ratio'],
            row['file_size'], row['annotation_count'], row['raw_annotation_count'], row['image_error'],
        ) for row in image_rows])
        conn.executemany('''
            INSERT OR REPLACE INTO analytics_object_stats (
                project_id, generation, image_id, annotation_id, class_name_norm, class_name, geometry_type, primary_geometry,
                task_type, has_detection, has_instance_segmentation, bbox_origin, raw_record_count,
                issue_count, error_count, issue_codes, component_count, has_mask,
                bbox_area_px, bbox_area_ratio, bbox_width_norm, bbox_height_norm,
                bbox_cx_norm, bbox_cy_norm, bbox_aspect_ratio, instance_area_px, instance_area_ratio,
                bbox_fill_ratio, score, source_model, source_model_norm, source_display_name, is_out_of_bounds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', [(
            project_id, generation, row['image_id'], row['annotation_id'], row['class_name_norm'], row['class_name'],
            row['geometry_type'], row['primary_geometry'], row['task_type'], row['has_detection'],
            row['has_instance_segmentation'], row['bbox_origin'], row['raw_record_count'], row['issue_count'],
            row['error_count'], row['issue_codes'], row['component_count'], row['has_mask'], row['bbox_area_px'], row['bbox_area_ratio'],
            row['bbox_width_norm'], row['bbox_height_norm'], row['bbox_cx_norm'], row['bbox_cy_norm'],
            row['bbox_aspect_ratio'], row['instance_area_px'], row['instance_area_ratio'], row['bbox_fill_ratio'],
            row['score'], row['source_model'], row['source_model_norm'], row['source_display_name'], row['is_out_of_bounds'],
        ) for row in object_rows])

    def append_build_batch(self, project_id: str, generation: str, image_rows: list[dict[str, Any]], object_rows: list[dict[str, Any]]) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                self._insert_rows(conn, str(project_id), generation, image_rows, object_rows)
                conn.commit()
            finally:
                conn.close()

    def activate(self, project_id: str, generation: str, *, content_rev: int, indexed_images: int) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                previous = conn.execute(
                    'SELECT active_generation FROM analytics_index_meta WHERE project_id = ?', (str(project_id),)
                ).fetchone()
                old_generation = str(previous['active_generation'] or '') if previous else ''
                conn.execute('''
                    UPDATE analytics_index_meta SET status='ready', active_generation=?, build_generation='',
                        indexed_content_rev=?, indexed_images=?, total_images=?, last_error='', updated_at=?
                    WHERE project_id=? AND build_generation=?
                ''', (generation, int(content_rev), int(indexed_images), int(indexed_images), now_ts(), str(project_id), generation))
                if old_generation and old_generation != generation:
                    conn.execute('DELETE FROM analytics_object_stats WHERE project_id=? AND generation=?', (str(project_id), old_generation))
                    conn.execute('DELETE FROM analytics_image_stats WHERE project_id=? AND generation=?', (str(project_id), old_generation))
                conn.commit()
            finally:
                conn.close()

    def fail_build(self, project_id: str, generation: str, error: str, *, stale: bool = False) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM analytics_object_stats WHERE project_id=? AND generation=?', (str(project_id), generation))
                conn.execute('DELETE FROM analytics_image_stats WHERE project_id=? AND generation=?', (str(project_id), generation))
                conn.execute('''
                    UPDATE analytics_index_meta SET status=?, build_generation='', last_error=?, updated_at=?
                    WHERE project_id=? AND build_generation=?
                ''', ('stale' if stale else 'failed', str(error)[:1000], now_ts(), str(project_id), generation))
                conn.commit()
            finally:
                conn.close()

    def replace_active_image(
        self, project_id: str, image_row: dict[str, Any], object_rows: list[dict[str, Any]], *, content_rev: int
    ) -> bool:
        with self._db_lock:
            conn = self._db_connect()
            try:
                meta = conn.execute(
                    "SELECT active_generation, status FROM analytics_index_meta WHERE project_id=?", (str(project_id),)
                ).fetchone()
                if meta is None or str(meta['status']) != 'ready' or not str(meta['active_generation'] or ''):
                    return False
                generation = str(meta['active_generation'])
                conn.execute('DELETE FROM analytics_object_stats WHERE project_id=? AND generation=? AND image_id=?',
                             (str(project_id), generation, str(image_row['image_id'])))
                self._insert_rows(conn, str(project_id), generation, [image_row], object_rows)
                conn.execute('UPDATE analytics_index_meta SET indexed_content_rev=?, updated_at=? WHERE project_id=?',
                             (int(content_rev), now_ts(), str(project_id)))
                conn.commit()
                return True
            finally:
                conn.close()

    def delete_project(self, project_id: str) -> None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                conn.execute('DELETE FROM analytics_object_stats WHERE project_id=?', (str(project_id),))
                conn.execute('DELETE FROM analytics_image_stats WHERE project_id=?', (str(project_id),))
                conn.execute('DELETE FROM analytics_index_meta WHERE project_id=?', (str(project_id),))
                conn.commit()
            finally:
                conn.close()

    def dimensions(self, project_id: str) -> dict[str, Any] | None:
        with self._db_lock:
            conn = self._db_connect()
            try:
                meta = conn.execute('SELECT * FROM analytics_index_meta WHERE project_id=?', (str(project_id),)).fetchone()
                if meta is None or str(meta['status']) != 'ready' or not str(meta['active_generation'] or ''):
                    return None
                generation = str(meta['active_generation'])
                source_rows = conn.execute('''
                    SELECT source_model_norm,
                           MAX(CASE WHEN source_display_name != '' THEN source_display_name ELSE source_model_norm END) display_name,
                           SUM(has_detection) detection_instances,
                           COUNT(DISTINCT CASE WHEN has_detection=1 THEN image_id END) detection_images,
                           SUM(has_instance_segmentation) segmentation_instances,
                           COUNT(DISTINCT CASE WHEN has_instance_segmentation=1 THEN image_id END) segmentation_images,
                           COUNT(*) instance_count, COUNT(DISTINCT image_id) image_count
                    FROM analytics_object_stats WHERE project_id=? AND generation=?
                    GROUP BY source_model_norm
                ''', (str(project_id), generation)).fetchall()
                task_totals = conn.execute('''
                    SELECT SUM(has_detection) detection_instances,
                           COUNT(DISTINCT CASE WHEN has_detection=1 THEN image_id END) detection_images,
                           SUM(has_instance_segmentation) segmentation_instances,
                           COUNT(DISTINCT CASE WHEN has_instance_segmentation=1 THEN image_id END) segmentation_images
                    FROM analytics_object_stats WHERE project_id=? AND generation=?
                ''', (str(project_id), generation)).fetchone()
                invalid = conn.execute('''
                    SELECT COUNT(*) count FROM analytics_object_stats
                    WHERE project_id=? AND generation=? AND has_detection=0 AND has_instance_segmentation=0
                ''', (str(project_id), generation)).fetchone()
            finally:
                conn.close()

        source_values = {str(row['source_model_norm']): row for row in source_rows}
        extra_sources = sorted(source for source in source_values if source not in KNOWN_SOURCE_MODELS)
        source_ids = [*KNOWN_SOURCE_MODELS, *extra_sources]
        tasks = []
        for task in TASK_TYPES:
            task_sources = []
            instance_key = 'detection_instances' if task == 'detection' else 'segmentation_instances'
            image_key = 'detection_images' if task == 'detection' else 'segmentation_images'
            for source in source_ids:
                row = source_values.get(source)
                task_sources.append({
                    'source': source,
                    'display_name': str(row['display_name']) if row else normalize_source(source).display_name,
                    'image_count': int(row[image_key] or 0) if row else 0,
                    'instance_count': int(row[instance_key] or 0) if row else 0,
                })
            tasks.append({
                'task': task,
                'image_count': int(task_totals[image_key] or 0),
                'instance_count': int(task_totals[instance_key] or 0),
                'sources': task_sources,
            })
        sources = [{
            'source': source,
            'display_name': str(source_values[source]['display_name']) if source in source_values else normalize_source(source).display_name,
            'image_count': int(source_values[source]['image_count'] or 0) if source in source_values else 0,
            'instance_count': int(source_values[source]['instance_count'] or 0) if source in source_values else 0,
        } for source in source_ids]
        return {
            'project_id': project_id,
            'index_version': int(meta['index_version']),
            'tasks': tasks,
            'sources': sources,
            'invalid_instance_count': int(invalid['count'] or 0),
        }

    def overview(self, project_id: str, *, task: str = 'detection', sources: list[str] | None = None) -> dict[str, Any] | None:
        if task not in TASK_TYPES:
            raise ValueError('task must be detection or instance_segmentation')
        selected = list(dict.fromkeys(normalize_source(source).source_id for source in sources)) if sources is not None else []
        if sources is not None and not selected:
            raise ValueError('at least one source is required')
        capability_field = 'has_detection' if task == 'detection' else 'has_instance_segmentation'
        with self._db_lock:
            conn = self._db_connect()
            try:
                meta = conn.execute('SELECT * FROM analytics_index_meta WHERE project_id=?', (str(project_id),)).fetchone()
                if meta is None or str(meta['status']) != 'ready' or not str(meta['active_generation'] or ''):
                    return None
                generation = str(meta['active_generation'])
                if sources is None:
                    available = conn.execute('''SELECT DISTINCT source_model_norm FROM analytics_object_stats
                        WHERE project_id=? AND generation=? ORDER BY source_model_norm''',
                        (str(project_id), generation)).fetchall()
                    found = {str(row['source_model_norm']) for row in available}
                    selected = [source for source in KNOWN_SOURCE_MODELS if source in found]
                    selected.extend(sorted(found.difference(KNOWN_SOURCE_MODELS)))
                    if not selected:
                        selected = list(KNOWN_SOURCE_MODELS)
                placeholders = ','.join('?' for _ in selected)
                summary = conn.execute('''SELECT COUNT(*) total_images, SUM(image_error) image_errors
                    FROM analytics_image_stats WHERE project_id=? AND generation=?''',
                    (str(project_id), generation)).fetchone()
                rows = conn.execute(f'''SELECT image_id, class_name_norm, class_name, primary_geometry AS geometry_type,
                        bbox_area_ratio, bbox_aspect_ratio, instance_area_ratio,
                        bbox_cx_norm, bbox_cy_norm, source_model_norm
                    FROM analytics_object_stats WHERE project_id=? AND generation=? AND {capability_field}=1
                    AND source_model_norm IN ({placeholders})''',
                    (str(project_id), generation, *selected)).fetchall()
                anomaly_count = conn.execute(f'''SELECT COUNT(*) count FROM analytics_object_stats
                    WHERE project_id=? AND generation=? AND issue_count>0
                    AND ({capability_field}=1 OR (has_detection=0 AND has_instance_segmentation=0))
                    AND source_model_norm IN ({placeholders})''',
                    (str(project_id), generation, *selected)).fetchone()['count']
                legacy = conn.execute('''SELECT COUNT(*) total_annotations,
                    COUNT(DISTINCT CASE WHEN class_name_norm != '' THEN class_name_norm END) class_count,
                    SUM(CASE WHEN has_detection=0 AND has_instance_segmentation=0 THEN 1 ELSE 0 END) invalid_count
                    FROM analytics_object_stats WHERE project_id=? AND generation=?''',
                    (str(project_id), generation)).fetchone()
                legacy_geometry = conn.execute('''SELECT primary_geometry, COUNT(*) count
                    FROM analytics_object_stats WHERE project_id=? AND generation=? GROUP BY primary_geometry''',
                    (str(project_id), generation)).fetchall()
            finally:
                conn.close()

        by_source = {source: [row for row in rows if str(row['source_model_norm']) == source] for source in selected}
        image_ids = {str(row['image_id']) for row in rows}
        class_names: dict[str, str] = {}
        class_totals: dict[str, int] = {}
        for row in rows:
            key = str(row['class_name_norm'] or '')
            if key:
                class_names.setdefault(key, str(row['class_name'] or key))
                class_totals[key] = class_totals.get(key, 0) + 1
        class_keys = sorted(class_totals, key=lambda key: (-class_totals[key], class_names[key].lower()))[:200]

        def series_for(categories: list[str], counts: dict[str, dict[str, int]], *, image_counts: dict[str, dict[str, int]] | None = None) -> dict[str, Any]:
            return {
                'categories': categories,
                'series': [{
                    'source': source,
                    'values': [counts.get(source, {}).get(category, 0) for category in categories],
                    **({'image_values': [image_counts.get(source, {}).get(category, 0) for category in categories]} if image_counts is not None else {}),
                } for source in selected],
            }

        class_counts: dict[str, dict[str, int]] = {}
        class_images: dict[str, dict[str, int]] = {}
        for source, source_rows in by_source.items():
            class_counts[source] = {}
            image_sets: dict[str, set[str]] = {}
            for row in source_rows:
                key = str(row['class_name_norm'] or '')
                if key in class_keys:
                    label = class_names[key]
                    class_counts[source][label] = class_counts[source].get(label, 0) + 1
                    image_sets.setdefault(label, set()).add(str(row['image_id']))
            class_images[source] = {key: len(value) for key, value in image_sets.items()}
        class_categories = [class_names[key] for key in class_keys]

        density_counts: dict[str, dict[str, int]] = {}
        for source, source_rows in by_source.items():
            per_image: dict[str, int] = {}
            for row in source_rows:
                image_id = str(row['image_id'])
                per_image[image_id] = per_image.get(image_id, 0) + 1
            density_counts[source] = {label: 0 for label, _start, _end in DENSITY_BUCKETS}
            density_counts[source]['0'] = max(0, int(summary['total_images'] or 0) - len(per_image))
            for value in per_image.values():
                for label, start, end in DENSITY_BUCKETS:
                    if value >= start and (end is None or value <= end):
                        density_counts[source][label] += 1
                        break

        area_labels = ['0-0.01%', '0.01-0.05%', '0.05-0.1%', '0.1-0.5%', '0.5-1%', '1-5%', '5-10%', '10-25%', '25-50%', '>50%']
        area_edges = BBOX_AREA_EDGES[1:-1]
        area_field = 'bbox_area_ratio' if task == 'detection' else 'instance_area_ratio'
        area_counts = {source: {label: 0 for label in area_labels} for source in selected}
        area_missing = {source: 0 for source in selected}
        for source, source_rows in by_source.items():
            for row in source_rows:
                value = row[area_field]
                if value is None:
                    area_missing[source] += 1
                    continue
                index = next((i for i, edge in enumerate(area_edges) if float(value) <= edge), len(area_labels) - 1)
                area_counts[source][area_labels[index]] += 1

        secondary_categories = list(ASPECT_RATIO_BUCKETS if task == 'detection' else ('polygon', 'multi_polygon', 'mask'))
        secondary_counts = {source: {label: 0 for label in secondary_categories} for source in selected}
        for source, source_rows in by_source.items():
            for row in source_rows:
                if task == 'instance_segmentation':
                    secondary_counts[source][str(row['geometry_type'])] += 1
                    continue
                value = row['bbox_aspect_ratio']
                if value is None:
                    continue
                value = float(value)
                label = ('<0.25' if value < .25 else '0.25-0.5' if value < .5 else '0.5-1' if value < 1
                         else '1-2' if value < 2 else '2-4' if value <= 4 else '>4')
                secondary_counts[source][label] += 1

        heat_series = []
        if task == 'detection':
            for source, source_rows in by_source.items():
                cells: dict[tuple[int, int], int] = {}
                for row in source_rows:
                    if row['bbox_cx_norm'] is None or row['bbox_cy_norm'] is None:
                        continue
                    x = min(19, max(0, int(float(row['bbox_cx_norm']) * 20)))
                    y = min(19, max(0, int(float(row['bbox_cy_norm']) * 20)))
                    cells[(x, y)] = cells.get((x, y), 0) + 1
                heat_series.append({'source': source, 'cells': [
                    {'x': x, 'y': y, 'count': count} for (x, y), count in sorted(cells.items())
                ]})

        resolution = self._resolution_grid_by_source(project_id, generation, by_source)
        source_summary = []
        for source, source_rows in by_source.items():
            source_summary.append({
                'source': source,
                'image_count': len({str(row['image_id']) for row in source_rows}),
                'instance_count': len(source_rows),
                'class_count': len({str(row['class_name_norm']) for row in source_rows if str(row['class_name_norm'] or '')}),
            })
        total_images = int(summary['total_images'] or 0)
        legacy_geometry_counts = {key: 0 for key in GEOMETRY_TYPES}
        for row in legacy_geometry:
            legacy_geometry_counts[str(row['primary_geometry'])] = int(row['count'])
        return {
            'project_id': project_id,
            'index_version': int(meta['index_version']),
            'content_rev': int(meta['indexed_content_rev']),
            'generated_at': str(meta['updated_at'] or ''),
            'scope': {
                'task': task, 'sources': selected, 'project_total_images': total_images,
                'hit_images': len(image_ids), 'instance_count': len(rows), 'class_count': len(class_totals),
                'anomaly_count': int(anomaly_count or 0) + int(summary['image_errors'] or 0),
            },
            'source_summary': source_summary,
            'class_distribution': series_for(class_categories, class_counts, image_counts=class_images),
            'density_distribution': series_for([label for label, _s, _e in DENSITY_BUCKETS], density_counts),
            'area_distribution': {**series_for(area_labels, area_counts), 'missing_by_source': area_missing},
            'aspect_ratio_distribution': series_for(secondary_categories, secondary_counts) if task == 'detection' else None,
            'geometry_distribution_by_source': series_for(secondary_categories, secondary_counts) if task == 'instance_segmentation' else None,
            'center_heatmap': {
                'x_edges': [round(index / 20, 2) for index in range(21)],
                'y_edges': [round(index / 20, 2) for index in range(21)],
                'series': heat_series,
            } if task == 'detection' else None,
            'resolution_distribution': resolution,
            'class_distribution_truncated': max(0, len(class_totals) - len(class_keys)),
            # Retain the v1 summary fields for callers of the storage/service API.
            'summary': {
                'total_images': total_images,
                'labeled_images': len({str(row['image_id']) for row in rows}),
                'unlabeled_images': max(0, total_images - len(image_ids)),
                'total_annotations': int(legacy['total_annotations'] or 0),
                'class_count': int(legacy['class_count'] or 0),
                'invalid_geometry_count': int(legacy['invalid_count'] or 0),
                'image_error_count': int(summary['image_errors'] or 0),
            },
            'geometry_distribution': [{'type': key, 'count': legacy_geometry_counts[key]} for key in GEOMETRY_TYPES],
        }

    def _resolution_grid_by_source(self, project_id: str, generation: str, by_source: dict[str, list[Any]], bins: int = 20) -> dict[str, Any]:
        source_images = {source: {str(row['image_id']) for row in rows} for source, rows in by_source.items()}
        all_ids = set().union(*source_images.values()) if source_images else set()
        if not all_ids:
            return {'x_edges': [], 'y_edges': [], 'series': [{'source': source, 'cells': []} for source in by_source]}
        placeholders = ','.join('?' for _ in all_ids)
        with self._db_lock:
            conn = self._db_connect()
            try:
                image_rows = conn.execute(f'''SELECT image_id, width, height FROM analytics_image_stats
                    WHERE project_id=? AND generation=? AND image_id IN ({placeholders}) AND width>0 AND height>0''',
                    (str(project_id), generation, *sorted(all_ids))).fetchall()
            finally:
                conn.close()
        if not image_rows:
            return {'x_edges': [], 'y_edges': [], 'series': [{'source': source, 'cells': []} for source in by_source]}
        widths, heights = [int(row['width']) for row in image_rows], [int(row['height']) for row in image_rows]
        min_w, max_w, min_h, max_h = min(widths), max(widths), min(heights), max(heights)
        x_bins = max(1, min(bins, max_w - min_w + 1))
        y_bins = max(1, min(bins, max_h - min_h + 1))
        x_step, y_step = max(1.0, (max_w - min_w + 1) / x_bins), max(1.0, (max_h - min_h + 1) / y_bins)
        result_series = []
        for source, ids in source_images.items():
            cells: dict[tuple[int, int], int] = {}
            for row in image_rows:
                if str(row['image_id']) not in ids:
                    continue
                x = min(x_bins - 1, int((int(row['width']) - min_w) / x_step))
                y = min(y_bins - 1, int((int(row['height']) - min_h) / y_step))
                cells[(x, y)] = cells.get((x, y), 0) + 1
            result_series.append({'source': source, 'cells': [
                {'x': x, 'y': y, 'count': count} for (x, y), count in sorted(cells.items())
            ]})
        return {
            'x_edges': [round(min_w + index * x_step) for index in range(x_bins + 1)],
            'y_edges': [round(min_h + index * y_step) for index in range(y_bins + 1)],
            'series': result_series,
        }
