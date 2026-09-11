from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query

from app.audit import AuditLogger
from app.schemas import (
    InferBatchIn,
    InferIn,
    InferJobControlIn,
    InferJobResumeIn,
)


def create_inference_router(
    *,
    get_project_or_404: Callable[..., dict[str, Any]],
    get_image_or_404: Callable[[dict[str, Any], str], dict[str, Any]],
    infer_single_impl: Callable[..., dict[str, Any]],
    run_infer_batch: Callable[..., dict[str, Any]],
    precheck_infer_batch: Callable[[InferBatchIn], None],
    spawn_infer_job: Callable[..., dict[str, Any]],
    get_active_infer_job_for_project: Callable[[str], dict[str, Any] | None],
    get_latest_infer_job_for_project: Callable[..., dict[str, Any] | None],
    get_infer_job_state_or_404: Callable[[str], dict[str, Any]],
    pause_infer_job: Callable[[str], bool],
    cancel_infer_job: Callable[[str], bool],
    update_infer_job_state: Callable[..., None],
    resume_infer_job: Callable[[InferJobResumeIn], dict[str, Any]],
    acquire_interactive_gpu: Callable[[], str],
    release_interactive_gpu: Callable[[str], None],
    audit: AuditLogger | None = None,
) -> APIRouter:
    router = APIRouter()

    def _to_upstream_error(exc: Exception, fallback: str) -> HTTPException:
        # Surface upstream failures (e.g. sam3-api returning 500 because the
        # GPU driver disappeared) as 502 with the original message in detail,
        # so frontends can display the real cause instead of a bare 500.
        detail = str(exc).strip() or fallback
        return HTTPException(status_code=502, detail=detail)

    @router.post('/api/infer')
    def infer_single(payload: InferIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')
        image = get_image_or_404(project, payload.image_id)
        lease_id = acquire_interactive_gpu()
        try:
            try:
                out = infer_single_impl(
                    project=project,
                    image=image,
                    mode=payload.mode,
                    classes=payload.classes,
                    active_class=payload.active_class,
                    points=payload.points,
                    threshold=payload.threshold,
                    api_base_url=payload.api_base_url,
                    model_backend=payload.model_backend,
                    locate_api_base_url=payload.locate_api_base_url,
                    score_default=payload.score_default,
                )
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                raise _to_upstream_error(exc, 'interactive inference failed') from exc
        finally:
            release_interactive_gpu(lease_id)
        if audit:
            audit.emit(category='inference', action='run_single', project_id=payload.project_id, message='Single-image inference completed', details={'image_id': payload.image_id, 'mode': payload.mode, 'classes': payload.classes, 'detection_count': len(out['detections'])})
        return {
            'project_id': payload.project_id,
            'image_id': payload.image_id,
            'mode': payload.mode,
            'num_detections': len(out['detections']),
            'detections': out['detections'],
            'saved_annotations': out['saved_annotations'],
            'impacted_classes': out['impacted_classes'],
            'raw': out['result'],
        }

    @router.post('/api/infer/batch')
    def infer_batch(payload: InferBatchIn) -> dict[str, Any]:
        try:
            return run_infer_batch(payload)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _to_upstream_error(exc, 'batch inference failed') from exc

    @router.post('/api/infer/jobs/start_batch')
    def start_infer_batch_job(payload: InferBatchIn) -> dict[str, Any]:
        try:
            precheck_infer_batch(payload)
            job = spawn_infer_job(
                project_id=payload.project_id,
                job_type='text_batch',
                payload_dict=payload.model_dump(),
                worker=lambda data, progress_cb, should_stop, resume_state: run_infer_batch(
                    InferBatchIn(**data),
                    progress_cb=progress_cb,
                    should_stop=should_stop,
                    resume_state=resume_state,
                ),
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _to_upstream_error(exc, 'failed to start batch inference job') from exc
        if audit:
            audit.emit(category='inference', action='start_batch', outcome='accepted', project_id=payload.project_id, job_id=str(job.get('job_id') or ''), message='Batch inference started', details={'classes': payload.classes, 'scope': payload.scope_mode, 'append_mode': payload.merge_mode, 'batch_size': payload.batch_size, 'save_features': payload.save_ai_features, 'target_count': len(payload.image_ids)})
        return {'job': job}

    @router.get('/api/infer/jobs/active')
    def get_active_infer_job(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        job = get_active_infer_job_for_project(project_id)
        if not job:
            # Return the latest durable error as well. The frontend ignores
            # ordinary terminal errors, but can restore an unacknowledged
            # fatal OOM dialog after a page reload.
            job = get_latest_infer_job_for_project(project_id, statuses={'paused', 'pausing', 'error'})
        return {'job': job}

    @router.get('/api/infer/jobs/{job_id}')
    def get_infer_job(job_id: str) -> dict[str, Any]:
        return {'job': get_infer_job_state_or_404(job_id)}

    @router.post('/api/infer/jobs/pause')
    @router.post('/api/infer/jobs/stop')
    def pause_infer_job_endpoint(payload: InferJobControlIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, enrich=False, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='infer pause currently supports image project only')

        state = get_active_infer_job_for_project(payload.project_id)
        if not state:
            paused = get_latest_infer_job_for_project(payload.project_id, statuses={'paused', 'pausing'})
            if audit:
                audit.emit(category='task', action='pause_request', outcome='rejected', project_id=payload.project_id, message='Inference pause request had no active task')
            return {'job': paused or get_latest_infer_job_for_project(payload.project_id)}
        job_id = str(state.get('job_id') or '').strip()
        if not job_id:
            return {'job': state}
        current_status = str(state.get('status') or '')
        if current_status in {'done', 'error', 'cancelled'}:
            return {'job': state}
        # Force the state to 'paused' immediately so the UI reflects the pause
        # within one poll cycle. The worker, still mid-HTTP-call, will observe
        # the terminal status on its next cooperative check and exit cleanly.
        update_infer_job_state(job_id, status='paused', running=False, message='paused')
        if audit:
            audit.emit(category='task', action='pause_request', outcome='accepted', project_id=payload.project_id, job_id=job_id, message='Inference pause request accepted', details={'previous_status': current_status})
        return {'job': get_infer_job_state_or_404(job_id)}

    @router.post('/api/infer/jobs/resume')
    def resume_infer_job_endpoint(payload: InferJobResumeIn) -> dict[str, Any]:
        try:
            result = resume_infer_job(payload)
            job = result.get('job', result) if isinstance(result, dict) else {}
            if audit:
                audit.emit(category='task', action='resume_request', outcome='accepted', project_id=payload.project_id, job_id=str(job.get('job_id') or ''), message='Inference resume request accepted')
            return result
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _to_upstream_error(exc, 'failed to resume inference job') from exc

    @router.post('/api/infer/jobs/cancel')
    def cancel_infer_job_endpoint(payload: InferJobControlIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, enrich=False, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='image project only')
        state = get_active_infer_job_for_project(payload.project_id)
        if not state:
            state = get_latest_infer_job_for_project(
                payload.project_id, statuses={'paused', 'pausing', 'queued', 'running'}
            )
        if not state:
            raise HTTPException(status_code=404, detail='no active or paused job')
        job_id = str(state.get('job_id') or '')
        if not cancel_infer_job(job_id):
            raise HTTPException(status_code=409, detail='job cannot be cancelled')
        return {'job': get_infer_job_state_or_404(job_id)}

    return router
