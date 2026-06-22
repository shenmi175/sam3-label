from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.services.image_tiles import ImageTileService
from app.storage import Storage


def _get_project_or_404(storage: Storage, project_id: str) -> dict[str, Any]:
    project = storage.get_project(project_id, enrich=False, include_images=False)
    if not project:
        raise HTTPException(status_code=404, detail='project not found')
    return project


def _get_image_or_404(storage: Storage, project: dict[str, Any], image_id: str) -> dict[str, Any]:
    image = storage.find_image(project, image_id)
    if not image:
        raise HTTPException(status_code=404, detail='image not found')
    return image


def create_image_files_router(
    *,
    get_storage: Callable[[], Storage],
    tile_service: ImageTileService,
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/projects/{project_id}/images/{image_id}/file')
    def get_image_file(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        return FileResponse(str(tile_service.image_file_path_or_404(image)))

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/info')
    def get_image_tiles_info(project_id: str, image_id: str) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        tile_dir, metadata = tile_service.ensure_image_tiles(project_id, image_id, image_path)
        return {
            'width': metadata['width'],
            'height': metadata['height'],
            'tile_size': metadata['tile_size'],
            'overlap': metadata['overlap'],
            'format': metadata['format'],
            'dzi_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image.dzi',
            'tiles_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image_files/',
            'cache_dir': str(tile_dir),
        }

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/image.dzi')
    def get_image_dzi(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        tile_dir, _metadata = tile_service.ensure_image_tiles(
            project_id,
            image_id,
            tile_service.image_file_path_or_404(image),
        )
        return FileResponse(str(tile_service.dzi_metadata_path(tile_dir)), media_type='application/xml')

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/image_files/{level}/{tile_name}')
    def get_image_tile(project_id: str, image_id: str, level: str, tile_name: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        tile_dir, _metadata = tile_service.ensure_image_tiles(
            project_id,
            image_id,
            tile_service.image_file_path_or_404(image),
        )
        safe_level = Path(str(level)).name
        safe_tile = Path(str(tile_name)).name
        tile_path = (tile_dir / 'image_files' / safe_level / safe_tile).resolve()
        try:
            tile_path.relative_to(tile_dir.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail='invalid tile path') from exc
        if not tile_path.exists() or not tile_path.is_file():
            raise HTTPException(status_code=404, detail='tile not found')
        return FileResponse(str(tile_path))

    return router
