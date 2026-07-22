from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from app.schemas import AnnotationMigrationIn, AppendAnnIn, SaveAnnIn
from app.storage import Storage
from app.utils import new_id


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


def _assign_unique_annotation_ids(
    *,
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    used: set[str] = set()
    for ann in existing:
        sid = str(ann.get('id') or '').strip()
        if sid:
            used.add(sid)

    out: list[dict[str, Any]] = []
    for idx, ann in enumerate(incoming, start=1):
        item = dict(ann) if isinstance(ann, dict) else {}
        sid = str(item.get('id') or '').strip()
        if (not sid) or (sid in used):
            sid = new_id('ann_')
        while sid in used:
            sid = f'{sid}_{idx}'
        used.add(sid)
        item['id'] = sid
        out.append(item)
    return out


def create_annotations_router(*, get_storage: Callable[[], Storage]) -> APIRouter:
    router = APIRouter()

    @router.get('/api/projects/{project_id}/images/{image_id}/annotations')
    def get_annotations(project_id: str, image_id: str) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, project_id)
        _get_image_or_404(storage, project, image_id)
        anns = storage.load_annotations(project_id, image_id)
        return {'annotations': anns}

    @router.post('/api/annotations/save')
    def save_annotations(payload: SaveAnnIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        _get_image_or_404(storage, project, payload.image_id)
        storage.save_annotations(payload.project_id, payload.image_id, payload.annotations)
        saved = storage.load_annotations(payload.project_id, payload.image_id)
        return {'ok': True, 'saved_annotations': saved}

    @router.post('/api/annotations/append')
    def append_annotations(payload: AppendAnnIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        _get_image_or_404(storage, project, payload.image_id)

        old = storage.load_annotations(payload.project_id, payload.image_id)
        incoming = payload.annotations if isinstance(payload.annotations, list) else []
        incoming = [ann for ann in incoming if isinstance(ann, dict)]
        incoming = _assign_unique_annotation_ids(existing=old, incoming=incoming)
        merged = list(old) + incoming
        storage.save_annotations(payload.project_id, payload.image_id, merged)
        saved = storage.load_annotations(payload.project_id, payload.image_id)
        return {'ok': True, 'saved_annotations': saved, 'added': len(incoming)}

    @router.post('/api/projects/{project_id}/annotations/migrate')
    def migrate_annotations(project_id: str, payload: AnnotationMigrationIn) -> dict[str, Any]:
        storage = get_storage()
        _get_project_or_404(storage, project_id)
        return storage.migrate_annotation_layout(project_id, dry_run=bool(payload.dry_run))

    return router
