from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

from app.annotations.models import CanonicalAnnotation


@dataclass(frozen=True)
class ResolvedAnnotationMask:
    image: Image.Image
    source_kind: str
    sha256: str = ''
    warning_code: str = ''

    @property
    def area_px(self) -> int:
        return int(sum(self.image.convert('L').histogram()[128:]))


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_annotation_mask(
    annotation: CanonicalAnnotation,
    *,
    size: tuple[int, int],
    sidecar_path: Path | None = None,
    require_multiple_regions: bool = False,
) -> ResolvedAnnotationMask | None:
    """Resolve sidecar/polygon geometry with one shared fallback policy."""
    sidecar_warning = ''
    schema_version = int(annotation.attributes.get('schema_version') or 0)
    if (
        (annotation.geometry.mask_refs or schema_version < 3)
        and sidecar_path is not None
        and sidecar_path.is_file()
    ):
        try:
            with Image.open(sidecar_path) as opened:
                mask = opened.convert('L')
            if mask.size == size:
                return ResolvedAnnotationMask(mask, 'mask', _hash_file(sidecar_path))
            sidecar_warning = 'MASK_DIMENSIONS_MISMATCH'
        except OSError:
            sidecar_warning = 'MASK_SIDECAR_INVALID'

    regions = annotation.geometry.regions
    if not regions or (require_multiple_regions and len(regions) <= 1):
        return None
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    for region in regions:
        draw.polygon([(float(x), float(y)) for x, y in region], fill=255)
    if not any(mask.getbbox() or ()):
        return None
    return ResolvedAnnotationMask(mask, 'polygons', warning_code=sidecar_warning)
