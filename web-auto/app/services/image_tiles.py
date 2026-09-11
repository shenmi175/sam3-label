from __future__ import annotations

import hashlib
import logging
import os
import queue
import shutil
import subprocess
import threading
import xml.etree.ElementTree as ET
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

from app.utils import ensure_dir, new_id


_PRIORITY_RANK = {
    'high': 0,
    'medium': 1,
    'low': 2,
}


@dataclass
class TileJobState:
    status: str
    priority: str
    error: str = ''


class ImageTileService:
    def __init__(
        self,
        *,
        get_current_data_dir: Callable[[], Path],
        max_workers: int = 2,
        logger: logging.Logger | None = None,
        lock: threading.Lock | None = None,
        maintenance_lock: threading.RLock | None = None,
    ):
        self.get_current_data_dir = get_current_data_dir
        self.max_workers = max(1, int(max_workers or 1))
        self.logger = logger or logging.getLogger('web_auto.tiles')
        self._queue: queue.PriorityQueue[tuple[int, int, str, str, str, Path]] = queue.PriorityQueue()
        self._sequence = 0
        self._jobs: dict[str, TileJobState] = {}
        self._jobs_lock = threading.RLock()
        self._key_locks: dict[str, threading.Lock] = {}
        self._workers_started = False
        self._start_lock = threading.Lock()
        # Kept only for backward-compatible construction by older callers.
        self._legacy_lock = lock
        self.maintenance_lock = maintenance_lock

    def has_active_jobs(self) -> bool:
        with self._jobs_lock:
            return any(state.status in {'queued', 'generating'} for state in self._jobs.values())

    @staticmethod
    def image_file_path_or_404(image: dict[str, Any]) -> Path:
        abs_path_raw = str(image.get('abs_path') or '').strip()
        if abs_path_raw:
            path = Path(abs_path_raw).expanduser().resolve()
            if path.exists() and path.is_file():
                return path
        raise HTTPException(status_code=404, detail='image file not found')

    def tile_cache_dir(self, project_id: str, image_id: str, image_path: Path) -> Path:
        stat = image_path.stat()
        key_raw = f'{project_id}:{image_id}:{image_path}:{stat.st_mtime_ns}:{stat.st_size}'
        key = hashlib.sha256(key_raw.encode('utf-8')).hexdigest()[:24]
        return ensure_dir(self.get_current_data_dir() / '.tile-cache' / str(project_id) / f'{image_id}_{key}')

    def _job_key(self, tile_dir: Path) -> str:
        return str(tile_dir.resolve())

    def _normalize_priority(self, priority: str) -> str:
        value = str(priority or 'medium').strip().lower()
        return value if value in _PRIORITY_RANK else 'medium'

    def _priority_rank(self, priority: str) -> int:
        return _PRIORITY_RANK[self._normalize_priority(priority)]

    def _start_workers(self) -> None:
        if self._workers_started:
            return
        with self._start_lock:
            if self._workers_started:
                return
            for i in range(self.max_workers):
                thread = threading.Thread(target=self._worker_loop, name=f'tile-worker-{i + 1}', daemon=True)
                thread.start()
            self._workers_started = True

    def _lock_for_key(self, key: str) -> threading.Lock:
        with self._jobs_lock:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._key_locks[key] = lock
            return lock

    def _set_job_state(self, key: str, status: str, priority: str, error: str = '') -> None:
        with self._jobs_lock:
            self._jobs[key] = TileJobState(status=status, priority=self._normalize_priority(priority), error=error)

    def _job_state(self, key: str) -> TileJobState | None:
        with self._jobs_lock:
            return self._jobs.get(key)

    def _worker_loop(self) -> None:
        while True:
            rank, _seq, key, project_id, image_id, image_path = self._queue.get()
            priority = 'medium'
            try:
                state = self._job_state(key)
                if state is not None:
                    priority = state.priority
                    if state.status not in {'queued', 'generating'}:
                        continue
                    if rank > self._priority_rank(state.priority):
                        continue

                gate = self.maintenance_lock if self.maintenance_lock is not None else nullcontext()
                with gate:
                    tile_dir = Path(key)
                    with self._lock_for_key(key):
                        metadata = self.read_dzi_metadata(tile_dir)
                        if metadata:
                            self._set_job_state(key, 'ready', priority)
                            continue
                        self._set_job_state(key, 'generating', priority)
                        try:
                            self.generate_image_tiles(tile_dir, image_path)
                            self._set_job_state(key, 'ready', priority)
                            self.logger.info('generated DZI tiles for %s/%s', project_id, image_id)
                        except Exception as exc:  # noqa: BLE001
                            self._set_job_state(key, 'error', priority, str(exc))
                            self.logger.warning('failed to generate DZI tiles for %s/%s: %s', project_id, image_id, exc)
            finally:
                self._queue.task_done()

    @staticmethod
    def dzi_metadata_path(tile_dir: Path) -> Path:
        return tile_dir / 'image.dzi'

    def read_dzi_metadata(self, tile_dir: Path) -> dict[str, Any] | None:
        dzi = self.dzi_metadata_path(tile_dir)
        if not dzi.exists():
            return None
        try:
            root = ET.fromstring(dzi.read_text(encoding='utf-8', errors='ignore'))
        except ET.ParseError:
            return None
        size = None
        for child in root:
            if child.tag.split('}', 1)[-1] == 'Size':
                size = child
                break
        if size is None:
            return None
        fmt = str(root.attrib.get('Format') or '').strip()
        overlap = str(root.attrib.get('Overlap') or '').strip()
        tile_size = str(root.attrib.get('TileSize') or '').strip()
        height = str(size.attrib.get('Height') or '').strip()
        width = str(size.attrib.get('Width') or '').strip()
        if not fmt or not overlap or not tile_size or not height or not width:
            return None
        return {
            'format': fmt,
            'overlap': int(float(overlap)),
            'tile_size': int(float(tile_size)),
            'height': int(float(height)),
            'width': int(float(width)),
        }

    def ensure_image_tiles(self, project_id: str, image_id: str, image_path: Path) -> tuple[Path, dict[str, Any]]:
        gate = self.maintenance_lock if self.maintenance_lock is not None else nullcontext()
        with gate:
            tile_dir = self.tile_cache_dir(project_id, image_id, image_path)
            metadata = self.read_dzi_metadata(tile_dir)
            if metadata:
                return tile_dir, metadata

            key = self._job_key(tile_dir)
            with self._lock_for_key(key):
                metadata = self.read_dzi_metadata(tile_dir)
                if metadata:
                    return tile_dir, metadata
                return self.generate_image_tiles(tile_dir, image_path)

    def tile_status(
        self,
        project_id: str,
        image_id: str,
        image_path: Path,
        *,
        enqueue: bool = False,
        priority: str = 'medium',
    ) -> dict[str, Any]:
        gate = self.maintenance_lock if self.maintenance_lock is not None else nullcontext()
        with gate:
            tile_dir = self.tile_cache_dir(project_id, image_id, image_path)
            key = self._job_key(tile_dir)
            metadata = self.read_dzi_metadata(tile_dir)
            if metadata:
                self._set_job_state(key, 'ready', priority)
                return {
                    'status': 'ready',
                    'tile_dir': tile_dir,
                    'metadata': metadata,
                    'error': '',
                }

            if enqueue:
                self.enqueue_tile_job(project_id, image_id, image_path, priority=priority)

            state = self._job_state(key)
            status = state.status if state else 'missing'
            if status == 'ready':
                metadata = self.read_dzi_metadata(tile_dir)
                if metadata:
                    return {'status': 'ready', 'tile_dir': tile_dir, 'metadata': metadata, 'error': ''}
                status = 'missing'
            return {
                'status': status,
                'tile_dir': tile_dir,
                'metadata': None,
                'error': state.error if state else '',
            }

    def enqueue_tile_job(self, project_id: str, image_id: str, image_path: Path, *, priority: str = 'medium') -> None:
        priority = self._normalize_priority(priority)
        tile_dir = self.tile_cache_dir(project_id, image_id, image_path)
        key = self._job_key(tile_dir)
        if self.read_dzi_metadata(tile_dir):
            self._set_job_state(key, 'ready', priority)
            return

        with self._jobs_lock:
            current = self._jobs.get(key)
            should_enqueue = current is None or current.status in {'missing', 'error'} or (
                current.status == 'queued' and self._priority_rank(priority) < self._priority_rank(current.priority)
            )
            if current is not None and current.status == 'generating':
                if self._priority_rank(priority) < self._priority_rank(current.priority):
                    current.priority = priority
                return
            if not should_enqueue:
                return
            self._sequence += 1
            self._jobs[key] = TileJobState(status='queued', priority=priority)
            self._queue.put((self._priority_rank(priority), self._sequence, key, str(project_id), str(image_id), image_path))

        self._start_workers()

    def generate_image_tiles(self, tile_dir: Path, image_path: Path) -> tuple[Path, dict[str, Any]]:
        if shutil.which('vips') is None:
            raise HTTPException(
                status_code=503,
                detail='tile generation requires libvips. Rebuild web-auto image after updating docker/web-auto.Dockerfile.',
            )

        tmp_dir = tile_dir.with_name(f'{tile_dir.name}.tmp_{new_id()}')
        ensure_dir(tmp_dir)
        output_base = tmp_dir / 'image'
        try:
            subprocess.run(
                [
                    'vips',
                    'dzsave',
                    str(image_path),
                    str(output_base),
                    '--layout',
                    'dz',
                    '--tile-size',
                    '256',
                    '--overlap',
                    '1',
                    '--suffix',
                    '.jpg[Q=90]',
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=300,
            )
            metadata = self.read_dzi_metadata(tmp_dir)
            if not metadata:
                raise RuntimeError('failed to read generated DZI metadata')
            if tile_dir.exists():
                shutil.rmtree(tile_dir)
            os.replace(tmp_dir, tile_dir)
            return tile_dir, metadata
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or str(exc)).strip()
            raise HTTPException(status_code=500, detail=f'failed to generate image tiles: {detail[:500]}') from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        finally:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir, ignore_errors=True)
