from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.services.analytics_service import AnalyticsService


def _http_error(exc: ValueError) -> HTTPException:
    status = 404 if str(exc) == 'project not found' else 400
    return HTTPException(status_code=status, detail=str(exc))


def create_analytics_router(*, service: AnalyticsService) -> APIRouter:
    router = APIRouter()

    @router.get('/api/projects/{project_id}/analytics/index')
    def analytics_index_status(project_id: str) -> dict[str, Any]:
        try:
            return {'index': service.status(project_id)}
        except ValueError as exc:
            raise _http_error(exc) from exc

    @router.post('/api/projects/{project_id}/analytics/index/rebuild')
    def rebuild_analytics_index(project_id: str) -> dict[str, Any]:
        try:
            return {'job': service.spawn_rebuild(project_id)}
        except ValueError as exc:
            raise _http_error(exc) from exc

    @router.get('/api/projects/{project_id}/analytics/overview')
    def analytics_overview(
        project_id: str,
        task: str = Query(default='detection'),
        source: list[str] | None = Query(default=None),
    ) -> dict[str, Any]:
        try:
            overview = service.overview(project_id, task=task, sources=source)
        except ValueError as exc:
            raise _http_error(exc) from exc
        if overview is None:
            raise HTTPException(
                status_code=409,
                detail={
                    'code': 'ANALYTICS_INDEX_NOT_READY',
                    'message': 'analytics index is not ready',
                },
            )
        return {'overview': overview}

    @router.get('/api/projects/{project_id}/analytics/dimensions')
    def analytics_dimensions(project_id: str) -> dict[str, Any]:
        try:
            dimensions = service.dimensions(project_id)
        except ValueError as exc:
            raise _http_error(exc) from exc
        if dimensions is None:
            raise HTTPException(
                status_code=409,
                detail={'code': 'ANALYTICS_INDEX_NOT_READY', 'message': 'analytics index is not ready'},
            )
        return {'dimensions': dimensions}

    return router
