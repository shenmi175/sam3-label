from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from app.locate_anything_client import LocateAnythingClient
from app.sam3_client import Sam3Client
from app.schemas import CacheDirUpdateIn, GlobalConfigUpdateIn
from app.services.config_service import AppConfigStore
from app.utils import now_ts


def create_config_router(
    *,
    allowed_origins: list[str],
    base_dir: Path,
    default_sapiens_api_base_url: str,
    ops_api_configured: bool,
    sam3_max_batch_files: int,
    app_config: AppConfigStore,
    config_lock: threading.Lock,
    get_current_data_dir: Callable[[], Path],
    ensure_no_active_jobs_for_config_change: Callable[[], None],
    set_storage_data_dir: Callable[[str], Path],
    resolve_dataset_upload_dir: Callable[[str], Path],
    global_config_info: Callable[[], dict[str, Any]],
    effective_sam3_api_base_url: Callable[[], str],
    allowed_sam3_api_base_urls: Callable[[], list[str]],
    effective_locate_api_base_url: Callable[[], str],
    allowed_locate_api_base_urls: Callable[[], list[str]],
    queue_health: Callable[[], dict[str, Any]],
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/info')
    def root_info() -> dict[str, Any]:
        return {
            'service': 'web-auto-api',
            'mode': 'api_only',
            'docs_url': '/docs',
            'openapi_url': '/openapi.json',
            'health_url': '/api/health',
            'allowed_origins': allowed_origins,
            'task_queue': queue_health(),
            'frontend_bundled': False,
        }

    @router.get('/api/health')
    def health() -> dict[str, Any]:
        return {
            'status': 'ok',
            'service': 'web-auto-api',
            'mode': 'api_only',
            'timestamp': now_ts(),
            'allowed_origins': allowed_origins,
            'task_queue': queue_health(),
        }

    @router.get('/api/config/defaults')
    def get_default_config() -> dict[str, Any]:
        return {
            'sam3_api_base_url': effective_sam3_api_base_url(),
            'allowed_sam3_api_base_urls': allowed_sam3_api_base_urls(),
            'locate_api_base_url': effective_locate_api_base_url(),
            'allowed_locate_api_base_urls': allowed_locate_api_base_urls(),
            'sapiens_api_base_url': default_sapiens_api_base_url,
            'ops_api_configured': ops_api_configured,
            'data_dir': str(get_current_data_dir()),
            'sam3_max_batch_files': sam3_max_batch_files,
        }

    @router.get('/api/config/global')
    def get_global_config() -> dict[str, Any]:
        return {'config': global_config_info()}

    @router.post('/api/config/global')
    def set_global_config(payload: GlobalConfigUpdateIn) -> dict[str, Any]:
        changes: dict[str, Any] = {}
        with config_lock:
            if payload.cache_dir is not None:
                cache_dir = str(payload.cache_dir or '').strip()
                if cache_dir:
                    ensure_no_active_jobs_for_config_change()
                    new_dir = set_storage_data_dir(cache_dir)
                    changes['cache_dir'] = str(new_dir)

            if payload.upload_target_dir is not None:
                upload_target = str(payload.upload_target_dir or '').strip()
                if upload_target:
                    target = resolve_dataset_upload_dir(upload_target)
                    changes['upload_target_dir'] = str(target)

            if payload.sam3_api_base_url is not None:
                api_base_url = str(payload.sam3_api_base_url or '').strip().rstrip('/')
                if api_base_url:
                    try:
                        api_base_url = Sam3Client._api_root(api_base_url)
                    except ValueError as exc:
                        raise HTTPException(status_code=400, detail=str(exc)) from exc
                    changes['sam3_api_base_url'] = api_base_url

            if payload.locate_api_base_url is not None:
                locate_url = str(payload.locate_api_base_url or '').strip().rstrip('/')
                if locate_url:
                    try:
                        locate_url = LocateAnythingClient._api_root(locate_url)
                    except ValueError as exc:
                        raise HTTPException(status_code=400, detail=str(exc)) from exc
                    changes['locate_api_base_url'] = locate_url

            if changes:
                app_config.update(changes)

        return {'ok': True, 'config': global_config_info()}

    @router.post('/api/system/restart')
    def restart_web_auto() -> dict[str, Any]:
        ensure_no_active_jobs_for_config_change()

        def _delayed_exit() -> None:
            time.sleep(0.5)
            os._exit(0)

        thread = threading.Thread(target=_delayed_exit, daemon=True)
        thread.start()
        return {'ok': True, 'message': 'web-auto is restarting'}

    @router.get('/api/config/cache_dir')
    def get_cache_dir_config() -> dict[str, Any]:
        return {
            'cache_dir': str(get_current_data_dir()),
            'default_dir': str(base_dir),
        }

    @router.post('/api/config/cache_dir')
    def set_cache_dir_config(payload: CacheDirUpdateIn) -> dict[str, Any]:
        with config_lock:
            ensure_no_active_jobs_for_config_change()
            new_dir = set_storage_data_dir(payload.cache_dir)
            app_config.update({'cache_dir': str(new_dir)})
        return {
            'ok': True,
            'cache_dir': str(new_dir),
            'message': 'Storage directory updated successfully.',
        }

    return router
