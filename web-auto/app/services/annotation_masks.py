from __future__ import annotations

import base64
import hashlib
import json
import re
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageDraw

from app.services.annotation_geometry import _bbox_from_polygon, _mask_components_from_base64
from app.utils import ensure_dir


_LIGHTWEIGHT_DROP_KEYS = {'mask_png_base64', 'mask_png'}


def _safe_name(value: str) -> str:
    text = re.sub(r'[^A-Za-z0-9_.-]+', '_', str(value or '').strip())
    return text[:120] or 'annotation'


def _mask_cache_dir(base_dir: Path, project_id: str, image_id: str) -> Path:
    return ensure_dir(base_dir / '.annotation-masks' / str(project_id) / str(image_id))


def annotation_mask_path(base_dir: Path, project_id: str, image_id: str, annotation_id: str) -> Path:
    return _mask_cache_dir(base_dir, project_id, image_id) / f'{_safe_name(annotation_id)}.png'


def annotation_mask_url(project_id: str, image_id: str, annotation_id: str) -> str:
    return f'/api/projects/{project_id}/images/{image_id}/masks/{_safe_name(annotation_id)}.png'


def semantic_mask_url(project_id: str, image_id: str) -> str:
    return f'/api/projects/{project_id}/images/{image_id}/masks/{image_id}/semantic.png'


def overlay_url(project_id: str, image_id: str) -> str:
    return f'/api/projects/{project_id}/images/{image_id}/masks/{image_id}/overlay.webp'


def _decode_mask(mask_b64: str) -> bytes:
    try:
        raw = base64.b64decode(str(mask_b64 or ''), validate=False)
    except Exception as exc:
        raise ValueError('invalid base64 mask') from exc
    if not raw:
        raise ValueError('empty mask')
    return raw


def _write_mask_sidecar(base_dir: Path, project_id: str, image_id: str, annotation_id: str, mask_b64: str) -> Path | None:
    if not str(mask_b64 or '').strip():
        return None
    raw = _decode_mask(mask_b64)
    try:
        with Image.open(BytesIO(raw)) as im:
            mask = im.convert('L')
            out = annotation_mask_path(base_dir, project_id, image_id, annotation_id)
            ensure_dir(out.parent)
            mask.save(out, format='PNG')
            return out
    except Exception:
        return None


def _fill_polygon_fallback(item: dict[str, Any], mask_b64: str) -> None:
    if isinstance(item.get('polygon'), list) and len(item.get('polygon') or []) >= 3:
        return
    components = _mask_components_from_base64(mask_b64)
    if not components:
        return
    component = max(components, key=lambda x: float(x.get('area') or 0.0))
    polygon = component.get('polygon') if isinstance(component, dict) else []
    if isinstance(polygon, list) and len(polygon) >= 3:
        item['polygon'] = polygon
        if not item.get('bbox'):
            bbox = _bbox_from_polygon(polygon)
            if bbox:
                item['bbox'] = bbox
    if not item.get('area'):
        try:
            item['area'] = float(component.get('area') or 0.0)
        except Exception:
            pass


def normalize_annotation_masks(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    annotations: list[dict[str, Any]],
    materialize: bool = True,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for idx, raw in enumerate(annotations if isinstance(annotations, list) else []):
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        ann_id = _safe_name(str(item.get('id') or f'ann_{idx + 1:04d}'))
        mask_b64 = str(item.get('mask_png_base64') or item.get('mask_png') or '').strip()
        if mask_b64:
            _fill_polygon_fallback(item, mask_b64)
            if materialize and _write_mask_sidecar(base_dir, project_id, image_id, ann_id, mask_b64):
                item['mask_url'] = annotation_mask_url(project_id, image_id, ann_id)
        elif not item.get('mask_url') and annotation_mask_path(base_dir, project_id, image_id, ann_id).is_file():
            item['mask_url'] = annotation_mask_url(project_id, image_id, ann_id)

        item['overlay_url'] = overlay_url(project_id, image_id)
        for key in _LIGHTWEIGHT_DROP_KEYS:
            item.pop(key, None)
        out.append(item)
    return out


def mask_file_or_404(base_dir: Path, project_id: str, image_id: str, annotation_id: str) -> Path:
    path = annotation_mask_path(base_dir, project_id, image_id, annotation_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail='annotation mask not found')
    return path


def _image_size_from_annotations(annotations: list[dict[str, Any]]) -> tuple[int, int] | None:
    max_x = 0.0
    max_y = 0.0
    for ann in annotations:
        for p in ann.get('polygon') or []:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    max_x = max(max_x, float(p[0]))
                    max_y = max(max_y, float(p[1]))
                except Exception:
                    pass
        bbox = ann.get('bbox') or []
        if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
            try:
                max_x = max(max_x, float(bbox[2]))
                max_y = max(max_y, float(bbox[3]))
            except Exception:
                pass
    if max_x <= 0 or max_y <= 0:
        return None
    return max(1, int(max_x + 1)), max(1, int(max_y + 1))


def _annotation_signature(annotations: list[dict[str, Any]]) -> str:
    payload = [
        {
            'id': ann.get('id'),
            'polygon': ann.get('polygon'),
            'bbox': ann.get('bbox'),
            'class_name': ann.get('class_name'),
            'area': ann.get('area'),
            'mask_url': ann.get('mask_url'),
        }
        for ann in annotations
        if isinstance(ann, dict)
    ]
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]


def _semantic_cache_paths(base_dir: Path, project_id: str, image_id: str, signature: str) -> tuple[Path, Path]:
    cache_dir = ensure_dir(base_dir / '.annotation-masks' / str(project_id) / str(image_id) / '_composite')
    return cache_dir / f'semantic_{signature}.png', cache_dir / f'overlay_{signature}.webp'


def build_semantic_mask(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    image_size: tuple[int, int] | None,
    annotations: list[dict[str, Any]],
) -> Path:
    size = image_size or _image_size_from_annotations(annotations)
    if not size:
        raise HTTPException(status_code=404, detail='cannot determine mask size')
    signature = _annotation_signature(annotations)
    semantic_path, _overlay_path = _semantic_cache_paths(base_dir, project_id, image_id, signature)
    if semantic_path.is_file():
        return semantic_path
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    for ann in annotations:
        ann_id = str(ann.get('id') or '').strip()
        sidecar = annotation_mask_path(base_dir, project_id, image_id, ann_id) if ann_id else None
        if sidecar and sidecar.is_file():
            try:
                with Image.open(sidecar) as im:
                    component = im.convert('L').resize(size) if im.size != size else im.convert('L')
                    mask = ImageChops.lighter(mask, component)
                    draw = ImageDraw.Draw(mask)
                    continue
            except Exception:
                pass
        polygon = ann.get('polygon') or []
        if isinstance(polygon, list) and len(polygon) >= 3:
            points: list[tuple[float, float]] = []
            for p in polygon:
                if isinstance(p, (list, tuple)) and len(p) >= 2:
                    try:
                        points.append((float(p[0]), float(p[1])))
                    except Exception:
                        pass
            if len(points) >= 3:
                draw.polygon(points, fill=255)
    mask.save(semantic_path, format='PNG')
    return semantic_path


def build_overlay(
    *,
    base_dir: Path,
    project_id: str,
    image_id: str,
    image_size: tuple[int, int] | None,
    annotations: list[dict[str, Any]],
) -> Path:
    size = image_size or _image_size_from_annotations(annotations)
    if not size:
        raise HTTPException(status_code=404, detail='cannot determine overlay size')
    signature = _annotation_signature(annotations)
    _semantic_path, overlay_path = _semantic_cache_paths(base_dir, project_id, image_id, signature)
    if overlay_path.is_file():
        return overlay_path
    semantic_path = build_semantic_mask(
        base_dir=base_dir,
        project_id=project_id,
        image_id=image_id,
        image_size=size,
        annotations=annotations,
    )
    with Image.open(semantic_path) as mask:
        alpha = mask.convert('L').point(lambda v: 96 if v > 0 else 0)
        overlay = Image.new('RGBA', size, (34, 197, 94, 0))
        overlay.putalpha(alpha)
        overlay.save(overlay_path, format='WEBP', lossless=False, quality=80)
    return overlay_path
