from __future__ import annotations

import hashlib
import logging
import shutil
import threading
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException
from PIL import Image

from app.utils import ensure_dir, new_id


class ImagePreviewService:
    def __init__(
        self,
        *,
        get_current_data_dir: Callable[[], Path],
        preview_max_edge: int = 1280,
        thumbnail_max_edge: int = 384,
        logger: logging.Logger | None = None,
        maintenance_lock: threading.RLock | None = None,
    ) -> None:
        self.get_current_data_dir = get_current_data_dir
        self.preview_max_edge = max(256, int(preview_max_edge or 1280))
        self.thumbnail_max_edge = max(64, int(thumbnail_max_edge or 384))
        self.logger = logger or logging.getLogger('web_auto.previews')
        self.maintenance_lock = maintenance_lock
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def preview_cache_dir(self, project_id: str, image_id: str, image_path: Path) -> Path:
        stat = image_path.stat()
        key_raw = f'{project_id}:{image_id}:{image_path}:{stat.st_mtime_ns}:{stat.st_size}:preview-v3'
        key = hashlib.sha256(key_raw.encode('utf-8')).hexdigest()[:24]
        return ensure_dir(self.get_current_data_dir() / '.preview-cache' / str(project_id) / f'{image_id}_{key}')

    def _lock_for_dir(self, cache_dir: Path) -> threading.Lock:
        key = str(cache_dir.resolve())
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    @staticmethod
    def _metadata_path(cache_dir: Path) -> Path:
        return cache_dir / 'metadata.json'

    @staticmethod
    def _preview_path(cache_dir: Path) -> Path:
        return cache_dir / 'preview.jpg'

    @staticmethod
    def _thumbnail_path(cache_dir: Path) -> Path:
        return cache_dir / 'thumbnail.jpg'

    def _read_metadata(self, cache_dir: Path) -> dict[str, Any] | None:
        meta_path = self._metadata_path(cache_dir)
        if not meta_path.is_file():
            return None
        try:
            import json

            data = json.loads(meta_path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                return None
            if not self._preview_path(cache_dir).is_file() or not self._thumbnail_path(cache_dir).is_file():
                return None
            return data
        except Exception:
            return None

    @staticmethod
    def _save_jpeg(source: Image.Image, output: Path, max_edge: int) -> tuple[int, int]:
        image = source.copy()
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        if image.mode not in {'RGB', 'L'}:
            background = Image.new('RGB', image.size, (255, 255, 255))
            if 'A' in image.getbands():
                background.paste(image, mask=image.getchannel('A'))
                image = background
            else:
                image = image.convert('RGB')
        elif image.mode == 'L':
            image = image.convert('RGB')
        image.info.pop('exif', None)
        image.save(output, format='JPEG', quality=85, optimize=True, exif=b'')
        return int(image.size[0]), int(image.size[1])

    def generate_previews(self, cache_dir: Path, image_path: Path) -> dict[str, Any]:
        tmp_dir = cache_dir.with_name(f'{cache_dir.name}.tmp_{new_id()}')
        ensure_dir(tmp_dir)
        try:
            with Image.open(image_path) as source:
                source.load()
                source_width, source_height = int(source.size[0]), int(source.size[1])
                preview_width, preview_height = self._save_jpeg(source, self._preview_path(tmp_dir), self.preview_max_edge)
                thumb_width, thumb_height = self._save_jpeg(source, self._thumbnail_path(tmp_dir), self.thumbnail_max_edge)

            metadata = {
                'status': 'ready',
                'source_width': source_width,
                'source_height': source_height,
                'preview_width': preview_width,
                'preview_height': preview_height,
                'thumbnail_width': thumb_width,
                'thumbnail_height': thumb_height,
                'preview_max_edge': self.preview_max_edge,
                'thumbnail_max_edge': self.thumbnail_max_edge,
            }
            import json

            self._metadata_path(tmp_dir).write_text(json.dumps(metadata, ensure_ascii=False), encoding='utf-8')
            if cache_dir.exists():
                shutil.rmtree(cache_dir)
            tmp_dir.replace(cache_dir)
            return metadata
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f'failed to generate image preview: {exc}') from exc
        finally:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir, ignore_errors=True)

    def ensure_image_previews(self, project_id: str, image_id: str, image_path: Path) -> tuple[Path, dict[str, Any]]:
        gate = self.maintenance_lock if self.maintenance_lock is not None else nullcontext()
        with gate:
            cache_dir = self.preview_cache_dir(project_id, image_id, image_path)
            metadata = self._read_metadata(cache_dir)
            if metadata:
                return cache_dir, metadata

            with self._lock_for_dir(cache_dir):
                metadata = self._read_metadata(cache_dir)
                if metadata:
                    return cache_dir, metadata
                metadata = self.generate_previews(cache_dir, image_path)
                self.logger.info('generated image preview for %s/%s', project_id, image_id)
                return cache_dir, metadata

    def preview_file(self, cache_dir: Path) -> Path:
        path = self._preview_path(cache_dir)
        if not path.is_file():
            raise HTTPException(status_code=404, detail='preview not found')
        return path

    def thumbnail_file(self, cache_dir: Path) -> Path:
        path = self._thumbnail_path(cache_dir)
        if not path.is_file():
            raise HTTPException(status_code=404, detail='thumbnail not found')
        return path
