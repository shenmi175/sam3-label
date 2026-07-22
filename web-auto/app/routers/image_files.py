from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response
from PIL import Image

from app.services.annotation_masks import build_overlay, build_semantic_mask, mask_file_or_404
from app.services.image_previews import ImagePreviewService
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
    preview_service: ImagePreviewService,
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/projects/{project_id}/images/{image_id}/file')
    def get_image_file(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        return FileResponse(str(tile_service.image_file_path_or_404(image)))

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/info')
    def get_image_tiles_info(
        project_id: str,
        image_id: str,
        priority: str = Query('high'),
        enqueue: bool = Query(True),
    ) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        status = tile_service.tile_status(
            project_id,
            image_id,
            image_path,
            enqueue=bool(enqueue),
            priority=priority,
        )
        metadata = status.get('metadata') if isinstance(status.get('metadata'), dict) else None
        out: dict[str, Any] = {
            'status': status.get('status') or 'missing',
            'dzi_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image.dzi',
            'tiles_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image_files/',
            'cache_dir': str(status.get('tile_dir') or ''),
            'error': status.get('error') or '',
        }
        if metadata:
            out.update(
                {
                    'width': metadata['width'],
                    'height': metadata['height'],
                    'tile_size': metadata['tile_size'],
                    'overlap': metadata['overlap'],
                    'format': metadata['format'],
                }
            )
        return out

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/image.dzi')
    def get_image_dzi(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        status = tile_service.tile_status(
            project_id,
            image_id,
            image_path,
            enqueue=True,
            priority='high',
        )
        if status.get('status') != 'ready':
            raise HTTPException(status_code=202, detail={'status': status.get('status') or 'missing'})
        tile_dir = status.get('tile_dir')
        return FileResponse(str(tile_service.dzi_metadata_path(tile_dir)), media_type='application/xml')

    @router.get('/api/projects/{project_id}/images/{image_id}/tiles/image_files/{level}/{tile_name}')
    def get_image_tile(project_id: str, image_id: str, level: str, tile_name: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        status = tile_service.tile_status(
            project_id,
            image_id,
            image_path,
            enqueue=True,
            priority='medium',
        )
        if status.get('status') != 'ready':
            raise HTTPException(status_code=404, detail='tile cache is not ready')
        tile_dir = status.get('tile_dir')
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

    @router.get('/api/projects/{project_id}/images/{image_id}/preview/info')
    def get_image_preview_info(project_id: str, image_id: str) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        cache_dir, metadata = preview_service.ensure_image_previews(project_id, image_id, image_path)
        out = dict(metadata)
        out.update(
            {
                'status': 'ready',
                'width': metadata.get('source_width'),
                'height': metadata.get('source_height'),
                'preview_url': f'/api/projects/{project_id}/images/{image_id}/preview/preview.jpg?v={cache_dir.name}',
                'thumbnail_url': f'/api/projects/{project_id}/images/{image_id}/preview/thumbnail.jpg?v={cache_dir.name}',
                'cache_dir': str(cache_dir),
            }
        )
        return out

    @router.get('/api/projects/{project_id}/images/{image_id}/preview/preview.jpg')
    def get_image_preview(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        cache_dir, _metadata = preview_service.ensure_image_previews(project_id, image_id, image_path)
        return FileResponse(str(preview_service.preview_file(cache_dir)), media_type='image/jpeg')

    @router.get('/api/projects/{project_id}/images/{image_id}/preview/thumbnail.jpg')
    def get_image_thumbnail(project_id: str, image_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        cache_dir, _metadata = preview_service.ensure_image_previews(project_id, image_id, image_path)
        return FileResponse(str(preview_service.thumbnail_file(cache_dir)), media_type='image/jpeg')

    @router.get('/api/projects/{project_id}/images/{image_id}/masks/{annotation_id}.png')
    def get_annotation_mask(project_id: str, image_id: str, annotation_id: str) -> Response:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        _get_image_or_404(storage, project, image_id)
        path = mask_file_or_404(storage.base_dir, project_id, image_id, annotation_id)
        return FileResponse(str(path), media_type='image/png')

    def _source_image_size(image_path: Path) -> tuple[int, int] | None:
        try:
            with Image.open(image_path) as im:
                return int(im.size[0]), int(im.size[1])
        except Exception:
            return None

    @router.get('/api/projects/{project_id}/images/{image_id}/masks/{mask_image_id}/semantic.png')
    def get_semantic_mask(project_id: str, image_id: str, mask_image_id: str) -> Response:
        if str(mask_image_id) != str(image_id):
            raise HTTPException(status_code=404, detail='mask image not found')
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        path = build_semantic_mask(
            base_dir=storage.base_dir,
            project_id=project_id,
            image_id=image_id,
            image_size=_source_image_size(image_path),
            annotations=storage.load_annotations(project_id, image_id),
        )
        return FileResponse(str(path), media_type='image/png')

    @router.get('/api/projects/{project_id}/images/{image_id}/masks/{mask_image_id}/overlay.webp')
    def get_overlay_mask(project_id: str, image_id: str, mask_image_id: str) -> Response:
        if str(mask_image_id) != str(image_id):
            raise HTTPException(status_code=404, detail='mask image not found')
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        image = _get_image_or_404(storage, project, image_id)
        image_path = tile_service.image_file_path_or_404(image)
        path = build_overlay(
            base_dir=storage.base_dir,
            project_id=project_id,
            image_id=image_id,
            image_size=_source_image_size(image_path),
            annotations=storage.load_annotations(project_id, image_id),
        )
        return FileResponse(str(path), media_type='image/webp')

    return router
