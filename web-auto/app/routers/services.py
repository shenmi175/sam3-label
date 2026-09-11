from __future__ import annotations

import re
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.audit import AuditLogger
from app.locate_anything_client import LocateAnythingClient
from app.sam3_client import Sam3Client
from app.schemas import HealthApiIn, LocateHealthApiIn, LocateUnloadApiIn
from app.services.integration_clients import OpsClient, SapiensClient, service_management_unavailable
from app.services.model_load_jobs import ModelLoadJobManager, ModelLoadRejected


def create_services_router(
    *,
    sam3: Sam3Client,
    locate: LocateAnythingClient,
    ops_client: OpsClient,
    sapiens_client: SapiensClient,
    default_sam3_api_base_url: str,
    effective_sam3_api_base_url: Callable[[], str],
    default_locate_api_base_url: str,
    default_sapiens_api_base_url: str,
    model_load_jobs: ModelLoadJobManager,
    audit: AuditLogger | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.post('/api/sam3/health')
    def sam3_health(payload: HealthApiIn) -> dict[str, Any]:
        try:
            result = sam3.health(payload.api_base_url)
            return {'ok': True, 'result': result}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/sam3/status')
    def sam3_status(api_base_url: str | None = Query(default=None)) -> dict[str, Any]:
        target_url = str(api_base_url or effective_sam3_api_base_url()).strip() or default_sam3_api_base_url
        try:
            result = sam3.health(target_url)
            return {'ok': True, 'api_base_url': target_url, 'result': result}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/services/status')
    def services_status() -> dict[str, Any]:
        try:
            result = ops_client.request('GET', '/v1/services', timeout=8.0)
            result['ok'] = True
            result['ops_available'] = True
            return result
        except Exception as exc:  # noqa: BLE001
            return service_management_unavailable(str(exc))

    @router.post('/api/services/{service}/model-load-jobs', status_code=202)
    def start_model_load_job(service: str) -> dict[str, Any]:
        try:
            job, created = model_load_jobs.start(service)
            if audit:
                audit.emit(
                    category='service',
                    action='model_load',
                    outcome='accepted',
                    message='Model load and inference warmup job accepted',
                    details={
                        'target_service': str(service or '').strip(),
                        'job_id': job.get('job_id'),
                        'created': created,
                    },
                )
            return {'job_id': job.get('job_id'), 'created': created, 'job': job}
        except ModelLoadRejected as exc:
            if audit:
                audit.emit(
                    category='service',
                    action='model_load',
                    outcome='rejected',
                    level='warning',
                    message='Model load and inference warmup job rejected',
                    details={
                        'target_service': str(service or '').strip(),
                        'error_code': exc.code,
                        'error': str(exc),
                    },
                )
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @router.get('/api/services/{service}/model-load-jobs/latest')
    def latest_model_load_job(service: str) -> dict[str, Any]:
        try:
            return {'job': model_load_jobs.latest(service)}
        except ModelLoadRejected as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @router.get('/api/services/model-load-jobs/{job_id}')
    def model_load_job(job_id: str) -> dict[str, Any]:
        job = model_load_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail='model load job not found')
        return {'job': job}

    @router.post('/api/services/{service}/{action}')
    def control_service(service: str, action: str) -> dict[str, Any]:
        clean_service = str(service or '').strip()
        clean_action = str(action or '').strip().lower()
        if clean_service == 'web-auto':
            raise HTTPException(status_code=400, detail='web-auto cannot be controlled from the web UI')
        if clean_service not in {'sam3-api', 'locate-anything-api', 'sapiens-api'}:
            raise HTTPException(status_code=400, detail=f'unsupported service: {clean_service}')
        if clean_action not in {'start', 'stop', 'restart'}:
            raise HTTPException(status_code=400, detail='action must be start, stop, or restart')
        try:
            result = ops_client.request('POST', f'/v1/services/{clean_service}/{clean_action}', timeout=35.0)
            if audit:
                audit.emit(category='service', action='control', outcome='accepted', message='Service control action accepted', details={'target_service': clean_service, 'control_action': clean_action})
            return result
        except Exception as exc:  # noqa: BLE001
            if audit:
                audit.emit(category='service', action='control', outcome='error', level='error', message='Service control action failed', details={'target_service': clean_service, 'control_action': clean_action, 'error': str(exc)})
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/logs/download')
    def download_logs() -> StreamingResponse:
        try:
            upstream = ops_client.stream('/v1/logs/download', timeout=180.0)
        except Exception as exc:  # noqa: BLE001
            if audit:
                audit.emit(category='logs', action='download', outcome='error', level='error', message='Log archive preparation failed', details={'error': str(exc)})
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        disposition = str(upstream.headers.get('content-disposition') or '')
        match = re.search(r'filename="?([A-Za-z0-9_.-]+)"?', disposition)
        filename = match.group(1) if match else 'sam3-logs.zip'
        if audit:
            audit.emit(category='logs', action='download', outcome='accepted', message='Unified log archive download started')

        def chunks():
            try:
                for chunk in upstream.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        yield chunk
            finally:
                upstream.close()

        return StreamingResponse(
            chunks(),
            media_type='application/zip',
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    @router.get('/api/services/{service}/logs')
    def service_logs(service: str, tail: int = Query(default=120, ge=1, le=1000)) -> dict[str, Any]:
        clean_service = str(service or '').strip()
        if clean_service not in {'sam3-api', 'locate-anything-api', 'sapiens-api'}:
            raise HTTPException(status_code=400, detail=f'unsupported service: {clean_service}')
        try:
            return ops_client.request('GET', f'/v1/services/{clean_service}/logs?tail={tail}', timeout=12.0)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/sapiens/status')
    def sapiens_status() -> dict[str, Any]:
        try:
            health_data = sapiens_client.request('GET', '/health', timeout=8.0)
            pose_data = sapiens_client.request('GET', '/v1/pose/status', timeout=8.0)
            return {
                'ok': True,
                'health': health_data,
                'pose': pose_data,
                'checkpoint': pose_data.get('checkpoint', {}),
                'api_base_url': default_sapiens_api_base_url,
            }
        except Exception as exc:  # noqa: BLE001
            return {'ok': False, 'error': str(exc), 'api_base_url': default_sapiens_api_base_url}

    @router.post('/api/sapiens/checkpoint/download')
    def sapiens_checkpoint_download() -> dict[str, Any]:
        try:
            return sapiens_client.request('POST', '/v1/pose/checkpoints/download', {}, timeout=12.0)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/sapiens/checkpoint/download/{job_id}')
    def sapiens_checkpoint_download_status(job_id: str) -> dict[str, Any]:
        try:
            return sapiens_client.request('GET', f'/v1/pose/checkpoints/download/{job_id}', timeout=8.0)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.post('/api/locate/health')
    def locate_health(payload: LocateHealthApiIn) -> dict[str, Any]:
        try:
            result = locate.health(payload.api_base_url)
            return {'ok': True, 'result': result}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/locate/status')
    def locate_status(api_base_url: str | None = Query(default=None)) -> dict[str, Any]:
        target_url = str(api_base_url or default_locate_api_base_url).strip() or default_locate_api_base_url
        try:
            result = locate.health(target_url)
            return {'ok': True, 'api_base_url': target_url, 'result': result}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.post('/api/locate/unload')
    def locate_unload(payload: LocateUnloadApiIn) -> dict[str, Any]:
        try:
            return locate.unload(payload.api_base_url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return router
