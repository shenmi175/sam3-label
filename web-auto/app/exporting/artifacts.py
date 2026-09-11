from __future__ import annotations

import tempfile
import zipfile
import os
from pathlib import Path


ALLOWED_ARCHIVE_FILES = frozenset({'manifest.json', 'classes.json', 'image_index.json', 'README.txt'})


def temporary_zip_path(directory: Path | None = None) -> Path:
    temporary = tempfile.NamedTemporaryFile(
        prefix='.web-auto-json-package-',
        suffix='.tmp',
        dir=str(directory) if directory is not None else None,
        delete=False,
    )
    path = Path(temporary.name)
    temporary.close()
    return path


def unique_output_path(path: Path) -> Path:
    if not path.exists():
        return path
    index = 1
    while True:
        candidate = path.with_name(f'{path.stem}_{index}{path.suffix}')
        if not candidate.exists():
            return candidate
        index += 1


def publish_unique_file(temporary_path: Path, requested_path: Path) -> Path:
    """Publish with an exclusive hard link so a race can never overwrite output."""
    index = 0
    while True:
        candidate = requested_path if index == 0 else requested_path.with_name(
            f'{requested_path.stem}_{index}{requested_path.suffix}'
        )
        try:
            os.link(temporary_path, candidate)
            temporary_path.unlink()
            return candidate
        except FileExistsError:
            index += 1


def publish_unique_directory(temporary_path: Path, requested_path: Path) -> Path:
    target = unique_output_path(requested_path)
    temporary_path.rename(target)
    return target


def validate_annotation_only_archive(path: Path) -> None:
    with zipfile.ZipFile(path, mode='r') as bundle:
        names = bundle.namelist()
    for name in names:
        if name in ALLOWED_ARCHIVE_FILES:
            continue
        if name.startswith('annotations/') and name.endswith('.json'):
            continue
        raise ValueError(f'annotation-only package contains a disallowed file: {name}')
