from __future__ import annotations

from threading import RLock
from typing import Any, Callable

from app.utils import norm_text, now_ts


class AnnotationIndexRepository:
    def __init__(self, *, db_connect: Callable[[], Any], db_lock: RLock) -> None:
        self._db_connect = db_connect
        self._db_lock = db_lock

    @staticmethod
    def annotation_class_name(ann: dict[str, Any]) -> str:
        return str(ann.get('class_name') or ann.get('label') or '').strip()

    @staticmethod
    def annotation_score(ann: dict[str, Any]) -> float:
        try:
            return float(ann.get('score') or ann.get('confidence') or 0.0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def annotation_area(ann: dict[str, Any]) -> float:
        try:
            area = float(ann.get('area') or 0.0)
            if area > 0.0:
                return area
        except (TypeError, ValueError):
            pass

        bbox = ann.get('bbox') or ann.get('bbox_xyxy') or ann.get('box') or []
        if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
            try:
                x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
                return max(0.0, abs(x2 - x1) * abs(y2 - y1))
            except (TypeError, ValueError):
                return 0.0
        return 0.0

    @classmethod
    def payload(cls, annotations: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        anns = [ann for ann in annotations if isinstance(ann, dict)]
        scores = [cls.annotation_score(ann) for ann in anns]
        areas = [cls.annotation_area(ann) for ann in anns]
        count = len(anns)
        stats = {
            'annotation_count': count,
            'total_area': float(sum(areas)),
            'avg_confidence': float(sum(scores) / count) if count > 0 else 0.0,
            'min_confidence': float(min(scores)) if scores else 0.0,
            'max_confidence': float(max(scores)) if scores else 0.0,
        }

        by_class: dict[str, dict[str, Any]] = {}
        for ann in anns:
            class_name = cls.annotation_class_name(ann)
            class_norm = norm_text(class_name)
            if not class_norm:
                continue
            item = by_class.setdefault(
                class_norm,
                {
                    'class_name_norm': class_norm,
                    'class_name': class_name,
                    'ann_count': 0,
                    'total_area': 0.0,
                    'scores': [],
                },
            )
            item['ann_count'] += 1
            item['total_area'] += cls.annotation_area(ann)
            item['scores'].append(cls.annotation_score(ann))

        class_rows: list[dict[str, Any]] = []
        for item in by_class.values():
            class_scores = item.pop('scores')
            item['avg_confidence'] = float(sum(class_scores) / len(class_scores)) if class_scores else 0.0
            item['min_confidence'] = float(min(class_scores)) if class_scores else 0.0
            item['max_confidence'] = float(max(class_scores)) if class_scores else 0.0
            class_rows.append(item)
        return stats, class_rows

    def replace(
        self,
        project_id: str,
        image_id: str,
        annotations: list[dict[str, Any]],
        *,
        conn: Any | None = None,
        updated_at: str | None = None,
    ) -> None:
        stats, class_rows = self.payload(annotations if isinstance(annotations, list) else [])
        ts = str(updated_at or now_ts())

        def write(target: Any) -> None:
            target.execute(
                '''
                INSERT OR REPLACE INTO image_annotation_stats (
                    project_id, image_id, annotation_count, total_area,
                    avg_confidence, min_confidence, max_confidence, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    str(project_id),
                    str(image_id),
                    int(stats['annotation_count']),
                    float(stats['total_area']),
                    float(stats['avg_confidence']),
                    float(stats['min_confidence']),
                    float(stats['max_confidence']),
                    ts,
                ),
            )
            target.execute(
                'DELETE FROM image_class_index WHERE project_id = ? AND image_id = ?',
                (str(project_id), str(image_id)),
            )
            target.executemany(
                '''
                INSERT INTO image_class_index (
                    project_id, image_id, class_name_norm, class_name, ann_count,
                    total_area, avg_confidence, min_confidence, max_confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                [
                    (
                        str(project_id),
                        str(image_id),
                        str(row['class_name_norm']),
                        str(row['class_name']),
                        int(row['ann_count']),
                        float(row['total_area']),
                        float(row['avg_confidence']),
                        float(row['min_confidence']),
                        float(row['max_confidence']),
                    )
                    for row in class_rows
                ],
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

    def dashboard(
        self,
        project_id: str,
        *,
        total_images: int,
        labeled_images: int,
        unlabeled_images: int,
    ) -> dict[str, Any]:
        with self._db_lock:
            conn = self._db_connect()
            try:
                totals = conn.execute(
                    '''
                    SELECT
                        COUNT(*) AS indexed_images,
                        COALESCE(SUM(annotation_count), 0) AS annotation_count,
                        COALESCE(SUM(total_area), 0) AS total_area,
                        COALESCE(AVG(CASE WHEN annotation_count > 0 THEN avg_confidence END), 0) AS avg_confidence
                    FROM image_annotation_stats
                    WHERE project_id = ?
                    ''',
                    (str(project_id),),
                ).fetchone()
                store_totals = conn.execute(
                    '''
                    SELECT COUNT(*) AS annotation_store_images
                    FROM image_annotations
                    WHERE project_id = ?
                    ''',
                    (str(project_id),),
                ).fetchone()
                class_rows = conn.execute(
                    '''
                    SELECT
                        class_name_norm,
                        MIN(class_name) AS class_name,
                        COUNT(*) AS image_count,
                        COALESCE(SUM(ann_count), 0) AS instance_count,
                        COALESCE(SUM(total_area), 0) AS total_area,
                        COALESCE(AVG(avg_confidence), 0) AS avg_confidence
                    FROM image_class_index
                    WHERE project_id = ?
                    GROUP BY class_name_norm
                    ORDER BY instance_count DESC, image_count DESC, class_name ASC
                    ''',
                    (str(project_id),),
                ).fetchall()
                density_rows = conn.execute(
                    '''
                    SELECT
                        CASE
                            WHEN annotation_count = 0 THEN '0'
                            WHEN annotation_count = 1 THEN '1'
                            WHEN annotation_count = 2 THEN '2'
                            WHEN annotation_count BETWEEN 3 AND 5 THEN '3-5'
                            WHEN annotation_count BETWEEN 6 AND 10 THEN '6-10'
                            ELSE '>10'
                        END AS bucket,
                        COUNT(*) AS image_count
                    FROM image_annotation_stats
                    WHERE project_id = ?
                    GROUP BY bucket
                    ''',
                    (str(project_id),),
                ).fetchall()
            finally:
                conn.close()

        indexed_images = int(totals['indexed_images'] if totals is not None else 0)
        annotation_store_images = int(store_totals['annotation_store_images'] if store_totals is not None else 0)
        annotation_count = int(totals['annotation_count'] if totals is not None else 0)
        density_order = ['0', '1', '2', '3-5', '6-10', '>10']
        density_map = {str(row['bucket']): int(row['image_count']) for row in density_rows}
        return {
            'project_id': project_id,
            'total_images': total_images,
            'labeled_images': labeled_images,
            'unlabeled_images': unlabeled_images,
            'indexed_images': indexed_images,
            'annotation_store_images': annotation_store_images,
            'annotation_count': annotation_count,
            'avg_confidence': float(totals['avg_confidence'] if totals is not None else 0.0),
            'total_area': float(totals['total_area'] if totals is not None else 0.0),
            'needs_rebuild': indexed_images < total_images or annotation_store_images < total_images,
            'classes': [
                {
                    'class_name': str(row['class_name'] or row['class_name_norm']),
                    'class_name_norm': str(row['class_name_norm']),
                    'image_count': int(row['image_count']),
                    'instance_count': int(row['instance_count']),
                    'total_area': float(row['total_area']),
                    'avg_confidence': float(row['avg_confidence']),
                }
                for row in class_rows
            ],
            'annotation_density': [
                {'bucket': bucket, 'image_count': int(density_map.get(bucket, 0))}
                for bucket in density_order
            ],
        }
