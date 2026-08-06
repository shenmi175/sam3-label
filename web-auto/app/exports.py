from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from app.repositories.project_files import ProjectFileRepository
from app.utils import ensure_dir

DEFAULT_SOURCE_MODEL = 'sam3'
DEFAULT_CLASS_NAME = 'object'


@dataclass
class ExportStats:
    images_total: int = 0
    images_written: int = 0
    images_missing: int = 0
    annotations_total: int = 0
    annotations_written: int = 0
    skipped_source: int = 0
    skipped_class: int = 0
    skipped_no_polygon: int = 0
    skipped_no_bbox: int = 0
    by_source: dict[str, int] = field(default_factory=dict)
    by_class: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


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

    raise ValueError(f"image size unavailable for {img.get('rel_path') or img.get('id')}")


def annotation_source(ann: dict[str, Any]) -> str:
    return str(ann.get('source_model') or DEFAULT_SOURCE_MODEL)


def annotation_class(ann: dict[str, Any]) -> str:
    return str(ann.get('class_name') or ann.get('label') or DEFAULT_CLASS_NAME)


def annotation_polygons(ann: dict[str, Any]) -> list[list[list[float]]]:
    """All contours of an annotation: merged `polygons` first, else `polygon`."""
    raw_polygons = ann.get('polygons')
    if isinstance(raw_polygons, list) and raw_polygons:
        out = [p for p in raw_polygons if isinstance(p, list) and len(p) >= 3]
        if out:
            return out
    polygon = ann.get('polygon')
    if isinstance(polygon, list) and len(polygon) >= 3:
        return [polygon]
    return []


def _bbox_from_polygons(polygons: list[list[list[float]]]) -> list[float]:
    xs: list[float] = []
    ys: list[float] = []
    for poly in polygons:
        for point in poly:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                xs.append(float(point[0]))
                ys.append(float(point[1]))
    if not xs or not ys:
        return []
    return [min(xs), min(ys), max(xs), max(ys)]


def resolve_class_list(project: dict[str, Any], classes: list[str] | None) -> list[str]:
    """Fixed class table used for ids; never grows while writing annotations."""
    source = classes if classes else project.get('classes') or []
    out: list[str] = []
    for name in source:
        cls = str(name or '').strip()
        if cls and cls not in out:
            out.append(cls)
    return out


def summarize_annotations(all_annotations: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    by_source: dict[str, int] = {}
    by_class: dict[str, int] = {}
    no_polygon_by_source: dict[str, int] = {}
    total = 0
    images_with_annotations = 0
    for anns in all_annotations.values():
        if anns:
            images_with_annotations += 1
        for ann in anns:
            total += 1
            src = annotation_source(ann)
            cls = annotation_class(ann)
            by_source[src] = by_source.get(src, 0) + 1
            by_class[cls] = by_class.get(cls, 0) + 1
            if not annotation_polygons(ann):
                no_polygon_by_source[src] = no_polygon_by_source.get(src, 0) + 1
    return {
        'annotations_total': total,
        'images_with_annotations': images_with_annotations,
        'by_source': by_source,
        'by_class': by_class,
        'no_polygon_by_source': no_polygon_by_source,
    }


def select_annotations(
    *,
    all_annotations: dict[str, list[dict[str, Any]]],
    source_models: list[str],
    class_list: list[str],
    stats: ExportStats,
) -> dict[str, list[dict[str, Any]]]:
    allowed_sources = {str(s) for s in source_models if str(s or '').strip()}
    allowed_classes = set(class_list)
    out: dict[str, list[dict[str, Any]]] = {}
    for image_id, anns in all_annotations.items():
        kept: list[dict[str, Any]] = []
        for ann in anns if isinstance(anns, list) else []:
            if not isinstance(ann, dict):
                continue
            stats.annotations_total += 1
            src = annotation_source(ann)
            cls = annotation_class(ann)
            if allowed_sources and src not in allowed_sources:
                stats.skipped_source += 1
                continue
            if cls not in allowed_classes:
                stats.skipped_class += 1
                continue
            stats.by_source[src] = stats.by_source.get(src, 0) + 1
            stats.by_class[cls] = stats.by_class.get(cls, 0) + 1
            kept.append(ann)
        out[image_id] = kept
    return out


def export_coco(
    *,
    project: dict[str, Any],
    images: list[dict[str, Any]],
    all_annotations: dict[str, list[dict[str, Any]]],
    class_list: list[str],
    output_dir: Path,
    include_bbox: bool = True,
    include_mask: bool = True,
    stats: ExportStats | None = None,
) -> tuple[Path, ExportStats]:
    stats = stats or ExportStats()
    ensure_dir(output_dir)
    categories = [{'id': i + 1, 'name': c} for i, c in enumerate(class_list)]
    category_to_id = {c['name']: c['id'] for c in categories}

    coco_images: list[dict[str, Any]] = []
    coco_anns: list[dict[str, Any]] = []

    ann_id = 1
    image_index = 0
    for img in images:
        stats.images_total += 1
        try:
            width, height = _get_image_size(project, img)
        except ValueError:
            stats.images_missing += 1
            continue

        image_index += 1
        stats.images_written += 1
        coco_images.append(
            {
                'id': image_index,
                'file_name': img['rel_path'],
                'width': width,
                'height': height,
            }
        )

        for ann in all_annotations.get(img['id'], []):
            cls = annotation_class(ann)
            category_id = category_to_id.get(cls)
            if category_id is None:
                stats.skipped_class += 1
                continue

            polygons = annotation_polygons(ann)
            if include_mask and not polygons:
                stats.skipped_no_polygon += 1
                continue

            bbox_xyxy = ann.get('bbox') or ann.get('bbox_xyxy') or []
            if not isinstance(bbox_xyxy, list) or len(bbox_xyxy) != 4:
                bbox_xyxy = _bbox_from_polygons(polygons)
            bbox_xywh = _xyxy_to_xywh(bbox_xyxy)
            if include_bbox and (bbox_xywh[2] <= 0.0 or bbox_xywh[3] <= 0.0):
                stats.skipped_no_bbox += 1
                continue

            segmentation = [flat for flat in (_flatten_polygon(p) for p in polygons) if len(flat) >= 6]

            area = ann.get('area')
            if area is None:
                area = float(bbox_xywh[2] * bbox_xywh[3])

            item: dict[str, Any] = {
                'id': ann_id,
                'image_id': image_index,
                'category_id': category_id,
                'area': float(area),
                'iscrowd': 0,
                'score': float(ann.get('score', 1.0)),
            }
            if include_bbox:
                item['bbox'] = [round(v, 3) for v in bbox_xywh]
            if include_mask:
                item['segmentation'] = segmentation
            coco_anns.append(item)
            stats.annotations_written += 1
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
    return out_file, stats


def _val_bucket(image_id: str) -> float:
    digest = hashlib.sha1(image_id.encode('utf-8')).hexdigest()[:8]
    return int(digest, 16) / float(0xFFFFFFFF)


def _write_data_yaml(*, out_root: Path, class_list: list[str], has_val: bool) -> Path:
    lines = [f'path: {out_root}', 'train: train.txt']
    if has_val:
        lines.append('val: val.txt')
    lines.append('names:')
    for idx, cls in enumerate(class_list):
        lines.append(f'  {idx}: {json.dumps(cls, ensure_ascii=False)}')
    yaml_file = out_root / 'data.yaml'
    yaml_file.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return yaml_file


def export_yolo(
    *,
    project: dict[str, Any],
    images: list[dict[str, Any]],
    all_annotations: dict[str, list[dict[str, Any]]],
    class_list: list[str],
    output_dir: Path,
    mode: str = 'det',
    val_ratio: float = 0.0,
    write_data_yaml: bool = True,
    stats: ExportStats | None = None,
) -> tuple[Path, ExportStats]:
    mode = str(mode or '').strip().lower()
    if mode not in {'det', 'seg'}:
        raise ValueError('yolo mode must be det or seg')

    stats = stats or ExportStats()
    out_name = 'yolo_det' if mode == 'det' else 'yolo_seg'
    out_root = ensure_dir(output_dir / out_name)
    labels_dir = ensure_dir(out_root / 'labels')
    label_rel_paths = ProjectFileRepository.annotation_relative_paths(images)
    class_to_idx = {c: i for i, c in enumerate(class_list)}

    train_images: list[str] = []
    val_images: list[str] = []

    for img in images:
        stats.images_total += 1
        try:
            w, h = _get_image_size(project, img)
        except ValueError:
            stats.images_missing += 1
            continue

        txt_lines: list[str] = []
        for ann in all_annotations.get(img['id'], []):
            cls = annotation_class(ann)
            cid = class_to_idx.get(cls)
            if cid is None:
                stats.skipped_class += 1
                continue

            if mode == 'det':
                bbox = ann.get('bbox') or ann.get('bbox_xyxy') or []
                if not isinstance(bbox, list) or len(bbox) != 4:
                    bbox = _bbox_from_polygons(annotation_polygons(ann))
                if len(bbox) != 4:
                    stats.skipped_no_bbox += 1
                    continue
                x1, y1, x2, y2 = [float(v) for v in bbox]
                bw = max(0.0, x2 - x1)
                bh = max(0.0, y2 - y1)
                if bw <= 0.0 or bh <= 0.0:
                    stats.skipped_no_bbox += 1
                    continue
                cx = x1 + bw / 2.0
                cy = y1 + bh / 2.0
                txt_lines.append(f"{cid} {cx / w:.6f} {cy / h:.6f} {bw / w:.6f} {bh / h:.6f}")
                stats.annotations_written += 1
            else:
                # YOLO-seg has no multi-part instance form, so each contour of a
                # merged annotation becomes its own line.
                polygons = annotation_polygons(ann)
                wrote = 0
                for poly in polygons:
                    flat = _flatten_polygon(poly)
                    if len(flat) < 6:
                        continue
                    norm: list[str] = []
                    for i in range(0, len(flat), 2):
                        norm.append(f"{flat[i] / w:.6f}")
                        norm.append(f"{flat[i + 1] / h:.6f}")
                    txt_lines.append(f"{cid} {' '.join(norm)}")
                    wrote += 1
                if wrote:
                    stats.annotations_written += 1
                else:
                    stats.skipped_no_polygon += 1

        annotation_rel = label_rel_paths.get(str(img.get('id') or ''), Path(f"{Path(img['rel_path']).stem}.json"))
        txt_path = labels_dir / annotation_rel.with_suffix('.txt')
        ensure_dir(txt_path.parent)
        txt_path.write_text('\n'.join(txt_lines), encoding='utf-8')
        stats.images_written += 1

        abs_path = str(img.get('abs_path') or '').strip()
        if val_ratio > 0.0 and _val_bucket(str(img.get('id') or '')) < val_ratio:
            val_images.append(abs_path)
        else:
            train_images.append(abs_path)

    (out_root / 'classes.txt').write_text('\n'.join(class_list), encoding='utf-8')
    (out_root / 'train.txt').write_text('\n'.join(train_images), encoding='utf-8')
    if val_ratio > 0.0:
        (out_root / 'val.txt').write_text('\n'.join(val_images), encoding='utf-8')
    if write_data_yaml:
        _write_data_yaml(out_root=out_root, class_list=class_list, has_val=val_ratio > 0.0)
    return out_root, stats
