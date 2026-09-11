from __future__ import annotations

import re
from typing import Any, Mapping

from app.annotations.models import SourceIdentity


_ALIASES = {
    'sam': ('sam3', 'SAM3'),
    'sam-3': ('sam3', 'SAM3'),
    'sam3': ('sam3', 'SAM3'),
    'la': ('locate-anything', 'Locate Anything'),
    'locate-anything': ('locate-anything', 'Locate Anything'),
    'locateanything': ('locate-anything', 'Locate Anything'),
    'annotator': ('manual', 'Manual'),
    'human': ('manual', 'Manual'),
    'human-annotation': ('manual', 'Manual'),
    'manual': ('manual', 'Manual'),
    'unknown': ('unknown', 'Unknown'),
}


def _slug(value: str) -> str:
    lowered = value.strip().lower().replace('_', '-').replace(' ', '-')
    lowered = re.sub(r'[^a-z0-9-]+', '-', lowered)
    return re.sub(r'-+', '-', lowered).strip('-')[:64].rstrip('-')


def normalize_source(value: Any) -> SourceIdentity:
    """Normalize known aliases while preserving valid future producer ids."""
    raw = str(value or '').strip()
    if not raw:
        return SourceIdentity('unknown', 'Unknown', '', is_unknown=True)
    slug = _slug(raw)
    if not slug:
        return SourceIdentity('unknown', 'Unknown', raw, is_unknown=True)
    known = _ALIASES.get(slug)
    if known:
        return SourceIdentity(known[0], known[1], raw, is_unknown=known[0] == 'unknown')
    return SourceIdentity(slug, raw, raw)


def _has_segmentation_geometry(annotation: Mapping[str, Any]) -> bool:
    if any(str(annotation.get(field) or '').strip() for field in ('mask_url', 'mask_png_base64', 'mask_png')):
        return True
    polygon = annotation.get('polygon')
    if isinstance(polygon, list) and len(polygon) >= 3:
        return True
    polygons = annotation.get('polygons')
    return isinstance(polygons, list) and any(
        isinstance(region, list) and len(region) >= 3
        for region in polygons
    )


def infer_annotation_source(annotation: Mapping[str, Any]) -> SourceIdentity:
    """Resolve provenance, treating legacy segmentation without a source as SAM3.

    Explicit provenance always wins, including an explicit ``unknown`` value.
    The geometry fallback is intentionally limited to source-less segmentation;
    bbox-only legacy annotations remain unknown.
    """
    source_value = (
        annotation.get('source_model')
        if annotation.get('source_model') not in (None, '')
        else annotation.get('source')
    )
    producer = normalize_source(source_value)
    if producer.is_unknown and not producer.raw_value and _has_segmentation_geometry(annotation):
        return normalize_source('sam3')
    return producer
