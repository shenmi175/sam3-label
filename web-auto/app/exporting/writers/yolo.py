from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.exporting.artifacts import publish_unique_file, temporary_zip_path, unique_output_path
from app.exporting.models import ExportImage, ExportInstance, ExportSnapshot
from app.repositories.project_files import ProjectFileRepository


ULTRALYTICS_MERGE_MULTI_SEGMENT_COMPAT = '8.3.203'


def _min_index(segment1: np.ndarray, segment2: np.ndarray) -> tuple[int, int]:
    distances = ((segment1[:, None, :] - segment2[None, :, :]) ** 2).sum(axis=2)
    return tuple(int(value) for value in np.unravel_index(np.argmin(distances), distances.shape))


def merge_multi_segment(segments: list[list[list[float]]]) -> list[list[float]]:
    """Ultralytics' official two-pass shortest-point multipart bridge."""
    if len(segments) == 1:
        return [[float(x), float(y)] for x, y in segments[0]]
    arrays = [np.asarray(segment, dtype=np.float64) for segment in segments]
    indexes: list[list[int]] = [[] for _ in arrays]
    for index in range(1, len(arrays)):
        first, second = _min_index(arrays[index - 1], arrays[index])
        indexes[index - 1].append(first)
        indexes[index].append(second)

    output: list[np.ndarray] = []
    for pass_index in range(2):
        if pass_index == 0:
            for index, points in enumerate(indexes):
                if len(points) == 2 and points[0] > points[1]:
                    points = points[::-1]
                    arrays[index] = arrays[index][::-1, :]
                arrays[index] = np.roll(arrays[index], -points[0], axis=0)
                arrays[index] = np.concatenate([arrays[index], arrays[index][:1]])
                if index in {0, len(indexes) - 1}:
                    output.append(arrays[index])
                else:
                    distance = points[1] - points[0]
                    output.append(arrays[index][: distance + 1])
        else:
            for index in range(1, len(indexes) - 1):
                points = indexes[index]
                distance = points[1] - points[0]
                if distance:
                    output.append(arrays[index][distance:])
    return np.concatenate(output, axis=0).astype(float).tolist()


def bridge_metrics(image: ExportImage, instance: ExportInstance) -> dict[str, Any]:
    if image.width is None or image.height is None:
        raise ValueError('image dimensions are required for YOLO bridge metrics')
    polygons = [region.polygon for region in instance.regions]
    merged = merge_multi_segment(polygons)
    before = np.zeros((image.height, image.width), dtype=np.uint8)
    after = np.zeros_like(before)
    cv2.fillPoly(before, [np.rint(np.asarray(poly)).astype(np.int32) for poly in polygons], 1)
    cv2.fillPoly(after, [np.rint(np.asarray(merged)).astype(np.int32)], 1)
    intersection = int(np.logical_and(before, after).sum())
    union = int(np.logical_or(before, after).sum())
    before_area = int(before.sum())
    after_area = int(after.sum())
    return {
        'image_id': image.image_id,
        'instance_id': instance.instance_id,
        'regions': len(polygons),
        'connections': len(polygons) - 1,
        'added_pixels': int(np.logical_and(after, np.logical_not(before)).sum()),
        'intersection_pixels': intersection,
        'union_pixels': union,
        'before_area_pixels': before_area,
        'after_area_pixels': after_area,
        'iou': round(intersection / union, 6) if union else 1.0,
        'area_change_ratio': round((after_area - before_area) / before_area, 6) if before_area else 0.0,
    }


def summarize_bridges(images: list[ExportImage]) -> dict[str, Any]:
    samples = [bridge_metrics(image, instance) for image in images for instance in image.instances if len(instance.regions) > 1]
    before = sum(item['before_area_pixels'] for item in samples)
    after = sum(item['after_area_pixels'] for item in samples)
    intersection = sum(item['intersection_pixels'] for item in samples)
    union = sum(item['union_pixels'] for item in samples)
    return {
        'ultralytics_compat_version': ULTRALYTICS_MERGE_MULTI_SEGMENT_COMPAT,
        'affected_instances': len(samples),
        'connections': sum(item['connections'] for item in samples),
        'added_pixels': sum(item['added_pixels'] for item in samples),
        'before_area_pixels': before,
        'after_area_pixels': after,
        'iou': round(intersection / union, 6) if union else 1.0,
        'area_change_ratio': round((after - before) / before, 6) if before else 0.0,
        'samples': samples[:20],
    }


def _split(image_id: str, val_ratio: float) -> str:
    digest = hashlib.sha1(image_id.encode('utf-8')).hexdigest()[:8]
    bucket = int(digest, 16) / float(0xFFFFFFFF)
    return 'val' if val_ratio > 0 and bucket < val_ratio else 'train'


def _format(value: float) -> str:
    rounded = min(1.0, max(0.0, value))
    return f'{rounded:.6f}'


def _training_image_paths(images: list[ExportImage]) -> dict[str, Path]:
    """Return image paths whose corresponding YOLO label stems are unique."""
    groups: dict[tuple[str, str], list[ExportImage]] = {}
    for image in images:
        relative = Path(image.image_rel_path)
        groups.setdefault((relative.parent.as_posix().casefold(), relative.stem.casefold()), []).append(image)
    paths: dict[str, Path] = {}
    for image in images:
        relative = Path(image.image_rel_path)
        group = groups[(relative.parent.as_posix().casefold(), relative.stem.casefold())]
        if len(group) > 1:
            digest = hashlib.sha1(image.image_id.encode('utf-8')).hexdigest()[:8]
            relative = relative.with_name(f'{relative.stem}__{digest}{relative.suffix}')
        paths[image.image_id] = relative
    return paths


def _data_yaml(snapshot: ExportSnapshot) -> str:
    names = '\n'.join(
        f'  {index}: {json.dumps(name, ensure_ascii=False)}'
        for index, name in enumerate(snapshot.selected_classes)
    )
    return (
        'train: images/train\n'
        'val: images/val\n'
        f'names:\n{names}\n'
    )


def _label_lines(snapshot: ExportSnapshot, image: ExportImage) -> list[str]:
    if image.width is None or image.height is None:
        raise ValueError(f'image dimensions unavailable: {image.image_id}')
    class_ids = {name: index for index, name in enumerate(snapshot.selected_classes)}
    lines: list[str] = []
    for instance in image.instances:
        class_id = class_ids[instance.class_name]
        if snapshot.profile == 'yolo_detection':
            x1, y1, x2, y2 = instance.bbox_xyxy
            lines.append(' '.join([
                str(class_id),
                _format(((x1 + x2) / 2) / image.width),
                _format(((y1 + y2) / 2) / image.height),
                _format((x2 - x1) / image.width),
                _format((y2 - y1) / image.height),
            ]))
        else:
            polygons = [region.polygon for region in instance.regions]
            polygon = polygons[0] if len(polygons) == 1 else merge_multi_segment(polygons)
            values = [str(class_id)]
            for x, y in polygon:
                values.extend((_format(x / image.width), _format(y / image.height)))
            lines.append(' '.join(values))
    return lines


def _validate_directory(root: Path, snapshot: ExportSnapshot, image_index: list[dict[str, Any]]) -> None:
    indexed_labels = {item['label_path'] for item in image_index}
    actual_labels = {path.relative_to(root).as_posix() for path in (root / 'labels').rglob('*.txt')}
    if indexed_labels != actual_labels:
        raise ValueError('YOLO image index and label files do not match')
    for relative in indexed_labels:
        for raw_line in (root / relative).read_text(encoding='utf-8').splitlines():
            fields = raw_line.split()
            if snapshot.profile == 'yolo_detection' and len(fields) != 5:
                raise ValueError('invalid YOLO detection record')
            if snapshot.profile == 'yolo_instance' and (len(fields) < 7 or (len(fields) - 1) % 2):
                raise ValueError('invalid YOLO instance record')
            class_id = int(fields[0])
            if class_id < 0 or class_id >= len(snapshot.selected_classes):
                raise ValueError('invalid YOLO class id')
            coordinates = [float(value) for value in fields[1:]]
            if any(value < 0 or value > 1 for value in coordinates):
                raise ValueError('YOLO coordinate is outside [0, 1]')
    if not (root / 'manifest.json').is_file() or not (root / 'image_index.json').is_file():
        raise ValueError('YOLO manifest is incomplete')
    for split in ('train', 'val'):
        expected = [item['training_image_path'] for item in image_index if item['split'] == split]
        actual = (root / f'{split}.txt').read_text(encoding='utf-8').splitlines()
        if actual != expected:
            raise ValueError(f'YOLO {split} split and image index do not match')
    allowed_top_level = {'labels', 'classes.txt', 'train.txt', 'val.txt', 'image_index.json', 'manifest.json', 'README.txt'}
    if snapshot.image_mode != 'none':
        allowed_top_level.update({'images', 'data.yaml'})
        source_paths = {image.image_id: image.source_path for image in snapshot.images}
        for item in image_index:
            exported_image = root / item['training_image_path']
            source_image = Path(source_paths[item['image_id']]).resolve()
            if snapshot.image_mode == 'symlink':
                if not exported_image.is_symlink() or exported_image.resolve() != source_image:
                    raise ValueError(f"YOLO image symlink is invalid: {item['image_id']}")
            elif exported_image.is_symlink() or not exported_image.is_file() or exported_image.stat().st_size != source_image.stat().st_size:
                raise ValueError(f"YOLO copied image is invalid: {item['image_id']}")
    if {path.name for path in root.iterdir()} != allowed_top_level:
        raise ValueError('YOLO export directory contains an unexpected top-level artifact')


def write_yolo(*, snapshot: ExportSnapshot, output_dir: Path, created_at: datetime) -> tuple[Path, dict[str, Any]]:
    if snapshot.profile not in {'yolo_detection', 'yolo_instance'}:
        raise ValueError('invalid YOLO profile')
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = ''.join(char if char.isalnum() or char in '._-' else '_' for char in snapshot.project_name).strip('._') or 'project'
    output_name = f"{stem}_{snapshot.profile}_{created_at.strftime('%Y%m%d_%H%M%S')}"
    retains_images = snapshot.image_mode != 'none'
    requested_path = output_dir / (output_name if retains_images else f'{output_name}.zip')
    dataset_target = unique_output_path(requested_path) if retains_images else None
    temporary = Path(tempfile.mkdtemp(prefix='.web-auto-yolo-', dir=output_dir))
    temporary_archive = None if retains_images else temporary_zip_path(output_dir)
    labels = temporary / 'labels'
    labels.mkdir()
    for split in ('train', 'val'):
        (labels / split).mkdir()
        if retains_images:
            (temporary / 'images' / split).mkdir(parents=True)
    relative_paths = ProjectFileRepository.annotation_relative_paths([
        {'id': image.image_id, 'rel_path': image.image_rel_path} for image in snapshot.images
    ])
    training_paths = _training_image_paths(snapshot.images) if retains_images else {}
    image_index: list[dict[str, Any]] = []
    split_paths: dict[str, list[str]] = {'train': [], 'val': []}
    try:
        for image in snapshot.images:
            split = _split(image.image_id, snapshot.val_ratio)
            if retains_images:
                training_relative = training_paths[image.image_id]
                label_relative = Path('labels') / split / training_relative.with_suffix('.txt')
                training_image_path = (Path('images') / split / training_relative).as_posix()
                exported_image = temporary / training_image_path
                exported_image.parent.mkdir(parents=True, exist_ok=True)
                source_image = Path(image.source_path).expanduser().resolve()
                if snapshot.image_mode == 'symlink':
                    exported_image.symlink_to(source_image)
                else:
                    shutil.copy2(source_image, exported_image)
            else:
                annotation_relative = relative_paths[image.image_id]
                label_relative = Path('labels') / split / annotation_relative.with_suffix('.txt')
                training_image_path = image.image_rel_path
            label_path = temporary / label_relative
            label_path.parent.mkdir(parents=True, exist_ok=True)
            lines = _label_lines(snapshot, image)
            label_path.write_text(('\n'.join(lines) + ('\n' if lines else '')), encoding='utf-8')
            split_paths[split].append(training_image_path)
            image_index.append({
                'image_id': image.image_id,
                'image_rel_path': image.image_rel_path,
                'training_image_path': training_image_path,
                'label_path': label_relative.as_posix(),
                'split': split,
                'instance_count': len(image.instances),
            })

        (temporary / 'classes.txt').write_text('\n'.join(snapshot.selected_classes) + '\n', encoding='utf-8')
        (temporary / 'train.txt').write_text('\n'.join(split_paths['train']) + ('\n' if split_paths['train'] else ''), encoding='utf-8')
        (temporary / 'val.txt').write_text('\n'.join(split_paths['val']) + ('\n' if split_paths['val'] else ''), encoding='utf-8')
        if retains_images:
            if dataset_target is None:
                raise ValueError('YOLO dataset output path is unavailable')
            (temporary / 'data.yaml').write_text(_data_yaml(snapshot), encoding='utf-8')
        (temporary / 'image_index.json').write_text(json.dumps({'images': image_index}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        manifest = {
            'profile': snapshot.profile,
            'annotation_only': snapshot.image_mode == 'none',
            'image_mode': snapshot.image_mode,
            'image_binaries_included': snapshot.image_mode == 'copy',
            'image_symlinks_included': snapshot.image_mode == 'symlink',
            'created_at': created_at.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'project': {'id': snapshot.project_id, 'name': snapshot.project_name, 'content_rev': snapshot.project_content_rev},
            'filters': {'source_models': snapshot.source_models, 'classes': snapshot.selected_classes},
            'val_ratio': snapshot.val_ratio,
            'yolo_multipart_policy': snapshot.yolo_multipart_policy,
            'format_details': snapshot.format_details,
            'stats': snapshot.stats.as_dict(),
            'warnings': [issue.as_dict() for issue in snapshot.warnings],
        }
        (temporary / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if snapshot.image_mode == 'symlink':
            readme = (
                'Web Auto local YOLO training export\n'
                'Images are absolute symlinks to the original project files; no image binaries are copied.\n'
                'Run Ultralytics with data.yaml on this machine. Moving the original images will break the links.\n'
            )
        elif snapshot.image_mode == 'copy':
            readme = (
                'Web Auto portable YOLO training export\n'
                'Original image binaries were copied into images/train and images/val.\n'
                'Run Ultralytics with data.yaml. The complete directory can be moved as-is.\n'
            )
        else:
            readme = (
                'Web Auto annotation-only YOLO export\n'
                'No images are copied or linked. train.txt and val.txt contain project-relative image references.\n'
                'Resolve those references against the original project image root before training.\n'
            )
        (temporary / 'README.txt').write_text(readme, encoding='utf-8')
        _validate_directory(temporary, snapshot, image_index)
        if retains_images:
            if dataset_target is None:
                raise ValueError('YOLO dataset output path is unavailable')
            temporary.rename(dataset_target)
            target = dataset_target
        else:
            if temporary_archive is None:
                raise ValueError('YOLO temporary archive is unavailable')
            with zipfile.ZipFile(temporary_archive, mode='w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
                for path in sorted(temporary.rglob('*')):
                    if path.is_file():
                        bundle.write(path, path.relative_to(temporary).as_posix())
            with zipfile.ZipFile(temporary_archive, mode='r') as bundle:
                archived_files = {name for name in bundle.namelist() if not name.endswith('/')}
            expected_files = {path.relative_to(temporary).as_posix() for path in temporary.rglob('*') if path.is_file()}
            if archived_files != expected_files:
                raise ValueError('YOLO archive and validated staging directory do not match')
            target = publish_unique_file(temporary_archive, requested_path)
    except Exception:
        if temporary_archive is not None:
            temporary_archive.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return target, manifest
