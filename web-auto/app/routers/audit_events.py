from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from app.audit import AuditLogger, MAX_DETAILS_BYTES


MAX_EVENT_BODY_BYTES = 16 * 1024
ALLOWED_UI_ACTIONS = {
    'open_full_image_inference',
    'open_ai_assistant',
    'open_data_cleaning',
    'open_import_export',
    'open_service_management',
}


def create_audit_events_router(*, audit: AuditLogger) -> APIRouter:
    router = APIRouter()

    @router.post('/api/log/events', status_code=202)
    async def collect_ui_event(request: Request) -> dict[str, Any]:
        content_length = str(request.headers.get('content-length') or '').strip()
        if content_length:
            try:
                if int(content_length) > MAX_EVENT_BODY_BYTES:
                    raise HTTPException(status_code=413, detail='event request exceeds 16 KiB')
            except ValueError as exc:
                raise HTTPException(status_code=400, detail='invalid content-length') from exc
        body = await request.body()
        if len(body) > MAX_EVENT_BODY_BYTES:
            raise HTTPException(status_code=413, detail='event request exceeds 16 KiB')
        try:
            payload = json.loads(body or b'{}')
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail='invalid JSON event') from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail='event must be an object')

        action = str(payload.get('action') or '').strip()
        if action not in ALLOWED_UI_ACTIONS:
            raise HTTPException(status_code=422, detail='unknown UI event action')
        project_id = str(payload.get('project_id') or '').strip()
        if len(project_id) > 128:
            raise HTTPException(status_code=422, detail='project_id is too long')
        details = payload.get('details', {})
        if not isinstance(details, dict):
            raise HTTPException(status_code=422, detail='details must be an object')
        try:
            details_bytes = len(json.dumps(details, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail='details must be JSON serializable') from exc
        if details_bytes > MAX_DETAILS_BYTES:
            raise HTTPException(status_code=413, detail='event details exceed 8 KiB')

        event = audit.emit(
            source='frontend',
            category='feature',
            action=action,
            outcome='opened',
            project_id=project_id,
            message='UI feature opened',
            details=details,
        )
        return {'accepted': True, 'event_id': event['event_id']}

    return router
