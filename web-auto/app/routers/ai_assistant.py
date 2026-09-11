from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from app.schemas import AiFeatureDeleteIn, AiPointIn, AiSessionIn, AiSessionOpenIn
from app.services.ai_assistant_service import AiAssistantService


def create_ai_assistant_router(service: AiAssistantService) -> APIRouter:
    router = APIRouter()

    def upstream(call):
        try:
            return call()
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.post('/api/ai/session/open')
    def open_session(payload: AiSessionOpenIn, background_tasks: BackgroundTasks) -> dict[str, Any]:
        result, neighbors, generation = upstream(lambda: service.open_session(payload))
        if neighbors:
            background_tasks.add_task(
                service.prefetch_neighbors,
                project_id=payload.project_id,
                image_ids=neighbors,
                api_base_url=payload.api_base_url,
                generation=generation,
            )
        return {'ok': True, 'session': result, 'prefetch_image_ids': neighbors}

    @router.post('/api/ai/point')
    def point(payload: AiPointIn) -> dict[str, Any]:
        return {'ok': True, **upstream(lambda: service.predict(payload))}

    @router.post('/api/ai/prompts/clear')
    def clear_prompts(payload: AiSessionIn) -> dict[str, Any]:
        return {'ok': True, **upstream(lambda: service.reset(payload))}

    @router.post('/api/ai/prompts/undo')
    def undo_prompt(payload: AiSessionIn) -> dict[str, Any]:
        return {'ok': True, **upstream(lambda: service.move_prompt_history(payload, direction='undo'))}

    @router.post('/api/ai/prompts/redo')
    def redo_prompt(payload: AiSessionIn) -> dict[str, Any]:
        return {'ok': True, **upstream(lambda: service.move_prompt_history(payload, direction='redo'))}

    @router.post('/api/ai/mask/accept')
    def accept_mask(payload: AiSessionIn) -> dict[str, Any]:
        return {'ok': True, **service.accept(payload)}

    @router.post('/api/ai/session/close')
    def close_session(payload: AiSessionIn) -> dict[str, Any]:
        return {'ok': True, **upstream(lambda: service.close(payload))}

    @router.get('/api/ai/features/status')
    def feature_status(
        project_id: str = Query(..., min_length=1),
        image_id: str = Query(default=''),
    ) -> dict[str, Any]:
        return service.feature_status(project_id, image_id)

    @router.post('/api/ai/features/delete')
    def delete_features(payload: AiFeatureDeleteIn) -> dict[str, Any]:
        return upstream(lambda: service.delete_features(payload))

    return router
