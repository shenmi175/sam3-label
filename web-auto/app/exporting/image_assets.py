from __future__ import annotations

import shutil
from pathlib import Path

from app.exporting.models import ExportImage, ImageExportMode


def materialize_images(
    *,
    root: Path,
    images: list[ExportImage],
    relative_paths: dict[str, Path],
    mode: ImageExportMode,
) -> None:
    if mode == 'none':
        return
    for image in images:
        relative = relative_paths.get(image.image_id)
        if relative is None or relative.is_absolute() or '..' in relative.parts:
            raise ValueError(f'invalid exported image path: {image.image_id}')
        source = Path(image.source_path).expanduser().resolve()
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            raise ValueError(f'duplicate exported image path: {relative.as_posix()}')
        if mode == 'symlink':
            target.symlink_to(source)
        else:
            shutil.copy2(source, target)


def validate_materialized_images(
    *,
    root: Path,
    images: list[ExportImage],
    relative_paths: dict[str, Path],
    mode: ImageExportMode,
) -> None:
    if mode == 'none':
        return
    sources = {image.image_id: Path(image.source_path).expanduser().resolve() for image in images}
    for image_id, relative in relative_paths.items():
        exported = root / relative
        source = sources[image_id]
        if mode == 'symlink':
            if not exported.is_symlink() or exported.resolve() != source:
                raise ValueError(f'exported image symlink is invalid: {image_id}')
        elif exported.is_symlink() or not exported.is_file() or exported.stat().st_size != source.stat().st_size:
            raise ValueError(f'exported image copy is invalid: {image_id}')
