from __future__ import annotations

import json
import gzip
import shutil
from collections import defaultdict
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageChops

from app.annotations.geometry import parse_bbox, parse_polygon, polygon_area, union_bboxes
from app.annotations.parser import parse_image_annotations
from app.services.annotation_masks import annotation_mask_path, annotation_mask_url
from app.utils import atomic_write_json, ensure_dir, now_ts


_LEGACY_FIELDS = ('model_det_id', 'contour_index', 'contour_count')


def _order_key(indexed: tuple[int, dict[str, Any]]) -> tuple[int, int]:
    index, item = indexed
    value = item.get('contour_index')
    try:
        contour_index = int(value)
    except (TypeError, ValueError):
        contour_index = 1_000_000 + index
    return contour_index if contour_index > 0 else 1_000_000 + index, index


def _regions(records: Iterable[dict[str, Any]]) -> list[list[list[float]]]:
    regions: list[list[list[float]]] = []
    for item in records:
        multi = item.get('polygons')
        candidates = multi if isinstance(multi, list) and multi else [item.get('polygon')]
        for candidate in candidates:
            parsed, _issue = parse_polygon(candidate, field='polygon')
            if parsed:
                regions.append([[float(x), float(y)] for x, y in parsed])
    return regions


def _bbox_union(records: Iterable[dict[str, Any]], regions: list[list[list[float]]]) -> list[float]:
    boxes = []
    for item in records:
        for field in ('bbox', 'bbox_xyxy', 'box'):
            if item.get(field) not in (None, []):
                box, _issue = parse_bbox(item.get(field), field=field)
                if box:
                    boxes.append(box)
                break
    union = union_bboxes(boxes)
    if union:
        return [union.x1, union.y1, union.x2, union.y2]
    points = [point for region in regions for point in region]
    if not points:
        return []
    xs, ys = [point[0] for point in points], [point[1] for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def migrate_split_records(records: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Best-effort conversion of legacy component records into modern instances."""
    source = [dict(item) for item in records if isinstance(item, dict)] if isinstance(records, list) else []
    groups: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    standalone: list[tuple[int, dict[str, Any]]] = []
    for index, item in enumerate(source):
        model_id = str(item.get('model_det_id') or '').strip()
        is_split = item.get('contour_index') is not None or item.get('contour_count') is not None
        if model_id and is_split:
            groups[model_id].append((index, item))
        else:
            standalone.append((index, item))

    output: list[tuple[int, dict[str, Any]]] = []
    conflicts: list[dict[str, Any]] = []
    merged_groups: list[dict[str, Any]] = []
    for model_id, indexed in groups.items():
        ordered = [item for _index, item in sorted(indexed, key=_order_key)]
        merged = dict(ordered[0])
        regions = _regions(ordered)
        for field in _LEGACY_FIELDS:
            merged.pop(field, None)
        if regions:
            merged['polygons'] = regions
            merged['polygon'] = max(regions, key=lambda region: polygon_area(tuple((p[0], p[1]) for p in region)))
            merged['component_count'] = len(regions)
            merged['area'] = sum(polygon_area(tuple((p[0], p[1]) for p in region)) for region in regions)
        bbox = _bbox_union(ordered, regions)
        if bbox:
            merged['bbox'] = bbox

        class_values = [str(item.get('class_name') or item.get('label') or '').strip() for item in ordered]
        source_values = [str(item.get('source_model') or item.get('source') or '').strip() for item in ordered]
        for field, values in (('class_name', class_values), ('source_model', source_values)):
            nonempty = list(dict.fromkeys(value for value in values if value))
            if nonempty:
                merged[field] = nonempty[0]
            if len(nonempty) > 1:
                conflicts.append({'model_det_id': model_id, 'field': field, 'values': nonempty, 'chosen': nonempty[0]})

        output.append((indexed[0][0], merged))
        merged_groups.append({
            'model_det_id': model_id,
            'source_ids': [str(item.get('id') or '') for item in ordered],
            'target_id': str(merged.get('id') or ''),
            'record_count': len(ordered),
            'component_count': len(regions),
        })

    stripped_standalone = 0
    for index, item in standalone:
        modern = dict(item)
        if any(field in modern for field in _LEGACY_FIELDS):
            stripped_standalone += 1
        for field in _LEGACY_FIELDS:
            modern.pop(field, None)
        regions = _regions((modern,))
        if regions:
            modern['component_count'] = len(regions)
        output.append((index, modern))

    output.sort(key=lambda pair: pair[0])
    return [item for _index, item in output], {
        'changed': bool(groups or stripped_standalone),
        'merged_group_count': len(groups),
        'merged_record_count': sum(len(items) for items in groups.values()),
        'stripped_standalone_count': stripped_standalone,
        'groups': merged_groups,
        'conflicts': conflicts,
    }


def _merge_sidecars(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    groups: list[dict[str, Any]],
    backup_dir: Path,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for group in groups:
        source_ids = [value for value in group.get('source_ids', []) if str(value).strip()]
        target_id = str(group.get('target_id') or '').strip()
        paths = [annotation_mask_path(base_dir, project_id, image_id, str(value)) for value in source_ids]
        existing = [path for path in paths if path.is_file()]
        if not existing or not target_id:
            continue
        merged: Image.Image | None = None
        used: list[Path] = []
        for path in existing:
            try:
                with Image.open(path) as opened:
                    mask = opened.convert('L')
                if merged is None:
                    merged = mask
                elif mask.size == merged.size:
                    merged = ImageChops.lighter(merged, mask)
                else:
                    continue
                used.append(path)
            except OSError:
                continue
        if merged is None:
            continue
        target = annotation_mask_path(base_dir, project_id, image_id, target_id)
        mask_backup = ensure_dir(backup_dir / 'masks' / project_id / image_id)
        for path in used:
            shutil.copy2(path, mask_backup / path.name)
        merged.save(target, format='PNG')
        results.append({
            'target_id': target_id,
            'source_masks': [path.name for path in used],
            'area': int(sum(merged.histogram()[128:])),
            'mask_url': annotation_mask_url(project_id, image_id, target_id),
        })
    return results


def migrate_all_projects(storage: Any, *, apply: bool) -> dict[str, Any]:
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_dir = storage.base_dir / '.legacy-split-backups' / timestamp
    project_reports: list[dict[str, Any]] = []
    changed_images = 0
    # The normalized annotation JSON in SQLite is the storage source of truth.
    # Querying only records with legacy field names avoids opening every image
    # in large projects during this one-time migration.
    with storage._db_lock:
        connection = storage._db_connect()
        try:
            candidate_rows = connection.execute(
                '''
                SELECT project_id, image_id
                FROM image_annotations
                WHERE annotations_json LIKE '%"contour_index"%'
                   OR annotations_json LIKE '%"contour_count"%'
                ORDER BY project_id, image_id
                '''
            ).fetchall()
        finally:
            connection.close()
    candidates: dict[str, list[str]] = defaultdict(list)
    for row in candidate_rows:
        candidates[str(row['project_id'])].append(str(row['image_id']))

    for project_id, image_ids in candidates.items():
        project = storage.get_project(project_id, enrich=False, include_images=False)
        if not project:
            continue
        image_reports: list[dict[str, Any]] = []
        project_changed = 0
        project_merged_groups = 0
        project_merged_records = 0
        project_stripped = 0
        conflict_samples: list[dict[str, Any]] = []
        backup_stream = None
        write_connection = None
        read_connection = storage._db_connect()
        if apply:
            backup_path = ensure_dir(backup_dir / 'annotations') / f'{project_id}.jsonl.gz'
            backup_stream = gzip.open(backup_path, 'wt', encoding='utf-8')
            write_connection = storage._db_connect()
        for image_id in image_ids:
            row = read_connection.execute(
                'SELECT annotations_json FROM image_annotations WHERE project_id = ? AND image_id = ?',
                (project_id, image_id),
            ).fetchone()
            original = json.loads(str(row['annotations_json'] or '[]')) if row is not None else []
            migrated, details = migrate_split_records(original)
            if not details['changed']:
                continue
            changed_images += 1
            project_changed += 1
            project_merged_groups += int(details['merged_group_count'])
            project_merged_records += int(details['merged_record_count'])
            project_stripped += int(details['stripped_standalone_count'])
            if len(conflict_samples) < 20:
                conflict_samples.extend(details['conflicts'][:20 - len(conflict_samples)])
            sidecars: list[dict[str, Any]] = []
            if apply:
                assert backup_stream is not None and write_connection is not None
                backup_stream.write(json.dumps({'image_id': image_id, 'annotations': original}, ensure_ascii=False) + '\n')
                sidecars = _merge_sidecars(
                    base_dir=storage.base_dir,
                    project_id=project_id,
                    image_id=image_id,
                    groups=details['groups'],
                    backup_dir=backup_dir,
                )
                masks_by_id = {item['target_id']: item for item in sidecars}
                for annotation in migrated:
                    mask = masks_by_id.get(str(annotation.get('id') or ''))
                    if mask:
                        annotation['mask_url'] = mask['mask_url']
                        annotation['area'] = float(mask['area'])
                atomic_write_json(storage._annotation_path(project, image_id), migrated)
                storage._replace_annotations_db(project_id, image_id, migrated, conn=write_connection)
                storage._replace_annotation_ids_db(
                    project_id, image_id,
                    [str(item.get('id') or '') for item in migrated if str(item.get('id') or '')],
                    conn=write_connection,
                )
                storage._replace_annotation_index_db(project_id, image_id, migrated, conn=write_connection)
                if project_changed % 250 == 0:
                    write_connection.commit()
            if len(image_reports) < 5:
                image_reports.append({
                    'image_id': image_id,
                    'merged_group_count': details['merged_group_count'],
                    'merged_record_count': details['merged_record_count'],
                    'stripped_standalone_count': details['stripped_standalone_count'],
                    'conflict_count': len(details['conflicts']),
                    'sidecars': sidecars,
                })
        if backup_stream is not None:
            backup_stream.close()
        read_connection.close()
        if write_connection is not None:
            write_connection.commit()
            write_connection.close()
        if apply and project_changed:
            projects = storage._load_projects()
            for raw_project in projects:
                if str(raw_project.get('id') or '') == project_id:
                    storage._bump_content_rev(raw_project)
                    raw_project['updated_at'] = now_ts()
                    project = raw_project
                    break
            storage._save_projects(projects)
            storage._write_project_manifest(project)
            # Analytics is derivative. The content revision bump makes the old
            # generation stale and forces one canonical rebuild before use.
        if project_changed:
            project_reports.append({
                'project_id': project_id,
                'changed_images': project_changed,
                'merged_group_count': project_merged_groups,
                'merged_record_count': project_merged_records,
                'stripped_standalone_count': project_stripped,
                'conflict_samples': conflict_samples,
                'image_samples': image_reports,
            })
    report = {
        'applied': apply,
        'changed_images': changed_images,
        'backup_dir': str(backup_dir) if apply and changed_images else '',
        'projects': project_reports,
    }
    if apply and changed_images:
        (ensure_dir(backup_dir) / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def strip_model_det_id(records: Any) -> tuple[list[Any], int]:
    """Remove legacy producer tracking without changing annotation semantics."""
    source = records if isinstance(records, list) else []
    cleaned: list[Any] = []
    removed = 0
    for raw in source:
        if not isinstance(raw, dict):
            cleaned.append(raw)
            continue
        item = dict(raw)
        if 'model_det_id' in item:
            item.pop('model_det_id', None)
            removed += 1
        cleaned.append(item)
    return cleaned, removed


def cleanup_model_det_ids(
    storage: Any,
    *,
    apply: bool,
    include_snapshots: bool = True,
) -> dict[str, Any]:
    """Strip ``model_det_id`` from active annotations and rollback snapshots.

    The field is consumed-but-ignored by the canonical parser.  Every active
    image is parsed before and after the rewrite and is only written when the
    canonical projection is identical.  SQL derivative indexes are left
    untouched because this cleanup cannot change their inputs.
    """
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_dir = storage.base_dir / '.model-det-id-backups' / timestamp
    lock = storage._catalog_write_lock if apply else nullcontext()
    active_candidates = 0
    active_candidate_annotations = 0
    active_images_cleaned = 0
    active_annotations_cleaned = 0
    snapshot_candidates = 0
    snapshot_candidate_annotations = 0
    snapshot_rows_cleaned = 0
    snapshot_annotations_cleaned = 0
    changed_projects: set[str] = set()
    failures: list[dict[str, Any]] = []

    with lock:
        with storage._db_lock:
            read_connection = storage._db_connect()
            try:
                active_rows = read_connection.execute(
                    '''
                    SELECT project_id, image_id, annotations_json
                    FROM image_annotations
                    WHERE annotations_json LIKE '%"model_det_id"%'
                    ORDER BY project_id, image_id
                    '''
                ).fetchall()
                snapshot_rows = []
                if include_snapshots:
                    snapshot_rows = read_connection.execute(
                        '''
                        SELECT run_id, project_id, image_id, annotations_json
                        FROM smart_filter_snapshots
                        WHERE annotations_json LIKE '%"model_det_id"%'
                        ORDER BY project_id, run_id, image_id
                        '''
                    ).fetchall()
            finally:
                read_connection.close()

        projects = {
            str(project.get('id') or ''): project
            for project in storage._load_projects()
            if str(project.get('id') or '')
        }
        active_backup = None
        snapshot_backup = None
        write_connection = storage._db_connect() if apply else None
        try:
            if apply and active_rows:
                active_backup = gzip.open(
                    ensure_dir(backup_dir) / 'active_annotations.jsonl.gz',
                    'wt',
                    encoding='utf-8',
                )
            if apply and snapshot_rows:
                snapshot_backup = gzip.open(
                    ensure_dir(backup_dir) / 'smart_filter_snapshots.jsonl.gz',
                    'wt',
                    encoding='utf-8',
                )

            for row in active_rows:
                project_id = str(row['project_id'])
                image_id = str(row['image_id'])
                try:
                    original = json.loads(str(row['annotations_json'] or '[]'))
                    cleaned, removed = strip_model_det_id(original)
                    if removed <= 0:
                        continue
                    if parse_image_annotations(original) != parse_image_annotations(cleaned):
                        raise ValueError('canonical annotations changed after removing model_det_id')
                    active_candidates += 1
                    active_candidate_annotations += removed
                    if not apply:
                        continue
                    project = projects.get(project_id)
                    if project is None:
                        raise ValueError('project not found in catalog')
                    assert active_backup is not None and write_connection is not None
                    active_backup.write(json.dumps({
                        'project_id': project_id,
                        'image_id': image_id,
                        'annotations': original,
                    }, ensure_ascii=False) + '\n')
                    atomic_write_json(storage._annotation_path(project, image_id), cleaned)
                    storage._replace_annotations_db(
                        project_id,
                        image_id,
                        cleaned,
                        conn=write_connection,
                        updated_at=now_ts(),
                    )
                    active_images_cleaned += 1
                    active_annotations_cleaned += removed
                    changed_projects.add(project_id)
                    if active_candidates % 250 == 0:
                        write_connection.commit()
                except Exception as exc:  # noqa: BLE001
                    failures.append({
                        'scope': 'active_annotation',
                        'project_id': project_id,
                        'image_id': image_id,
                        'error': str(exc),
                    })

            for row in snapshot_rows:
                run_id = str(row['run_id'])
                project_id = str(row['project_id'])
                image_id = str(row['image_id'])
                try:
                    original = json.loads(str(row['annotations_json'] or '[]'))
                    cleaned, removed = strip_model_det_id(original)
                    if removed <= 0:
                        continue
                    if parse_image_annotations(original) != parse_image_annotations(cleaned):
                        raise ValueError('canonical snapshot changed after removing model_det_id')
                    snapshot_candidates += 1
                    snapshot_candidate_annotations += removed
                    if not apply:
                        continue
                    assert snapshot_backup is not None and write_connection is not None
                    snapshot_backup.write(json.dumps({
                        'run_id': run_id,
                        'project_id': project_id,
                        'image_id': image_id,
                        'annotations': original,
                    }, ensure_ascii=False) + '\n')
                    write_connection.execute(
                        '''
                        UPDATE smart_filter_snapshots
                        SET annotations_json = ?
                        WHERE run_id = ? AND project_id = ? AND image_id = ?
                        ''',
                        (
                            storage._json_dumps_db(cleaned),
                            run_id,
                            project_id,
                            image_id,
                        ),
                    )
                    snapshot_rows_cleaned += 1
                    snapshot_annotations_cleaned += removed
                    if snapshot_candidates % 250 == 0:
                        write_connection.commit()
                except Exception as exc:  # noqa: BLE001
                    failures.append({
                        'scope': 'smart_filter_snapshot',
                        'run_id': run_id,
                        'project_id': project_id,
                        'image_id': image_id,
                        'error': str(exc),
                    })

            if write_connection is not None:
                write_connection.commit()
        finally:
            if active_backup is not None:
                active_backup.close()
            if snapshot_backup is not None:
                snapshot_backup.close()
            if write_connection is not None:
                write_connection.close()

        if apply and changed_projects:
            catalog = storage._load_projects()
            changed_manifests: list[dict[str, Any]] = []
            for project in catalog:
                if str(project.get('id') or '') not in changed_projects:
                    continue
                storage._bump_content_rev(project)
                project['updated_at'] = now_ts()
                changed_manifests.append(project)
            storage._save_projects(catalog)
            for project in changed_manifests:
                storage._write_project_manifest(project)

        residual_active_rows = 0
        residual_snapshot_rows = 0
        if apply:
            with storage._db_lock:
                verify_connection = storage._db_connect()
                try:
                    residual_active_rows = int(verify_connection.execute(
                        '''
                        SELECT COUNT(*)
                        FROM image_annotations
                        WHERE annotations_json LIKE '%"model_det_id"%'
                        '''
                    ).fetchone()[0])
                    if include_snapshots:
                        residual_snapshot_rows = int(verify_connection.execute(
                            '''
                            SELECT COUNT(*)
                            FROM smart_filter_snapshots
                            WHERE annotations_json LIKE '%"model_det_id"%'
                            '''
                        ).fetchone()[0])
                finally:
                    verify_connection.close()

    report = {
        'applied': apply,
        'include_snapshots': include_snapshots,
        'active_candidate_images': active_candidates,
        'active_candidate_annotations': active_candidate_annotations,
        'active_images_cleaned': active_images_cleaned,
        'active_annotations_cleaned': active_annotations_cleaned,
        'snapshot_candidate_rows': snapshot_candidates,
        'snapshot_candidate_annotations': snapshot_candidate_annotations,
        'snapshot_rows_cleaned': snapshot_rows_cleaned,
        'snapshot_annotations_cleaned': snapshot_annotations_cleaned,
        'residual_active_rows': residual_active_rows,
        'residual_snapshot_rows': residual_snapshot_rows,
        'changed_projects': sorted(changed_projects),
        'failure_count': len(failures),
        'failures': failures[:100],
        'backup_dir': str(backup_dir) if apply and (active_candidates or snapshot_candidates) else '',
    }
    if apply and (active_candidates or snapshot_candidates):
        (ensure_dir(backup_dir) / 'report.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
    return report
