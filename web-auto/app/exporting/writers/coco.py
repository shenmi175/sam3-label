from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.exporting.artifacts import publish_unique_directory, publish_unique_file, temporary_zip_path, validate_annotation_only_archive
from app.exporting.image_assets import materialize_images, validate_materialized_images
from app.exporting.models import ExportImage, ExportSnapshot
from app.repositories.project_files import ProjectFileRepository


SCHEMA = 'web-auto.coco-per-image.v1'


def _rounded(values: list[float]) -> list[float]:
    return [round(float(value), 6) for value in values]


def _categories(snapshot: ExportSnapshot) -> list[dict[str, Any]]:
    return [{'id': index + 1, 'name': name} for index, name in enumerate(snapshot.selected_classes)]


def _image_payload(
    snapshot: ExportSnapshot,
    image: ExportImage,
    *,
    image_index: int,
    created_at: datetime,
    export_image_path: str | None = None,
) -> dict[str, Any]:
    if image.width is None or image.height is None:
        raise ValueError(f'image dimensions unavailable: {image.image_id}')
    categories = _categories(snapshot)
    class_ids = {item['name']: item['id'] for item in categories}
    annotations: list[dict[str, Any]] = []
    for annotation_id, instance in enumerate(image.instances, start=1):
        x1, y1, x2, y2 = instance.bbox_xyxy
        annotation: dict[str, Any] = {
            'id': annotation_id,
            'image_id': image_index,
            'category_id': class_ids[instance.class_name],
            'bbox': _rounded([x1, y1, x2 - x1, y2 - y1]),
            'area': round(float(instance.area), 6),
            'iscrowd': 0,
        }
        if snapshot.profile == 'coco_instance':
            annotation['segmentation'] = [
                _rounded([coordinate for point in region.polygon for coordinate in point])
                for region in instance.regions
            ]
        annotations.append(annotation)
    return {
        'info': {
            'description': snapshot.project_name or 'web-auto',
            'version': '1.0',
            'date_created': created_at.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
        },
        'images': [{
            'id': image_index,
            'file_name': export_image_path or image.image_rel_path,
            'width': image.width,
            'height': image.height,
        }],
        'annotations': annotations,
        'categories': categories,
    }


def validate_coco(path: Path, *, instance_profile: bool) -> None:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if len(payload.get('images', [])) != 1:
        raise ValueError('per-image COCO document must contain exactly one image')
    image_ids = {item['id'] for item in payload['images']}
    category_ids = {item['id'] for item in payload['categories']}
    for annotation in payload['annotations']:
        if annotation['image_id'] not in image_ids or annotation['category_id'] not in category_ids:
            raise ValueError('COCO annotation contains a dangling image or category reference')
        bbox = annotation.get('bbox')
        if not isinstance(bbox, list) or len(bbox) != 4 or bbox[2] <= 0 or bbox[3] <= 0:
            raise ValueError('COCO annotation contains an invalid bbox')
        if float(annotation.get('area', 0)) <= 0:
            raise ValueError('COCO annotation contains an invalid area')
        if instance_profile and not annotation.get('segmentation'):
            raise ValueError('COCO instance annotation contains no segmentation')

    try:
        from pycocotools.coco import COCO
    except ImportError:
        return
    with contextlib.redirect_stdout(io.StringIO()):
        loaded = COCO(str(path))
    if len(loaded.getAnnIds()) != len(payload['annotations']):
        raise ValueError('pycocotools did not load every COCO annotation')
    for annotation_id in loaded.getAnnIds():
        annotation = loaded.loadAnns([annotation_id])[0]
        if instance_profile:
            loaded.annToRLE(annotation)


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def write_coco(*, snapshot: ExportSnapshot, output_dir: Path, created_at: datetime) -> tuple[Path, dict[str, Any]]:
    if snapshot.profile not in {'coco_detection', 'coco_instance'}:
        raise ValueError('invalid COCO profile')
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = ''.join(char if char.isalnum() or char in '._-' else '_' for char in snapshot.project_name).strip('._') or 'project'
    output_name = f"{stem}_{snapshot.profile}_{created_at.strftime('%Y%m%d_%H%M%S')}"
    retains_images = snapshot.image_mode != 'none'
    requested_path = output_dir / (output_name if retains_images else f'{output_name}.zip')
    working = Path(tempfile.mkdtemp(prefix='.web-auto-coco-package-', dir=output_dir))
    temporary_archive = None if retains_images else temporary_zip_path(output_dir)
    relative_paths = ProjectFileRepository.annotation_relative_paths([
        {'id': image.image_id, 'rel_path': image.image_rel_path} for image in snapshot.images
    ])
    exported_image_paths = {
        image.image_id: Path('images') / Path(image.image_rel_path)
        for image in snapshot.images
    }
    image_index_entries: list[dict[str, Any]] = []
    manifest: dict[str, Any] = {}
    try:
        for image_index, image in enumerate(snapshot.images, start=1):
            annotation_relative = Path('annotations') / relative_paths[image.image_id]
            annotation_path = working / annotation_relative
            annotation_path.parent.mkdir(parents=True, exist_ok=True)
            export_image_path = exported_image_paths[image.image_id].as_posix() if retains_images else None
            payload = _image_payload(
                snapshot,
                image,
                image_index=image_index,
                created_at=created_at,
                export_image_path=export_image_path,
            )
            annotation_path.write_text(_json_text(payload), encoding='utf-8')
            validate_coco(annotation_path, instance_profile=snapshot.profile == 'coco_instance')
            image_index_entries.append({
                'image_id': image.image_id,
                'image_rel_path': image.image_rel_path,
                **({'export_image_path': export_image_path} if export_image_path else {}),
                'annotation_path': annotation_relative.as_posix(),
                'width': image.width,
                'height': image.height,
                'instance_count': len(image.instances),
            })

        if retains_images:
            materialize_images(
                root=working,
                images=snapshot.images,
                relative_paths=exported_image_paths,
                mode=snapshot.image_mode,
            )
            validate_materialized_images(
                root=working,
                images=snapshot.images,
                relative_paths=exported_image_paths,
                mode=snapshot.image_mode,
            )

        manifest = {
            'schema': SCHEMA,
            'profile': snapshot.profile,
            'annotation_only': not retains_images,
            'image_mode': snapshot.image_mode,
            'image_binaries_included': snapshot.image_mode == 'copy',
            'image_symlinks_included': snapshot.image_mode == 'symlink',
            'per_image_annotations': True,
            'created_at': created_at.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'project': {'id': snapshot.project_id, 'name': snapshot.project_name, 'content_rev': snapshot.project_content_rev},
            'filters': {'source_models': snapshot.source_models, 'classes': snapshot.selected_classes},
            'stats': snapshot.stats.as_dict(),
            'warnings': [issue.as_dict() for issue in snapshot.warnings],
        }
        (working / 'classes.json').write_text(_json_text({'schema': SCHEMA, 'categories': _categories(snapshot)}), encoding='utf-8')
        (working / 'image_index.json').write_text(_json_text({'schema': SCHEMA, 'images': image_index_entries}), encoding='utf-8')
        (working / 'manifest.json').write_text(_json_text(manifest), encoding='utf-8')
        image_note = (
            'Images under images/ are absolute symlinks to the original project files.\n'
            if snapshot.image_mode == 'symlink' else
            'Original image binaries were copied under images/; this directory is portable.\n'
            if snapshot.image_mode == 'copy' else
            'No original image, mask, overlay, or other image binary is included.\n'
        )
        (working / 'README.txt').write_text(
            'Web Auto per-image COCO export\n'
            'Each annotations/*.json file is a standalone one-image COCO document.\n'
            f'{image_note}',
            encoding='utf-8',
        )
        if retains_images:
            target = publish_unique_directory(working, requested_path)
        else:
            if temporary_archive is None:
                raise ValueError('COCO temporary archive is unavailable')
            with zipfile.ZipFile(temporary_archive, mode='w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
                for path in sorted(working.rglob('*')):
                    if path.is_file():
                        bundle.write(path, path.relative_to(working).as_posix())
            validate_annotation_only_archive(temporary_archive)
            with zipfile.ZipFile(temporary_archive, mode='r') as bundle:
                archived_files = {name for name in bundle.namelist() if not name.endswith('/')}
            expected_files = {path.relative_to(working).as_posix() for path in working.rglob('*') if path.is_file()}
            if archived_files != expected_files:
                raise ValueError('COCO archive and validated per-image documents do not match')
            target = publish_unique_file(temporary_archive, requested_path)
    except Exception:
        if temporary_archive is not None:
            temporary_archive.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(working, ignore_errors=True)
    return target, manifest
