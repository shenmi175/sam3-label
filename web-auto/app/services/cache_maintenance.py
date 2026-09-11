from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path
from typing import Any, Callable, Iterable

from fastapi import HTTPException

from app.utils import ensure_dir, new_id


CACHE_SCOPES = ('previews', 'tiles', 'composites')


def _empty_usage() -> dict[str, int]:
    return {
        'file_count': 0,
        'directory_count': 0,
        'logical_bytes': 0,
        'disk_bytes': 0,
    }


def _add_entry(usage: dict[str, int], entry: os.DirEntry[str]) -> None:
    try:
        stat = entry.stat(follow_symlinks=False)
    except OSError:
        return
    if entry.is_dir(follow_symlinks=False):
        usage['directory_count'] += 1
        usage['disk_bytes'] += int(getattr(stat, 'st_blocks', 0)) * 512
    else:
        usage['file_count'] += 1
        usage['logical_bytes'] += int(stat.st_size)
        usage['disk_bytes'] += int(getattr(stat, 'st_blocks', 0)) * 512


def _tree_usage(root: Path) -> dict[str, int]:
    usage = _empty_usage()
    if not root.exists() and not root.is_symlink():
        return usage
    if root.is_symlink() or not root.is_dir():
        raise HTTPException(status_code=409, detail=f'cache path is not a regular directory: {root.name}')

    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f'failed to inspect cache: {exc}') from exc
        for entry in entries:
            _add_entry(usage, entry)
            if entry.is_dir(follow_symlinks=False):
                pending.append(Path(entry.path))
    return usage


def _composite_dirs(mask_root: Path) -> Iterable[Path]:
    if not mask_root.exists() and not mask_root.is_symlink():
        return
    if mask_root.is_symlink() or not mask_root.is_dir():
        raise HTTPException(status_code=409, detail='annotation mask path is not a regular directory')

    pending = [mask_root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f'failed to inspect composite cache: {exc}') from exc
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            path = Path(entry.path)
            if entry.name == '_composite':
                yield path
            else:
                pending.append(path)


def _sum_usage(items: Iterable[dict[str, int]]) -> dict[str, int]:
    total = _empty_usage()
    for usage in items:
        for key in total:
            total[key] += int(usage.get(key, 0))
    return total


class CacheMaintenanceService:
    def __init__(
        self,
        *,
        get_current_data_dir: Callable[[], Path],
        ensure_no_active_jobs: Callable[[], None],
        has_active_tile_jobs: Callable[[], bool],
        maintenance_lock: threading.RLock,
    ) -> None:
        self.get_current_data_dir = get_current_data_dir
        self.ensure_no_active_jobs = ensure_no_active_jobs
        self.has_active_tile_jobs = has_active_tile_jobs
        self.maintenance_lock = maintenance_lock

    def _data_dir(self) -> Path:
        return self.get_current_data_dir().expanduser().resolve()

    @staticmethod
    def _child(data_dir: Path, name: str) -> Path:
        path = data_dir / name
        try:
            path.resolve(strict=False).relative_to(data_dir)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail='cache path escaped the configured data directory') from exc
        return path

    def _scope_usage(self, data_dir: Path, scope: str) -> dict[str, int]:
        if scope == 'previews':
            return _tree_usage(self._child(data_dir, '.preview-cache'))
        if scope == 'tiles':
            return _tree_usage(self._child(data_dir, '.tile-cache'))
        if scope == 'composites':
            roots = list(_composite_dirs(self._child(data_dir, '.annotation-masks')))
            usage = _sum_usage(_tree_usage(root) for root in roots)
            usage['directory_count'] += len(roots)
            return usage
        raise HTTPException(status_code=400, detail=f'unsupported cache scope: {scope}')

    def status(self) -> dict[str, Any]:
        with self.maintenance_lock:
            data_dir = self._data_dir()
            scopes = {scope: self._scope_usage(data_dir, scope) for scope in CACHE_SCOPES}
            return {
                'data_dir': str(data_dir),
                'scopes': scopes,
                'total': _sum_usage(scopes.values()),
            }

    @staticmethod
    def _clear_root(root: Path) -> None:
        if not root.exists() and not root.is_symlink():
            ensure_dir(root)
            return
        if root.is_symlink() or not root.is_dir():
            raise HTTPException(status_code=409, detail=f'cache path is not a regular directory: {root.name}')
        retired = root.with_name(f'{root.name}.cleanup_{new_id()}')
        os.replace(root, retired)
        ensure_dir(root)
        try:
            shutil.rmtree(retired)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f'cache was detached but could not be removed: {exc}') from exc

    @staticmethod
    def _clear_composites(mask_root: Path) -> None:
        roots = list(_composite_dirs(mask_root))
        retired: list[Path] = []
        for root in roots:
            moved = root.with_name(f'_composite.cleanup_{new_id()}')
            os.replace(root, moved)
            retired.append(moved)
        for root in retired:
            try:
                shutil.rmtree(root)
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f'composite cache could not be removed: {exc}') from exc

    def cleanup(self, scopes: list[str]) -> dict[str, Any]:
        selected = list(dict.fromkeys(scopes))
        invalid = [scope for scope in selected if scope not in CACHE_SCOPES]
        if not selected:
            raise HTTPException(status_code=400, detail='select at least one cache scope')
        if invalid:
            raise HTTPException(status_code=400, detail=f'unsupported cache scope: {invalid[0]}')

        with self.maintenance_lock:
            self.ensure_no_active_jobs()
            if 'tiles' in selected and self.has_active_tile_jobs():
                raise HTTPException(status_code=409, detail='cannot clear tile cache while tile jobs are queued or running')

            data_dir = self._data_dir()
            before = {scope: self._scope_usage(data_dir, scope) for scope in selected}
            for scope in selected:
                if scope == 'previews':
                    self._clear_root(self._child(data_dir, '.preview-cache'))
                elif scope == 'tiles':
                    self._clear_root(self._child(data_dir, '.tile-cache'))
                else:
                    self._clear_composites(self._child(data_dir, '.annotation-masks'))

            return {
                'ok': True,
                'scopes': before,
                'released': _sum_usage(before.values()),
                'status': self.status(),
            }
