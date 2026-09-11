from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.annotations import CanonicalAnnotation, ParseContext, parse_image_annotations, resolve_annotation_mask
from app.services.annotation_masks import annotation_mask_path
from app.utils import ensure_dir


_PREVIEW_SIZE = (1920, 1280)


def _safe_name(value: str) -> str:
    cleaned = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(value or '').strip())
    return cleaned[:120] or 'image'


def _polygon_lists(annotation: CanonicalAnnotation) -> list[list[Any]]:
    return [list(region) for region in annotation.geometry.regions]


def _annotation_has_segmentation(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    annotation: CanonicalAnnotation,
) -> bool:
    ann_id = annotation.source_annotation_ids[0] if len(annotation.source_annotation_ids) == 1 else ''
    if ann_id and annotation_mask_path(base_dir, project_id, image_id, ann_id).is_file():
        return True
    return annotation.has_instance_segmentation


def _annotation_bbox(annotation: CanonicalAnnotation, size: tuple[int, int]) -> tuple[float, float, float, float] | None:
    bbox = annotation.geometry.bbox
    if bbox is None:
        return None
    x1, y1, x2, y2 = bbox.x1, bbox.y1, bbox.x2, bbox.y2
    x1 = max(0.0, min(float(size[0] - 1), x1))
    y1 = max(0.0, min(float(size[1] - 1), y1))
    x2 = max(0.0, min(float(size[0] - 1), x2))
    y2 = max(0.0, min(float(size[1] - 1), y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def _annotation_mask(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    annotation: CanonicalAnnotation,
    size: tuple[int, int],
) -> np.ndarray:
    ann_id = annotation.source_annotation_ids[0] if len(annotation.source_annotation_ids) == 1 else ''
    sidecar = annotation_mask_path(base_dir, project_id, image_id, ann_id) if ann_id else None
    resolved = resolve_annotation_mask(annotation, size=size, sidecar_path=sidecar)
    return np.asarray(resolved.image) > 127 if resolved is not None else np.zeros((size[1], size[0]), dtype=bool)


def _artifact_mask(artifact_dir: Path, relative_name: str, size: tuple[int, int]) -> np.ndarray:
    relative = str(relative_name or '').strip()
    if not relative:
        return np.zeros((size[1], size[0]), dtype=bool)
    root = artifact_dir.resolve()
    target = (artifact_dir / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return np.zeros((size[1], size[0]), dtype=bool)
    if not target.is_file():
        return np.zeros((size[1], size[0]), dtype=bool)
    try:
        with Image.open(target) as source:
            mask = source.convert('L')
            if mask.size != size:
                mask = mask.resize(size, Image.Resampling.NEAREST)
            return np.asarray(mask) > 127
    except Exception:
        return np.zeros((size[1], size[0]), dtype=bool)


def _blend(rgb: np.ndarray, mask: np.ndarray, color: tuple[int, int, int], opacity: float) -> None:
    if not np.any(mask):
        return
    rgb[mask] = rgb[mask] * (1.0 - opacity) + np.asarray(color, dtype=np.float32) * opacity


def _mask_boundary(mask: np.ndarray, width: int) -> np.ndarray:
    """Return a visible inside/outside boundary for one instance mask."""
    if not np.any(mask):
        return np.zeros_like(mask, dtype=bool)
    import cv2

    radius = max(1, int(width))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    return cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_GRADIENT, kernel) > 0


def _draw_mask_outlines(
    rgb: np.ndarray,
    masks: list[tuple[np.ndarray, tuple[int, int, int]]],
    *,
    image_size: tuple[int, int],
) -> None:
    """Draw every segmentation separately so overlapping instances do not merge visually."""
    if not masks:
        return
    width = max(2, round(min(image_size) * 0.004))
    for mask, color in masks:
        # Match detection boxes: a dark halo keeps adjacent same-color instance
        # boundaries visible, while the colored inner stroke preserves status.
        _blend(rgb, _mask_boundary(mask, width + 2), (17, 24, 39), 0.92)
        _blend(rgb, _mask_boundary(mask, width), color, 0.96)


def _draw_boxes(
    image: Image.Image,
    boxes: list[tuple[tuple[float, float, float, float], tuple[int, int, int]]],
) -> None:
    if not boxes:
        return
    draw = ImageDraw.Draw(image)
    width = max(2, round(min(image.size) * 0.004))
    for bbox, color in boxes:
        # A dark under-stroke keeps detection boxes legible on both bright and
        # dark images while leaving their interiors untouched.
        draw.rectangle(bbox, outline=(17, 24, 39), width=width + 2)
        draw.rectangle(bbox, outline=color, width=width)


def _mask_bbox(mask: np.ndarray) -> tuple[float, float, float, float] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)


def _instance_label(annotation: CanonicalAnnotation, *, class_name: str | None = None) -> str:
    ann_id = annotation.source_annotation_ids[0] if annotation.source_annotation_ids else annotation.instance_id
    name = str(class_name if class_name is not None else annotation.class_name or '?')
    return f'{name} · {ann_id[:6] or "?"}'


def _draw_labels(image: Image.Image, labels: list[tuple[tuple[float, float, float, float], str, tuple[int, int, int]]]) -> None:
    draw = ImageDraw.Draw(image)
    font_size = max(11, round(min(image.size) * 0.018))
    font = None
    for candidate in (
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ):
        try:
            font = ImageFont.truetype(candidate, font_size)
            break
        except OSError:
            continue
    font = font or ImageFont.load_default()
    for bbox, text, color in labels:
        x = max(0, int(bbox[0]))
        y = max(0, int(bbox[1]) - font_size - 5)
        try:
            text_box = draw.textbbox((0, 0), text, font=font)
            width = max(24, text_box[2] - text_box[0] + 6)
            height = max(font_size + 4, text_box[3] - text_box[1] + 4)
            draw.rectangle((x, y, min(image.width - 1, x + width), min(image.height - 1, y + height)), fill=(17, 24, 39))
            draw.text((x + 3, y + 1), text, fill=color, font=font)
        except UnicodeError:
            fallback = f'instance · {text.rsplit("·", 1)[-1].strip()}'
            draw.text((x + 3, y + 1), fallback, fill=color, font=font)


def geometry_preview_plan(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    annotations: list[dict[str, Any]],
    change_set: dict[str, Any],
) -> list[dict[str, Any]]:
    """Return independent geometry layers, including layers with zero changes."""
    deleted_indices = {int(value) for value in change_set.get('delete_indices', [])}
    relabeled_indices = {
        int(row.get('annotation_index'))
        for row in change_set.get('relabels', [])
        if isinstance(row, dict)
    }
    parsed = parse_image_annotations(annotations)
    by_id = {instance.source_annotation_ids[0]: instance for instance in parsed.instances if len(instance.source_annotation_ids) == 1}
    plan = {
        'bbox': {'geometry_type': 'bbox', 'annotation_count': 0, 'candidate_count': 0, 'relabel_count': 0},
        'segmentation': {'geometry_type': 'segmentation', 'annotation_count': 0, 'candidate_count': 0, 'relabel_count': 0},
    }
    for index, annotation in enumerate(annotations):
        if not isinstance(annotation, dict):
            continue
        canonical = by_id.get(str(annotation.get('id') or ''))
        if canonical is None:
            continue
        if _annotation_has_segmentation(
            base_dir=base_dir,
            project_id=project_id,
            image_id=image_id,
            annotation=canonical,
        ):
            geometry_type = 'segmentation'
        elif _annotation_bbox(canonical, (2**31, 2**31)):
            geometry_type = 'bbox'
        else:
            continue
        layer = plan[geometry_type]
        layer['annotation_count'] += 1
        if index in deleted_indices:
            layer['candidate_count'] += 1
        if index in relabeled_indices:
            layer['relabel_count'] += 1
    return [plan[geometry_type] for geometry_type in ('bbox', 'segmentation') if plan[geometry_type]['annotation_count'] > 0]


def _save_webp(image: Image.Image, target: Path) -> None:
    ensure_dir(target.parent)
    fd, temporary = tempfile.mkstemp(prefix='.preview_', suffix='.webp', dir=str(target.parent))
    os.close(fd)
    try:
        output = image.copy()
        output.thumbnail(_PREVIEW_SIZE, Image.Resampling.LANCZOS)
        output.save(temporary, 'WEBP', quality=90)
        os.replace(temporary, target)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _union_annotation_masks(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    annotations: list[CanonicalAnnotation],
    indices: set[int],
    size: tuple[int, int],
) -> np.ndarray:
    output = np.zeros((size[1], size[0]), dtype=bool)
    for index in indices:
        if 0 <= index < len(annotations):
            output |= _annotation_mask(
                base_dir=base_dir,
                project_id=project_id,
                image_id=image_id,
                annotation=annotations[index],
                size=size,
            )
    return output


def render_comparison_sample(
    *,
    base_dir: Path,
    artifact_dir: Path,
    project_id: str,
    operation_mode: str,
    image: dict[str, Any],
    annotations: list[dict[str, Any]],
    change_set: dict[str, Any],
    component_layers: dict[str, str] | None = None,
    geometry_type: str = 'segmentation',
) -> dict[str, str]:
    """Render one best-effort before/after pair from an analyzed change set."""
    image_id = str(image.get('id') or change_set.get('image_id') or '')
    image_path = Path(str(image.get('abs_path') or ''))
    with Image.open(image_path) as source:
        original_image = source.convert('RGB')
    size = original_image.size
    parsed = parse_image_annotations(
        annotations,
        ParseContext(image_id=image_id, image_width=size[0], image_height=size[1]),
    )
    canonical_by_id = {
        instance.source_annotation_ids[0]: instance
        for instance in parsed.instances if len(instance.source_annotation_ids) == 1
    }
    canonical_by_index = {
        index: canonical_by_id[str(annotation.get('id') or '')]
        for index, annotation in enumerate(annotations)
        if isinstance(annotation, dict) and str(annotation.get('id') or '') in canonical_by_id
    }
    before = np.asarray(original_image).astype(np.float32).copy()
    after = before.copy()
    removed_pixels = np.zeros((size[1], size[0]), dtype=bool)
    added_pixels = np.zeros_like(removed_pixels)
    relabeled_pixels = np.zeros_like(removed_pixels)
    before_labels: list[tuple[tuple[float, float, float, float], str, tuple[int, int, int]]] = []
    after_labels: list[tuple[tuple[float, float, float, float], str, tuple[int, int, int]]] = []

    if operation_mode == 'delete_unlabeled':
        removed_pixels[:] = True
        _blend(after, np.ones((size[1], size[0]), dtype=bool), (185, 28, 28), 0.62)
        after_image = Image.fromarray(np.clip(after, 0, 255).astype(np.uint8))
        draw = ImageDraw.Draw(after_image)
        margin = max(12, round(min(size) * 0.12))
        width = max(8, round(min(size) * 0.035))
        draw.line((margin, margin, size[0] - margin, size[1] - margin), fill=(255, 255, 255), width=width)
        draw.line((size[0] - margin, margin, margin, size[1] - margin), fill=(255, 255, 255), width=width)
    elif operation_mode == 'component_noise':
        updates = [row for row in change_set.get('geometry_updates', []) if isinstance(row, dict)]
        before_masks: list[tuple[np.ndarray, tuple[int, int, int]]] = []
        after_masks: list[tuple[np.ndarray, tuple[int, int, int]]] = []
        layers = component_layers or {}
        bridged_mask = _artifact_mask(artifact_dir, layers.get('bridged', ''), size)
        filled_mask = _artifact_mask(artifact_dir, layers.get('filled', ''), size)
        for update in updates:
            index = int(update.get('annotation_index', -1))
            if index < 0 or index >= len(annotations):
                continue
            annotation = canonical_by_index.get(index)
            if annotation is None:
                continue
            original_mask = _annotation_mask(
                base_dir=base_dir, project_id=project_id, image_id=image_id,
                annotation=annotation, size=size,
            )
            final_mask = _artifact_mask(artifact_dir, str(update.get('staged_mask') or ''), size)
            removed_mask = original_mask & ~final_mask
            removed_pixels |= removed_mask
            added_pixels |= final_mask & ~original_mask
            _blend(before, original_mask, (245, 158, 11), 0.48)
            _blend(before, removed_mask, (239, 68, 68), 0.88)
            _blend(after, final_mask, (245, 158, 11), 0.48)
            before_masks.append((original_mask, (245, 158, 11)))
            after_masks.append((final_mask, (245, 158, 11)))
            before_box = _mask_bbox(original_mask)
            after_box = _mask_bbox(final_mask)
            if before_box:
                before_labels.append((before_box, _instance_label(annotation), (255, 255, 255)))
            if after_box:
                after_labels.append((after_box, _instance_label(annotation), (255, 255, 255)))
        _blend(after, bridged_mask, (59, 130, 246), 0.80)
        _blend(after, filled_mask, (6, 182, 212), 0.80)
        _draw_mask_outlines(before, before_masks, image_size=size)
        _draw_mask_outlines(after, after_masks, image_size=size)
        after_image = Image.fromarray(np.clip(after, 0, 255).astype(np.uint8))
    else:
        all_indices = set(range(len(annotations)))
        delete_indices = {int(value) for value in change_set.get('delete_indices', [])}
        relabel_indices = {
            int(row.get('annotation_index'))
            for row in change_set.get('relabels', [])
            if isinstance(row, dict)
        }
        all_mask = np.zeros((size[1], size[0]), dtype=bool)
        deleted_mask = np.zeros_like(all_mask)
        kept_mask = np.zeros_like(all_mask)
        relabeled_mask = np.zeros_like(all_mask)
        before_masks: list[tuple[np.ndarray, tuple[int, int, int]]] = []
        after_masks: list[tuple[np.ndarray, tuple[int, int, int]]] = []
        before_boxes: list[tuple[tuple[float, float, float, float], tuple[int, int, int]]] = []
        after_boxes: list[tuple[tuple[float, float, float, float], tuple[int, int, int]]] = []
        for index in all_indices:
            annotation = canonical_by_index.get(index)
            if annotation is None:
                continue
            has_segmentation = _annotation_has_segmentation(
                base_dir=base_dir,
                project_id=project_id,
                image_id=image_id,
                annotation=annotation,
            )
            if geometry_type in {'bbox', 'mixed'} and not has_segmentation:
                bbox = _annotation_bbox(annotation, size)
                if bbox:
                    if index in delete_indices or index in relabel_indices:
                        x1, y1, x2, y2 = map(int, bbox)
                        target = removed_pixels if index in delete_indices else relabeled_pixels
                        target[y1:y2 + 1, x1:x2 + 1] = True
                    before_boxes.append((bbox, (239, 68, 68) if index in delete_indices else (245, 158, 11)))
                    before_labels.append((bbox, _instance_label(annotation), (255, 255, 255)))
                    if index not in delete_indices:
                        after_boxes.append((bbox, (59, 130, 246) if index in relabel_indices else (34, 197, 94)))
                        next_class = next((str(row.get('class_name') or '') for row in change_set.get('relabels', []) if int(row.get('annotation_index', -1)) == index), None)
                        after_labels.append((bbox, _instance_label(annotation, class_name=next_class), (255, 255, 255)))
                continue
            if geometry_type not in {'segmentation', 'mixed'} or not has_segmentation:
                continue
            mask = _annotation_mask(
                base_dir=base_dir,
                project_id=project_id,
                image_id=image_id,
                annotation=annotation,
                size=size,
            )
            all_mask |= mask
            if index in delete_indices:
                removed_pixels |= mask
                deleted_mask |= mask
                before_masks.append((mask, (239, 68, 68)))
            else:
                kept_mask |= mask
                before_masks.append((mask, (245, 158, 11)))
                if index in relabel_indices:
                    relabeled_pixels |= mask
                    relabeled_mask |= mask
                    after_masks.append((mask, (59, 130, 246)))
                else:
                    after_masks.append((mask, (34, 197, 94)))
            bbox = _mask_bbox(mask)
            if bbox:
                before_labels.append((bbox, _instance_label(annotation), (255, 255, 255)))
                if index not in delete_indices:
                    next_class = next((str(row.get('class_name') or '') for row in change_set.get('relabels', []) if int(row.get('annotation_index', -1)) == index), None)
                    after_labels.append((bbox, _instance_label(annotation, class_name=next_class), (255, 255, 255)))
        _blend(before, all_mask, (245, 158, 11), 0.45)
        _blend(before, deleted_mask, (239, 68, 68), 0.80)
        _blend(after, kept_mask, (34, 197, 94), 0.55)
        _blend(after, relabeled_mask, (59, 130, 246), 0.80)
        _draw_mask_outlines(before, before_masks, image_size=size)
        _draw_mask_outlines(after, after_masks, image_size=size)
        after_image = Image.fromarray(np.clip(after, 0, 255).astype(np.uint8))
        _draw_boxes(after_image, after_boxes)
        _draw_labels(after_image, after_labels)

    before_image = Image.fromarray(np.clip(before, 0, 255).astype(np.uint8))
    if operation_mode not in {'delete_unlabeled', 'component_noise'}:
        _draw_boxes(before_image, before_boxes)
    _draw_labels(before_image, before_labels)
    if operation_mode == 'component_noise':
        _draw_labels(after_image, after_labels)
    safe_image_id = _safe_name(image_id)
    suffix = _safe_name('image' if operation_mode == 'delete_unlabeled' else geometry_type)
    before_rel = f'samples/{safe_image_id}_{suffix}_before.webp'
    after_rel = f'samples/{safe_image_id}_{suffix}_after.webp'
    _save_webp(before_image, artifact_dir / before_rel)
    _save_webp(after_image, artifact_dir / after_rel)
    # Difference is derived from geometry, never from the differently colored
    # rendered images. Unchanged pixels retain the source image appearance.
    difference = np.asarray(original_image).astype(np.float32) * 0.45
    _blend(difference, removed_pixels, (239, 68, 68), 0.95)
    _blend(difference, added_pixels, (59, 130, 246), 0.95)
    _blend(difference, relabeled_pixels, (168, 85, 247), 0.95)
    difference_image = Image.fromarray(np.clip(difference, 0, 255).astype(np.uint8))
    diff_rel = f'samples/{safe_image_id}_{suffix}_diff.png'
    difference_image.save(artifact_dir / diff_rel, 'PNG')
    bounds = _mask_bbox(removed_pixels | added_pixels | relabeled_pixels)
    crop_paths = {}
    if bounds:
        x1, y1, x2, y2 = bounds
        margin = 32
        crop = (max(0, int(x1) - margin), max(0, int(y1) - margin),
                min(size[0], int(x2) + margin), min(size[1], int(y2) + margin))
        for label, artwork in [('before', before_image), ('after', after_image), ('diff', difference_image)]:
            relative = f'samples/{safe_image_id}_{suffix}_{label}_detail.png'
            artwork.crop(crop).save(artifact_dir / relative, 'PNG')
            crop_paths[f'{label}_detail_rel'] = relative
    return {
        **crop_paths,
        'before_rel': before_rel, 'after_rel': after_rel, 'diff_rel': diff_rel,
        'change_bbox': list(bounds) if bounds else None,
        'source_width': size[0], 'source_height': size[1],
        'removed_pixels': int(removed_pixels.sum()), 'added_pixels': int(added_pixels.sum()),
    }
