from __future__ import annotations

import shutil
import time
from pathlib import Path

from app.utils import ensure_dir


PREVIEW_TTL_SECONDS = 24 * 60 * 60


def preview_root(base_dir: Path) -> Path:
    return ensure_dir(base_dir / '.smart-filter-previews')


def preview_dir(base_dir: Path, token: str) -> Path:
    return ensure_dir(preview_root(base_dir) / str(token))


def cleanup_expired_previews(base_dir: Path, *, now: float | None = None) -> None:
    cutoff = float(now if now is not None else time.time()) - PREVIEW_TTL_SECONDS
    for child in preview_root(base_dir).iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue


def resolve_preview_artifact(base_dir: Path, token: str, relative_name: str) -> Path | None:
    root = (preview_root(base_dir) / Path(str(token)).name).resolve()
    target = (root / str(relative_name)).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    return target if target.is_file() else None
