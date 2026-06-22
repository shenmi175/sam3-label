from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

from app.utils import ensure_dir, new_id


class ImageTileService:
    def __init__(self, *, get_current_data_dir: Callable[[], Path], lock: threading.Lock):
        self.get_current_data_dir = get_current_data_dir
        self.lock = lock

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
        tile_dir = self.tile_cache_dir(project_id, image_id, image_path)
        metadata = self.read_dzi_metadata(tile_dir)
        if metadata:
            return tile_dir, metadata

        with self.lock:
            metadata = self.read_dzi_metadata(tile_dir)
            if metadata:
                return tile_dir, metadata
            return self.generate_image_tiles(tile_dir, image_path)

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
