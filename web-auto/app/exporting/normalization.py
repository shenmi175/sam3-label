from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from app.annotations import CanonicalAnnotation
from app.annotations.geometry import polygon_area
from app.exporting.models import ExportImage, ExportInstance, ExportIssue, ExportRegion, ExportStats


_PATH_KEY = re.compile(r'(?:^|_)(?:path|url|uri|file|image|mask|overlay)(?:$|_)', re.IGNORECASE)
_WINDOWS_ABSOLUTE = re.compile(r'^[a-zA-Z]:[\\/]')
_MAX_ISSUE_SAMPLES = 20
_IDENTITY_ERROR_CODES = frozenset({
    'MISSING_ANNOTATION_ID',
    'DUPLICATE_INSTANCE_ID',
    'UNSUPPORTED_SPLIT_ANNOTATION',
})
_POLYGON_ERROR_CODES = frozenset({
    'INVALID_POLYGON',
    'INVALID_POLYGON_POINT',
    'INVALID_POLYGONS',
    'DEGENERATE_POLYGON',
    'SELF_INTERSECTING_POLYGON',
})


class IssueCollector:
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], ExportIssue] = {}

    def add(
        self,
        *,
        code: str,
        message: str,
        severity: str,
        image_id: str = '',
        annotation_id: str = '',
        sample: dict[str, Any] | None = None,
        details: dict[str, Any] | None = None,
        occurrences: int = 1,
    ) -> None:
        key = (severity, code)
        issue = self._items.get(key)
        sample_value = {key: value for key, value in {'image_id': image_id, 'annotation_id': annotation_id}.items() if value}
        if sample:
            sample_value.update(sample)
        if issue is None:
            issue = ExportIssue(code=code, message=message, severity=severity, count=0)
            self._items[key] = issue
        if details:
            issue.details.update(details)
        issue.count += max(1, int(occurrences))
        if sample_value and len(issue.samples) < _MAX_ISSUE_SAMPLES:
            issue.samples.append(sample_value)

    def split(self) -> tuple[list[ExportIssue], list[ExportIssue]]:
        ordered = sorted(self._items.values(), key=lambda item: (item.severity, item.code))
        return (
            [item for item in ordered if item.severity == 'warning'],
            [item for item in ordered if item.severity == 'blocker'],
        )


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _image_size(image: dict[str, Any]) -> tuple[int | None, int | None]:
    width, height = _number(image.get('width')), _number(image.get('height'))
    if width and height and width > 0 and height > 0:
        return int(width), int(height)
    absolute = str(image.get('abs_path') or '').strip()
    if absolute:
        try:
            path = Path(absolute).expanduser().resolve()
            if path.is_file():
                with Image.open(path) as opened:
                    return int(opened.width), int(opened.height)
        except (OSError, ValueError):
            pass
    return None, None


def _unsafe_string(value: str, key: str) -> bool:
    stripped = value.strip()
    if stripped.startswith('/') or stripped.startswith('file://') or _WINDOWS_ABSOLUTE.match(stripped):
        return True
    return bool(
        _PATH_KEY.search(key)
        and (stripped.startswith(('http://', 'https://', 'data:image/')) or '/' in stripped or '\\' in stripped)
    )


def _sanitize(value: Any, *, key: str, stats: ExportStats) -> Any:
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for raw_key, nested in value.items():
            nested_key = str(raw_key)
            cleaned = _sanitize(nested, key=nested_key, stats=stats)
            if cleaned is not None:
                output[nested_key] = cleaned
        return output
    if isinstance(value, (list, tuple)):
        output_list = []
        for nested in value:
            cleaned = _sanitize(nested, key=key, stats=stats)
            if cleaned is not None:
                output_list.append(cleaned)
        return output_list
    if isinstance(value, str) and _unsafe_string(value, key):
        stats.stripped_values += 1
        return None
    if isinstance(value, float) and not math.isfinite(value):
        stats.stripped_values += 1
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    stats.stripped_values += 1
    return None


def _add_parser_issues(
    instance: CanonicalAnnotation,
    *,
    image_id: str,
    issues: IssueCollector,
    allow_polygon_bbox_fallback: bool,
) -> bool:
    """Return whether the canonical instance is safe for this export profile."""
    annotation_id = instance.source_annotation_ids[0] if instance.source_annotation_ids else instance.instance_id
    safe = True
    seen: set[str] = set()
    for problem in instance.issues:
        if problem.code in seen:
            continue
        seen.add(problem.code)
        if problem.code in _IDENTITY_ERROR_CODES:
            issues.add(
                code=problem.code,
                message='The selected annotation has no unambiguous modern storage identity.',
                severity='blocker', image_id=image_id, annotation_id=annotation_id,
            )
            safe = False
        elif problem.code in _POLYGON_ERROR_CODES:
            fallback = allow_polygon_bbox_fallback and instance.has_detection
            issues.add(
                code='INVALID_POLYGON_BBOX_FALLBACK' if fallback else problem.code,
                message=(
                    'A malformed polygon will be exported from its canonical bbox in this detection profile.'
                    if fallback else 'The selected annotation contains invalid polygon geometry.'
                ),
                severity='warning' if fallback else 'blocker',
                image_id=image_id, annotation_id=annotation_id,
            )
            safe = safe and fallback
        elif problem.severity == 'error' and problem.code != 'MISSING_VALID_GEOMETRY':
            issues.add(
                code=problem.code,
                message='The selected annotation could not be interpreted safely.',
                severity='blocker', image_id=image_id, annotation_id=annotation_id,
            )
            safe = False
    return safe


def normalize_image(
    *,
    image: dict[str, Any],
    annotations: Iterable[CanonicalAnnotation],
    stats: ExportStats,
    issues: IssueCollector,
    require_dimensions: bool = False,
    allow_polygon_bbox_fallback: bool = False,
) -> ExportImage | None:
    image_id = str(image.get('id') or '').strip()
    rel_path = str(image.get('rel_path') or '').strip().replace('\\', '/')
    if not image_id or not rel_path or rel_path == '.' or any(ord(char) < 32 for char in rel_path):
        issues.add(code='INVALID_IMAGE_REFERENCE', message='An image is missing its id or relative path.', severity='blocker', image_id=image_id)
        return None
    rel = Path(rel_path)
    if rel.is_absolute() or _WINDOWS_ABSOLUTE.match(rel_path) or '..' in rel.parts:
        issues.add(code='UNSAFE_IMAGE_PATH', message='An image relative path is absolute or escapes its root.', severity='blocker', image_id=image_id)
        return None

    width, height = _image_size(image)
    if width is None or height is None:
        issues.add(
            code='IMAGE_DIMENSIONS_UNAVAILABLE',
            message='Image dimensions are required by this export profile.' if require_dimensions else 'Image dimensions could not be read and will be null.',
            severity='blocker' if require_dimensions else 'warning', image_id=image_id,
        )

    exported: list[ExportInstance] = []
    for instance in annotations:
        if not _add_parser_issues(
            instance, image_id=image_id, issues=issues,
            allow_polygon_bbox_fallback=allow_polygon_bbox_fallback,
        ):
            continue
        if len(instance.source_annotation_ids) != 1:
            issues.add(
                code='AMBIGUOUS_SOURCE_ANNOTATION_IDS',
                message='A canonical instance must map to exactly one stored annotation.',
                severity='blocker', image_id=image_id, annotation_id=instance.instance_id,
            )
            continue
        geometry = instance.geometry
        bbox = geometry.bbox
        if bbox is None:
            issues.add(
                code='MISSING_GEOMETRY', message='A selected annotation has no canonical bbox.',
                severity='blocker', image_id=image_id, annotation_id=instance.instance_id,
            )
            continue
        if geometry.is_out_of_bounds:
            issues.add(
                code='GEOMETRY_OUT_OF_BOUNDS', message='A selected annotation lies outside its image bounds.',
                severity='blocker', image_id=image_id, annotation_id=instance.instance_id,
            )
            continue

        regions = [
            ExportRegion(
                polygon=[[float(x), float(y)] for x, y in region],
                source_annotation_id=instance.source_annotation_ids[0],
            )
            for region in geometry.regions
        ]
        if regions:
            area = sum(polygon_area(region) for region in geometry.regions)
        else:
            area = bbox.area
            stats.bbox_only_instances += 1
        exported.append(ExportInstance(
            instance_id=f'{image_id}::{instance.instance_id}',
            source_instance_id=instance.instance_id,
            source_annotation_ids=list(instance.source_annotation_ids),
            class_name=instance.class_name,
            source_model=instance.provenance.producer.source_id,
            bbox_xyxy=[bbox.x1, bbox.y1, bbox.x2, bbox.y2],
            area=area,
            regions=regions,
            attributes=_sanitize(dict(instance.attributes), key='', stats=stats) or {},
        ))
        stats.regions_written += len(regions)
        if len(regions) > 1:
            stats.multipart_instances += 1

    stats.instances_written += len(exported)
    return ExportImage(
        image_id=image_id,
        image_rel_path=rel.as_posix(),
        width=width,
        height=height,
        source_path=str(image.get('abs_path') or '').strip(),
        instances=exported,
    )
