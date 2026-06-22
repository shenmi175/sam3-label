from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, Query

from app.schemas import UIStateIn
from app.storage import Storage


def create_ui_state_router(*, get_storage: Callable[[], Storage]) -> APIRouter:
    router = APIRouter()

    @router.get('/api/ui_state')
    def get_ui_state(project_id: Optional[str] = Query(default=None)) -> dict[str, Any]:
        storage = get_storage()
        return {'state': storage.get_ui_state(project_id)}

    @router.post('/api/ui_state')
    def set_ui_state(payload: UIStateIn) -> dict[str, Any]:
        storage = get_storage()
        storage.set_ui_state(state=payload.state, project_id=payload.project_id)
        return {'ok': True}

    return router
