from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.exporting.artifacts import publish_unique_directory, validate_annotation_only_archive
from app.exporting.image_assets import materialize_images, validate_materialized_images
from app.exporting.models import ExportSnapshot
from app.repositories.project_files import ProjectFileRepository


SCHEMA = 'web-auto.annotation-bundle.v2'


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def _documents(snapshot: ExportSnapshot, created: datetime) -> tuple[dict[str, bytes], dict[str, Any], dict[str, Path]]:
    written_images = list(snapshot.images)
    relative_paths = ProjectFileRepository.annotation_relative_paths(
        [{'id': image.image_id, 'rel_path': image.image_rel_path} for image in written_images]
    )
    exported_image_paths = {
        image.image_id: Path('images') / Path(image.image_rel_path)
        for image in written_images
    }
    documents: dict[str, bytes] = {}
    image_index: list[dict[str, Any]] = []
    for image in written_images:
        relative = relative_paths.get(image.image_id)
        if relative is None:
            raise ValueError(f'annotation path unavailable for image: {image.image_id}')
        annotation_path = (Path('annotations') / relative).as_posix()
        documents[annotation_path] = _json_bytes({
            'schema': SCHEMA,
            'image': {
                'image_id': image.image_id,
                'image_rel_path': image.image_rel_path,
                **(
                    {'export_image_path': exported_image_paths[image.image_id].as_posix()}
                    if snapshot.image_mode != 'none' else {}
                ),
                'width': image.width,
                'height': image.height,
            },
            'instances': [instance.as_dict() for instance in image.instances],
        })
        image_index.append({
            'image_id': image.image_id,
            'image_rel_path': image.image_rel_path,
            **(
                {'export_image_path': exported_image_paths[image.image_id].as_posix()}
                if snapshot.image_mode != 'none' else {}
            ),
            'annotation_path': annotation_path,
            'width': image.width,
            'height': image.height,
            'instance_count': len(image.instances),
        })

    class_entries = [
        {'id': index + 1, 'name': name}
        for index, name in enumerate(snapshot.selected_classes)
    ]
    manifest = {
        'schema': SCHEMA,
        'version': 2,
        'profile': 'native_json_v2',
        'annotation_only': snapshot.image_mode == 'none',
        'image_mode': snapshot.image_mode,
        'created_at': created.isoformat().replace('+00:00', 'Z'),
        'project': {
            'id': snapshot.project_id,
            'name': snapshot.project_name,
            'content_rev': snapshot.project_content_rev,
        },
        'filters': {
            'source_models': list(snapshot.source_models),
            'classes': list(snapshot.selected_classes),
        },
        'layout': {
            'annotations_root': 'annotations/',
            'images_root': 'images/' if snapshot.image_mode != 'none' else None,
            'per_image_format': 'normalized_instance_document',
            'image_binaries_included': snapshot.image_mode == 'copy',
            'image_symlinks_included': snapshot.image_mode == 'symlink',
        },
        'stats': snapshot.stats.as_dict(),
        'warnings': [warning.as_dict() for warning in snapshot.warnings],
    }
    documents['classes.json'] = _json_bytes({'schema': SCHEMA, 'classes': class_entries})
    documents['image_index.json'] = _json_bytes({'schema': SCHEMA, 'images': image_index})
    documents['manifest.json'] = _json_bytes(manifest)
    if snapshot.image_mode == 'symlink':
        readme = 'Images under images/ are absolute symlinks to the original project files.\n'
    elif snapshot.image_mode == 'copy':
        readme = 'Original image binaries were copied under images/; this directory is portable.\n'
    else:
        readme = 'No image, mask, overlay, or other image binary is included.\n'
    documents['README.txt'] = (
        'Web Auto native JSON v2 export\n'
        'This output contains normalized annotations and project image references.\n'
        f'{readme}'
    ).encode('utf-8')
    return documents, manifest, exported_image_paths


def write_native_json_v2(
    *,
    snapshot: ExportSnapshot,
    archive_path: Path,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    if not snapshot.ok:
        raise ValueError('cannot build an export with preflight blockers')
    created = (created_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    documents, manifest, _exported_image_paths = _documents(snapshot, created)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path, mode='w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
        for relative, content in documents.items():
            bundle.writestr(relative, content)

    validate_annotation_only_archive(archive_path)
    return manifest


def write_native_json_v2_directory(
    *,
    snapshot: ExportSnapshot,
    output_dir: Path,
    created_at: datetime,
    filename_stem: str,
) -> tuple[Path, dict[str, Any]]:
    if snapshot.image_mode == 'none':
        raise ValueError('native JSON directory export requires retained images')
    output_dir.mkdir(parents=True, exist_ok=True)
    requested = output_dir / f"{filename_stem}_native_json_v2_{created_at.strftime('%Y%m%d_%H%M%S')}"
    working = Path(tempfile.mkdtemp(prefix='.web-auto-native-package-', dir=output_dir))
    try:
        documents, manifest, exported_image_paths = _documents(snapshot, created_at.astimezone(timezone.utc))
        for relative, content in documents.items():
            target = working / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
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
        target = publish_unique_directory(working, requested)
    except Exception:
        raise
    finally:
        shutil.rmtree(working, ignore_errors=True)
    return target, manifest
