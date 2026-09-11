from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from app.audit import AuditLogger
from app.schemas import ImportImagesIn
from app.storage import Storage
from app.utils import IMAGE_EXTENSIONS, ensure_dir


def _error_code(exc: ValueError, *, not_found: set[str] | None = None) -> int:
    msg = str(exc)
    return 404 if msg in (not_found or {'project not found'}) else 400


def _safe_upload_target(root: Path, filename: str) -> Path:
    base_name = Path(str(filename or '').strip()).name
    if not base_name:
        base_name = 'upload.jpg'
    suffix = Path(base_name).suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f'unsupported image type: {suffix or "unknown"}')

    stem = Path(base_name).stem.strip() or 'upload'
    target = (root / f'{stem}{suffix}').resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='invalid upload filename') from exc

    if not target.exists():
        return target
    for idx in range(1, 10000):
        candidate = (root / f'{stem}_{idx}{suffix}').resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail='invalid upload filename') from exc
        if not candidate.exists():
            return candidate
    raise HTTPException(status_code=409, detail='too many duplicate filenames')


def create_project_images_router(*, get_storage: Callable[[], Storage], audit: AuditLogger | None = None) -> APIRouter:
    router = APIRouter()

    @router.post('/api/projects/{project_id}/images/upload')
    async def upload_project_image(project_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
        storage = get_storage()
        project = storage.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise HTTPException(status_code=404, detail='project not found')
        if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
            raise HTTPException(status_code=400, detail='only image or pose projects support uploads')

        image_dir = Path(str(project.get('image_dir') or '')).expanduser().resolve()
        ensure_dir(image_dir)
        target_path = _safe_upload_target(image_dir, file.filename or 'upload.jpg')
        try:
            ensure_dir(target_path.parent)
            with target_path.open('wb') as out:
                shutil.copyfileobj(file.file, out)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f'failed to save file: {exc}') from exc
        finally:
            try:
                await file.close()
            except Exception:
                pass

        storage.refresh_project_images(project_id)
        return {'ok': True, 'filename': target_path.name}

    @router.get('/api/projects/{project_id}/images')
    def list_project_images(
        project_id: str,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=200, ge=1, le=1000),
        image_id: str = Query(default=''),
        status: str = Query(default=''),
        class_name: str = Query(default=''),
        source_model: str = Query(default=''),
    ) -> dict[str, Any]:
        try:
            items, total, safe_offset, safe_limit, image_index = get_storage().get_project_images_page(
                project_id,
                offset=offset,
                limit=limit,
                image_id=image_id,
                status=status,
                class_name=class_name,
                source_model=source_model,
            )
            return {
                'items': items,
                'total': total,
                'offset': safe_offset,
                'limit': safe_limit,
                'image_index': image_index,
                'status': status,
                'class_name': class_name,
                'source_model': source_model,
            }
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.get('/api/projects/{project_id}/annotation_dashboard')
    def get_annotation_dashboard(project_id: str) -> dict[str, Any]:
        try:
            return {'stats': get_storage().get_annotation_dashboard(project_id)}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.post('/api/projects/{project_id}/annotation_index/rebuild')
    def rebuild_annotation_index(project_id: str) -> dict[str, Any]:
        try:
            return {'ok': True, 'result': get_storage().rebuild_annotation_index(project_id)}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.get('/api/projects/{project_id}/images/unlabeled')
    def get_unlabeled_project_image(
        project_id: str,
        after_image_id: str = Query(default=''),
        direction: str = Query(default='next', pattern='^(next|prev)$'),
    ) -> dict[str, Any]:
        try:
            image, image_index = get_storage().find_unlabeled_image(
                project_id,
                after_image_id=after_image_id,
                direction=direction,
            )
            return {'image': image, 'image_index': image_index}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.post('/api/projects/{project_id}/images/refresh')
    def refresh_project_images(project_id: str) -> dict[str, Any]:
        try:
            project, added = get_storage().refresh_project_images(project_id)
            return {'project': project, 'added_images': added}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.post('/api/projects/{project_id}/images/import')
    def import_project_images(project_id: str, payload: ImportImagesIn) -> dict[str, Any]:
        try:
            project, copied, added = get_storage().import_images_from_dir(project_id, payload.source_dir)
            if audit:
                audit.emit(category='data_transfer', action='import_images', project_id=project_id, message='Images imported into project', details={'copied_files': copied, 'added_images': added})
            return {'project': project, 'copied_files': copied, 'added_images': added}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.delete('/api/projects/{project_id}/images/{image_id}')
    def delete_image(project_id: str, image_id: str) -> dict[str, Any]:
        try:
            project, deleted_image = get_storage().delete_image(project_id, image_id)
            return {'ok': True, 'project': project, 'deleted_image': deleted_image}
        except ValueError as exc:
            raise HTTPException(
                status_code=_error_code(exc, not_found={'project not found', 'image not found'}),
                detail=str(exc),
            ) from exc

    return router
