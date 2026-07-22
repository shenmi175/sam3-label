from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.services.job_queue import PersistentJobQueue


def create_jobs_router(*, queue: PersistentJobQueue) -> APIRouter:
    router = APIRouter()

    @router.get('/api/jobs')
    def list_jobs(project_id: str = Query(..., min_length=1), limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
        return {'jobs': queue.list_jobs(project_id, limit=limit)}

    @router.post('/api/jobs/{job_id}/pause')
    def pause_job(job_id: str) -> dict[str, Any]:
        if not queue.request_pause(job_id):
            raise HTTPException(status_code=409, detail='job cannot be paused')
        return {'job': queue.get(job_id)}

    @router.post('/api/jobs/{job_id}/resume')
    def resume_job(job_id: str) -> dict[str, Any]:
        if not queue.resume(job_id):
            raise HTTPException(status_code=409, detail='job cannot be resumed')
        return {'job': queue.get(job_id)}

    @router.post('/api/jobs/{job_id}/cancel')
    def cancel_job(job_id: str) -> dict[str, Any]:
        if not queue.cancel(job_id):
            raise HTTPException(status_code=409, detail='job cannot be cancelled')
        return {'job': queue.get(job_id)}

    return router
