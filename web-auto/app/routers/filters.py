from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.audit import AuditLogger
from app.data_cleaning.artifacts import resolve_preview_artifact
from app.schemas import SmartFilterIn
from app.storage import Storage


def create_filters_router(
    *,
    get_storage: Callable[[], Storage],
    get_project_or_404: Callable[..., dict[str, Any]],
    analyze_smart_merge_annotations: Callable[..., dict[str, Any]],
    normalize_smart_filter_payload: Callable[[SmartFilterIn], dict[str, Any]],
    spawn_smart_filter_job: Callable[..., dict[str, Any]],
    run_smart_filter_preview_job: Callable[..., dict[str, Any]],
    run_smart_filter_apply_job: Callable[..., dict[str, Any]],
    run_smart_filter_sync_preview: Callable[[SmartFilterIn], dict[str, Any]],
    run_smart_filter_sync_apply: Callable[[SmartFilterIn], dict[str, Any]],
    get_active_smart_filter_job_for_project: Callable[[str], dict[str, Any] | None],
    get_smart_filter_job_state_or_404: Callable[[str], dict[str, Any]],
    audit: AuditLogger | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/filter/intelligent/artifacts/{preview_token}/{relative_name:path}')
    def get_smart_filter_artifact(preview_token: str, relative_name: str) -> FileResponse:
        path = resolve_preview_artifact(get_storage().base_dir, preview_token, relative_name)
        if path is None:
            raise HTTPException(status_code=404, detail='preview artifact not found')
        media_type = 'image/webp' if path.suffix.lower() == '.webp' else 'image/png'
        return FileResponse(str(path), media_type=media_type)

    @router.post('/api/filter/intelligent/preview')
    def preview_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
        result = run_smart_filter_sync_preview(payload)
        if audit:
            audit.emit(category='data_cleaning', action='preview', project_id=payload.project_id, message='Data-cleaning preview completed')
        return result

    @router.post('/api/filter/intelligent/apply')
    def apply_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
        result = run_smart_filter_sync_apply(payload)
        if audit:
            audit.emit(category='data_cleaning', action='apply', project_id=payload.project_id, message='Data-cleaning changes applied')
        return result

    @router.post('/api/filter/intelligent/jobs/start_preview')
    def start_smart_filter_preview_job(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')
        normalize_smart_filter_payload(payload)
        job = spawn_smart_filter_job(
            project_id=payload.project_id,
            job_type='preview',
            payload_dict=payload.model_dump(exclude_unset=True),
            worker=run_smart_filter_preview_job,
        )
        if audit:
            audit.emit(category='data_cleaning', action='start_preview', outcome='accepted', project_id=payload.project_id, job_id=str(job.get('job_id') or ''), message='Data-cleaning preview task started')
        return {'job': job}

    @router.post('/api/filter/intelligent/jobs/start_apply')
    def start_smart_filter_apply_job(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')
        normalize_smart_filter_payload(payload)
        job = spawn_smart_filter_job(
            project_id=payload.project_id,
            job_type='apply',
            payload_dict=payload.model_dump(exclude_unset=True),
            worker=run_smart_filter_apply_job,
        )
        if audit:
            audit.emit(category='data_cleaning', action='start_apply', outcome='accepted', project_id=payload.project_id, job_id=str(job.get('job_id') or ''), message='Data-cleaning apply task started')
        return {'job': job}

    @router.get('/api/filter/intelligent/jobs/active')
    def get_active_smart_filter_job(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        return {'job': get_active_smart_filter_job_for_project(project_id)}

    @router.get('/api/filter/intelligent/jobs/{job_id}')
    def get_smart_filter_job(job_id: str) -> dict[str, Any]:
        return {'job': get_smart_filter_job_state_or_404(job_id)}

    @router.get('/api/filter/intelligent/runs/latest')
    def get_latest_smart_filter_run(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        return {'run': get_storage().get_latest_smart_filter_run(project_id=project_id)}

    @router.post('/api/filter/intelligent/runs/{run_id}/rollback')
    def rollback_smart_filter_run(run_id: str, project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        try:
            result = get_storage().rollback_smart_filter_run(project_id=project_id, run_id=run_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if audit:
            audit.emit(category='data_cleaning', action='rollback', project_id=project_id, message='Data-cleaning run rolled back', details={'run_id': run_id})
        return {'result': result}

    return router
