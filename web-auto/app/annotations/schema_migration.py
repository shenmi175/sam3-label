from __future__ import annotations

import gzip
import json
from collections import Counter
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.annotations.parser import parse_image_annotations
from app.annotations.records import normalize_annotation_records
from app.services.annotation_masks import normalize_annotation_masks
from app.utils import atomic_write_json, ensure_dir, now_ts


def _projection(records: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    projected: list[tuple[Any, ...]] = []
    for instance in parse_image_annotations(records).instances:
        bbox = instance.geometry.bbox
        projected.append((
            instance.instance_id,
            instance.class_name,
            instance.score,
            None if bbox is None else (bbox.x1, bbox.y1, bbox.x2, bbox.y2),
            instance.geometry.regions,
            instance.has_detection,
            instance.has_instance_segmentation,
        ))
    return projected


def _source_value(record: dict[str, Any]) -> str:
    return str(record.get('source_model') or record.get('source') or '').strip().lower()


def _change_counts(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for original, normalized in zip(before, after):
        old_source = _source_value(original) or 'missing'
        new_source = _source_value(normalized) or 'missing'
        if old_source != new_source:
            counts[f'source:{old_source}->{new_source}'] += 1
        if 'source' in original:
            counts['removed:source'] += 1
        if 'label' in original:
            counts['removed:label'] += 1
        if int(original.get('schema_version') or 0) != int(normalized.get('schema_version') or 0):
            counts['schema_version'] += 1
    return counts


def _selected_projects(storage: Any, project_ids: Iterable[str] | None) -> dict[str, dict[str, Any]]:
    wanted = {str(value).strip() for value in (project_ids or ()) if str(value).strip()}
    projects = {
        str(project.get('id') or ''): project
        for project in storage._load_projects()
        if str(project.get('project_type') or 'image') == 'image' and str(project.get('id') or '')
    }
    if not wanted:
        return projects
    missing = sorted(wanted.difference(projects))
    if missing:
        raise ValueError(f'project not found: {", ".join(missing)}')
    return {project_id: projects[project_id] for project_id in wanted}


def migrate_annotation_schema(
    storage: Any,
    *,
    apply: bool,
    project_ids: Iterable[str] | None = None,
    manual_source: str = 'sam3',
    include_snapshots: bool = False,
) -> dict[str, Any]:
    """Normalize active records, optionally including rollback snapshots.

    Snapshots are excluded by default because they can contain historical,
    embedded masks that must remain byte-for-byte usable for rollback.
    Derived indexes are deliberately left untouched for the separate rebuild
    script.
    """
    if manual_source not in {'sam3', 'locate-anything'}:
        raise ValueError('manual_source must be sam3 or locate-anything')
    projects = _selected_projects(storage, project_ids)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_dir = storage.base_dir / '.annotation-schema-v3-backups' / timestamp
    lock = storage._catalog_write_lock if apply else nullcontext()
    report: dict[str, Any] = {
        'applied': bool(apply),
        'manual_source': manual_source,
        'projects_scanned': len(projects),
        'active_images_scanned': 0,
        'active_images_changed': 0,
        'active_annotations_changed': 0,
        'snapshot_rows_scanned': 0,
        'snapshot_rows_changed': 0,
        'snapshot_annotations_changed': 0,
        'changes': {},
        'failures': [],
        'backup_dir': '',
    }
    changes: Counter[str] = Counter()
    changed_projects: set[str] = set()

    with lock:
        read_connection = storage._db_connect()
        write_connection = storage._db_connect() if apply else None
        active_backup = None
        snapshot_backup = None
        try:
            placeholders = ','.join('?' for _ in projects)
            active_rows = read_connection.execute(
                f'''SELECT project_id, image_id, annotations_json FROM image_annotations
                    WHERE annotation_count > 0 AND project_id IN ({placeholders})
                    ORDER BY project_id, image_id''',
                tuple(projects),
            ).fetchall() if projects else []
            snapshot_rows = read_connection.execute(
                f'''SELECT run_id, project_id, image_id, annotations_json FROM smart_filter_snapshots
                    WHERE project_id IN ({placeholders}) ORDER BY project_id, run_id, image_id''',
                tuple(projects),
            ).fetchall() if include_snapshots and projects else []
            if apply:
                active_backup = gzip.open(
                    ensure_dir(backup_dir) / 'active_annotations.jsonl.gz', 'wt', encoding='utf-8',
                )
                if include_snapshots:
                    snapshot_backup = gzip.open(
                        ensure_dir(backup_dir) / 'smart_filter_snapshots.jsonl.gz', 'wt', encoding='utf-8',
                    )

            for row in active_rows:
                project_id = str(row['project_id'])
                image_id = str(row['image_id'])
                original = json.loads(str(row['annotations_json'] or '[]'))
                original = original if isinstance(original, list) else []
                report['active_images_scanned'] += 1
                prepared = normalize_annotation_masks(
                    base_dir=storage.base_dir,
                    project_id=project_id,
                    image_id=image_id,
                    annotations=original,
                    materialize=False,
                )
                normalized = normalize_annotation_records(prepared, manual_source=manual_source)
                if normalized == original:
                    continue
                if _projection(original) != _projection(normalized):
                    report['failures'].append({
                        'kind': 'active', 'project_id': project_id, 'image_id': image_id,
                        'error': 'canonical geometry projection changed',
                    })
                    continue
                if apply:
                    prepared = normalize_annotation_masks(
                        base_dir=storage.base_dir,
                        project_id=project_id,
                        image_id=image_id,
                        annotations=original,
                        materialize=True,
                    )
                    normalized = normalize_annotation_records(prepared, manual_source=manual_source)
                report['active_images_changed'] += 1
                report['active_annotations_changed'] += len(normalized)
                changes.update(_change_counts(original, normalized))
                changed_projects.add(project_id)
                if not apply:
                    continue
                assert write_connection is not None and active_backup is not None
                active_backup.write(json.dumps({
                    'project_id': project_id, 'image_id': image_id, 'annotations': original,
                }, ensure_ascii=False) + '\n')
                atomic_write_json(storage._annotation_path(projects[project_id], image_id), normalized)
                storage._replace_annotations_db(project_id, image_id, normalized, conn=write_connection)
                if report['active_images_changed'] % 250 == 0:
                    write_connection.commit()

            for row in snapshot_rows:
                project_id = str(row['project_id'])
                image_id = str(row['image_id'])
                original = json.loads(str(row['annotations_json'] or '[]'))
                original = original if isinstance(original, list) else []
                report['snapshot_rows_scanned'] += 1
                normalized = normalize_annotation_records(original, manual_source=manual_source)
                if normalized == original:
                    continue
                if _projection(original) != _projection(normalized):
                    report['failures'].append({
                        'kind': 'snapshot', 'project_id': project_id,
                        'run_id': str(row['run_id']), 'image_id': image_id,
                        'error': 'canonical geometry projection changed',
                    })
                    continue
                report['snapshot_rows_changed'] += 1
                report['snapshot_annotations_changed'] += len(normalized)
                changes.update(_change_counts(original, normalized))
                if not apply:
                    continue
                assert write_connection is not None and snapshot_backup is not None
                snapshot_backup.write(json.dumps({
                    'run_id': str(row['run_id']), 'project_id': project_id,
                    'image_id': image_id, 'annotations': original,
                }, ensure_ascii=False) + '\n')
                write_connection.execute(
                    '''UPDATE smart_filter_snapshots SET annotations_json=?
                       WHERE run_id=? AND project_id=? AND image_id=?''',
                    (
                        json.dumps(normalized, ensure_ascii=False, separators=(',', ':')),
                        str(row['run_id']), project_id, image_id,
                    ),
                )
                if report['snapshot_rows_changed'] % 250 == 0:
                    write_connection.commit()

            if write_connection is not None:
                write_connection.commit()
            if apply and changed_projects:
                catalog = storage._load_projects()
                for project in catalog:
                    project_id = str(project.get('id') or '')
                    if project_id not in changed_projects:
                        continue
                    storage._bump_content_rev(project)
                    project['updated_at'] = now_ts()
                storage._save_projects(catalog)
                catalog_by_id = {str(project.get('id') or ''): project for project in catalog}
                for project_id in changed_projects:
                    storage._write_project_manifest(catalog_by_id[project_id])
        finally:
            read_connection.close()
            if write_connection is not None:
                write_connection.close()
            if active_backup is not None:
                active_backup.close()
            if snapshot_backup is not None:
                snapshot_backup.close()

    report['changes'] = dict(sorted(changes.items()))
    if apply and (report['active_images_changed'] or report['snapshot_rows_changed']):
        report['backup_dir'] = str(backup_dir)
        (ensure_dir(backup_dir) / 'report.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8',
        )
    return report
