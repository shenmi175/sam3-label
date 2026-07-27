
from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.routers.annotations import create_annotations_router
from app.routers.auth import create_auth_router
from app.routers.classes import create_classes_router
from app.routers.config import create_config_router
from app.routers.export import create_export_router
from app.routers.filters import create_filters_router
from app.routers.image_files import create_image_files_router
from app.routers.inference import create_inference_router
from app.routers.jobs import create_jobs_router
from app.routers.pose import create_pose_router
from app.routers.project_images import create_project_images_router
from app.routers.projects import create_projects_router
from app.routers.services import create_services_router
from app.routers.ui_state import create_ui_state_router
from app.routers.uploads import create_uploads_router
from app.sam3_client import Sam3Client
from app.locate_anything_client import LocateAnythingClient
from app.services.auth_http import AuthHttp
from app.services.auth_service import AuthStore
from app.services.config_service import AppConfigStore, parse_allowed_data_roots, parse_positive_int_env
from app.services.inference_jobs import InferenceJobService
from app.services.inference_service import InferenceService
from app.services.job_queue import PersistentJobQueue
from app.services.integration_clients import OpsClient, SapiensClient
from app.services.image_previews import ImagePreviewService
from app.services.image_tiles import ImageTileService
from app.services.smart_filter_service import (
    _analyze_smart_merge_annotations,
    _normalize_smart_filter_payload,
    SmartFilterJobService,
)
from app.storage import Storage
from app.utils import ensure_dir


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ensure_dir(Path(os.getenv('WEB_AUTO_DATA_DIR', str(BASE_DIR / 'data'))).expanduser().resolve())
HOST_DATA_ROOT = Path(os.getenv('WEB_AUTO_HOST_DATA_ROOT', str(DATA_DIR / 'uploads'))).expanduser().resolve()
DEFAULT_UPLOAD_TARGET_DIR = Path(
    os.getenv('WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR', '').strip() or str(HOST_DATA_ROOT / 'uploads')
).expanduser().resolve()
APP_CONFIG_FILE = DATA_DIR / 'global_config.json'
DEFAULT_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', 'http://127.0.0.1:8001').strip() or 'http://127.0.0.1:8001'
DEFAULT_LOCATE_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_LOCATE_API_BASE_URL', 'http://127.0.0.1:8004').strip() or 'http://127.0.0.1:8004'
DEFAULT_SAPIENS_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAPIENS_API_BASE_URL', 'http://sapiens-api:8010').strip() or 'http://sapiens-api:8010'
SAPIENS_API_TOKEN = os.getenv('WEB_AUTO_SAPIENS_API_TOKEN', '').strip()
OPS_API_BASE_URL = os.getenv('WEB_AUTO_OPS_API_BASE_URL', 'http://ops-api:8020').strip().rstrip('/')
OPS_API_TOKEN = os.getenv('WEB_AUTO_OPS_API_TOKEN', '').strip()
DEFAULT_SAM3_MAX_BATCH_FILES = 32
MAX_PENDING_IMAGE_IDS_IN_JOB_STATE = 200

SAM3_MAX_BATCH_FILES = parse_positive_int_env('WEB_AUTO_SAM3_MAX_BATCH_FILES', DEFAULT_SAM3_MAX_BATCH_FILES)
MAX_TILE_WORKERS = parse_positive_int_env('WEB_AUTO_MAX_TILE_WORKERS', 2)
PREVIEW_MAX_EDGE = parse_positive_int_env('WEB_AUTO_PREVIEW_MAX_EDGE', 1280)
THUMBNAIL_MAX_EDGE = parse_positive_int_env('WEB_AUTO_THUMBNAIL_MAX_EDGE', 384)
ALLOWED_DATA_ROOTS = parse_allowed_data_roots(HOST_DATA_ROOT)
APP_CONFIG = AppConfigStore(APP_CONFIG_FILE)


logger = logging.getLogger('web_auto')
logger.setLevel(logging.INFO)
if not logger.handlers:
    fmt = logging.Formatter('%(asctime)s | %(levelname)s | %(name)s | %(message)s')
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    logger.addHandler(ch)


storage = Storage(APP_CONFIG.initial_storage_dir(DATA_DIR))
_job_db_path = storage.index_db_file
if _job_db_path.exists() and not os.access(_job_db_path, os.W_OK):
    _job_db_path = Path(tempfile.gettempdir()) / f'web_auto_jobs_{os.getuid()}.sqlite3'
JOB_QUEUE = PersistentJobQueue(_job_db_path)
sam3 = Sam3Client(timeout_sec=180)
locate = LocateAnythingClient(timeout_sec=600)
OPS_CLIENT = OpsClient(OPS_API_BASE_URL, OPS_API_TOKEN)
SAPIENS_CLIENT = SapiensClient(DEFAULT_SAPIENS_API_BASE_URL, SAPIENS_API_TOKEN)
CURRENT_DATA_DIR = Path(storage.base_dir)


def _current_storage() -> Storage:
    return storage


INFER_JOBS = InferenceJobService(
    max_pending_image_ids=MAX_PENDING_IMAGE_IDS_IN_JOB_STATE,
    logger=logger,
    queue=JOB_QUEUE,
)
INFERENCE_SERVICE = InferenceService(
    get_storage=_current_storage,
    sam3=sam3,
    locate=locate,
    infer_jobs=INFER_JOBS,
    default_api_base_url=DEFAULT_API_BASE_URL,
    default_locate_api_base_url=DEFAULT_LOCATE_API_BASE_URL,
    max_batch_files=SAM3_MAX_BATCH_FILES,
    max_pending_image_ids=MAX_PENDING_IMAGE_IDS_IN_JOB_STATE,
)
SMART_FILTER_JOBS = SmartFilterJobService(get_storage=_current_storage, logger=logger, queue=JOB_QUEUE)
CONFIG_LOCK = threading.Lock()
PROJECT_DISCOVERY_LOCK = threading.Lock()
IMAGE_TILE_SERVICE = ImageTileService(
    get_current_data_dir=lambda: CURRENT_DATA_DIR,
    max_workers=MAX_TILE_WORKERS,
    logger=logger,
)
IMAGE_PREVIEW_SERVICE = ImagePreviewService(
    get_current_data_dir=lambda: CURRENT_DATA_DIR,
    preview_max_edge=PREVIEW_MAX_EDGE,
    thumbnail_max_edge=THUMBNAIL_MAX_EDGE,
    logger=logger,
)
PROJECT_DISCOVERY_LAST_SCAN = 0.0
PROJECT_DISCOVERY_INTERVAL_SECONDS = 60.0


AUTH_FILE = DATA_DIR / 'auth.json'
SESSION_COOKIE_NAME = os.getenv('WEB_AUTO_SESSION_COOKIE_NAME', 'web_auto_session').strip() or 'web_auto_session'
SESSION_TTL_SECONDS = parse_positive_int_env('WEB_AUTO_SESSION_TTL_SECONDS', 12 * 60 * 60)
AUTH_ENABLED = os.getenv('WEB_AUTO_AUTH_ENABLED', '1').strip().lower() not in {'0', 'false', 'no', 'off'}


AUTH_STORE = AuthStore(
    AUTH_FILE,
    auth_enabled=AUTH_ENABLED,
    session_ttl_seconds=SESSION_TTL_SECONDS,
    logger=logger,
)
AUTH_HTTP = AuthHttp(
    AUTH_STORE,
    auth_enabled=AUTH_ENABLED,
    cookie_name=SESSION_COOKIE_NAME,
    session_ttl_seconds=SESSION_TTL_SECONDS,
)


def _parse_allowed_origins(raw: str) -> list[str]:
    text = str(raw or '').strip()
    if not text:
        return ['*']
    origins = [item.strip() for item in text.split(',') if item.strip()]
    return origins or ['*']


ALLOWED_ORIGINS = _parse_allowed_origins(os.getenv('WEB_AUTO_ALLOW_ORIGINS', '*'))

app = FastAPI(
    title='web-auto API',
    version='1.0',
    description='API-only backend for image annotation workflows built on sam3-api.',
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.middleware('http')
async def require_web_auto_session(request: Request, call_next):
    if not AUTH_ENABLED or request.method.upper() == 'OPTIONS' or AUTH_HTTP.public_path(request.url.path):
        return await call_next(request)

    admin_missing = not AUTH_STORE.has_admin()
    if admin_missing:
        if request.url.path.startswith('/api/') or request.url.path in {'/docs', '/redoc', '/openapi.json'}:
            return JSONResponse(status_code=503, content={'detail': 'admin credentials are not configured', 'code': 'admin_not_configured'})
        return RedirectResponse('/login', status_code=303)

    if not AUTH_HTTP.request_username(request):
        if request.url.path.startswith('/api/') or request.url.path in {'/docs', '/redoc', '/openapi.json'}:
            return JSONResponse(status_code=401, content={'detail': 'login required', 'code': 'login_required'})
        return RedirectResponse('/login', status_code=303)

    return await call_next(request)


app.include_router(create_auth_router(AUTH_HTTP))
app.include_router(
    create_services_router(
        sam3=sam3,
        locate=locate,
        ops_client=OPS_CLIENT,
        sapiens_client=SAPIENS_CLIENT,
        default_sam3_api_base_url=DEFAULT_API_BASE_URL,
        effective_sam3_api_base_url=lambda: _effective_sam3_api_base_url(),
        default_locate_api_base_url=DEFAULT_LOCATE_API_BASE_URL,
        default_sapiens_api_base_url=DEFAULT_SAPIENS_API_BASE_URL,
    )
)
app.include_router(create_pose_router(get_storage=_current_storage, sapiens_client=SAPIENS_CLIENT))
app.include_router(create_ui_state_router(get_storage=_current_storage))
app.include_router(create_export_router(get_storage=_current_storage))
app.include_router(create_annotations_router(get_storage=_current_storage))
app.include_router(create_classes_router(get_storage=_current_storage))
app.include_router(
    create_image_files_router(
        get_storage=_current_storage,
        tile_service=IMAGE_TILE_SERVICE,
        preview_service=IMAGE_PREVIEW_SERVICE,
    )
)
app.include_router(create_project_images_router(get_storage=_current_storage))
app.include_router(create_jobs_router(queue=JOB_QUEUE))


def _get_project_or_404(project_id: str, *, enrich: bool = False, include_images: bool = True) -> dict[str, Any]:
    project = storage.get_project(project_id, enrich=enrich, include_images=include_images)
    if not project:
        raise HTTPException(status_code=404, detail='project not found')
    return project


def _get_image_or_404(project: dict[str, Any], image_id: str) -> dict[str, Any]:
    img = storage.find_image(project, image_id)
    if not img:
        raise HTTPException(status_code=404, detail='image not found')
    return img


def _path_within_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _data_root_for_path(path: Path) -> Path | None:
    resolved = path.resolve()
    matches = [root for root in ALLOWED_DATA_ROOTS if _path_within_root(resolved, root)]
    if not matches:
        return None
    return max(matches, key=lambda item: len(str(item)))


def _resolve_dataset_upload_dir(target_dir: str) -> Path:
    raw = str(target_dir or '').strip()
    if not raw:
        raise HTTPException(status_code=400, detail='target_dir is required')

    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = ALLOWED_DATA_ROOTS[0] / target
    target = target.resolve()
    if _data_root_for_path(target) is None:
        roots_text = ', '.join(str(root) for root in ALLOWED_DATA_ROOTS)
        raise HTTPException(
            status_code=400,
            detail=f'target_dir must be inside a mounted data root: {roots_text}. Add a root with ./deploy.sh data-root add <path> --default',
        )
    ensure_dir(target)
    return target


def _count_running_infer_jobs() -> int:
    return INFER_JOBS.count_running_jobs()


def _count_running_smart_filter_jobs() -> int:
    return SMART_FILTER_JOBS.count_running_jobs()


def _ensure_no_active_jobs_for_config_change() -> None:
    active = _count_running_infer_jobs() + _count_running_smart_filter_jobs()
    if active > 0:
        raise HTTPException(status_code=409, detail='cannot change configuration while background jobs are running')


def _set_storage_data_dir(path_text: str) -> Path:
    global storage, CURRENT_DATA_DIR
    new_dir = ensure_dir(Path(str(path_text or '')).expanduser().resolve())
    storage = Storage(new_dir)
    CURRENT_DATA_DIR = new_dir
    return new_dir


def _allowed_sam3_api_base_urls() -> list[str]:
    raw_allowed = os.getenv(
        'WEB_AUTO_ALLOWED_SAM3_API_BASE_URLS',
        os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', DEFAULT_API_BASE_URL),
    )
    urls: list[str] = []
    for item in str(raw_allowed or '').split(','):
        clean = item.strip().rstrip('/')
        if clean:
            urls.append(clean)
    return urls


def _effective_sam3_api_base_url() -> str:
    configured = str(APP_CONFIG.read().get('sam3_api_base_url') or '').strip().rstrip('/')
    if configured:
        return configured
    return DEFAULT_API_BASE_URL


def _allowed_locate_api_base_urls() -> list[str]:
    raw_allowed = os.getenv(
        'WEB_AUTO_ALLOWED_LOCATE_API_BASE_URLS',
        os.getenv('WEB_AUTO_DEFAULT_LOCATE_API_BASE_URL', DEFAULT_LOCATE_API_BASE_URL),
    )
    urls: list[str] = []
    for item in str(raw_allowed or '').split(','):
        clean = item.strip().rstrip('/')
        if clean:
            urls.append(clean)
    return urls


def _effective_locate_api_base_url() -> str:
    configured = str(APP_CONFIG.read().get('locate_api_base_url') or '').strip().rstrip('/')
    if configured:
        return configured
    return DEFAULT_LOCATE_API_BASE_URL


def _configured_upload_target_dir() -> Path:
    configured = str(APP_CONFIG.read().get('upload_target_dir') or '').strip()
    if configured:
        try:
            return _resolve_dataset_upload_dir(configured)
        except (HTTPException, OSError):
            pass
    try:
        return _resolve_dataset_upload_dir(str(DEFAULT_UPLOAD_TARGET_DIR))
    except (HTTPException, OSError):
        pass
    return HOST_DATA_ROOT


def _resolve_project_discovery_roots(scan_root: str = '') -> list[Path]:
    raw = str(scan_root or '').strip()
    if not raw:
        return ALLOWED_DATA_ROOTS
    try:
        resolved = Path(raw).expanduser().resolve()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid scan_root: {exc}') from exc
    if _data_root_for_path(resolved) is None:
        roots_text = ', '.join(str(root) for root in ALLOWED_DATA_ROOTS)
        raise HTTPException(status_code=400, detail=f'scan_root must be inside a mounted data root: {roots_text}')
    return [resolved]


def _project_discovery_root_info(roots: list[Path]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for root in roots:
        try:
            resolved = root.expanduser().resolve()
            out.append({
                'path': str(resolved),
                'exists': resolved.exists(),
                'is_dir': resolved.is_dir(),
            })
        except Exception as exc:
            out.append({'path': str(root), 'exists': False, 'is_dir': False, 'error': str(exc)})
    return out


def _auto_import_project_manifests(*, roots: list[Path] | None = None, force: bool = False, max_depth: int = 5) -> dict[str, Any]:
    global PROJECT_DISCOVERY_LAST_SCAN
    now = time.time()
    scan_roots = roots or ALLOWED_DATA_ROOTS
    with PROJECT_DISCOVERY_LOCK:
        if not force and (now - PROJECT_DISCOVERY_LAST_SCAN) < PROJECT_DISCOVERY_INTERVAL_SECONDS:
            return {'imported': [], 'skipped': 0, 'errors': [], 'cached': True}
        PROJECT_DISCOVERY_LAST_SCAN = now
    try:
        result = storage.auto_import_manifests(scan_roots, max_depth=max_depth)
        result['cached'] = False
        if result.get('errors'):
            logger.warning('project manifest auto-import completed with errors: %s', result.get('errors'))
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning('project manifest auto-import failed: %s', exc)
        return {'imported': [], 'skipped': 0, 'errors': [{'error': str(exc)}], 'cached': False}


def _global_config_info() -> dict[str, Any]:
    upload_dir = _configured_upload_target_dir()
    return {
        'cache_dir': str(CURRENT_DATA_DIR),
        'default_dir': str(BASE_DIR),
        'upload_root': str(HOST_DATA_ROOT),
        'allowed_data_roots': [str(root) for root in ALLOWED_DATA_ROOTS],
        'default_upload_target_dir': str(DEFAULT_UPLOAD_TARGET_DIR),
        'upload_target_dir': str(upload_dir),
        'sam3_api_base_url': _effective_sam3_api_base_url(),
        'allowed_sam3_api_base_urls': _allowed_sam3_api_base_urls(),
        'locate_api_base_url': _effective_locate_api_base_url(),
        'allowed_locate_api_base_urls': _allowed_locate_api_base_urls(),
        'sapiens_api_base_url': DEFAULT_SAPIENS_API_BASE_URL,
        'ops_api_configured': bool(OPS_API_BASE_URL),
        'sam3_max_batch_files': SAM3_MAX_BATCH_FILES,
        'max_tile_workers': MAX_TILE_WORKERS,
        'preview_max_edge': PREVIEW_MAX_EDGE,
        'thumbnail_max_edge': THUMBNAIL_MAX_EDGE,
        'auth_enabled': AUTH_ENABLED,
        'session_ttl_seconds': SESSION_TTL_SECONDS,
        'restart_supported': True,
        'restart_note': 'Docker restart policy restarts web-auto after the process exits.',
    }



@app.on_event('startup')
def on_startup() -> None:
    AUTH_STORE.ensure_admin_from_env()
    return None


app.include_router(
    create_config_router(
        allowed_origins=ALLOWED_ORIGINS,
        base_dir=BASE_DIR,
        default_sapiens_api_base_url=DEFAULT_SAPIENS_API_BASE_URL,
        ops_api_configured=bool(OPS_API_BASE_URL),
        sam3_max_batch_files=SAM3_MAX_BATCH_FILES,
        app_config=APP_CONFIG,
        config_lock=CONFIG_LOCK,
        get_current_data_dir=lambda: CURRENT_DATA_DIR,
        ensure_no_active_jobs_for_config_change=_ensure_no_active_jobs_for_config_change,
        set_storage_data_dir=_set_storage_data_dir,
        resolve_dataset_upload_dir=_resolve_dataset_upload_dir,
        global_config_info=_global_config_info,
        effective_sam3_api_base_url=_effective_sam3_api_base_url,
        allowed_sam3_api_base_urls=_allowed_sam3_api_base_urls,
        effective_locate_api_base_url=_effective_locate_api_base_url,
        allowed_locate_api_base_urls=_allowed_locate_api_base_urls,
        queue_health=JOB_QUEUE.health_summary,
    )
)
app.include_router(
    create_uploads_router(
        host_data_root=HOST_DATA_ROOT,
        allowed_data_roots=ALLOWED_DATA_ROOTS,
        configured_upload_target_dir=_configured_upload_target_dir,
        resolve_dataset_upload_dir=_resolve_dataset_upload_dir,
        path_within_root=_path_within_root,
    )
)

app.include_router(
    create_projects_router(
        get_storage=_current_storage,
        logger=logger,
        allowed_data_roots=ALLOWED_DATA_ROOTS,
        auto_import_project_manifests=_auto_import_project_manifests,
        resolve_project_discovery_roots=_resolve_project_discovery_roots,
        project_discovery_root_info=_project_discovery_root_info,
    )
)

app.include_router(
    create_inference_router(
        get_project_or_404=_get_project_or_404,
        get_image_or_404=_get_image_or_404,
        infer_single_impl=INFERENCE_SERVICE.infer_single,
        infer_example_preview_impl=INFERENCE_SERVICE.infer_example_preview,
        run_infer_batch=INFERENCE_SERVICE.run_infer_batch,
        spawn_infer_job=INFER_JOBS.spawn_job,
        get_active_infer_job_for_project=INFER_JOBS.get_active_job_for_project,
        get_latest_infer_job_for_project=INFER_JOBS.get_latest_job_for_project,
        get_infer_job_state_or_404=INFER_JOBS.get_job_state_or_404,
        pause_infer_job=INFER_JOBS.pause_job,
        update_infer_job_state=INFER_JOBS.update_job_state,
        resume_infer_job=INFERENCE_SERVICE.resume_infer_job,
        acquire_interactive_gpu=JOB_QUEUE.acquire_interactive_gpu,
        release_interactive_gpu=JOB_QUEUE.release_interactive_gpu,
    )
)


app.include_router(
    create_filters_router(
        get_storage=_current_storage,
        get_project_or_404=_get_project_or_404,
        analyze_smart_merge_annotations=_analyze_smart_merge_annotations,
        normalize_smart_filter_payload=_normalize_smart_filter_payload,
        spawn_smart_filter_job=SMART_FILTER_JOBS.spawn_job,
        run_smart_filter_preview_job=SMART_FILTER_JOBS.run_preview_job,
        run_smart_filter_apply_job=SMART_FILTER_JOBS.run_apply_job,
        get_active_smart_filter_job_for_project=SMART_FILTER_JOBS.get_active_job_for_project,
        get_smart_filter_job_state_or_404=SMART_FILTER_JOBS.get_job_state_or_404,
    )
)


def create_app() -> FastAPI:
    return app

frontend_dir = BASE_DIR / 'frontend'
if frontend_dir.exists():
    app.mount('/', StaticFiles(directory=str(frontend_dir), html=True), name='frontend')
else:
    logger.warning(f'Frontend directory not found at {frontend_dir}')
