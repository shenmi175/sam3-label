from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

WEB_AUTO_ROOT = Path(__file__).resolve().parents[1]
if str(WEB_AUTO_ROOT) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO_ROOT))

from app.schemas import SmartFilterIn
from app.services.annotation_masks import annotation_mask_path
from app.services.job_queue import PersistentJobQueue
from app.services.smart_filter_service import SmartFilterJobService
from app.storage import Storage


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def annotation_total(storage: Storage, project_id: str) -> int:
    conn = sqlite3.connect(str(storage.index_db_file))
    try:
        row = conn.execute('SELECT SUM(annotation_count) FROM image_annotations WHERE project_id=?', (project_id,)).fetchone()
        return int(row[0] or 0)
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default=str(Path(__file__).resolve().parents[1] / 'data'))
    parser.add_argument('--project-id', default='prj_61492c95b05d')
    parser.add_argument('--image-id', default='222127a567f9573b')
    parser.add_argument('--writable-clone', action='store_true', help='clone the target image/annotations into a temporary writable project')
    args = parser.parse_args()

    storage = Storage(Path(args.data_dir).resolve())
    project_id = args.project_id
    image_id = args.image_id
    clone_temp: tempfile.TemporaryDirectory[str] | None = None
    if args.writable_clone:
        source_storage = storage
        source_project = source_storage.get_project(project_id, enrich=False, include_images=True)
        if not source_project:
            raise SystemExit('source project not found')
        source_image = source_storage.find_image(source_project, image_id)
        if not source_image:
            raise SystemExit('source image not found')
        source_annotations = source_storage.load_annotations(project_id, image_id)
        clone_temp = tempfile.TemporaryDirectory(prefix='component-noise-project-clone-')
        clone_root = Path(clone_temp.name)
        clone_images = clone_root / 'images'
        clone_images.mkdir()
        shutil.copy2(str(source_image['abs_path']), clone_images / Path(str(source_image['rel_path'])).name)
        storage = Storage(clone_root / 'data')
        clone_project = storage.create_project(name='component-noise-clone', image_dir=str(clone_images), save_dir=str(clone_root / 'output'), classes_text='chair,floor,stool,sofa,table,person')
        project_id = str(clone_project['id'])
        image_id = str(storage.get_project(project_id, include_images=True)['images'][0]['id'])
        storage.save_annotations(project_id, image_id, source_annotations)
        for ann in source_annotations:
            ann_id = str(ann.get('id') or '')
            source_mask = annotation_mask_path(source_storage.base_dir, args.project_id, args.image_id, ann_id)
            if source_mask.is_file():
                target_mask = annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)
                shutil.copy2(source_mask, target_mask)

    project = storage.get_project(project_id, enrich=False, include_images=False)
    if not project:
        raise SystemExit('project not found')
    original_annotations = storage.load_annotations(project_id, image_id)
    annotation_path = storage._annotation_read_path(project, image_id)  # acceptance audit of the real file
    json_hash_before = sha256(annotation_path)
    mask_hashes_before = {
        str(ann['id']): sha256(annotation_mask_path(storage.base_dir, project_id, image_id, str(ann['id'])))
        for ann in original_annotations
        if annotation_mask_path(storage.base_dir, project_id, image_id, str(ann.get('id') or '')).is_file()
    }
    total_before = annotation_total(storage, project_id)
    identity_before = [
        (ann.get('id'), ann.get('class_name'), ann.get('score'), ann.get('confidence')) for ann in original_annotations
    ]

    with tempfile.TemporaryDirectory(prefix='component-noise-acceptance-') as temporary:
        queue = PersistentJobQueue(Path(temporary) / 'jobs.sqlite3')
        service = SmartFilterJobService(get_storage=lambda: storage, logger=logging.getLogger('acceptance'), queue=queue)
        payload = SmartFilterIn(project_id=project_id, operation_mode='component_noise').model_dump()
        preview = service.run_preview_job(payload, lambda **_updates: None)
        entry = preview.pop('_preview_entry')
        preview_job = queue.enqueue(
            project_id=project_id,
            job_type='smart_filter:preview',
            resource_class='cpu',
            payload=payload,
            state={'status': 'done', 'running': False},
        )
        queue.update(str(preview_job['job_id']), preview_entry=entry, status='done', running=False)
        print('preview', json.dumps({key: preview.get(key) for key in ('image_count', 'modified_annotations', 'removed_components', 'removed_pixels', 'sample_urls')}, ensure_ascii=False))
        assert (preview['image_count'], preview['modified_annotations'], preview['removed_components'], preview['removed_pixels']) == (1, 5, 33, 727)

        apply_payload = {**payload, 'preview_token': preview['preview_token'], '_job_id': 'acceptance-apply'}
        applied = service.run_apply_job(apply_payload, lambda **_updates: None)
        after_annotations = storage.load_annotations(project_id, image_id)
        identity_after = [(ann.get('id'), ann.get('class_name'), ann.get('score'), ann.get('confidence')) for ann in after_annotations]
        print('apply', json.dumps({key: applied.get(key) for key in ('changed_images', 'modified_annotations', 'removed_components', 'removed_pixels', 'rollback_run_id')}, ensure_ascii=False))
        assert identity_after == identity_before
        assert annotation_total(storage, project_id) == total_before
        if not args.writable_clone:
            assert total_before == 3306
        assert any(sha256(annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)) != digest for ann_id, digest in mask_hashes_before.items())

        rollback = storage.rollback_smart_filter_run(project_id=project_id, run_id=str(applied['rollback_run_id']))
        print('rollback', json.dumps(rollback, ensure_ascii=False))
        assert rollback['restored_images'] == 1 and rollback['skipped_images'] == 0
        assert sha256(annotation_path) == json_hash_before
        assert annotation_total(storage, project_id) == total_before
        for ann_id, digest in mask_hashes_before.items():
            assert sha256(annotation_mask_path(storage.base_dir, project_id, image_id, ann_id)) == digest

        variants = {
            'relative_only': {'component_abs_area_enabled': False},
            'absolute_only': {'component_relative_area_enabled': False},
            'or': {'component_require_all_thresholds': False},
        }
        variant_stats = {}
        for name, changes in variants.items():
            variant_payload = {**payload, **changes}
            result = service.run_preview_job(variant_payload, lambda **_updates: None)
            result.pop('_preview_entry', None)
            variant_stats[name] = {
                key: result.get(key) for key in ('image_count', 'modified_annotations', 'removed_components', 'removed_pixels')
            }
        print('variants', json.dumps(variant_stats, ensure_ascii=False, sort_keys=True))

    print(json.dumps({'status': 'ok', 'annotation_total': total_before, 'json_sha256': json_hash_before, 'mask_count': len(mask_hashes_before)}, ensure_ascii=False))
    if clone_temp is not None:
        clone_temp.cleanup()


if __name__ == '__main__':
    main()
