from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.utils import ensure_dir, new_id


def _safe_dataset_relative_path(relative_path: str, filename: str) -> Path:
    raw = str(relative_path or filename or '').replace('\\', '/').strip().lstrip('/')
    if not raw:
        raw = str(filename or '').replace('\\', '/').strip().lstrip('/')
    if not raw:
        raw = f'upload_{new_id()}'

    parts: list[str] = []
    for part in raw.split('/'):
        if part in {'', '.', '..'}:
            raise HTTPException(status_code=400, detail='invalid relative_path')
        if '\x00' in part:
            raise HTTPException(status_code=400, detail='invalid relative_path')
        parts.append(part)
    return Path(*parts)


def create_uploads_router(
    *,
    host_data_root: Path,
    allowed_data_roots: list[Path],
    configured_upload_target_dir: Callable[[], Path],
    resolve_dataset_upload_dir: Callable[[str], Path],
    path_within_root: Callable[[Path, Path], bool],
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/uploads/config')
    def get_upload_config() -> dict[str, Any]:
        target = configured_upload_target_dir()
        return {
            'host_data_root': str(host_data_root),
            'allowed_data_roots': [str(root) for root in allowed_data_roots],
            'default_target_dir': str(target),
        }

    @router.post('/api/uploads/dataset')
    async def upload_dataset_file(
        file: UploadFile = File(...),
        target_dir: str = Form(...),
        relative_path: str = Form(default=''),
        overwrite: bool = Form(default=False),
    ) -> dict[str, Any]:
        upload_root = resolve_dataset_upload_dir(target_dir)
        safe_rel = _safe_dataset_relative_path(relative_path, file.filename or '')
        target_path = (upload_root / safe_rel).resolve()
        if not path_within_root(target_path, upload_root):
            raise HTTPException(status_code=400, detail='relative_path escapes target_dir')
        if target_path.exists() and not overwrite:
            raise HTTPException(status_code=409, detail=f'file already exists: {target_path}')

        ensure_dir(target_path.parent)
        tmp_path = target_path.with_name(f'.{target_path.name}.upload-{new_id()}.tmp')
        bytes_written = 0
        try:
            with tmp_path.open('wb') as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    bytes_written += len(chunk)
            tmp_path.replace(target_path)
        except HTTPException:
            raise
        except Exception as exc:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f'failed to save file: {exc}') from exc
        finally:
            try:
                await file.close()
            except Exception:
                pass

        return {
            'ok': True,
            'path': str(target_path),
            'relative_path': safe_rel.as_posix(),
            'size': bytes_written,
        }

    return router
