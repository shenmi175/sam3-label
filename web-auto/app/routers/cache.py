from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.schemas.cache import CacheCleanupIn
from app.services.cache_maintenance import CacheMaintenanceService


def create_cache_router(*, service: CacheMaintenanceService) -> APIRouter:
    router = APIRouter()

    @router.get('/api/cache/status')
    def get_cache_status() -> dict[str, Any]:
        return service.status()

    @router.post('/api/cache/cleanup')
    def cleanup_cache(payload: CacheCleanupIn) -> dict[str, Any]:
        if not payload.confirm:
            raise HTTPException(status_code=400, detail='cache cleanup requires explicit confirmation')
        return service.cleanup(list(payload.scopes))

    return router
