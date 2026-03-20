from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from PIL import Image

from app.utils import ensure_dir


def _flatten_polygon(points: list[list[float]]) -> list[float]:
    out: list[float] = []
    for p in points:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        out.extend([float(p[0]), float(p[1])])
    return out


def _xyxy_to_xywh(bbox: list[float]) -> list[float]:
    if not isinstance(bbox, list) or len(bbox) != 4:
        return [0.0, 0.0, 0.0, 0.0]
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return [x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)]


def _get_image_size(project: dict[str, Any], img: dict[str, Any]) -> tuple[int, int]:
    abs_path = str(img.get('abs_path') or '').strip()
    if abs_path:
        p = Path(abs_path).expanduser().resolve()
        if p.exists() and p.is_file():
            with Image.open(p) as im:
                w, h = im.size
                return int(w), int(h)

    # Fallback for virtual video frames (no extracted files on disk).
    video_meta = project.get('video_meta', {}) if isinstance(project.get('video_meta', {}), dict) else {}
    w = int(video_meta.get('width') or 0)
    h = int(video_meta.get('height') or 0)
    if w > 0 and h > 0:
        return w, h
    raise ValueError(f"image size unavailable for {img.get('rel_path') or img.get('id')}")


def export_coco(
    *,
    project: dict[str, Any],
    images: list[dict[str, Any]],
    all_annotations: dict[str, list[dict[str, Any]]],
    output_dir: Path,
    include_bbox: bool = True,
    include_mask: bool = True,
) -> Path:
    ensure_dir(output_dir)
    categories = [{'id': i + 1, 'name': c} for i, c in enumerate(project.get('classes', []))]
    category_to_id = {c['name']: c['id'] for c in categories}

    coco_images: list[dict[str, Any]] = []
    coco_anns: list[dict[str, Any]] = []

    ann_id = 1
    for i, img in enumerate(images, start=1):
        width, height = _get_image_size(project, img)
        coco_images.append(
            {
                'id': i,
                'file_name': img['rel_path'],
                'width': width,
                'height': height,
            }
        )

        anns = all_annotations.get(img['id'], [])
        for ann in anns:
            cls = ann.get('class_name') or ann.get('label') or 'object'
            if cls not in category_to_id:
                # append unseen class dynamically
                category_to_id[cls] = len(category_to_id) + 1
                categories.append({'id': category_to_id[cls], 'name': cls})

            bbox_xyxy = ann.get('bbox') or ann.get('bbox_xyxy') or []
            bbox_xywh = _xyxy_to_xywh(bbox_xyxy)
            polygon = ann.get('polygon') or []
            segmentation: list[list[float]] = []
            flat = _flatten_polygon(polygon)
            if len(flat) >= 6:
                segmentation = [flat]

            area = ann.get('area')
            if area is None:
                area = float(bbox_xywh[2] * bbox_xywh[3])

            item: dict[str, Any] = {
                'id': ann_id,
                'image_id': i,
                'category_id': category_to_id[cls],
                'area': float(area),
                'iscrowd': 0,
                'score': float(ann.get('score', 1.0)),
            }
            if include_bbox:
                item['bbox'] = [round(v, 3) for v in bbox_xywh]
            if include_mask:
                item['segmentation'] = segmentation
            coco_anns.append(item)
            ann_id += 1

    payload = {
        'info': {'description': project.get('name', 'web-auto'), 'version': '1.0', 'date_created': time.strftime('%Y-%m-%d')},
        'images': coco_images,
        'annotations': coco_anns,
        'categories': categories,
    }

    suffix = 'bbox_mask' if include_bbox and include_mask else ('bbox' if include_bbox else 'mask_polygon')
    out_file = output_dir / f'annotations_coco_{suffix}.json'
    with out_file.open('w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return out_file


def export_yolo(
    *,
    project: dict[str, Any],
    images: list[dict[str, Any]],
    all_annotations: dict[str, list[dict[str, Any]]],
    output_dir: Path,
    mode: str = 'det',
) -> Path:
    mode = str(mode or '').strip().lower()
    if mode not in {'det', 'seg'}:
        raise ValueError('yolo mode must be det or seg')

    labels_dir = ensure_dir(output_dir / 'labels')
    classes = list(project.get('classes', []))
    class_to_idx = {c: i for i, c in enumerate(classes)}

    for img in images:
        w, h = _get_image_size(project, img)
        txt_lines: list[str] = []

        for ann in all_annotations.get(img['id'], []):
            cls = ann.get('class_name') or ann.get('label') or 'object'
            if cls not in class_to_idx:
                class_to_idx[cls] = len(class_to_idx)
                classes.append(cls)

            if mode == 'det':
                bbox = ann.get('bbox') or ann.get('bbox_xyxy') or []
                if not isinstance(bbox, list) or len(bbox) != 4:
                    continue
                x1, y1, x2, y2 = [float(v) for v in bbox]
                bw = max(0.0, x2 - x1)
                bh = max(0.0, y2 - y1)
                if bw <= 0.0 or bh <= 0.0:
                    continue
                cx = x1 + bw / 2.0
                cy = y1 + bh / 2.0
                txt_lines.append(f"{class_to_idx[cls]} {cx / w:.6f} {cy / h:.6f} {bw / w:.6f} {bh / h:.6f}")
            else:
                polygon = ann.get('polygon') or []
                flat = _flatten_polygon(polygon)
                if len(flat) < 6:
                    continue
                norm: list[str] = []
                for i in range(0, len(flat), 2):
                    norm.append(f"{flat[i] / w:.6f}")
                    norm.append(f"{flat[i + 1] / h:.6f}")
                txt_lines.append(f"{class_to_idx[cls]} {' '.join(norm)}")

        txt_path = labels_dir / f"{Path(img['rel_path']).stem}.txt"
        txt_path.write_text('\n'.join(txt_lines), encoding='utf-8')

    classes_file = output_dir / 'classes.txt'
    classes_file.write_text('\n'.join(classes), encoding='utf-8')
    out_name = 'yolo_det' if mode == 'det' else 'yolo_seg'
    out_root = ensure_dir(output_dir / out_name)
    ensure_dir(out_root)
    # move generated files into dedicated folder for clarity
    (out_root / 'labels').mkdir(parents=True, exist_ok=True)
    for txt in labels_dir.glob('*.txt'):
        txt.replace(out_root / 'labels' / txt.name)
    classes_file = output_dir / 'classes.txt'
    classes_file.replace(out_root / 'classes.txt')
    try:
        labels_dir.rmdir()
    except OSError:
        pass
    return out_root


def export_video_json(
    *,
    project: dict[str, Any],
    images: list[dict[str, Any]],
    all_annotations: dict[str, list[dict[str, Any]]],
    output_dir: Path,
) -> Path:
    ensure_dir(output_dir)
    video_name = str(project.get('video_name') or project.get('name') or 'video')
    frames: list[dict[str, Any]] = []
    for i, img in enumerate(images):
        frame_index = int(img.get('frame_index', i))
        anns = all_annotations.get(img.get('id', ''), [])
        frames.append(
            {
                'frame_index': frame_index,
                'image_id': img.get('id', ''),
                'file_name': img.get('rel_path', ''),
                'annotations': anns if isinstance(anns, list) else [],
            }
        )

    payload = {
        'project_id': project.get('id'),
        'project_name': project.get('name'),
        'project_type': 'video',
        'video_name': video_name,
        'video_path': project.get('video_path', ''),
        'num_frames': len(frames),
        'classes': project.get('classes', []),
        'frames': frames,
        'updated_at': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime()),
    }

    out_file = output_dir / f'{video_name}_annotations.json'
    with out_file.open('w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return out_file
