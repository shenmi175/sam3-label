from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query

from app.sam3_client import Sam3Client
from app.schemas import HealthApiIn
from app.services.integration_clients import OpsClient, SapiensClient, service_management_unavailable


def create_services_router(
    *,
    sam3: Sam3Client,
    ops_client: OpsClient,
    sapiens_client: SapiensClient,
    default_sam3_api_base_url: str,
    effective_sam3_api_base_url: Callable[[], str],
    default_sapiens_api_base_url: str,
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

    @router.post('/api/services/{service}/{action}')
    def control_service(service: str, action: str) -> dict[str, Any]:
        clean_service = str(service or '').strip()
        clean_action = str(action or '').strip().lower()
        if clean_service == 'web-auto':
            raise HTTPException(status_code=400, detail='web-auto cannot be controlled from the web UI')
        if clean_service not in {'sam3-api', 'sapiens-api', 'caddy'}:
            raise HTTPException(status_code=400, detail=f'unsupported service: {clean_service}')
        if clean_action not in {'start', 'stop', 'restart'}:
            raise HTTPException(status_code=400, detail='action must be start, stop, or restart')
        try:
            return ops_client.request('POST', f'/v1/services/{clean_service}/{clean_action}', timeout=35.0)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get('/api/services/{service}/logs')
    def service_logs(service: str, tail: int = Query(default=120, ge=1, le=1000)) -> dict[str, Any]:
        clean_service = str(service or '').strip()
        if clean_service not in {'sam3-api', 'sapiens-api', 'caddy'}:
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

    return router
