from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from app.schemas import UpdateClassesIn
from app.storage import Storage


def _error_code(exc: ValueError) -> int:
    return 404 if str(exc) == 'project not found' else 400


def create_classes_router(*, get_storage: Callable[[], Storage]) -> APIRouter:
    router = APIRouter()

    @router.post('/api/projects/{project_id}/classes')
    def update_classes(project_id: str, payload: UpdateClassesIn) -> dict[str, Any]:
        try:
            project = get_storage().add_classes(project_id, payload.classes_text)
            return {'project': project}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.post('/api/projects/{project_id}/classes/add')
    def add_classes(project_id: str, payload: UpdateClassesIn) -> dict[str, Any]:
        try:
            project = get_storage().add_classes(project_id, payload.classes_text)
            return {'project': project}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    @router.delete('/api/projects/{project_id}/classes/{class_name}')
    def delete_class(project_id: str, class_name: str) -> dict[str, Any]:
        try:
            project = get_storage().delete_class(project_id, class_name)
            return {'project': project}
        except ValueError as exc:
            raise HTTPException(status_code=_error_code(exc), detail=str(exc)) from exc

    return router
