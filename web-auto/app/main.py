
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import math
import mimetypes
import os
import secrets
import shutil
import subprocess
import threading
import time
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.exports import export_coco, export_video_json, export_yolo
from app.sam3_client import Sam3Client
from app.storage import Storage
from app.utils import IMAGE_EXTENSIONS, ensure_dir, list_video_files_recursive, new_id, norm_text, now_ts


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ensure_dir(Path(os.getenv('WEB_AUTO_DATA_DIR', str(BASE_DIR / 'data'))).expanduser().resolve())
HOST_DATA_ROOT = Path(os.getenv('WEB_AUTO_HOST_DATA_ROOT', str(DATA_DIR / 'uploads'))).expanduser().resolve()
DEFAULT_UPLOAD_TARGET_DIR = Path(
    os.getenv('WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR', '').strip() or str(HOST_DATA_ROOT / 'uploads')
).expanduser().resolve()
APP_CONFIG_FILE = DATA_DIR / 'global_config.json'
DEFAULT_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', 'http://127.0.0.1:8001').strip() or 'http://127.0.0.1:8001'
DEFAULT_SAPIENS_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAPIENS_API_BASE_URL', 'http://sapiens-api:8010').strip() or 'http://sapiens-api:8010'
SAPIENS_API_TOKEN = os.getenv('WEB_AUTO_SAPIENS_API_TOKEN', '').strip()
OPS_API_BASE_URL = os.getenv('WEB_AUTO_OPS_API_BASE_URL', 'http://ops-api:8020').strip().rstrip('/')
OPS_API_TOKEN = os.getenv('WEB_AUTO_OPS_API_TOKEN', '').strip()
DEFAULT_SAM3_MAX_BATCH_FILES = 32
MAX_PENDING_IMAGE_IDS_IN_JOB_STATE = 200


def _parse_positive_int_env(key: str, default: int) -> int:
    try:
        value = int(os.getenv(key, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(1, value)


SAM3_MAX_BATCH_FILES = _parse_positive_int_env('WEB_AUTO_SAM3_MAX_BATCH_FILES', DEFAULT_SAM3_MAX_BATCH_FILES)


def _parse_allowed_data_roots() -> list[Path]:
    roots: list[Path] = []
    raw = os.getenv('WEB_AUTO_ALLOWED_DATA_ROOTS', '').strip()
    items = [str(HOST_DATA_ROOT)]
    if raw:
        items.extend(item for item in raw.split(os.pathsep) if item.strip())
    for item in items:
        try:
            root = Path(item).expanduser().resolve()
        except Exception:
            continue
        if root not in roots:
            roots.append(root)
    return roots or [HOST_DATA_ROOT]


ALLOWED_DATA_ROOTS = _parse_allowed_data_roots()


def _read_app_config() -> dict[str, Any]:
    if not APP_CONFIG_FILE.exists():
        return {}
    try:
        with APP_CONFIG_FILE.open('r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_app_config(data: dict[str, Any]) -> dict[str, Any]:
    ensure_dir(APP_CONFIG_FILE.parent)
    tmp = APP_CONFIG_FILE.with_suffix(APP_CONFIG_FILE.suffix + '.tmp')
    clean = data if isinstance(data, dict) else {}
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(clean, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp, APP_CONFIG_FILE)
    return clean


def _update_app_config(values: dict[str, Any]) -> dict[str, Any]:
    data = _read_app_config()
    for key, value in values.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    return _write_app_config(data)


def _initial_storage_dir() -> Path:
    configured = str(_read_app_config().get('cache_dir') or '').strip()
    if configured:
        try:
            return ensure_dir(Path(configured).expanduser().resolve())
        except Exception:
            pass
    return DATA_DIR


logger = logging.getLogger('web_auto')
logger.setLevel(logging.INFO)
if not logger.handlers:
    fmt = logging.Formatter('%(asctime)s | %(levelname)s | %(name)s | %(message)s')
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    logger.addHandler(ch)


storage = Storage(_initial_storage_dir())
sam3 = Sam3Client(timeout_sec=180)
CURRENT_DATA_DIR = Path(storage.base_dir)


def _raise_video_annotation_removed() -> None:
    raise HTTPException(status_code=410, detail='video annotation has been removed; image projects only')


VIDEO_JOB_LOCK = threading.Lock()
VIDEO_JOB_THREADS: dict[str, dict[str, Any]] = {}
INFER_JOB_LOCK = threading.Lock()
INFER_JOB_THREADS: dict[str, dict[str, Any]] = {}
INFER_JOB_STATES: dict[str, dict[str, Any]] = {}
INFER_PROJECT_ACTIVE: dict[str, str] = {}
SMART_FILTER_JOB_LOCK = threading.Lock()
SMART_FILTER_JOB_THREADS: dict[str, dict[str, Any]] = {}
SMART_FILTER_JOB_STATES: dict[str, dict[str, Any]] = {}
SMART_FILTER_PROJECT_ACTIVE: dict[str, str] = {}
SMART_FILTER_PREVIEW_CACHE: dict[str, dict[str, Any]] = {}
CONFIG_LOCK = threading.Lock()
PROJECT_DISCOVERY_LOCK = threading.Lock()
TILE_CACHE_LOCK = threading.Lock()
PROJECT_DISCOVERY_LAST_SCAN = 0.0
PROJECT_DISCOVERY_INTERVAL_SECONDS = 60.0


AUTH_FILE = DATA_DIR / 'auth.json'
SESSION_COOKIE_NAME = os.getenv('WEB_AUTO_SESSION_COOKIE_NAME', 'web_auto_session').strip() or 'web_auto_session'
SESSION_TTL_SECONDS = _parse_positive_int_env('WEB_AUTO_SESSION_TTL_SECONDS', 12 * 60 * 60)
AUTH_ENABLED = os.getenv('WEB_AUTO_AUTH_ENABLED', '1').strip().lower() not in {'0', 'false', 'no', 'off'}


class AuthStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.sessions: dict[str, dict[str, Any]] = {}

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        with self.path.open('r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}

    def _save_locked(self, data: dict[str, Any]) -> None:
        ensure_dir(self.path.parent)
        tmp = self.path.with_suffix(self.path.suffix + '.tmp')
        with tmp.open('w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write('\n')
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    @staticmethod
    def _validate_username(username: str) -> str:
        clean = str(username or '').strip()
        if len(clean) < 3 or len(clean) > 64:
            raise ValueError('username must be 3-64 characters')
        if not re.fullmatch(r'[A-Za-z0-9_.@-]+', clean):
            raise ValueError('username may only contain letters, numbers, dot, underscore, at sign, and dash')
        return clean

    @staticmethod
    def _validate_password(password: str) -> str:
        text = str(password or '')
        if len(text) < 8:
            raise ValueError('password must be at least 8 characters')
        if len(text) > 256:
            raise ValueError('password is too long')
        return text

    @staticmethod
    def _hash_password(password: str) -> str:
        salt = secrets.token_hex(16)
        iterations = 260000
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('ascii'), iterations)
        return f'pbkdf2_sha256${iterations}${salt}${digest.hex()}'

    @staticmethod
    def _verify_password(password: str, stored: str) -> bool:
        try:
            algorithm, iterations_raw, salt, digest_hex = str(stored or '').split('$', 3)
            if algorithm != 'pbkdf2_sha256':
                return False
            iterations = int(iterations_raw)
            expected = bytes.fromhex(digest_hex)
            actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('ascii'), iterations)
            return hmac.compare_digest(actual, expected)
        except Exception:
            return False

    @staticmethod
    def _session_key(token: str) -> str:
        return hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()

    def has_admin(self) -> bool:
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin')
            return isinstance(admin, dict) and bool(str(admin.get('username') or '').strip()) and bool(admin.get('password_hash'))

    def setup_admin(self, username: str, password: str) -> str:
        clean_username = self._validate_username(username)
        clean_password = self._validate_password(password)
        with self.lock:
            data = self._load_locked()
            if isinstance(data.get('admin'), dict) and data['admin'].get('password_hash'):
                raise ValueError('admin user is already initialized')
            data = {
                'version': 1,
                'admin': {
                    'username': clean_username,
                    'password_hash': self._hash_password(clean_password),
                    'created_at': now_ts(),
                    'password_changed_at': now_ts(),
                },
            }
            self._save_locked(data)
            self.sessions.clear()
        return clean_username

    def ensure_admin_from_env(self) -> str | None:
        if not AUTH_ENABLED or self.has_admin():
            return None
        username = os.getenv('WEB_AUTO_ADMIN_USERNAME', 'admin').strip() or 'admin'
        password = os.getenv('WEB_AUTO_ADMIN_PASSWORD', '').strip()
        if not password:
            logger.warning('web-auto admin is not initialized and WEB_AUTO_ADMIN_PASSWORD is empty')
            return None
        try:
            created = self.setup_admin(username, password)
            logger.info('initialized web-auto admin user from environment: %s', created)
            return created
        except ValueError as exc:
            logger.error('failed to initialize web-auto admin from environment: %s', exc)
            return None

    def verify_login(self, username: str, password: str) -> str:
        clean_username = str(username or '').strip()
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin') if isinstance(data.get('admin'), dict) else {}
            stored_username = str(admin.get('username') or '').strip()
            stored_hash = str(admin.get('password_hash') or '')
            if not stored_username or not stored_hash:
                raise ValueError('admin user is not initialized')
            if clean_username != stored_username or not self._verify_password(str(password or ''), stored_hash):
                raise ValueError('invalid username or password')
            return stored_username

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(48)
        with self.lock:
            self.sessions[self._session_key(token)] = {
                'username': str(username),
                'expires_at': time.time() + SESSION_TTL_SECONDS,
            }
        return token

    def validate_session(self, token: str) -> str | None:
        if not token:
            return None
        key = self._session_key(token)
        with self.lock:
            item = self.sessions.get(key)
            if not isinstance(item, dict):
                return None
            if float(item.get('expires_at') or 0.0) <= time.time():
                self.sessions.pop(key, None)
                return None
            item['expires_at'] = time.time() + SESSION_TTL_SECONDS
            return str(item.get('username') or '').strip() or None

    def destroy_session(self, token: str) -> None:
        if not token:
            return
        with self.lock:
            self.sessions.pop(self._session_key(token), None)

    def change_password(self, username: str, current_password: str, new_password: str) -> None:
        clean_password = self._validate_password(new_password)
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin') if isinstance(data.get('admin'), dict) else {}
            stored_username = str(admin.get('username') or '').strip()
            stored_hash = str(admin.get('password_hash') or '')
            if username != stored_username or not stored_hash:
                raise ValueError('admin user is not initialized')
            if not self._verify_password(str(current_password or ''), stored_hash):
                raise ValueError('current password is incorrect')
            admin['password_hash'] = self._hash_password(clean_password)
            admin['password_changed_at'] = now_ts()
            data['admin'] = admin
            self._save_locked(data)
            self.sessions.clear()


AUTH_STORE = AuthStore(AUTH_FILE)


def _secure_cookie_for_request(request: Request) -> bool:
    raw = os.getenv('WEB_AUTO_SESSION_COOKIE_SECURE', 'auto').strip().lower()
    if raw in {'1', 'true', 'yes', 'on'}:
        return True
    if raw in {'0', 'false', 'no', 'off'}:
        return False
    proto = str(request.headers.get('x-forwarded-proto') or request.url.scheme or '').split(',')[0].strip().lower()
    return proto == 'https'


def _set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=_secure_cookie_for_request(request),
        samesite='lax',
        path='/',
    )


def _clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path='/',
        secure=_secure_cookie_for_request(request),
        httponly=True,
        samesite='lax',
    )


def _request_username(request: Request) -> str | None:
    if not AUTH_ENABLED:
        return 'auth-disabled'
    return AUTH_STORE.validate_session(str(request.cookies.get(SESSION_COOKIE_NAME) or ''))


def _auth_public_path(path: str) -> bool:
    if path in {'/login', '/logout', '/api/health'}:
        return True
    return path.startswith('/api/auth/') and path != '/api/auth/setup'


def _auth_page_html(mode: str) -> str:
    is_setup = mode == 'setup'
    title = 'Initialize web-auto admin' if is_setup else 'Sign in to web-auto'
    button = 'Create administrator' if is_setup else 'Sign in'
    endpoint = '/api/auth/setup' if is_setup else '/api/auth/login'
    extra = ''
    username_autocomplete = 'username'
    password_autocomplete = 'new-password' if is_setup else 'current-password'
    html = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__TITLE__</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #eef2f6;
      color: #243042;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border: 1px solid #d8e0ea;
      border-radius: 8px;
      box-shadow: 0 18px 50px rgba(23, 37, 54, 0.16);
      padding: 28px;
    }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { margin: 0 0 24px; color: #657287; font-size: 14px; line-height: 1.5; }
    label { display: block; margin: 14px 0 7px; font-weight: 650; font-size: 13px; }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 11px 12px;
      font-size: 15px;
      outline: none;
    }
    input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
    button {
      margin-top: 22px;
      width: 100%;
      border: 0;
      border-radius: 6px;
      padding: 12px 14px;
      font-weight: 700;
      font-size: 15px;
      color: #fff;
      background: #2563eb;
      cursor: pointer;
    }
    button:disabled { opacity: 0.7; cursor: wait; }
    .error { display: none; margin-top: 14px; color: #b91c1c; font-size: 13px; line-height: 1.4; }
    .link { display: inline-block; margin-top: 16px; color: #2563eb; font-size: 13px; text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      main { background: #1f2937; border-color: #374151; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); }
      p { color: #a7b0c0; }
      input { background: #111827; color: #e5e7eb; border-color: #4b5563; }
    }
  </style>
</head>
<body>
  <main>
    <h1>__TITLE__</h1>
    <p>Use this account to access the web-auto workspace and API.</p>
    <form id="auth-form">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="__USERNAME_AUTOCOMPLETE__" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="__PASSWORD_AUTOCOMPLETE__" required>
      <button id="submit" type="submit">__BUTTON__</button>
      <div id="error" class="error"></div>
      __EXTRA__
    </form>
  </main>
  <script>
    const form = document.getElementById('auth-form');
    const errorBox = document.getElementById('error');
    const submit = document.getElementById('submit');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.style.display = 'none';
      submit.disabled = true;
      try {
        const response = await fetch('__ENDPOINT__', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || response.statusText);
        window.location.href = '/';
      } catch (err) {
        errorBox.textContent = err.message || String(err);
        errorBox.style.display = 'block';
      } finally {
        submit.disabled = false;
      }
    });
  </script>
</body>
</html>
"""
    return (
        html.replace('__TITLE__', title)
        .replace('__BUTTON__', button)
        .replace('__ENDPOINT__', endpoint)
        .replace('__EXTRA__', extra)
        .replace('__USERNAME_AUTOCOMPLETE__', username_autocomplete)
        .replace('__PASSWORD_AUTOCOMPLETE__', password_autocomplete)
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
    description='API-only backend for image/video annotation workflows built on sam3-api.',
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
    if not AUTH_ENABLED or request.method.upper() == 'OPTIONS' or _auth_public_path(request.url.path):
        return await call_next(request)

    admin_missing = not AUTH_STORE.has_admin()
    if admin_missing:
        if request.url.path.startswith('/api/') or request.url.path in {'/docs', '/redoc', '/openapi.json'}:
            return JSONResponse(status_code=503, content={'detail': 'admin credentials are not configured', 'code': 'admin_not_configured'})
        return RedirectResponse('/login', status_code=303)

    if not _request_username(request):
        if request.url.path.startswith('/api/') or request.url.path in {'/docs', '/redoc', '/openapi.json'}:
            return JSONResponse(status_code=401, content={'detail': 'login required', 'code': 'login_required'})
        return RedirectResponse('/login', status_code=303)

    return await call_next(request)


class OpenProjectIn(BaseModel):
    name: str = ''
    project_type: str = Field(default='image', pattern='^(image|pose)$')
    image_dir: str = ''
    save_dir: Optional[str] = None
    classes_text: str = ''


class UpdateClassesIn(BaseModel):
    classes_text: str = ''


class ImportImagesIn(BaseModel):
    source_dir: str


class ImportExistingProjectIn(BaseModel):
    output_dir: str = ''
    manifest_path: str = ''
    image_dir: str = ''
    name: str = ''
    classes_text: str = ''
    project_type: str = ''


class InferIn(BaseModel):
    project_id: str
    image_id: str
    mode: str = Field(pattern='^(text|points|boxes)$')
    classes: list[str] = Field(default_factory=list)
    active_class: str = ''
    points: list[list[float | int]] = Field(default_factory=list)
    boxes: list[list[float | int]] = Field(default_factory=list)
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class InferBatchIn(BaseModel):
    project_id: str
    classes: list[str] = Field(default_factory=list)
    image_ids: list[str] = Field(default_factory=list)
    retry_image_ids: list[str] = Field(default_factory=list)
    all_images: bool = False
    scope_mode: str = Field(default='all', pattern='^(all|unlabeled|class_related|class_related_unlabeled)$')
    related_classes: list[str] = Field(default_factory=list)
    batch_size: int = 8
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class InferExampleBatchIn(BaseModel):
    project_id: str
    source_image_id: str
    active_class: str = ''
    boxes: list[list[float | int]] = Field(default_factory=list)
    pure_visual: bool = False
    image_ids: list[str] = Field(default_factory=list)
    batch_size: int = 8
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class InferExamplePreviewIn(BaseModel):
    project_id: str
    image_id: str
    active_class: str = ''
    boxes: list[list[float | int]] = Field(default_factory=list)
    pure_visual: bool = False
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class SaveAnnIn(BaseModel):
    project_id: str
    image_id: str
    annotations: list[dict[str, Any]] = Field(default_factory=list)


class AppendAnnIn(BaseModel):
    project_id: str
    image_id: str
    annotations: list[dict[str, Any]] = Field(default_factory=list)


class PoseInferIn(BaseModel):
    project_id: str
    image_id: str
    bbox_threshold: float = 0.3
    nms_threshold: float = 0.3
    keypoint_threshold: float = 0.3


class ExportIn(BaseModel):
    project_id: str
    format: str = Field(pattern='^(coco|json|yolo)$')
    include_bbox: bool = True
    include_mask: bool = False
    output_dir: Optional[str] = None


class SmartFilterIn(BaseModel):
    project_id: str
    operation_mode: str = Field(default='merge', pattern='^(merge|rule)$')
    merge_mode: str = Field(default='same_class', pattern='^(same_class|canonical_class)$')
    spatial_mode: str = Field(default='instance_cover', pattern='^(bbox_cover|instance_cover)$')
    coverage_threshold: float = 0.98
    canonical_class: str = ''
    source_classes: list[str] = Field(default_factory=list)
    area_mode: str = Field(default='instance', pattern='^(instance|bbox)$')
    rule_classes: list[str] = Field(default_factory=list)
    small_target_enabled: bool = False
    max_area_ratio: float = 0.02
    instance_count_enabled: bool = False
    min_instances: int = 1
    max_instances: int = 0
    position_enabled: bool = False
    center_x_half_width: float = 0.25
    center_y_half_height: float = 0.05
    confidence_enabled: bool = False
    min_confidence: float = 0.0
    max_confidence: float = 1.0
    preview_token: str = ''


class HealthApiIn(BaseModel):
    api_base_url: str = DEFAULT_API_BASE_URL


class CacheDirUpdateIn(BaseModel):
    cache_dir: str


class GlobalConfigUpdateIn(BaseModel):
    cache_dir: Optional[str] = None
    upload_target_dir: Optional[str] = None
    sam3_api_base_url: Optional[str] = None


class UIStateIn(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)
    project_id: Optional[str] = None


class VideoJobStartIn(BaseModel):
    project_id: str
    classes: list[str] = Field(default_factory=list)
    mode: str = Field(default='keyframe', pattern='^(keyframe|per_frame)$')
    start_frame_index: int = 0
    end_frame_index: Optional[int] = None
    segment_size_frames: int = 300
    threshold: float = 0.5
    imgsz: int = 640
    api_base_url: str = DEFAULT_API_BASE_URL
    prompt_mode: str = Field(default='text', pattern='^(text|boxes)$')
    prompt_frame_index: Optional[int] = None
    active_class: str = ''
    points: list[list[float | int]] = Field(default_factory=list)
    boxes: list[list[float | int]] = Field(default_factory=list)


class VideoJobControlIn(BaseModel):
    project_id: str


class VideoAnnotationsSaveIn(BaseModel):
    project_id: str
    frames: list[dict[str, Any]] = Field(default_factory=list)
    replace_all: bool = True


class InferJobControlIn(BaseModel):
    project_id: str


class InferJobResumeIn(BaseModel):
    project_id: str
    classes: Optional[list[str]] = None
    batch_size: Optional[int] = None
    threshold: Optional[float] = None
    api_base_url: Optional[str] = None
    active_class: Optional[str] = None
    source_image_id: Optional[str] = None
    boxes: Optional[list[list[float | int]]] = None
    pure_visual: Optional[bool] = None


class VideoJobResumeIn(BaseModel):
    project_id: str
    classes: Optional[list[str]] = None
    segment_size_frames: Optional[int] = None
    threshold: Optional[float] = None
    imgsz: Optional[int] = None
    api_base_url: Optional[str] = None
    prompt_mode: Optional[str] = Field(default=None, pattern='^(text|boxes)$')
    prompt_frame_index: Optional[int] = None
    active_class: Optional[str] = None
    boxes: Optional[list[list[float | int]]] = None


class AuthSetupIn(BaseModel):
    username: str
    password: str


class AuthLoginIn(BaseModel):
    username: str
    password: str


class AuthPasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


class InferJobPaused(RuntimeError):
    """Cooperative stop for long-running infer jobs."""


def _build_class_maps(classes: list[str]) -> tuple[dict[str, str], list[str]]:
    canonical: list[str] = []
    norm_to_real: dict[str, str] = {}
    for c in classes:
        real = str(c).strip()
        if not real:
            continue
        key = norm_text(real)
        if key in norm_to_real:
            continue
        norm_to_real[key] = real
        canonical.append(real)
    return norm_to_real, canonical


def _resolve_class_for_detection(det: dict[str, Any], classes: list[str]) -> str:
    raw_label = str(det.get('label') or '').strip()
    if raw_label:
        # Keep API label as-is; do not remap to project classes.
        return raw_label

    if not classes:
        return 'unknown'

    norm_to_real, ordered = _build_class_maps(classes)

    cid = det.get('class_id')
    if isinstance(cid, int):
        if 0 <= cid < len(ordered):
            return ordered[cid]
        if 1 <= cid <= len(ordered):
            return ordered[cid - 1]

    if len(ordered) == 1:
        return ordered[0]
    return 'unknown'


def _bbox_from_polygon(polygon: list[list[float]]) -> list[float]:
    if not isinstance(polygon, list) or len(polygon) < 3:
        return []
    xs, ys = [], []
    for p in polygon:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            xs.append(float(p[0]))
            ys.append(float(p[1]))
        except (TypeError, ValueError):
            continue
    if not xs or not ys:
        return []
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)
    if x2 <= x1 or y2 <= y1:
        return []
    return [x1, y1, x2, y2]


def _polygon_from_mask(mask_b64: str) -> list[list[float]]:
    if not isinstance(mask_b64, str) or not mask_b64:
        return []
    try:
        import cv2
        import numpy as np

        raw = base64.b64decode(mask_b64)
        arr = np.frombuffer(raw, dtype=np.uint8)
        mask = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            return []
        _, binary = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return []
        contour = max(contours, key=cv2.contourArea)
        if float(cv2.contourArea(contour)) < 10.0:
            return []
        peri = cv2.arcLength(contour, True)
        epsilon = max(1.0, 0.003 * peri)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        if approx is None or len(approx) < 3:
            return []
        out: list[list[float]] = []
        for pt in approx.reshape(-1, 2):
            out.append([float(pt[0]), float(pt[1])])
        return out
    except Exception:
        return []


def _convert_detections(
    *,
    detections: list[dict[str, Any]],
    classes: list[str],
    forced_class: str = '',
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, det in enumerate(detections, start=1):
        bbox = det.get('bbox_xyxy') or det.get('bbox') or []
        if not isinstance(bbox, list) or len(bbox) != 4:
            bbox = []

        polygon = det.get('polygon') if isinstance(det.get('polygon'), list) else []
        if len(polygon) < 3:
            polygon = _polygon_from_mask(det.get('mask_png_base64') or det.get('mask_png') or '')
        if (not bbox) and len(polygon) >= 3:
            bbox = _bbox_from_polygon(polygon)

        if not bbox and len(polygon) < 3:
            continue

        class_name = forced_class or _resolve_class_for_detection(det, classes)
        out.append(
            {
                'id': str(det.get('id') or f'det_{i:04d}'),
                'class_name': class_name,
                'raw_label': str(det.get('label') or ''),
                'score': float(det.get('score') or 0.0),
                'bbox': [float(v) for v in bbox] if bbox else [],
                'polygon': polygon if len(polygon) >= 3 else [],
                'area': float(det.get('area') or 0.0),
                'mask_png_base64': det.get('mask_png_base64') or '',
            }
        )
    return out


def _replace_by_classes(
    old_annotations: list[dict[str, Any]],
    *,
    impacted_classes: list[str],
    new_annotations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    impacted_norm: set[str] = set()
    for c in impacted_classes:
        raw = str(c).strip()
        if not raw:
            continue
        n = norm_text(raw)
        if n:
            impacted_norm.add(n)

    if not impacted_norm:
        return new_annotations

    kept: list[dict[str, Any]] = []
    for a in old_annotations:
        cls = str(a.get('class_name') or '').strip()
        cls_norm = norm_text(cls)
        if not cls_norm:
            kept.append(a)
            continue
        if cls_norm in impacted_norm:
            continue
        kept.append(a)

    kept.extend(new_annotations)
    return kept


def _annotation_score(ann: dict[str, Any]) -> float:
    try:
        return float(ann.get('score') or ann.get('confidence') or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _get_image_dimensions(image: dict[str, Any]) -> tuple[int, int]:
    image_path = str(image.get('abs_path') or '').strip()
    if not image_path:
        return 0, 0
    try:
        from PIL import Image  # type: ignore

        with Image.open(image_path) as im:
            width, height = im.size
        return max(0, int(width)), max(0, int(height))
    except Exception:
        return 0, 0


def _annotation_has_any_class(
    annotations: list[dict[str, Any]],
    class_names: list[str],
) -> bool:
    wanted = {norm_text(x) for x in class_names if norm_text(x)}
    if not wanted:
        return bool(annotations)
    for ann in annotations:
        if norm_text(str(ann.get('class_name') or '')) in wanted:
            return True
    return False


def _smart_filter_image_scope_count(
    annotations: list[dict[str, Any]],
    *,
    rule_classes: list[str],
) -> int:
    wanted = {norm_text(x) for x in rule_classes if norm_text(x)}
    if not wanted:
        return len([ann for ann in annotations if _annotation_class_name(ann)])
    count = 0
    for ann in annotations:
        cls_norm = norm_text(_annotation_class_name(ann))
        if cls_norm in wanted:
            count += 1
    return count


def _smart_filter_annotation_allowed(
    ann: dict[str, Any],
    *,
    area_mode: str,
    rule_classes: list[str],
    image_width: int,
    image_height: int,
    small_target_enabled: bool,
    max_area_ratio: float,
    position_enabled: bool,
    center_x_half_width: float,
    center_y_half_height: float,
    confidence_enabled: bool,
    min_confidence: float,
    max_confidence: float,
    require_geometry: bool = False,
) -> bool:
    cls = _annotation_class_name(ann)
    if not cls:
        return False
    wanted = {norm_text(x) for x in rule_classes if norm_text(x)}
    cls_norm = norm_text(cls)
    if wanted and cls_norm not in wanted:
        return False

    score = _annotation_score(ann)
    if confidence_enabled and not (float(min_confidence) <= score <= float(max_confidence)):
        return False

    bbox = _ann_bbox(ann)
    if require_geometry and not bbox:
        return False

    if small_target_enabled and image_width > 0 and image_height > 0:
        if not bbox:
            return False
        image_area = float(image_width * image_height)
        ann_area = _annotation_metric_area(ann, area_mode=area_mode)
        if image_area > 0.0 and (ann_area / image_area) > float(max_area_ratio):
            return False

    if position_enabled and image_width > 0 and image_height > 0:
        if not bbox:
            return False
        cx = ((bbox[0] + bbox[2]) / 2.0) / float(image_width)
        cy = ((bbox[1] + bbox[3]) / 2.0) / float(image_height)
        if abs(cx - 0.5) > float(center_x_half_width):
            return False
        if abs(cy - 0.5) > float(center_y_half_height):
            return False

    return True


def _assign_unique_annotation_ids(
    *,
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    used: set[str] = set()
    for a in existing:
        sid = str(a.get('id') or '').strip()
        if sid:
            used.add(sid)

    out: list[dict[str, Any]] = []
    for idx, ann in enumerate(incoming, start=1):
        item = dict(ann) if isinstance(ann, dict) else {}
        sid = str(item.get('id') or '').strip()
        if (not sid) or (sid in used):
            sid = new_id('ann_')
        # Extra guard in case random collision happens.
        while sid in used:
            sid = f'{sid}_{idx}'
        used.add(sid)
        item['id'] = sid
        out.append(item)
    return out


def _chunked(items: list[Any], size: int) -> list[list[Any]]:
    chunk_size = max(1, int(size))
    return [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]


def _requested_batch_size(raw: Any) -> int:
    try:
        return max(1, int(raw or 1))
    except (TypeError, ValueError):
        return 1


def _effective_sam3_batch_size(raw: Any) -> int:
    return min(_requested_batch_size(raw), SAM3_MAX_BATCH_FILES)


def _infer_job_state_default(*, job_id: str, project_id: str, job_type: str) -> dict[str, Any]:
    return {
        'job_id': job_id,
        'project_id': project_id,
        'job_type': job_type,
        'status': 'queued',
        'running': False,
        'message': 'waiting',
        'progress_done': 0,
        'progress_total': 0,
        'progress_pct': 0.0,
        'requested': 0,
        'batch_size': 0,
        'succeeded': 0,
        'failed': 0,
        'skipped': 0,
        'new_annotations': 0,
        'current_image_id': '',
        'current_image_rel_path': '',
        'started_at': '',
        'updated_at': now_ts(),
        'finished_at': '',
        'error': '',
        'errors': [],
        'failed_image_ids': [],
        'skipped_image_ids': [],
        'class_additions': {},
        'image_results': [],
        'params': {},
        'payload_dict': {},
        'pending_image_ids': [],
        'pending_image_count': 0,
        'pending_image_ids_truncated': False,
        'resume_count': 0,
        'result': {},
    }


def _cleanup_infer_project_slot(project_id: str) -> None:
    active_job_id = str(INFER_PROJECT_ACTIVE.get(project_id) or '').strip()
    if not active_job_id:
        return
    holder = INFER_JOB_THREADS.get(active_job_id) or {}
    thread = holder.get('thread')
    if thread and thread.is_alive():
        return
    INFER_JOB_THREADS.pop(active_job_id, None)
    if INFER_PROJECT_ACTIVE.get(project_id) == active_job_id:
        INFER_PROJECT_ACTIVE.pop(project_id, None)
    state = INFER_JOB_STATES.get(active_job_id)
    if isinstance(state, dict):
        state['running'] = False
        state['updated_at'] = now_ts()


def _update_infer_job_state(job_id: str, **updates: Any) -> None:
    with INFER_JOB_LOCK:
        state = INFER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            return
        state.update(updates)
        progress_total = int(state.get('progress_total') or 0)
        progress_done = int(state.get('progress_done') or 0)
        if progress_total > 0 and 'progress_pct' not in updates:
            state['progress_pct'] = float(max(0, min(progress_done, progress_total)) * 100.0 / max(progress_total, 1))
        state['updated_at'] = now_ts()


def _compact_infer_job_state_for_response(state: dict[str, Any]) -> dict[str, Any]:
    out = dict(state)
    pending = [str(x).strip() for x in out.get('pending_image_ids', []) if str(x).strip()] if isinstance(out.get('pending_image_ids'), list) else []
    pending_count = int(out.get('pending_image_count') or len(pending))
    if len(pending) > MAX_PENDING_IMAGE_IDS_IN_JOB_STATE:
        out['pending_image_ids'] = pending[:MAX_PENDING_IMAGE_IDS_IN_JOB_STATE]
        out['pending_image_ids_truncated'] = True
    else:
        out['pending_image_ids'] = pending
        out['pending_image_ids_truncated'] = bool(out.get('pending_image_ids_truncated')) and pending_count > len(pending)
    out['pending_image_count'] = pending_count
    return out


def _get_infer_job_state_or_404(job_id: str) -> dict[str, Any]:
    with INFER_JOB_LOCK:
        state = INFER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            raise HTTPException(status_code=404, detail='infer job not found')
        holder = INFER_JOB_THREADS.get(job_id) or {}
        thread = holder.get('thread')
        running = bool(thread and thread.is_alive())
        out = dict(state)
        out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
        return _compact_infer_job_state_for_response(out)


def _get_active_infer_job_for_project(project_id: str) -> dict[str, Any] | None:
    with INFER_JOB_LOCK:
        _cleanup_infer_project_slot(project_id)
        job_id = str(INFER_PROJECT_ACTIVE.get(project_id) or '').strip()
        if not job_id:
            return None
        state = INFER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            INFER_PROJECT_ACTIVE.pop(project_id, None)
            return None
        holder = INFER_JOB_THREADS.get(job_id) or {}
        thread = holder.get('thread')
        running = bool(thread and thread.is_alive())
        out = dict(state)
        out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
        return _compact_infer_job_state_for_response(out)


def _get_latest_infer_job_for_project(
    project_id: str,
    *,
    statuses: Optional[set[str]] = None,
) -> dict[str, Any] | None:
    with INFER_JOB_LOCK:
        matches: list[dict[str, Any]] = []
        for state in INFER_JOB_STATES.values():
            if str(state.get('project_id') or '').strip() != project_id:
                continue
            status = str(state.get('status') or '').strip().lower()
            if statuses and status not in statuses:
                continue
            matches.append(dict(state))
        if not matches:
            return None
        matches.sort(key=lambda item: (str(item.get('updated_at') or ''), str(item.get('job_id') or '')), reverse=True)
        out = matches[0]
        holder = INFER_JOB_THREADS.get(str(out.get('job_id') or '')) or {}
        thread = holder.get('thread')
        running = bool(thread and thread.is_alive())
        out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
        return _compact_infer_job_state_for_response(out)


def _pause_infer_job(project_id: str) -> bool:
    with INFER_JOB_LOCK:
        _cleanup_infer_project_slot(project_id)
        job_id = str(INFER_PROJECT_ACTIVE.get(project_id) or '').strip()
        if not job_id:
            return False
        holder = INFER_JOB_THREADS.get(job_id) or {}
        ev = holder.get('stop_event')
        if not ev:
            return False
        ev.set()
        return True


def _smart_filter_job_state_default(*, job_id: str, project_id: str, job_type: str) -> dict[str, Any]:
    return {
        'job_id': job_id,
        'project_id': project_id,
        'job_type': job_type,
        'status': 'queued',
        'running': False,
        'message': 'waiting',
        'progress_done': 0,
        'progress_total': 0,
        'progress_pct': 0.0,
        'current_image_id': '',
        'current_image_rel_path': '',
        'started_at': '',
        'updated_at': now_ts(),
        'finished_at': '',
        'error': '',
        'params': {},
        'payload_dict': {},
        'result': {},
    }


def _cleanup_smart_filter_project_slot(project_id: str) -> None:
    active_job_id = str(SMART_FILTER_PROJECT_ACTIVE.get(project_id) or '').strip()
    if not active_job_id:
        return
    holder = SMART_FILTER_JOB_THREADS.get(active_job_id) or {}
    thread = holder.get('thread')
    if thread and thread.is_alive():
        return
    SMART_FILTER_JOB_THREADS.pop(active_job_id, None)
    if SMART_FILTER_PROJECT_ACTIVE.get(project_id) == active_job_id:
        SMART_FILTER_PROJECT_ACTIVE.pop(project_id, None)
    state = SMART_FILTER_JOB_STATES.get(active_job_id)
    if isinstance(state, dict):
        state['running'] = False
        state['updated_at'] = now_ts()


def _update_smart_filter_job_state(job_id: str, **updates: Any) -> None:
    with SMART_FILTER_JOB_LOCK:
        state = SMART_FILTER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            return
        state.update(updates)
        progress_total = int(state.get('progress_total') or 0)
        progress_done = int(state.get('progress_done') or 0)
        if progress_total > 0 and 'progress_pct' not in updates:
            state['progress_pct'] = float(max(0, min(progress_done, progress_total)) * 100.0 / max(progress_total, 1))
        state['updated_at'] = now_ts()


def _get_smart_filter_job_state_or_404(job_id: str) -> dict[str, Any]:
    with SMART_FILTER_JOB_LOCK:
        state = SMART_FILTER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            raise HTTPException(status_code=404, detail='smart filter job not found')
        holder = SMART_FILTER_JOB_THREADS.get(job_id) or {}
        thread = holder.get('thread')
        running = bool(thread and thread.is_alive())
        out = dict(state)
        out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
        return out


def _get_active_smart_filter_job_for_project(project_id: str) -> dict[str, Any] | None:
    with SMART_FILTER_JOB_LOCK:
        _cleanup_smart_filter_project_slot(project_id)
        job_id = str(SMART_FILTER_PROJECT_ACTIVE.get(project_id) or '').strip()
        if not job_id:
            return None
        state = SMART_FILTER_JOB_STATES.get(job_id)
        if not isinstance(state, dict):
            SMART_FILTER_PROJECT_ACTIVE.pop(project_id, None)
            return None
        holder = SMART_FILTER_JOB_THREADS.get(job_id) or {}
        thread = holder.get('thread')
        running = bool(thread and thread.is_alive())
        out = dict(state)
        out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
        return out


def _smart_filter_signature(
    *,
    operation_mode: str,
    merge_mode: str,
    spatial_mode: str,
    coverage_threshold: float,
    canonical_class: str,
    source_classes: list[str],
    area_mode: str,
    rule_classes: list[str],
    small_target_enabled: bool,
    max_area_ratio: float,
    instance_count_enabled: bool,
    min_instances: int,
    max_instances: int,
    position_enabled: bool,
    center_x_half_width: float,
    center_y_half_height: float,
    confidence_enabled: bool,
    min_confidence: float,
    max_confidence: float,
) -> str:
    source = sorted(str(x).strip() for x in source_classes if str(x).strip())
    rules = sorted(str(x).strip() for x in rule_classes if str(x).strip())
    return '|'.join(
        [
            str(operation_mode or 'merge').strip().lower(),
            str(merge_mode or 'same_class').strip().lower(),
            str(spatial_mode or 'instance_cover').strip().lower(),
            f'{float(coverage_threshold):.6f}',
            str(canonical_class or '').strip(),
            ','.join(source),
            str(area_mode or 'instance').strip().lower(),
            ','.join(rules),
            '1' if small_target_enabled else '0',
            f'{float(max_area_ratio):.6f}',
            '1' if instance_count_enabled else '0',
            str(max(0, int(min_instances))),
            str(max(0, int(max_instances))),
            '1' if position_enabled else '0',
            f'{float(center_x_half_width):.6f}',
            f'{float(center_y_half_height):.6f}',
            '1' if confidence_enabled else '0',
            f'{float(min_confidence):.6f}',
            f'{float(max_confidence):.6f}',
        ]
    )


def _normalize_smart_filter_payload(payload: SmartFilterIn) -> dict[str, Any]:
    operation_mode = str(payload.operation_mode or 'merge').strip().lower()
    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
    spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
    canonical_class = str(payload.canonical_class or '').strip()
    source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
    area_mode = str(payload.area_mode or 'instance').strip().lower()
    rule_classes = [str(x).strip() for x in payload.rule_classes if str(x).strip()]
    small_target_enabled = bool(payload.small_target_enabled)
    max_area_ratio = max(0.0, min(1.0, float(payload.max_area_ratio or 0.0)))
    instance_count_enabled = bool(payload.instance_count_enabled)
    min_instances = max(0, int(payload.min_instances or 0))
    max_instances = max(0, int(payload.max_instances or 0))
    position_enabled = bool(payload.position_enabled)
    center_x_half_width = max(0.0, min(0.5, float(payload.center_x_half_width or 0.25)))
    center_y_half_height = max(0.0, min(0.5, float(payload.center_y_half_height or 0.05)))
    confidence_enabled = bool(payload.confidence_enabled)
    min_confidence = max(0.0, min(1.0, float(payload.min_confidence or 0.0)))
    max_confidence = max(0.0, min(1.0, float(payload.max_confidence if payload.max_confidence is not None else 1.0)))
    if operation_mode == 'merge' and merge_mode == 'canonical_class' and not canonical_class:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if operation_mode == 'merge' and merge_mode == 'canonical_class' and not source_classes:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')
    if instance_count_enabled and max_instances > 0 and max_instances < min_instances:
        raise HTTPException(status_code=400, detail='max_instances must be >= min_instances')
    if confidence_enabled and max_confidence < min_confidence:
        raise HTTPException(status_code=400, detail='max_confidence must be >= min_confidence')
    if operation_mode == 'rule' and not (
        small_target_enabled
        or instance_count_enabled
        or position_enabled
        or confidence_enabled
    ):
        raise HTTPException(status_code=400, detail='rule filter requires at least one enabled rule')
    return {
        'project_id': str(payload.project_id or '').strip(),
        'operation_mode': operation_mode,
        'merge_mode': merge_mode,
        'spatial_mode': spatial_mode,
        'coverage_threshold': coverage_threshold,
        'canonical_class': canonical_class,
        'source_classes': source_classes,
        'area_mode': area_mode,
        'rule_classes': rule_classes,
        'small_target_enabled': small_target_enabled,
        'max_area_ratio': max_area_ratio,
        'instance_count_enabled': instance_count_enabled,
        'min_instances': min_instances,
        'max_instances': max_instances,
        'position_enabled': position_enabled,
        'center_x_half_width': center_x_half_width,
        'center_y_half_height': center_y_half_height,
        'confidence_enabled': confidence_enabled,
        'min_confidence': min_confidence,
        'max_confidence': max_confidence,
        'preview_token': str(payload.preview_token or '').strip(),
        'signature': _smart_filter_signature(
            operation_mode=operation_mode,
            merge_mode=merge_mode,
            spatial_mode=spatial_mode,
            coverage_threshold=coverage_threshold,
            canonical_class=canonical_class,
            source_classes=source_classes,
            area_mode=area_mode,
            rule_classes=rule_classes,
            small_target_enabled=small_target_enabled,
            max_area_ratio=max_area_ratio,
            instance_count_enabled=instance_count_enabled,
            min_instances=min_instances,
            max_instances=max_instances,
            position_enabled=position_enabled,
            center_x_half_width=center_x_half_width,
            center_y_half_height=center_y_half_height,
            confidence_enabled=confidence_enabled,
            min_confidence=min_confidence,
            max_confidence=max_confidence,
        ),
    }


def _analyze_smart_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    operation_mode = str(config.get('operation_mode') or 'merge').strip().lower()
    if operation_mode == 'rule':
        return _analyze_rule_filter_project(project=project, config=config, progress_cb=progress_cb)

    return _analyze_merge_filter_project(project=project, config=config, progress_cb=progress_cb)


def _analyze_merge_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images', []), list) else []
    total = len(images)
    items: list[dict[str, Any]] = []
    apply_items: list[dict[str, Any]] = []
    total_candidates = 0
    total_images = 0
    total_relabels = 0

    if progress_cb:
        progress_cb(
            message=f'准备智能过滤分析，待扫描 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    need_image_metrics = bool(config.get('small_target_enabled')) or bool(config.get('position_enabled'))

    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = storage.load_annotations(str(project.get('id') or ''), image_id)

        scoped_count = _smart_filter_image_scope_count(
            annotations,
            rule_classes=list(config.get('rule_classes') or []),
        )
        if bool(config.get('instance_count_enabled')):
            min_instances = max(0, int(config.get('min_instances') or 0))
            max_instances = max(0, int(config.get('max_instances') or 0))
            if scoped_count < min_instances or (max_instances > 0 and scoped_count > max_instances):
                if progress_cb:
                    progress_cb(
                        message=f'分析 {idx}/{total}: {rel_path}',
                        progress_done=idx,
                        progress_total=total,
                        current_image_id=image_id,
                        current_image_rel_path=rel_path,
                    )
                continue

        width, height = _get_image_dimensions(image) if need_image_metrics else (0, 0)
        filtered_annotations: list[dict[str, Any]] = []
        untouched_annotations: list[dict[str, Any]] = []
        for ann in annotations:
            if _smart_filter_annotation_allowed(
                ann,
                area_mode=str(config.get('area_mode') or 'instance'),
                rule_classes=list(config.get('rule_classes') or []),
                image_width=width,
                image_height=height,
                small_target_enabled=bool(config.get('small_target_enabled')),
                max_area_ratio=float(config.get('max_area_ratio') or 0.0),
                position_enabled=bool(config.get('position_enabled')),
                center_x_half_width=float(config.get('center_x_half_width') or 0.25),
                center_y_half_height=float(config.get('center_y_half_height') or 0.05),
                confidence_enabled=bool(config.get('confidence_enabled')),
                min_confidence=float(config.get('min_confidence') or 0.0),
                max_confidence=float(config.get('max_confidence') if config.get('max_confidence') is not None else 1.0),
                require_geometry=True,
            ):
                filtered_annotations.append(ann)
            else:
                untouched_annotations.append(ann)

        analysis = _analyze_smart_merge_annotations(
            filtered_annotations,
            merge_mode=str(config.get('merge_mode') or 'same_class'),
            spatial_mode=str(config.get('spatial_mode') or 'instance_cover'),
            coverage_threshold=float(config.get('coverage_threshold') or 0.98),
            canonical_class=str(config.get('canonical_class') or ''),
            source_classes=list(config.get('source_classes') or []),
            area_mode=str(config.get('area_mode') or 'instance'),
        )
        removed = analysis.get('removed_annotations', [])
        pairs = analysis.get('pairs', [])
        relabeled = analysis.get('relabeled_annotations', [])
        kept_filtered = analysis.get('kept_annotations', filtered_annotations)
        kept_annotations = list(untouched_annotations) + (kept_filtered if isinstance(kept_filtered, list) else filtered_annotations)
        remove_count = len(removed) if isinstance(removed, list) else 0
        relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
        if remove_count > 0 or relabel_count > 0:
            total_candidates += remove_count
            total_relabels += relabel_count
            total_images += 1
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'candidate_count': remove_count,
                    'relabel_count': relabel_count,
                    'pair_count': len(pairs) if isinstance(pairs, list) else 0,
                    'scoped_annotation_count': len(filtered_annotations),
                }
            )
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': remove_count,
                    'relabel_count': relabel_count,
                    'kept_annotations': kept_annotations,
                }
            )
        if progress_cb:
            progress_cb(
                message=f'分析 {idx}/{total}: {rel_path}',
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    items.sort(key=lambda x: (int(x.get('candidate_count') or 0), int(x.get('relabel_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    apply_items.sort(key=lambda x: (int(x.get('removed_count') or 0), int(x.get('relabel_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    return {
        'image_count': total_images,
        'candidate_count': total_candidates,
        'relabel_count': total_relabels,
        'items': items,
        'apply_items': apply_items,
    }


def _analyze_rule_filter_project(
    *,
    project: dict[str, Any],
    config: dict[str, Any],
    progress_cb: Optional[Callable[..., None]] = None,
) -> dict[str, Any]:
    images = project.get('images', []) if isinstance(project.get('images', []), list) else []
    total = len(images)
    items: list[dict[str, Any]] = []
    apply_items: list[dict[str, Any]] = []
    total_candidates = 0
    total_images = 0

    if progress_cb:
        progress_cb(
            message=f'规则过滤预览准备中，待扫描 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    need_image_metrics = bool(config.get('small_target_enabled')) or bool(config.get('position_enabled'))

    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = storage.load_annotations(str(project.get('id') or ''), image_id)

        scoped_count = _smart_filter_image_scope_count(
            annotations,
            rule_classes=list(config.get('rule_classes') or []),
        )
        if bool(config.get('instance_count_enabled')):
            min_instances = max(0, int(config.get('min_instances') or 0))
            max_instances = max(0, int(config.get('max_instances') or 0))
            if scoped_count < min_instances or (max_instances > 0 and scoped_count > max_instances):
                if progress_cb:
                    progress_cb(
                        message=f'规则过滤 {idx}/{total}: {rel_path}',
                        progress_done=idx,
                        progress_total=total,
                        current_image_id=image_id,
                        current_image_rel_path=rel_path,
                    )
                continue

        width, height = _get_image_dimensions(image) if need_image_metrics else (0, 0)
        matched_annotations: list[dict[str, Any]] = []
        kept_annotations: list[dict[str, Any]] = []
        for ann in annotations:
            if _smart_filter_annotation_allowed(
                ann,
                area_mode=str(config.get('area_mode') or 'instance'),
                rule_classes=list(config.get('rule_classes') or []),
                image_width=width,
                image_height=height,
                small_target_enabled=bool(config.get('small_target_enabled')),
                max_area_ratio=float(config.get('max_area_ratio') or 0.0),
                position_enabled=bool(config.get('position_enabled')),
                center_x_half_width=float(config.get('center_x_half_width') or 0.25),
                center_y_half_height=float(config.get('center_y_half_height') or 0.05),
                confidence_enabled=bool(config.get('confidence_enabled')),
                min_confidence=float(config.get('min_confidence') or 0.0),
                max_confidence=float(config.get('max_confidence') if config.get('max_confidence') is not None else 1.0),
                require_geometry=False,
            ):
                matched_annotations.append(ann)
            else:
                kept_annotations.append(ann)

        matched_count = len(matched_annotations)
        if matched_count > 0:
            total_candidates += matched_count
            total_images += 1
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'candidate_count': matched_count,
                    'relabel_count': 0,
                    'pair_count': 0,
                }
            )
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': matched_count,
                    'relabel_count': 0,
                    'kept_annotations': kept_annotations,
                }
            )

        if progress_cb:
            progress_cb(
                message=f'规则过滤 {idx}/{total}: {rel_path}',
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    items.sort(key=lambda x: (int(x.get('candidate_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    apply_items.sort(key=lambda x: (int(x.get('removed_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    return {
        'image_count': total_images,
        'candidate_count': total_candidates,
        'relabel_count': 0,
        'items': items,
        'apply_items': apply_items,
    }


def _run_smart_filter_preview_job(payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
    payload = SmartFilterIn(**payload_dict)
    config = _normalize_smart_filter_payload(payload)
    project = storage.get_project(config['project_id'], enrich=False, include_images=True)
    if not project:
        raise RuntimeError('project not found')
    if project.get('project_type') != 'image':
        raise RuntimeError('only image project is supported')

    analysis = _analyze_smart_filter_project(project=project, config=config, progress_cb=progress_cb)
    preview_token = new_id('sfp_')
    project_rev = int(project.get('content_rev', 1) or 1)
    operation_mode = str(config.get('operation_mode') or 'merge')
    preview_entry = {
        'preview_token': preview_token,
        'project_id': config['project_id'],
        'project_content_rev': project_rev,
        'signature': str(config['signature']),
        'config': {
            'operation_mode': operation_mode,
            'merge_mode': config['merge_mode'],
            'spatial_mode': config['spatial_mode'],
            'coverage_threshold': float(config['coverage_threshold']),
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
            'rule_classes': list(config['rule_classes']),
            'small_target_enabled': bool(config['small_target_enabled']),
            'max_area_ratio': float(config['max_area_ratio']),
            'instance_count_enabled': bool(config['instance_count_enabled']),
            'min_instances': int(config['min_instances']),
            'max_instances': int(config['max_instances']),
            'position_enabled': bool(config['position_enabled']),
            'center_x_half_width': float(config['center_x_half_width']),
            'center_y_half_height': float(config['center_y_half_height']),
            'confidence_enabled': bool(config['confidence_enabled']),
            'min_confidence': float(config['min_confidence']),
            'max_confidence': float(config['max_confidence']),
        },
        'result': analysis,
    }
    with SMART_FILTER_JOB_LOCK:
        SMART_FILTER_PREVIEW_CACHE[config['project_id']] = preview_entry

    candidate_count = int(analysis.get('candidate_count') or 0)
    relabel_count = int(analysis.get('relabel_count') or 0)
    return {
        'project_id': config['project_id'],
        'operation_mode': operation_mode,
        'preview_token': preview_token,
        'project_content_rev': project_rev,
        'image_count': int(analysis.get('image_count') or 0),
        'candidate_count': candidate_count,
        'relabel_count': relabel_count,
        'items': analysis.get('items', []),
        'rule': {
            'operation_mode': operation_mode,
            'merge_mode': config['merge_mode'],
            'spatial_mode': config['spatial_mode'],
            'same_class': config['merge_mode'] == 'same_class',
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
            'rule_classes': list(config['rule_classes']),
            'small_target_enabled': bool(config['small_target_enabled']),
            'max_area_ratio': float(config['max_area_ratio']),
            'instance_count_enabled': bool(config['instance_count_enabled']),
            'min_instances': int(config['min_instances']),
            'max_instances': int(config['max_instances']),
            'position_enabled': bool(config['position_enabled']),
            'center_x_half_width': float(config['center_x_half_width']),
            'center_y_half_height': float(config['center_y_half_height']),
            'confidence_enabled': bool(config['confidence_enabled']),
            'min_confidence': float(config['min_confidence']),
            'max_confidence': float(config['max_confidence']),
            'small_box_covered_by_large_gte': float(config['coverage_threshold']),
            'keep': 'larger_area',
        },
        'message': (
            (
                f'合并过滤预览完成：可删除 {candidate_count} 个标注'
                + (f'，可改类 {relabel_count} 个标注' if relabel_count > 0 else '')
            )
            if operation_mode == 'merge' and (candidate_count > 0 or relabel_count > 0)
            else (
                '合并过滤预览完成：没有命中可处理标注'
                if operation_mode == 'merge'
                else (
                    f'规则过滤预览完成：命中 {candidate_count} 个待删除标注'
                    if candidate_count > 0
                    else '规则过滤预览完成：没有命中标注'
                )
            )
        ),
    }

def _run_smart_filter_apply_job(payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
    payload = SmartFilterIn(**payload_dict)
    config = _normalize_smart_filter_payload(payload)
    job_id = str(payload_dict.get('_job_id') or '').strip()
    preview_token = str(config.get('preview_token') or '').strip()
    if not preview_token:
        raise RuntimeError('preview_token is required; please run preview first')

    project = storage.get_project(config['project_id'], enrich=False, include_images=False)
    if not project:
        raise RuntimeError('project not found')
    if project.get('project_type') != 'image':
        raise RuntimeError('only image project is supported')
    current_rev = int(project.get('content_rev', 1) or 1)

    with SMART_FILTER_JOB_LOCK:
        preview_entry = dict(SMART_FILTER_PREVIEW_CACHE.get(config['project_id']) or {})
    if not preview_entry:
        raise RuntimeError('preview cache is missing; please rerun preview')
    if str(preview_entry.get('preview_token') or '') != preview_token:
        raise RuntimeError('preview token is stale; please rerun preview')
    if int(preview_entry.get('project_content_rev') or 0) != current_rev:
        raise RuntimeError('project annotations changed after preview; please rerun preview')
    if str(preview_entry.get('signature') or '') != str(config.get('signature') or ''):
        raise RuntimeError('filter config changed after preview; please rerun preview')

    cached_result = preview_entry.get('result', {}) if isinstance(preview_entry.get('result', {}), dict) else {}
    apply_items = list(cached_result.get('apply_items', [])) if isinstance(cached_result.get('apply_items', []), list) else []
    total = len(apply_items)
    operation_mode = str(config.get('operation_mode') or 'merge')
    changed_images = 0
    removed_annotations = 0
    relabeled_annotations = 0
    items: list[dict[str, Any]] = []
    rollback_run_id = ''
    if total > 0:
        rollback_run_id = storage.begin_smart_filter_run(
            project_id=config['project_id'],
            job_id=job_id,
            operation_mode=operation_mode,
            rule=dict(preview_entry.get('config') or {}),
        )

    if progress_cb:
        progress_cb(
            message=(f'准备执行合并过滤，待写回 {total} 张' if operation_mode == 'merge' else f'准备执行规则过滤删除，待写回 {total} 张'),
            progress_done=0,
            progress_total=total,
        )

    for idx, item in enumerate(apply_items, start=1):
        image_id = str(item.get('image_id') or '')
        rel_path = str(item.get('rel_path') or image_id)
        kept_annotations = item.get('kept_annotations', [])
        original_annotations = storage.load_annotations(config['project_id'], image_id)
        if rollback_run_id:
            storage.add_smart_filter_snapshot(
                run_id=rollback_run_id,
                project_id=config['project_id'],
                image_id=image_id,
                annotations=original_annotations,
            )
        storage.save_annotations(config['project_id'], image_id, kept_annotations if isinstance(kept_annotations, list) else [])
        remove_count = int(item.get('removed_count') or 0)
        relabel_count = int(item.get('relabel_count') or 0)
        changed_images += 1
        removed_annotations += remove_count
        relabeled_annotations += relabel_count
        items.append(
            {
                'image_id': image_id,
                'rel_path': rel_path,
                'removed_count': remove_count,
                'relabel_count': relabel_count,
            }
        )
        if progress_cb:
            progress_cb(
                message=(f'合并过滤写回 {idx}/{total}: {rel_path}' if operation_mode == 'merge' else f'规则过滤删除 {idx}/{total}: {rel_path}'),
                progress_done=idx,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    with SMART_FILTER_JOB_LOCK:
        current_entry = SMART_FILTER_PREVIEW_CACHE.get(config['project_id'])
        if isinstance(current_entry, dict) and str(current_entry.get('preview_token') or '') == preview_token:
            SMART_FILTER_PREVIEW_CACHE.pop(config['project_id'], None)

    items.sort(key=lambda x: (int(x.get('removed_count') or 0), int(x.get('relabel_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    result = {
        'project_id': config['project_id'],
        'operation_mode': operation_mode,
        'rollback_run_id': rollback_run_id,
        'changed_images': changed_images,
        'removed_annotations': removed_annotations,
        'relabeled_annotations': relabeled_annotations,
        'rule': {
            'operation_mode': operation_mode,
            'merge_mode': config['merge_mode'],
            'spatial_mode': config['spatial_mode'],
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
            'small_box_covered_by_large_gte': float(config['coverage_threshold']),
        },
        'items': items,
        'message': (
            f'合并过滤已应用：修改 {changed_images} 张图片，删除 {removed_annotations} 个标注'
            + (f'，改类 {relabeled_annotations} 个标注' if relabeled_annotations > 0 else '')
            if operation_mode == 'merge'
            else f'规则过滤已应用：修改 {changed_images} 张图片，删除 {removed_annotations} 个命中标注'
        ),
    }
    if rollback_run_id:
        storage.finish_smart_filter_run(run_id=rollback_run_id, summary=result)
    return result

def _spawn_smart_filter_job(
    *,
    project_id: str,
    job_type: str,
    payload_dict: dict[str, Any],
    worker: Callable[[dict[str, Any], Callable[..., None]], dict[str, Any]],
) -> dict[str, Any]:
    with SMART_FILTER_JOB_LOCK:
        _cleanup_smart_filter_project_slot(project_id)
        active_job_id = str(SMART_FILTER_PROJECT_ACTIVE.get(project_id) or '').strip()
        if active_job_id:
            raise HTTPException(status_code=409, detail='another smart filter job is already running for this project')

        job_id = new_id('sfjob_')
        worker_payload = dict(payload_dict)
        worker_payload['_job_id'] = job_id
        state = _smart_filter_job_state_default(job_id=job_id, project_id=project_id, job_type=job_type)
        state['payload_dict'] = dict(worker_payload)
        state['params'] = {
            'mode_label': '智能过滤分析预览' if job_type == 'preview' else '智能过滤确认合并',
            'scope_label': '全部图片',
        }
        SMART_FILTER_JOB_STATES[job_id] = state
        SMART_FILTER_PROJECT_ACTIVE[project_id] = job_id

        def _worker_entry() -> None:
            _update_smart_filter_job_state(
                job_id,
                status='running',
                running=True,
                started_at=now_ts(),
                message='job started',
            )
            try:
                result = worker(worker_payload, lambda **kw: _update_smart_filter_job_state(job_id, **kw))
                total = int(state.get('progress_total') or result.get('image_count') or result.get('changed_images') or 0)
                done = int(state.get('progress_done') or total)
                _update_smart_filter_job_state(
                    job_id,
                    status='done',
                    running=False,
                    finished_at=now_ts(),
                    message=str(result.get('message') or 'done'),
                    result=result,
                    progress_done=done,
                    progress_total=total,
                    progress_pct=100.0 if total > 0 else 0.0,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception('smart filter job failed project=%s type=%s', project_id, job_type)
                _update_smart_filter_job_state(
                    job_id,
                    status='error',
                    running=False,
                    finished_at=now_ts(),
                    message=str(exc),
                    error=str(exc),
                )
            finally:
                with SMART_FILTER_JOB_LOCK:
                    SMART_FILTER_JOB_THREADS.pop(job_id, None)
                    if SMART_FILTER_PROJECT_ACTIVE.get(project_id) == job_id:
                        SMART_FILTER_PROJECT_ACTIVE.pop(project_id, None)

        thread = threading.Thread(target=_worker_entry, daemon=True)
        SMART_FILTER_JOB_THREADS[job_id] = {'thread': thread, 'project_id': project_id}
        thread.start()
        return dict(state)


def _count_prompt_labels(items: Any, label_index: int) -> tuple[int, int]:
    pos = 0
    neg = 0
    if not isinstance(items, list):
        return (pos, neg)
    for raw in items:
        if not isinstance(raw, list) or len(raw) <= label_index:
            continue
        try:
            is_pos = bool(int(float(raw[label_index])))
        except (TypeError, ValueError):
            is_pos = bool(raw[label_index])
        if is_pos:
            pos += 1
        else:
            neg += 1
    return (pos, neg)


def _infer_job_params_from_payload(job_type: str, payload_dict: dict[str, Any]) -> dict[str, Any]:
    payload = payload_dict if isinstance(payload_dict, dict) else {}
    classes = [str(x).strip() for x in payload.get('classes', []) if str(x).strip()]
    image_ids = [str(x).strip() for x in payload.get('image_ids', []) if str(x).strip()]
    try:
        threshold = float(payload.get('threshold') if payload.get('threshold') is not None else 0.5)
    except (TypeError, ValueError):
        threshold = 0.5
    try:
        batch_size = max(0, int(payload.get('batch_size') or 0))
    except (TypeError, ValueError):
        batch_size = 0
    active_class = str(payload.get('active_class') or '').strip()
    source_image_id = str(payload.get('source_image_id') or '').strip()
    pure_visual = bool(payload.get('pure_visual'))
    pos_points, neg_points = _count_prompt_labels(payload.get('points'), 2)
    pos_boxes, neg_boxes = _count_prompt_labels(payload.get('boxes'), 4)

    params: dict[str, Any] = {
        'job_type': str(job_type or '').strip(),
        'threshold': threshold,
        'batch_size': batch_size,
        'classes': classes,
        'active_class': active_class,
        'selected_image_count': len(image_ids),
        'all_images': bool(payload.get('all_images')),
        'source_image_id': source_image_id,
        'pure_visual': pure_visual,
        'positive_points': pos_points,
        'negative_points': neg_points,
        'positive_boxes': pos_boxes,
        'negative_boxes': neg_boxes,
    }
    if job_type == 'text_batch':
        params['mode_label'] = '全图文本批推'
        params['scope_label'] = '全部图片' if bool(payload.get('all_images')) else '选中图片'
    elif job_type == 'example_batch':
        params['mode_label'] = '全图集范例传播'
        params['scope_label'] = '全部图片'
    else:
        params['mode_label'] = str(job_type or '').strip() or '推理任务'
        params['scope_label'] = ''
    return params


def _infer_job_image_ids(items: list[dict[str, Any]], *, limit: int = 0) -> list[str]:
    out: list[str] = []
    for image in items:
        image_id = str(image.get('id') or '').strip()
        if image_id:
            out.append(image_id)
            if limit > 0 and len(out) >= limit:
                break
    return out


def _pending_image_progress_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    pending_count = len(items)
    return {
        'pending_image_ids': _infer_job_image_ids(items, limit=MAX_PENDING_IMAGE_IDS_IN_JOB_STATE),
        'pending_image_count': pending_count,
        'pending_image_ids_truncated': pending_count > MAX_PENDING_IMAGE_IDS_IN_JOB_STATE,
    }


def _merge_infer_resume_payload(job_type: str, base_payload: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    payload = dict(base_payload if isinstance(base_payload, dict) else {})

    if 'threshold' in overrides and overrides.get('threshold') is not None:
        payload['threshold'] = float(overrides['threshold'])
    if 'batch_size' in overrides and overrides.get('batch_size') is not None:
        payload['batch_size'] = max(1, int(overrides['batch_size']))
    if 'api_base_url' in overrides and overrides.get('api_base_url') is not None:
        payload['api_base_url'] = str(overrides['api_base_url'] or '').strip() or DEFAULT_API_BASE_URL

    if job_type == 'text_batch':
        if 'classes' in overrides and overrides.get('classes') is not None:
            payload['classes'] = [str(x).strip() for x in overrides.get('classes', []) if str(x).strip()]
        return payload

    if job_type == 'example_batch':
        if 'active_class' in overrides and overrides.get('active_class') is not None:
            payload['active_class'] = str(overrides['active_class'] or '').strip()
        if 'source_image_id' in overrides and overrides.get('source_image_id') is not None:
            payload['source_image_id'] = str(overrides['source_image_id'] or '').strip()
        if 'boxes' in overrides and overrides.get('boxes') is not None:
            payload['boxes'] = overrides.get('boxes') or []
        if 'pure_visual' in overrides and overrides.get('pure_visual') is not None:
            payload['pure_visual'] = bool(overrides.get('pure_visual'))
        return payload

    return payload


def _spawn_infer_job(
    *,
    project_id: str,
    job_type: str,
    payload_dict: dict[str, Any],
    worker: Callable[[dict[str, Any], Callable[..., None], Callable[[], bool], Optional[dict[str, Any]]], dict[str, Any]],
    existing_job_id: Optional[str] = None,
) -> dict[str, Any]:
    with INFER_JOB_LOCK:
        _cleanup_infer_project_slot(project_id)
        active_job_id = str(INFER_PROJECT_ACTIVE.get(project_id) or '').strip()
        if active_job_id:
            raise HTTPException(status_code=409, detail='another infer job is already running for this project')

        if existing_job_id:
            job_id = str(existing_job_id).strip()
            state = INFER_JOB_STATES.get(job_id)
            if not isinstance(state, dict):
                raise HTTPException(status_code=404, detail='infer job not found')
            if str(state.get('project_id') or '').strip() != project_id:
                raise HTTPException(status_code=400, detail='infer job does not belong to this project')
            state['resume_count'] = int(state.get('resume_count') or 0) + 1
        else:
            job_id = new_id('ijob_')
            state = _infer_job_state_default(job_id=job_id, project_id=project_id, job_type=job_type)
            INFER_JOB_STATES[job_id] = state

        state['job_type'] = job_type
        state['payload_dict'] = dict(payload_dict)
        state['params'] = _infer_job_params_from_payload(job_type, payload_dict)
        state['status'] = 'queued'
        state['running'] = False
        state['message'] = 'waiting'
        state['error'] = ''
        state['finished_at'] = ''
        state['updated_at'] = now_ts()
        INFER_PROJECT_ACTIVE[project_id] = job_id
        resume_state = dict(state)
        stop_event = threading.Event()

        def _worker_entry() -> None:
            _update_infer_job_state(
                job_id,
                status='running',
                running=True,
                started_at=now_ts(),
                message='job started',
            )
            try:
                result = worker(
                    payload_dict,
                    lambda **kw: _update_infer_job_state(job_id, **kw),
                    lambda: bool(stop_event.is_set()),
                    resume_state,
                )
                _update_infer_job_state(
                    job_id,
                    status='done',
                    running=False,
                    finished_at=now_ts(),
                    message=str(result.get('message') or 'done'),
                    result=result,
                    requested=int(result.get('requested') or 0),
                    batch_size=int(result.get('batch_size') or 0),
                    succeeded=int(result.get('succeeded') or 0),
                    failed=int(result.get('failed') or 0),
                    new_annotations=int(result.get('new_annotations') or 0),
                    errors=result.get('errors', []),
                    progress_done=int(result.get('requested') or 0),
                    progress_total=int(result.get('requested') or 0),
                    progress_pct=100.0,
                    pending_image_ids=[],
                    pending_image_count=0,
                    pending_image_ids_truncated=False,
                )
            except InferJobPaused as exc:
                _update_infer_job_state(
                    job_id,
                    status='paused',
                    running=False,
                    message=str(exc) or 'job paused',
                    error='',
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception('infer job failed project=%s type=%s', project_id, job_type)
                _update_infer_job_state(
                    job_id,
                    status='error',
                    running=False,
                    finished_at=now_ts(),
                    message=str(exc),
                    error=str(exc),
                )
            finally:
                with INFER_JOB_LOCK:
                    INFER_JOB_THREADS.pop(job_id, None)
                    if INFER_PROJECT_ACTIVE.get(project_id) == job_id:
                        INFER_PROJECT_ACTIVE.pop(project_id, None)

        thread = threading.Thread(target=_worker_entry, daemon=True)
        INFER_JOB_THREADS[job_id] = {'thread': thread, 'project_id': project_id, 'stop_event': stop_event}
        thread.start()
        return dict(state)


def _resume_infer_job(payload: InferJobResumeIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='infer resume currently supports image project only')

    paused = _get_latest_infer_job_for_project(payload.project_id, statuses={'paused'})
    if not paused:
        raise HTTPException(status_code=409, detail='no paused infer job found for this project')

    job_type = str(paused.get('job_type') or '').strip().lower()
    pending_image_ids = [str(x).strip() for x in paused.get('pending_image_ids', []) if str(x).strip()]
    pending_count = max(0, int(paused.get('pending_image_count') or len(pending_image_ids)))
    pending_truncated = bool(paused.get('pending_image_ids_truncated'))
    if pending_count <= 0:
        raise HTTPException(status_code=409, detail='paused infer job has no remaining images to continue')

    overrides = payload.model_dump(exclude_unset=True, exclude_none=True)
    merged = _merge_infer_resume_payload(job_type, paused.get('payload_dict') or {}, overrides)

    if job_type == 'text_batch':
        scope = str(merged.get('scope_mode') or 'all').strip().lower()
        if pending_truncated:
            if scope not in {'unlabeled', 'class_related', 'class_related_unlabeled'}:
                raise HTTPException(
                    status_code=409,
                    detail='paused job has too many remaining images to resume exactly; start a new "unlabeled only" job instead',
                )
            merged['image_ids'] = []
            merged['retry_image_ids'] = []
        else:
            merged['image_ids'] = pending_image_ids
        merged['all_images'] = False
        job = _spawn_infer_job(
            project_id=payload.project_id,
            job_type='text_batch',
            payload_dict=merged,
            existing_job_id=str(paused.get('job_id') or ''),
            worker=lambda data, progress_cb, should_stop, resume_state: _run_infer_batch(
                InferBatchIn(**data),
                progress_cb=progress_cb,
                should_stop=should_stop,
                resume_state=resume_state,
            ),
        )
        return {'job': job}

    if job_type == 'example_batch':
        merged['image_ids'] = pending_image_ids
        job = _spawn_infer_job(
            project_id=payload.project_id,
            job_type='example_batch',
            payload_dict=merged,
            existing_job_id=str(paused.get('job_id') or ''),
            worker=lambda data, progress_cb, should_stop, resume_state: _run_infer_batch_example(
                InferExampleBatchIn(**data),
                progress_cb=progress_cb,
                should_stop=should_stop,
                resume_state=resume_state,
            ),
        )
        return {'job': job}

    raise HTTPException(status_code=400, detail=f'unsupported paused infer job type: {job_type}')
def _norm_bbox_xyxy(raw: Any) -> list[float]:
    if not isinstance(raw, list) or len(raw) < 4:
        return []
    try:
        x1 = float(raw[0])
        y1 = float(raw[1])
        x2 = float(raw[2])
        y2 = float(raw[3])
    except (TypeError, ValueError):
        return []
    x_min = min(x1, x2)
    y_min = min(y1, y2)
    x_max = max(x1, x2)
    y_max = max(y1, y2)
    if x_max <= x_min or y_max <= y_min:
        return []
    return [x_min, y_min, x_max, y_max]


def _bbox_center(bbox: list[float]) -> tuple[float, float]:
    return (float((bbox[0] + bbox[2]) / 2.0), float((bbox[1] + bbox[3]) / 2.0))


def _point_in_bbox(x: float, y: float, bbox: list[float]) -> bool:
    # Small tolerance for post-processing coordinate jitter.
    margin = 6.0
    return (bbox[0] - margin) <= x <= (bbox[2] + margin) and (bbox[1] - margin) <= y <= (bbox[3] + margin)


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(0.0, (b[2] - b[0]) * (b[3] - b[1]))
    union = area_a + area_b - inter
    if union <= 0.0:
        return 0.0
    return inter / union


def _bbox_intersection_area(a: list[float], b: list[float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    return iw * ih


def _polygon_area(poly: list[list[float]]) -> float:
    if not isinstance(poly, list) or len(poly) < 3:
        return 0.0
    area = 0.0
    pts: list[tuple[float, float]] = []
    for p in poly:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            pts.append((float(p[0]), float(p[1])))
        except (TypeError, ValueError):
            continue
    if len(pts) < 3:
        return 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        area += (x1 * y2) - (x2 * y1)
    return abs(area) * 0.5


def _annotation_area_value(ann: dict[str, Any]) -> float:
    try:
        raw_area = float(ann.get('area') or 0.0)
    except (TypeError, ValueError):
        raw_area = 0.0
    if raw_area > 0.0:
        return raw_area
    poly_area = _polygon_area(ann.get('polygon') or [])
    if poly_area > 0.0:
        return poly_area
    bbox = _ann_bbox(ann)
    if bbox:
        return max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    return 0.0


def _bbox_area_value(bbox: list[float]) -> float:
    if not bbox or len(bbox) != 4:
        return 0.0
    return max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))


def _annotation_metric_area(ann: dict[str, Any], *, area_mode: str) -> float:
    bbox = _ann_bbox(ann)
    if str(area_mode or 'instance').strip().lower() == 'bbox':
        return _bbox_area_value(bbox)
    metric = _annotation_area_value(ann)
    if metric > 0.0:
        return metric
    return _bbox_area_value(bbox)


def _ann_polygon(ann: dict[str, Any]) -> list[list[float]]:
    raw = ann.get('polygon') or []
    out: list[list[float]] = []
    if isinstance(raw, list):
        for p in raw:
            if not isinstance(p, (list, tuple)) or len(p) < 2:
                continue
            try:
                out.append([float(p[0]), float(p[1])])
            except (TypeError, ValueError):
                continue
    if len(out) >= 3:
        return out
    mask_poly = _polygon_from_mask(str(ann.get('mask_png_base64') or ann.get('mask_png') or ''))
    if len(mask_poly) >= 3:
        return [[float(p[0]), float(p[1])] for p in mask_poly]
    return []


def _polygon_cover_ratio(outer_poly: list[list[float]], inner_poly: list[list[float]]) -> float | None:
    if len(outer_poly) < 3 or len(inner_poly) < 3:
        return None
    try:
        from PIL import Image, ImageChops, ImageDraw  # type: ignore

        xs = [float(p[0]) for p in outer_poly] + [float(p[0]) for p in inner_poly]
        ys = [float(p[1]) for p in outer_poly] + [float(p[1]) for p in inner_poly]
        min_x = math.floor(min(xs)) - 2
        min_y = math.floor(min(ys)) - 2
        max_x = math.ceil(max(xs)) + 2
        max_y = math.ceil(max(ys)) + 2
        width = max(1, int(max_x - min_x + 1))
        height = max(1, int(max_y - min_y + 1))

        def _shift(poly: list[list[float]]) -> list[tuple[float, float]]:
            return [(float(p[0]) - min_x, float(p[1]) - min_y) for p in poly]

        outer_mask = Image.new('L', (width, height), 0)
        inner_mask = Image.new('L', (width, height), 0)
        ImageDraw.Draw(outer_mask).polygon(_shift(outer_poly), fill=255)
        ImageDraw.Draw(inner_mask).polygon(_shift(inner_poly), fill=255)
        inter_mask = ImageChops.multiply(outer_mask, inner_mask)
        inner_area = inner_mask.tobytes().count(255)
        if inner_area <= 0:
            return None
        inter_area = inter_mask.tobytes().count(255)
        return float(inter_area) / float(inner_area)
    except Exception:
        return None


def _annotation_cover_ratio(
    bigger_ann: dict[str, Any],
    smaller_ann: dict[str, Any],
    *,
    spatial_mode: str,
) -> float:
    bigger_bbox = _ann_bbox(bigger_ann)
    smaller_bbox = _ann_bbox(smaller_ann)
    smaller_bbox_area = _bbox_area_value(smaller_bbox)
    if not bigger_bbox or not smaller_bbox or smaller_bbox_area <= 0.0:
        return 0.0

    bbox_cover = _bbox_intersection_area(bigger_bbox, smaller_bbox) / smaller_bbox_area
    if str(spatial_mode or 'instance_cover').strip().lower() == 'bbox_cover':
        return bbox_cover

    bigger_poly = _ann_polygon(bigger_ann)
    smaller_poly = _ann_polygon(smaller_ann)
    poly_cover = _polygon_cover_ratio(bigger_poly, smaller_poly)
    if poly_cover is not None:
        return poly_cover
    return bbox_cover


def _annotation_class_name(ann: dict[str, Any]) -> str:
    return str(ann.get('class_name') or ann.get('label') or '').strip()


def _class_tokens(raw: str) -> set[str]:
    return {norm_text(p) for p in re.split(r'[\s_\-]+', str(raw or '').strip()) if norm_text(p)}


def _class_matches_canonical_family(class_name: str, canonical_class: str) -> bool:
    cls_norm = norm_text(class_name)
    canon_norm = norm_text(canonical_class)
    if not cls_norm or not canon_norm:
        return False
    if cls_norm == canon_norm:
        return True
    cls_tokens = _class_tokens(class_name)
    canon_tokens = _class_tokens(canonical_class)
    if not cls_tokens or not canon_tokens:
        return False
    return cls_tokens.issubset(canon_tokens) or canon_tokens.issubset(cls_tokens)


def _analyze_smart_merge_annotations(
    annotations: list[dict[str, Any]],
    *,
    merge_mode: str = 'same_class',
    spatial_mode: str = 'instance_cover',
    coverage_threshold: float = 0.98,
    canonical_class: str = '',
    source_classes: list[str] | None = None,
    area_mode: str = 'instance',
) -> dict[str, Any]:
    anns = [dict(a) for a in annotations if isinstance(a, dict)]
    if not anns:
        return {'pairs': [], 'remove_indices': set(), 'kept_annotations': [], 'removed_annotations': []}

    indexed: list[dict[str, Any]] = []
    for idx, ann in enumerate(anns):
        bbox = _ann_bbox(ann)
        cls = _annotation_class_name(ann)
        area = _annotation_metric_area(ann, area_mode=area_mode)
        if not bbox or not cls or area <= 0.0:
            continue
        indexed.append({'idx': idx, 'class_name': cls, 'bbox': bbox, 'area': area})

    use_canonical = str(merge_mode or 'same_class').strip().lower() == 'canonical_class'
    canonical = str(canonical_class or '').strip()
    selected_sources = [str(x).strip() for x in (source_classes or []) if str(x).strip()]
    selected_source_norm = {norm_text(x) for x in selected_sources if norm_text(x)}
    remove_indices: set[int] = set()
    relabel_indices: set[int] = set()
    pairs: list[dict[str, Any]] = []

    if use_canonical and not canonical:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if use_canonical and not selected_source_norm:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

    if use_canonical:
        canonical_norm = norm_text(canonical)
        candidate_items = []
        for item in indexed:
            item_norm = norm_text(str(item['class_name']))
            if not item_norm:
                continue
            if item_norm == canonical_norm or item_norm in selected_source_norm:
                candidate_items.append(item)
        items_sorted = sorted(candidate_items, key=lambda x: (float(x['area']), str(x['idx'])), reverse=True)
        for i, bigger in enumerate(items_sorted):
            keep_idx = int(bigger['idx'])
            if keep_idx in remove_indices:
                continue
            for smaller in items_sorted[i + 1:]:
                s_idx = int(smaller['idx'])
                if s_idx in remove_indices or s_idx == keep_idx:
                    continue
                smaller_area = max(float(smaller['area']), 0.0)
                if smaller_area <= 0.0:
                    continue
                cover = _annotation_cover_ratio(
                    anns[keep_idx],
                    anns[s_idx],
                    spatial_mode=spatial_mode,
                )
                if cover < float(coverage_threshold):
                    continue
                remove_indices.add(s_idx)
                if norm_text(str(bigger['class_name'])) != canonical_norm:
                    relabel_indices.add(keep_idx)
                pairs.append(
                    {
                        'keep_index': keep_idx,
                        'remove_index': s_idx,
                        'keep_class_name': str(bigger['class_name']),
                        'remove_class_name': str(smaller['class_name']),
                        'merged_class_name': canonical,
                        'coverage': round(cover, 6),
                        'kept_area': round(float(bigger['area']), 3),
                        'removed_area': round(smaller_area, 3),
                    }
                )
    else:
        by_class: dict[str, list[dict[str, Any]]] = {}
        for item in indexed:
            by_class.setdefault(norm_text(item['class_name']), []).append(item)

        for items in by_class.values():
            items_sorted = sorted(items, key=lambda x: (float(x['area']), str(x['idx'])), reverse=True)
            for i, bigger in enumerate(items_sorted):
                if int(bigger['idx']) in remove_indices:
                    continue
                for smaller in items_sorted[i + 1:]:
                    s_idx = int(smaller['idx'])
                    if s_idx in remove_indices:
                        continue
                    smaller_area = max(float(smaller['area']), 0.0)
                    if smaller_area <= 0.0:
                        continue
                    cover = _annotation_cover_ratio(
                        anns[int(bigger['idx'])],
                        anns[s_idx],
                        spatial_mode=spatial_mode,
                    )
                    if cover < float(coverage_threshold):
                        continue
                    remove_indices.add(s_idx)
                    pairs.append(
                        {
                            'keep_index': int(bigger['idx']),
                            'remove_index': s_idx,
                            'keep_class_name': str(bigger['class_name']),
                            'remove_class_name': str(smaller['class_name']),
                            'merged_class_name': str(bigger['class_name']),
                            'coverage': round(cover, 6),
                            'kept_area': round(float(bigger['area']), 3),
                            'removed_area': round(smaller_area, 3),
                        }
                    )

    kept_annotations: list[dict[str, Any]] = []
    relabeled_annotations: list[dict[str, Any]] = []
    for idx, ann in enumerate(anns):
        if idx in remove_indices:
            continue
        item = dict(ann)
        if use_canonical and idx in relabel_indices:
            item['class_name'] = canonical
            relabeled_annotations.append(dict(item))
        kept_annotations.append(item)
    removed_annotations = [ann for idx, ann in enumerate(anns) if idx in remove_indices]
    return {
        'pairs': pairs,
        'remove_indices': remove_indices,
        'kept_annotations': kept_annotations,
        'removed_annotations': removed_annotations,
        'relabel_indices': relabel_indices,
        'relabeled_annotations': relabeled_annotations,
    }


def _split_visual_prompts(
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> tuple[list[list[float]], list[list[float]], list[list[float]], list[list[float]]]:
    pos_points: list[list[float]] = []
    neg_points: list[list[float]] = []
    for item in points or []:
        if not isinstance(item, list) or len(item) < 2:
            continue
        try:
            x = float(item[0])
            y = float(item[1])
            label = 0 if (len(item) >= 3 and int(item[2]) == 0) else 1
        except (TypeError, ValueError):
            continue
        if label == 0:
            neg_points.append([x, y])
        else:
            pos_points.append([x, y])

    pos_boxes: list[list[float]] = []
    neg_boxes: list[list[float]] = []
    for item in boxes or []:
        if not isinstance(item, list) or len(item) < 4:
            continue
        b = _norm_bbox_xyxy(item[:4])
        if not b:
            continue
        try:
            label = 0 if (len(item) >= 5 and int(item[4]) == 0) else 1
        except (TypeError, ValueError):
            label = 1
        if label == 0:
            neg_boxes.append(b)
        else:
            pos_boxes.append(b)

    return pos_points, neg_points, pos_boxes, neg_boxes


def _prepare_example_prompt_boxes(
    *,
    image: dict[str, Any],
    boxes: list[list[float | int]],
) -> list[list[float]]:
    del image
    norm_boxes = _normalize_prompt_boxes(boxes)
    if not norm_boxes:
        raise HTTPException(status_code=400, detail='example preview requires boxes')
    if not _has_positive_visual_prompt([], norm_boxes):
        raise HTTPException(status_code=400, detail='example boxes require at least one positive prompt')
    return norm_boxes


def _has_positive_visual_prompt(
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> bool:
    pos_points, _, pos_boxes, _ = _split_visual_prompts(points, boxes)
    return bool(pos_points or pos_boxes)


def _ann_bbox(ann: dict[str, Any]) -> list[float]:
    bbox = _norm_bbox_xyxy(ann.get('bbox') or [])
    if bbox:
        return bbox
    return _bbox_from_polygon(ann.get('polygon') or [])


def _match_positive_prompt(
    bbox: list[float],
    pos_points: list[list[float]],
    pos_boxes: list[list[float]],
) -> bool:
    for p in pos_points:
        if _point_in_bbox(float(p[0]), float(p[1]), bbox):
            return True
    cx, cy = _bbox_center(bbox)
    for pb in pos_boxes:
        if _point_in_bbox(cx, cy, pb):
            return True
        if _bbox_iou(bbox, pb) >= 0.1:
            return True
    return False


def _match_negative_prompt(
    bbox: list[float],
    neg_points: list[list[float]],
    neg_boxes: list[list[float]],
) -> bool:
    for p in neg_points:
        if _point_in_bbox(float(p[0]), float(p[1]), bbox):
            return True
    cx, cy = _bbox_center(bbox)
    for nb in neg_boxes:
        if _point_in_bbox(cx, cy, nb):
            return True
        if _bbox_iou(bbox, nb) >= 0.2:
            return True
    return False


def _filter_visual_detections(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    pos_points, neg_points, pos_boxes, neg_boxes = _split_visual_prompts(points, boxes)
    has_positive = bool(pos_points or pos_boxes)
    out: list[dict[str, Any]] = []
    for det in detections:
        bbox = _ann_bbox(det)
        if not bbox:
            continue
        if has_positive and (not _match_positive_prompt(bbox, pos_points, pos_boxes)):
            continue
        if _match_negative_prompt(bbox, neg_points, neg_boxes):
            continue
        out.append(det)
    return out


def _filter_negative_only(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    _, neg_points, _, neg_boxes = _split_visual_prompts(points, boxes)
    if not neg_points and not neg_boxes:
        return list(detections)
    out: list[dict[str, Any]] = []
    for det in detections:
        bbox = _ann_bbox(det)
        if not bbox:
            continue
        if _match_negative_prompt(bbox, neg_points, neg_boxes):
            continue
        out.append(det)
    return out


def _positive_points_only(points: list[list[float | int]]) -> list[list[float]]:
    pos_points, _, _, _ = _split_visual_prompts(points, [])
    return pos_points


def _distance_sq(x1: float, y1: float, x2: float, y2: float) -> float:
    dx = x1 - x2
    dy = y1 - y2
    return dx * dx + dy * dy


def _pick_by_positive_points(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
) -> list[dict[str, Any]]:
    pos_points = _positive_points_only(points)
    if not detections or not pos_points:
        return []

    out: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for px, py in pos_points:
        best: dict[str, Any] | None = None
        best_dist = float('inf')
        # Prefer detections that contain the clicked point.
        for det in detections:
            det_id = str(det.get('id') or '')
            if det_id and det_id in used_ids:
                continue
            bbox = _ann_bbox(det)
            if not bbox:
                continue
            if not _point_in_bbox(float(px), float(py), bbox):
                continue
            cx, cy = _bbox_center(bbox)
            d = _distance_sq(float(px), float(py), cx, cy)
            if d < best_dist:
                best_dist = d
                best = det

        # If none contains the point, fallback to nearest bbox center.
        if best is None:
            for det in detections:
                det_id = str(det.get('id') or '')
                if det_id and det_id in used_ids:
                    continue
                bbox = _ann_bbox(det)
                if not bbox:
                    continue
                cx, cy = _bbox_center(bbox)
                d = _distance_sq(float(px), float(py), cx, cy)
                if d < best_dist:
                    best_dist = d
                    best = det

        if best is not None:
            det_id = str(best.get('id') or '')
            if det_id:
                used_ids.add(det_id)
            out.append(best)
    return out


def _reduce_points_to_single_instance(
    detections: list[dict[str, Any]],
    *,
    points: list[list[float | int]],
) -> list[dict[str, Any]]:
    if not detections:
        return []
    picked = _pick_by_positive_points(detections, points=points)
    if picked:
        return [picked[0]]
    best = max(detections, key=lambda d: float(d.get('score') or 0.0))
    return [best]


def _merge_visual_annotations(
    old_annotations: list[dict[str, Any]],
    *,
    new_annotations: list[dict[str, Any]],
    points: list[list[float | int]],
    boxes: list[list[float | int]],
) -> list[dict[str, Any]]:
    if not old_annotations:
        return list(new_annotations)
    if not new_annotations:
        return list(old_annotations)

    pos_points, _, pos_boxes, _ = _split_visual_prompts(points, boxes)
    new_bboxes = [_ann_bbox(a) for a in new_annotations]
    new_bboxes = [b for b in new_bboxes if b]
    kept: list[dict[str, Any]] = []
    for old in old_annotations:
        old_bbox = _ann_bbox(old)
        if not old_bbox:
            kept.append(old)
            continue

        drop = False
        if pos_points or pos_boxes:
            if _match_positive_prompt(old_bbox, pos_points, pos_boxes):
                drop = True
        if not drop:
            for nb in new_bboxes:
                if _bbox_iou(old_bbox, nb) >= 0.6:
                    drop = True
                    break
        if not drop:
            kept.append(old)
    kept.extend(new_annotations)
    return kept


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


def _image_file_path_or_404(image: dict[str, Any]) -> Path:
    abs_path_raw = str(image.get('abs_path') or '').strip()
    if abs_path_raw:
        path = Path(abs_path_raw).expanduser().resolve()
        if path.exists() and path.is_file():
            return path
    raise HTTPException(status_code=404, detail='image file not found')


def _image_tile_cache_dir(project_id: str, image_id: str, image_path: Path) -> Path:
    stat = image_path.stat()
    key_raw = f'{project_id}:{image_id}:{image_path}:{stat.st_mtime_ns}:{stat.st_size}'
    key = hashlib.sha256(key_raw.encode('utf-8')).hexdigest()[:24]
    return ensure_dir(CURRENT_DATA_DIR / '.tile-cache' / str(project_id) / f'{image_id}_{key}')


def _dzi_metadata_path(tile_dir: Path) -> Path:
    return tile_dir / 'image.dzi'


def _read_dzi_metadata(tile_dir: Path) -> dict[str, Any] | None:
    dzi = _dzi_metadata_path(tile_dir)
    if not dzi.exists():
        return None
    try:
        root = ET.fromstring(dzi.read_text(encoding='utf-8', errors='ignore'))
    except ET.ParseError:
        return None
    size = None
    for child in root:
        if child.tag.split('}', 1)[-1] == 'Size':
            size = child
            break
    if size is None:
        return None
    fmt = str(root.attrib.get('Format') or '').strip()
    overlap = str(root.attrib.get('Overlap') or '').strip()
    tile_size = str(root.attrib.get('TileSize') or '').strip()
    height = str(size.attrib.get('Height') or '').strip()
    width = str(size.attrib.get('Width') or '').strip()
    if not fmt or not overlap or not tile_size or not height or not width:
        return None
    return {
        'format': fmt,
        'overlap': int(float(overlap)),
        'tile_size': int(float(tile_size)),
        'height': int(float(height)),
        'width': int(float(width)),
    }


def _ensure_image_tiles(project_id: str, image_id: str, image_path: Path) -> tuple[Path, dict[str, Any]]:
    tile_dir = _image_tile_cache_dir(project_id, image_id, image_path)
    metadata = _read_dzi_metadata(tile_dir)
    if metadata:
        return tile_dir, metadata

    with TILE_CACHE_LOCK:
        metadata = _read_dzi_metadata(tile_dir)
        if metadata:
            return tile_dir, metadata
        return _generate_image_tiles(tile_dir, image_path)


def _generate_image_tiles(tile_dir: Path, image_path: Path) -> tuple[Path, dict[str, Any]]:
    if shutil.which('vips') is None:
        raise HTTPException(
            status_code=503,
            detail='tile generation requires libvips. Rebuild web-auto image after updating docker/web-auto.Dockerfile.',
        )

    tmp_dir = tile_dir.with_name(f'{tile_dir.name}.tmp_{new_id()}')
    ensure_dir(tmp_dir)
    output_base = tmp_dir / 'image'
    try:
        subprocess.run(
            [
                'vips',
                'dzsave',
                str(image_path),
                str(output_base),
                '--layout',
                'dz',
                '--tile-size',
                '256',
                '--overlap',
                '1',
                '--suffix',
                '.jpg[Q=90]',
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=300,
        )
        metadata = _read_dzi_metadata(tmp_dir)
        if not metadata:
            raise RuntimeError('failed to read generated DZI metadata')
        if tile_dir.exists():
            shutil.rmtree(tile_dir)
        os.replace(tmp_dir, tile_dir)
        return tile_dir, metadata
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise HTTPException(status_code=500, detail=f'failed to generate image tiles: {detail[:500]}') from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _safe_upload_target(root: Path, filename: str) -> Path:
    base_name = Path(str(filename or '').strip()).name
    if not base_name:
        base_name = f'upload_{new_id()}.jpg'
    suffix = Path(base_name).suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f'unsupported image extension: {suffix or "(empty)"}')

    target = (root / base_name).resolve()
    ensure_dir(target.parent)
    if not target.exists():
        return target

    stem = target.stem
    idx = 1
    while True:
        candidate = target.with_name(f'{stem}_upload{idx}{suffix}')
        if not candidate.exists():
            return candidate
        idx += 1


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


def _safe_dataset_relative_path(relative_path: str, filename: str) -> Path:
    raw = str(relative_path or filename or '').replace('\\', '/').strip().lstrip('/')
    if not raw:
        raw = str(filename or '').replace('\\', '/').strip().lstrip('/')
    if not raw:
        raw = f'upload_{new_id()}'

    parts: list[str] = []
    for part in raw.split('/'):
        if part in {'', '.', '..'}:
            raise HTTPException(status_code=400, detail='invalid relative_path')
        if '\x00' in part:
            raise HTTPException(status_code=400, detail='invalid relative_path')
        parts.append(part)
    return Path(*parts)


def _resolve_output_dir(project: dict[str, Any], output_dir: Optional[str]) -> Path:
    if output_dir and str(output_dir).strip():
        return ensure_dir(Path(str(output_dir)).expanduser().resolve())
    if project.get('project_type') == 'video':
        return ensure_dir(Path(project.get('project_save_dir') or project.get('save_dir')).expanduser().resolve())
    return ensure_dir(Path(project.get('image_dir') or project.get('project_save_dir')).expanduser().resolve())


def _resolve_project_video_file(project: dict[str, Any]) -> Path:
    raw = str(project.get('video_path') or '').strip()
    p = Path(raw).expanduser().resolve() if raw else Path('')
    if raw and p.exists() and p.is_file():
        return p
    if raw and p.exists() and p.is_dir():
        videos = list_video_files_recursive(p)
        if len(videos) == 1:
            return videos[0]
    raise FileNotFoundError(f'video file not found for project: {project.get("id")}')


def _iter_file_range(path: Path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open('rb') as f:
        f.seek(start)
        remaining = (end - start) + 1
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _parse_range_header(range_header: str, file_size: int) -> tuple[int, int]:
    raw = str(range_header or '').strip().lower()
    if not raw.startswith('bytes='):
        raise ValueError('unsupported range unit')
    spec = raw[6:].split(',', 1)[0].strip()
    if '-' not in spec:
        raise ValueError('invalid range syntax')
    start_s, end_s = spec.split('-', 1)
    start_s = start_s.strip()
    end_s = end_s.strip()

    if not start_s:
        if not end_s:
            raise ValueError('invalid suffix range')
        suffix_len = int(end_s)
        if suffix_len <= 0:
            raise ValueError('invalid suffix range')
        if suffix_len >= file_size:
            return 0, max(0, file_size - 1)
        return file_size - suffix_len, file_size - 1

    start = int(start_s)
    end = file_size - 1 if not end_s else int(end_s)
    if start < 0 or end < 0 or start > end:
        raise ValueError('invalid byte range')
    if start >= file_size:
        raise ValueError('range start out of bounds')
    if end >= file_size:
        end = file_size - 1
    return start, end


def _resolve_video_file_from_resource(resource_path: str) -> Path:
    raw = str(resource_path or '').strip()
    p = Path(raw).expanduser().resolve() if raw else Path('')
    if raw and p.exists() and p.is_file():
        return p
    if raw and p.exists() and p.is_dir():
        videos = list_video_files_recursive(p)
        if len(videos) == 1:
            return videos[0]
    raise FileNotFoundError(f'video resource file not found: {resource_path}')


def _is_local_api_base_url(api_base_url: str) -> bool:
    try:
        host = str(urlparse(str(api_base_url or '').strip()).hostname or '').strip().lower()
    except Exception:
        host = ''
    return host in {'127.0.0.1', 'localhost', '0.0.0.0', '::1'}


def _looks_like_windows_local_path(path_text: str) -> bool:
    raw = str(path_text or '').strip()
    if not raw:
        return False
    if re.match(r'^[a-zA-Z]:[\\/]', raw):
        return True
    # UNC path
    if raw.startswith('\\\\'):
        return True
    return False


def _write_video_segment(
    source_video: Path,
    *,
    start_frame: int,
    end_frame: int,
    out_file: Path,
) -> int:
    try:
        import cv2
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError('opencv-python is required for segmented video processing') from exc

    source_video = source_video.expanduser().resolve()
    if not source_video.exists() or not source_video.is_file():
        raise RuntimeError(f'source video not found: {source_video}')
    if end_frame <= start_frame:
        raise RuntimeError(f'invalid segment range: [{start_frame}, {end_frame})')

    cap = cv2.VideoCapture(str(source_video))
    if not cap.isOpened():
        raise RuntimeError(f'failed to open source video: {source_video}')
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 0:
        fps = 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if width <= 0 or height <= 0:
        cap.release()
        raise RuntimeError(f'invalid source video size: {width}x{height}')

    ensure_dir(out_file.parent)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(out_file), fourcc, fps, (width, height))
    if not writer.isOpened():
        cap.release()
        raise RuntimeError(f'failed to open segment writer: {out_file}')

    ok_seek = cap.set(cv2.CAP_PROP_POS_FRAMES, int(start_frame))
    if not ok_seek:
        writer.release()
        cap.release()
        raise RuntimeError(f'failed to seek source video to frame {start_frame}')

    written = 0
    target = int(end_frame - start_frame)
    while written < target:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        writer.write(frame)
        written += 1

    writer.release()
    cap.release()

    if written <= 0:
        raise RuntimeError(f'no frame written for segment [{start_frame}, {end_frame})')
    return written


def _read_video_frame_jpeg(video_path: str, frame_index: int) -> bytes:
    try:
        import cv2
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError('opencv-python is required for video frame decoding') from exc

    path = Path(str(video_path or '')).expanduser().resolve()
    if path.exists() and path.is_dir():
        videos = list_video_files_recursive(path)
        if len(videos) == 1:
            path = videos[0]
    if not path.exists() or not path.is_file():
        raise RuntimeError(f'video file not found: {path}')

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f'failed to open video: {path}')

    idx = max(0, int(frame_index))
    ok_set = cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    if not ok_set:
        cap.release()
        raise RuntimeError(f'failed to seek frame index: {idx}')
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise RuntimeError(f'failed to read frame index: {idx}')
    ok_enc, buf = cv2.imencode('.jpg', frame)
    if not ok_enc:
        raise RuntimeError(f'failed to encode frame index: {idx}')
    return bytes(buf.tobytes())


def _count_running_infer_jobs() -> int:
    with INFER_JOB_LOCK:
        total = 0
        for holder in INFER_JOB_THREADS.values():
            thread = holder.get('thread') if isinstance(holder, dict) else None
            if thread and thread.is_alive():
                total += 1
        return total


def _count_running_smart_filter_jobs() -> int:
    with SMART_FILTER_JOB_LOCK:
        total = 0
        for holder in SMART_FILTER_JOB_THREADS.values():
            thread = holder.get('thread') if isinstance(holder, dict) else None
            if thread and thread.is_alive():
                total += 1
        return total


def _count_running_video_jobs() -> int:
    with VIDEO_JOB_LOCK:
        total = 0
        for holder in VIDEO_JOB_THREADS.values():
            thread = holder.get('thread') if isinstance(holder, dict) else None
            if thread and thread.is_alive():
                total += 1
        return total


def _ensure_no_active_jobs_for_config_change() -> None:
    active = _count_running_infer_jobs() + _count_running_smart_filter_jobs() + _count_running_video_jobs()
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
    configured = str(_read_app_config().get('sam3_api_base_url') or '').strip().rstrip('/')
    if configured:
        return configured
    return DEFAULT_API_BASE_URL


def _ops_headers() -> dict[str, str]:
    headers = {'Accept': 'application/json'}
    if OPS_API_TOKEN:
        headers['Authorization'] = f'Bearer {OPS_API_TOKEN}'
    return headers


def _ops_request(method: str, path: str, payload: Optional[dict[str, Any]] = None, timeout: float = 10.0) -> dict[str, Any]:
    if not OPS_API_BASE_URL:
        raise RuntimeError('ops-api is not configured')
    url = OPS_API_BASE_URL + '/' + path.lstrip('/')
    try:
        response = requests.request(
            method.upper(),
            url,
            json=payload,
            headers=_ops_headers(),
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f'ops-api request failed: {exc}') from exc
    try:
        data = response.json() if response.text else {}
    except Exception:
        data = {'raw': response.text[:400]}
    if not response.ok:
        detail = data.get('detail') if isinstance(data, dict) else None
        raise RuntimeError(f'ops-api HTTP {response.status_code}: {detail or data}')
    return data if isinstance(data, dict) else {}


def _sapiens_headers() -> dict[str, str]:
    headers = {'Accept': 'application/json'}
    if SAPIENS_API_TOKEN:
        headers['Authorization'] = f'Bearer {SAPIENS_API_TOKEN}'
    return headers


def _sapiens_request(method: str, path: str, payload: Optional[dict[str, Any]] = None, timeout: float = 10.0) -> dict[str, Any]:
    base_url = DEFAULT_SAPIENS_API_BASE_URL.rstrip('/')
    url = base_url + '/' + path.lstrip('/')
    try:
        response = requests.request(
            method.upper(),
            url,
            json=payload,
            headers=_sapiens_headers(),
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f'sapiens-api request failed: {exc}') from exc
    try:
        data = response.json() if response.text else {}
    except Exception:
        data = {'raw': response.text[:400]}
    if not response.ok:
        detail = data.get('detail') if isinstance(data, dict) else None
        raise RuntimeError(f'sapiens-api HTTP {response.status_code}: {detail or data}')
    return data if isinstance(data, dict) else {}


def _sapiens_file_request(
    path: str,
    *,
    file_path: Path,
    fields: Optional[dict[str, Any]] = None,
    timeout: float = 300.0,
) -> dict[str, Any]:
    base_url = DEFAULT_SAPIENS_API_BASE_URL.rstrip('/')
    url = base_url + '/' + path.lstrip('/')
    try:
        with file_path.open('rb') as f:
            response = requests.post(
                url,
                files={'file': (file_path.name, f, mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream')},
                data={key: str(value) for key, value in (fields or {}).items()},
                headers=_sapiens_headers(),
                timeout=timeout,
            )
    except requests.RequestException as exc:
        raise RuntimeError(f'sapiens-api request failed: {exc}') from exc
    try:
        data = response.json() if response.text else {}
    except Exception:
        data = {'raw': response.text[:400]}
    if not response.ok:
        detail = data.get('detail') if isinstance(data, dict) else None
        raise RuntimeError(f'sapiens-api HTTP {response.status_code}: {detail or data}')
    return data if isinstance(data, dict) else {}


def _service_management_unavailable(error: str) -> dict[str, Any]:
    return {
        'ok': False,
        'ops_available': False,
        'error': error,
        'services': [
            {'service': 'sam3-api', 'status': 'unknown', 'manage_command': './deploy.sh services restart sam3-api'},
            {'service': 'sapiens-api', 'status': 'unknown', 'manage_command': './deploy.sh sapiens enable'},
            {'service': 'caddy', 'status': 'unknown', 'manage_command': './deploy.sh install --proxy'},
        ],
    }


def _cache_dir_info() -> dict[str, Any]:
    return {
        'cache_dir': str(CURRENT_DATA_DIR),
        'default_dir': str(BASE_DIR),
    }


def _configured_upload_target_dir() -> Path:
    configured = str(_read_app_config().get('upload_target_dir') or '').strip()
    if configured:
        try:
            return _resolve_dataset_upload_dir(configured)
        except HTTPException:
            pass
    try:
        return _resolve_dataset_upload_dir(str(DEFAULT_UPLOAD_TARGET_DIR))
    except HTTPException:
        pass
    return _resolve_dataset_upload_dir(str(HOST_DATA_ROOT))


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
        'sapiens_api_base_url': DEFAULT_SAPIENS_API_BASE_URL,
        'ops_api_configured': bool(OPS_API_BASE_URL),
        'sam3_max_batch_files': SAM3_MAX_BATCH_FILES,
        'auth_enabled': AUTH_ENABLED,
        'session_ttl_seconds': SESSION_TTL_SECONDS,
        'restart_supported': True,
        'restart_note': 'Docker restart policy restarts web-auto after the process exits.',
    }


def _build_video_annotations_payload(project_id: str) -> dict[str, Any]:
    project = _get_project_or_404(project_id, include_images=True)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    images = project.get('images', [])
    all_anns = storage.all_annotations(project_id)
    frames: list[dict[str, Any]] = []
    for idx, img in enumerate(images):
        frame_index = int(img.get('frame_index', idx))
        image_id = str(img.get('id') or '')
        frames.append(
            {
                'frame_index': frame_index,
                'image_id': image_id,
                'file_name': str(img.get('rel_path') or ''),
                'annotations': all_anns.get(image_id, []),
            }
        )
    return {
        'project_id': project.get('id'),
        'project_name': project.get('name'),
        'project_type': 'video',
        'video_name': str(project.get('video_name') or project.get('name') or 'video'),
        'video_path': str(project.get('video_path') or ''),
        'num_frames': len(frames),
        'classes': project.get('classes', []),
        'frames': frames,
        'updated_at': now_ts(),
    }


def _save_video_annotations_payload(payload: VideoAnnotationsSaveIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=True)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')

    images = project.get('images', [])
    by_image_id: dict[str, dict[str, Any]] = {}
    by_frame_index: dict[int, dict[str, Any]] = {}
    for idx, img in enumerate(images):
        image_id = str(img.get('id') or '').strip()
        if image_id:
            by_image_id[image_id] = img
        by_frame_index[int(img.get('frame_index', idx))] = img

    touched: set[str] = set()
    saved_frames = 0
    for frame in payload.frames:
        if not isinstance(frame, dict):
            continue
        image_id = str(frame.get('image_id') or '').strip()
        target = by_image_id.get(image_id) if image_id else None
        if target is None:
            try:
                idx = int(frame.get('frame_index'))
            except Exception:
                idx = -1
            target = by_frame_index.get(idx)
        if target is None:
            continue
        target_image_id = str(target.get('id') or '').strip()
        anns = frame.get('annotations', [])
        storage.save_annotations(payload.project_id, target_image_id, anns if isinstance(anns, list) else [])
        touched.add(target_image_id)
        saved_frames += 1

    if payload.replace_all:
        for img in images:
            image_id = str(img.get('id') or '').strip()
            if image_id and image_id not in touched:
                storage.save_annotations(payload.project_id, image_id, [])

    _write_video_default_json(payload.project_id)
    out = _build_video_annotations_payload(payload.project_id)
    out['saved_frames'] = saved_frames
    out['replace_all'] = bool(payload.replace_all)
    return out


def _video_default_state(project: dict[str, Any]) -> dict[str, Any]:
    total = len(project.get('images', []))
    return {
        'project_id': project.get('id'),
        'status': 'idle',
        'mode': 'keyframe',
        'classes': project.get('classes', []),
        'active_class': '',
        'prompt_mode': 'text',
        'prompt_frame_index': 0,
        'prompt_points': [],
        'prompt_boxes': [],
        'api_base_url': DEFAULT_API_BASE_URL,
        'resource_path': str(project.get('video_path') or project.get('image_dir') or ''),
        'session_id': '',
        'prompt_added': False,
        'threshold': 0.5,
        'imgsz': 640,
        'segment_size_frames': 300,
        'start_frame_index': 0,
        'end_frame_index': max(total - 1, 0),
        'next_frame_index': 0,
        'current_frame_index': -1,
        'processed_frames': 0,
        'total_frames': total,
        'progress_pct': 0.0,
        'elapsed_ms': 0.0,
        'avg_frame_ms': 0.0,
        'fps': 0.0,
        'started_at': '',
        'updated_at': now_ts(),
        'ended_at': '',
        'last_error': '',
    }


def _get_video_state(project_id: str) -> dict[str, Any]:
    project = _get_project_or_404(project_id, include_images=False)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    state = storage.get_video_job_state(project_id)
    if not state:
        state = _video_default_state(project)
    state['running'] = _is_video_job_running(project_id)
    return state


def _is_video_job_running(project_id: str) -> bool:
    with VIDEO_JOB_LOCK:
        holder = VIDEO_JOB_THREADS.get(project_id)
        if not holder:
            return False
        thread = holder.get('thread')
        if not thread or not thread.is_alive():
            VIDEO_JOB_THREADS.pop(project_id, None)
            return False
        return True


def _spawn_video_worker(project_id: str) -> None:
    with VIDEO_JOB_LOCK:
        holder = VIDEO_JOB_THREADS.get(project_id)
        if holder:
            thread = holder.get('thread')
            if thread and thread.is_alive():
                # A short-lived stale window can exist after job state switches to done/error/paused
                # but before the worker thread has fully exited and unregistered itself.
                state = storage.get_video_job_state(project_id)
                status = str(state.get('status') or '').strip().lower() if isinstance(state, dict) else ''
                if status in {'done', 'error', 'paused', 'idle'}:
                    thread.join(timeout=1.2)
                if thread.is_alive():
                    raise RuntimeError('video job is already running')
            VIDEO_JOB_THREADS.pop(project_id, None)
        stop_event = threading.Event()
        thread = threading.Thread(target=_video_job_worker, args=(project_id, stop_event), daemon=True)
        VIDEO_JOB_THREADS[project_id] = {'thread': thread, 'stop_event': stop_event}
        thread.start()


def _pause_video_worker(project_id: str) -> bool:
    with VIDEO_JOB_LOCK:
        holder = VIDEO_JOB_THREADS.get(project_id)
        if not holder:
            return False
        ev = holder.get('stop_event')
        if not ev:
            return False
        ev.set()
        return True


def _write_video_default_json(project_id: str) -> None:
    project = storage.get_project(project_id, include_images=True)
    if not project or project.get('project_type') != 'video':
        return
    images = project.get('images', [])
    all_anns = storage.all_annotations(project_id)
    output_dir = Path(project.get('project_save_dir') or project.get('save_dir')).expanduser().resolve()
    export_video_json(project=project, images=images, all_annotations=all_anns, output_dir=output_dir)


def _normalize_segment_size(raw: Any) -> int:
    try:
        value = int(raw)
    except Exception:
        raise RuntimeError('segment_size_frames must be a positive integer')
    if value <= 0:
        raise RuntimeError('segment_size_frames must be a positive integer')
    return value


def _normalize_prompt_points(raw: Any) -> list[list[float]]:
    out: list[list[float]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        try:
            x = float(item[0])
            y = float(item[1])
            label = 0.0 if (len(item) > 2 and int(item[2]) == 0) else 1.0
            out.append([x, y, label])
        except Exception:
            continue
    return out


def _normalize_prompt_boxes(raw: Any) -> list[list[float]]:
    out: list[list[float]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 4:
            continue
        try:
            x1 = float(item[0])
            y1 = float(item[1])
            x2 = float(item[2])
            y2 = float(item[3])
            if x2 <= x1 or y2 <= y1:
                continue
            label = 0.0 if (len(item) > 4 and int(item[4]) == 0) else 1.0
            out.append([x1, y1, x2, y2, label])
        except Exception:
            continue
    return out


def _box_center_point(box: list[float], label: float) -> list[float]:
    x1, y1, x2, y2 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
    return [float((x1 + x2) / 2.0), float((y1 + y2) / 2.0), float(label)]


def _prepare_video_box_prompt(
    prompt_points: list[list[float]],
    prompt_boxes: list[list[float]],
) -> tuple[list[list[float]], list[list[float]], str]:
    """Keep one positive box as the semantic video seed prompt."""
    del prompt_points
    positives = [b for b in prompt_boxes if len(b) >= 5 and int(b[4]) != 0]
    notes: list[str] = []

    if not positives:
        raise RuntimeError('boxes prompt requires at least one positive box')

    out_boxes = [positives[0]]
    out_points: list[list[float]] = []

    if len(positives) > 1:
        notes.append(f'positive_boxes={len(positives)} -> keep first box only')

    return out_points, out_boxes, '; '.join(notes)


def _valid_xyxy(bbox: Any) -> list[float]:
    if not isinstance(bbox, list) or len(bbox) != 4:
        return []
    try:
        x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    except Exception:
        return []
    if x2 <= x1 or y2 <= y1:
        return []
    return [x1, y1, x2, y2]


def _carry_prompt_from_frame(
    *,
    project_id: str,
    images: list[dict[str, Any]],
    frame_index: int,
) -> tuple[list[list[float]], list[list[float]], str]:
    """Build a carry prompt from an already-annotated frame using the first bbox only."""
    if frame_index < 0 or frame_index >= len(images):
        return [], [], ''
    image_id = str(images[frame_index].get('id') or '').strip()
    if not image_id:
        return [], [], ''

    anns = storage.load_annotations(project_id, image_id)
    if not isinstance(anns, list) or not anns:
        return [], [], ''

    points: list[list[float]] = []
    boxes: list[list[float]] = []
    for ann in anns:
        if not isinstance(ann, dict):
            continue
        bbox = _valid_xyxy(ann.get('bbox'))
        if not bbox:
            bbox = _bbox_from_polygon(ann.get('polygon') or [])
            bbox = _valid_xyxy(bbox)
        if not bbox:
            continue
        if not boxes:
            boxes.append([bbox[0], bbox[1], bbox[2], bbox[3], 1.0])
            break
    note = f'carry_from_frame={frame_index}, carry_boxes={len(boxes)}, carry_points=0'
    return points, boxes, note


def _transcode_video_h264_inplace(video_path: Path) -> dict[str, Any]:
    ffmpeg_bin = shutil.which('ffmpeg')
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg not found in PATH, please install ffmpeg first')

    src = video_path.expanduser().resolve()
    if not src.exists() or not src.is_file():
        raise RuntimeError(f'video file not found: {src}')

    tmp = src.with_name(f'{src.stem}.h264_tmp{src.suffix}')
    if tmp.exists():
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

    cmd = [
        ffmpeg_bin,
        '-y',
        '-i',
        str(src),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'medium',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not tmp.exists():
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        err = (proc.stderr or proc.stdout or '').strip()
        raise RuntimeError(f'ffmpeg transcode failed: {err[-800:] if err else "unknown error"}')

    try:
        os.replace(str(tmp), str(src))
    except Exception as exc:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise RuntimeError(f'replace original video failed: {exc}') from exc

    return {'video_path': str(src), 'size_bytes': int(src.stat().st_size)}


def _video_job_worker(project_id: str, stop_event: threading.Event) -> None:
    logger.info('video job worker start project=%s', project_id)
    session_id = ''
    try:
        project = _get_project_or_404(project_id)
        if project.get('project_type') != 'video':
            raise RuntimeError('project is not video type')

        images = project.get('images', [])
        total = len(images)
        if total <= 0:
            raise RuntimeError('video project has no frames')

        state = storage.get_video_job_state(project_id)
        if not isinstance(state, dict) or not state:
            state = _video_default_state(project)

        mode = str(state.get('mode') or 'keyframe').strip().lower()
        if mode not in {'keyframe', 'per_frame'}:
            mode = 'keyframe'

        classes = [str(c).strip() for c in state.get('classes', []) if str(c).strip()]
        if not classes:
            classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]
        if not classes:
            raise RuntimeError('no classes selected for video inference')
        prompt_mode = str(state.get('prompt_mode') or 'text').strip().lower()
        if prompt_mode not in {'text', 'boxes'}:
            prompt_mode = 'text'
        active_class = str(state.get('active_class') or '').strip()
        prompt_points = _normalize_prompt_points(state.get('prompt_points', []))
        prompt_boxes = _normalize_prompt_boxes(state.get('prompt_boxes', []))
        prepared_prompt_points = list(prompt_points)
        prepared_prompt_boxes = list(prompt_boxes)
        prompt_note = ''

        api_base_url = str(state.get('api_base_url') or DEFAULT_API_BASE_URL).strip()
        threshold = float(state.get('threshold') or 0.5)
        imgsz = max(128, int(state.get('imgsz') or 640))
        resource_path = str(state.get('resource_path') or project.get('video_path') or project.get('image_dir') or '').strip()
        if not resource_path:
            raise RuntimeError('video resource_path is empty')

        start_idx = int(state.get('start_frame_index', 0))
        start_idx = max(0, min(start_idx, total - 1))
        end_idx = int(state.get('end_frame_index', total - 1))
        end_idx = max(start_idx, min(end_idx, total - 1))
        prompt_frame_idx = int(state.get('prompt_frame_index', start_idx))
        prompt_frame_idx = max(start_idx, min(prompt_frame_idx, end_idx))
        if prompt_mode == 'boxes':
            if not prompt_boxes:
                raise RuntimeError('boxes prompt is empty')
            prepared_prompt_points, prepared_prompt_boxes, prompt_note = _prepare_video_box_prompt(
                prompt_points,
                prompt_boxes,
            )
            if active_class:
                classes = [active_class]
            start_idx = max(start_idx, prompt_frame_idx)
        stop_idx = end_idx + 1
        target_total = max(stop_idx - start_idx, 1)

        next_idx = int(state.get('next_frame_index', start_idx))
        next_idx = max(start_idx, min(next_idx, stop_idx))

        processed = int(state.get('processed_frames', 0))
        sum_frame_ms = float(state.get('sum_frame_ms', 0.0))
        session_id = str(state.get('session_id') or '').strip()
        prompt_added = bool(state.get('prompt_added', False))

        started_at = str(state.get('started_at') or now_ts())
        worker_start = time.perf_counter()

        state.update(
            {
                'project_id': project_id,
                'status': 'running',
                'mode': mode,
                'classes': classes,
                'active_class': active_class,
                'prompt_mode': prompt_mode,
                'prompt_frame_index': prompt_frame_idx,
                'prompt_points': prepared_prompt_points,
                'prompt_boxes': prepared_prompt_boxes,
                'prompt_note': prompt_note,
                'api_base_url': api_base_url,
                'resource_path': resource_path,
                'threshold': threshold,
                'imgsz': imgsz,
                'start_frame_index': start_idx,
                'end_frame_index': end_idx,
                'next_frame_index': next_idx,
                'total_frames': target_total,
                'started_at': started_at,
                'updated_at': now_ts(),
                'last_error': '',
            }
        )
        storage.set_video_job_state(project_id, state)

        # Segmented processing is default for text mode.
        # For visual mode (points/boxes), one continuous session is preferred, but when
        # API is remote and resource path is a local Windows path, full-video upload
        # may OOM; then force segmented mode to keep memory bounded.
        segment_size = _normalize_segment_size(state.get('segment_size_frames'))
        force_segmented_visual = (
            prompt_mode == 'boxes'
            and (not _is_local_api_base_url(api_base_url))
            and _looks_like_windows_local_path(resource_path)
        )
        use_segmented = (prompt_mode == 'text') or force_segmented_visual
        state['segmented'] = bool(use_segmented)
        state['segment_size_frames'] = segment_size
        if force_segmented_visual:
            reason = 'forced_segmented=remote_api_with_local_windows_path'
            prev_note = str(state.get('prompt_note') or '').strip()
            state['prompt_note'] = f'{prev_note}; {reason}' if prev_note else reason
            logger.info(
                'video job project=%s forcing segmented mode for visual prompt to avoid full upload OOM',
                project_id,
            )
        storage.set_video_job_state(project_id, state)
        logger.info(
            'video job config project=%s prompt=%s prompt_frame=%s range=[%s,%s] segment_size=%s segmented=%s',
            project_id,
            prompt_mode,
            prompt_frame_idx,
            start_idx,
            end_idx,
            segment_size,
            use_segmented,
        )
        if use_segmented:
            source_video = _resolve_video_file_from_resource(resource_path)
            segments_dir = ensure_dir(Path(project.get('workspace_dir') or CURRENT_DATA_DIR) / 'cache' / 'video_segments')

            while next_idx < stop_idx:
                if stop_event.is_set():
                    state.update(
                        {
                            'status': 'paused',
                            'session_id': '',
                            'prompt_added': False,
                            'next_frame_index': next_idx,
                            'updated_at': now_ts(),
                        }
                    )
                    storage.set_video_job_state(project_id, state)
                    _write_video_default_json(project_id)
                    logger.info('video job paused project=%s at frame=%s', project_id, next_idx)
                    return

                seg_start = int(next_idx)
                seg_end = int(min(stop_idx, seg_start + segment_size))
                logger.info(
                    'video segment project=%s segment=[%s,%s] len=%s',
                    project_id,
                    seg_start,
                    seg_end - 1,
                    max(seg_end - seg_start, 0),
                )
                seg_file = segments_dir / f'{project_id}_{seg_start:06d}_{seg_end-1:06d}.mp4'
                segment_session = ''
                try:
                    written = _write_video_segment(
                        source_video,
                        start_frame=seg_start,
                        end_frame=seg_end,
                        out_file=seg_file,
                    )
                    seg_len = int(written)
                    local_next = 0
                    add_local_idx = 0
                    add_text = ', '.join(classes)
                    add_points: list[list[float]] | None = None
                    add_boxes: list[list[float]] | None = None
                    seg_prompt_note = ''
                    if prompt_mode == 'boxes':
                        # Visual interactive mode: use geometric box prompts only.
                        # Do not send text together with box prompts.
                        add_text = ''
                        if seg_start <= prompt_frame_idx < seg_end:
                            add_local_idx = int(prompt_frame_idx - seg_start)
                            add_boxes = prepared_prompt_boxes
                            seg_prompt_note = f'user_prompt_frame={prompt_frame_idx}'
                        else:
                            add_local_idx = 0
                            # Cross-segment carry: search backward for the latest annotated frame.
                            # If no visual carry found, fallback to text prompt for this segment
                            # instead of filling the whole segment with empty outputs.
                            found_carry = False
                            carry_from = -1
                            seek_start = max(seg_start - 1, start_idx)
                            for seek_idx in range(seek_start, start_idx - 1, -1):
                                carry_points, carry_boxes, carry_note = _carry_prompt_from_frame(
                                    project_id=project_id,
                                    images=images,
                                    frame_index=seek_idx,
                                )
                                if carry_boxes:
                                    add_boxes = carry_boxes if carry_boxes else None
                                    seg_prompt_note = carry_note
                                    found_carry = True
                                    carry_from = seek_idx
                                    break

                            if found_carry:
                                logger.info(
                                    'video segment project=%s reuse carry prompt from frame=%s for segment=[%s,%s]',
                                    project_id,
                                    carry_from,
                                    seg_start,
                                    seg_end - 1,
                                )
                            else:
                                add_boxes = None
                                add_text = ', '.join(classes)
                                seg_prompt_note = f'no_carry_prompt; fallback=text@segment_start={seg_start}'
                                logger.warning(
                                    'video segment project=%s no carry prompt; fallback to text prompt for segment=[%s,%s]',
                                    project_id,
                                    seg_start,
                                    seg_end - 1,
                                )

                    start_resp = sam3.video_start_session_upload(
                        api_base_url=api_base_url,
                        video_path=str(seg_file),
                        threshold=threshold,
                        imgsz=imgsz,
                    )
                    segment_session = str(start_resp.get('session_id') or '').strip()
                    if not segment_session:
                        raise RuntimeError('segmented start_session_upload returned empty session_id')

                    add_resp = sam3.video_add_prompt(
                        api_base_url=api_base_url,
                        session_id=segment_session,
                        frame_index=add_local_idx,
                        text=add_text,
                        points=None,
                        boxes=add_boxes,
                        obj_id=1 if add_boxes else None,
                        include_mask_png=True,
                        max_detections=200,
                    )
                    add_dets = add_resp.get('detections', [])
                    add_dets = add_dets if isinstance(add_dets, list) else []
                    logger.info(
                        'video segment project=%s add_prompt frame=%s dets=%s prompt=%s',
                        project_id,
                        seg_start + add_local_idx,
                        len(add_dets),
                        prompt_mode,
                    )
                    forced = classes[0] if len(classes) == 1 else ''
                    converted0 = _convert_detections(detections=add_dets, classes=classes, forced_class=forced)
                    prompt_global_idx = int(seg_start + add_local_idx)
                    local_next = max(local_next, add_local_idx + 1)
                    if start_idx <= prompt_global_idx < stop_idx:
                        image0 = images[prompt_global_idx]
                        storage.save_annotations(project_id, str(image0.get('id') or ''), converted0)
                        next_idx = max(next_idx, prompt_global_idx + 1)
                        processed += 1

                    if local_next < seg_len:
                        if stop_event.is_set():
                            state.update(
                                {
                                    'status': 'paused',
                                    'next_frame_index': next_idx,
                                    'session_id': '',
                                    'prompt_added': False,
                                    'updated_at': now_ts(),
                                }
                            )
                            storage.set_video_job_state(project_id, state)
                            _write_video_default_json(project_id)
                            logger.info('video job paused project=%s at frame=%s', project_id, next_idx)
                            return

                        frame_t0 = time.perf_counter()
                        prop = sam3.video_propagate(
                            api_base_url=api_base_url,
                            session_id=segment_session,
                            propagation_direction='forward',
                            start_frame_index=local_next,
                            max_frame_num_to_track=max(1, int(seg_len - local_next)),
                            include_mask_png=True,
                            max_detections=200,
                            max_frames=0,
                        )
                        frames = prop.get('frames', [])
                        frames = frames if isinstance(frames, list) else []
                        if frames:
                            logger.info(
                                'video segment project=%s propagate returned frames=%s first=%s last=%s',
                                project_id,
                                len(frames),
                                int(frames[0].get('frame_index', -1)),
                                int(frames[-1].get('frame_index', -1)),
                            )
                        else:
                            logger.warning(
                                'video segment project=%s propagate returned no frames for segment=[%s,%s]',
                                project_id,
                                seg_start,
                                seg_end - 1,
                            )
                        seen_local: set[int] = set()
                        non_empty_frames = 0

                        for fr in frames:
                            local_idx = int(fr.get('frame_index', -1))
                            if local_idx < local_next or local_idx >= seg_len:
                                continue
                            global_idx = seg_start + local_idx
                            if global_idx < start_idx or global_idx >= stop_idx:
                                continue
                            dets = fr.get('detections', [])
                            dets = dets if isinstance(dets, list) else []
                            if dets:
                                non_empty_frames += 1
                            forced = classes[0] if len(classes) == 1 else ''
                            converted = _convert_detections(detections=dets, classes=classes, forced_class=forced)
                            image = images[global_idx]
                            storage.save_annotations(project_id, str(image.get('id') or ''), converted)
                            seen_local.add(local_idx)
                            next_idx = max(next_idx, global_idx + 1)
                            processed += 1
                            state['current_frame_index'] = global_idx
                        logger.info(
                            'video segment project=%s propagate non_empty_frames=%s/%s',
                            project_id,
                            non_empty_frames,
                            max(len(frames), 0),
                        )

                        # Keep frame coverage deterministic even when upstream returns sparse frames.
                        for local_idx in range(local_next, seg_len):
                            if local_idx in seen_local:
                                continue
                            global_idx = seg_start + local_idx
                            if global_idx < start_idx or global_idx >= stop_idx:
                                continue
                            image = images[global_idx]
                            storage.save_annotations(project_id, str(image.get('id') or ''), [])
                            next_idx = max(next_idx, global_idx + 1)
                            processed += 1
                            state['current_frame_index'] = global_idx

                        frame_ms = (time.perf_counter() - frame_t0) * 1000.0
                        sum_frame_ms += frame_ms
                        elapsed_ms = (time.perf_counter() - worker_start) * 1000.0
                        avg_frame_ms = sum_frame_ms / max(processed, 1)
                        fps = 1000.0 / avg_frame_ms if avg_frame_ms > 0 else 0.0
                        progressed = max(0, min(next_idx, stop_idx) - start_idx)
                        progress_pct = float(progressed * 100.0 / max(target_total, 1))
                        state.update(
                            {
                                'status': 'running',
                                'next_frame_index': next_idx,
                                'processed_frames': processed,
                                'progress_pct': progress_pct,
                                'elapsed_ms': elapsed_ms,
                                'avg_frame_ms': avg_frame_ms,
                                'fps': fps,
                                'sum_frame_ms': sum_frame_ms,
                                'prompt_note': seg_prompt_note or state.get('prompt_note', ''),
                                'updated_at': now_ts(),
                            }
                        )
                        storage.set_video_job_state(project_id, state)
                finally:
                    if segment_session:
                        try:
                            sam3.video_close_session(api_base_url=api_base_url, session_id=segment_session)
                        except Exception:
                            pass
                    try:
                        seg_file.unlink(missing_ok=True)
                    except Exception:
                        pass

            state.update(
                {
                    'status': 'done',
                    'current_frame_index': end_idx,
                    'next_frame_index': stop_idx,
                    'processed_frames': processed,
                    'progress_pct': 100.0,
                    'elapsed_ms': (time.perf_counter() - worker_start) * 1000.0,
                    'avg_frame_ms': sum_frame_ms / max(processed, 1) if processed > 0 else 0.0,
                    'fps': (1000.0 * processed / max(sum_frame_ms, 1e-6)) if processed > 0 else 0.0,
                    'session_id': '',
                    'prompt_added': False,
                    'ended_at': now_ts(),
                    'updated_at': now_ts(),
                }
            )
            storage.set_video_job_state(project_id, state)
            _write_video_default_json(project_id)
            logger.info('video job done (segmented) project=%s processed=%s', project_id, processed)
            return

        # Resume existing remote session if possible, otherwise create a new one.
        resume_target_idx = int(next_idx)
        if session_id:
            try:
                sam3.video_get_session(api_base_url=api_base_url, session_id=session_id)
            except Exception:
                session_id = ''
                prompt_added = False
        if not session_id:
            try:
                start_resp = sam3.video_start_session(
                    api_base_url=api_base_url,
                    resource_path=resource_path,
                    threshold=threshold,
                    imgsz=imgsz,
                )
            except Exception as exc:
                # Cross-machine fallback: if remote server cannot access local path,
                # upload the local video file to sam3-api and start session from uploaded file.
                err_text = str(exc)
                local_path = Path(resource_path).expanduser()
                if 'resource_path does not exist' in err_text and local_path.exists() and local_path.is_file():
                    logger.info('video start_session path is not accessible remotely, fallback to upload: %s', resource_path)
                    start_resp = sam3.video_start_session_upload(
                        api_base_url=api_base_url,
                        video_path=str(local_path.resolve()),
                        threshold=threshold,
                        imgsz=imgsz,
                    )
                else:
                    raise
            session_id = str(start_resp.get('session_id') or '').strip()
            if not session_id:
                raise RuntimeError('video session start returned empty session_id')
            prompt_added = False
            state.update(
                {
                    'session_id': session_id,
                    'prompt_added': False,
                    'updated_at': now_ts(),
                }
            )
            storage.set_video_job_state(project_id, state)

        # Add initial prompt at keyframe, then propagate frame-by-frame for responsive UI updates.
        if not prompt_added:
            add_text = ', '.join(classes)
            add_points: list[list[float]] | None = None
            add_boxes: list[list[float]] | None = None
            add_frame_idx = start_idx
            if prompt_mode == 'boxes':
                # Visual interactive mode: use geometric box prompts only.
                # Do not send text together with box prompts.
                add_text = ''
                add_frame_idx = prompt_frame_idx
                add_boxes = prepared_prompt_boxes
            add_resp = sam3.video_add_prompt(
                api_base_url=api_base_url,
                session_id=session_id,
                frame_index=add_frame_idx,
                text=add_text,
                points=None,
                boxes=add_boxes,
                obj_id=1 if add_boxes else None,
                include_mask_png=True,
                max_detections=200,
            )
            add_dets = add_resp.get('detections', [])
            add_dets = add_dets if isinstance(add_dets, list) else []
            logger.info(
                'video job project=%s add_prompt frame=%s dets=%s prompt=%s',
                project_id,
                add_frame_idx,
                len(add_dets),
                prompt_mode,
            )
            forced = classes[0] if len(classes) == 1 else ''
            converted_start = _convert_detections(detections=add_dets, classes=classes, forced_class=forced)
            start_image = images[add_frame_idx]
            storage.save_annotations(project_id, str(start_image.get('id') or ''), converted_start)

            next_idx = max(next_idx, add_frame_idx + 1)
            processed = max(processed, 1 if converted_start else 0)
            state.update(
                {
                    'session_id': session_id,
                    'prompt_added': True,
                    'current_frame_index': add_frame_idx,
                    'next_frame_index': next_idx,
                    'processed_frames': processed,
                    'progress_pct': float(max(0, min(next_idx, stop_idx) - start_idx) * 100.0 / max(target_total, 1)),
                    'updated_at': now_ts(),
                }
            )
            storage.set_video_job_state(project_id, state)

            rebuild_from_idx = int(add_frame_idx + 1)
            rebuild_stop_idx = int(max(rebuild_from_idx, min(resume_target_idx, stop_idx)))
            if rebuild_stop_idx > rebuild_from_idx:
                logger.info(
                    'video job project=%s rebuilding remote session frames=[%s,%s] before continue',
                    project_id,
                    rebuild_from_idx,
                    rebuild_stop_idx - 1,
                )
                while rebuild_from_idx < rebuild_stop_idx:
                    if stop_event.is_set():
                        state.update(
                            {
                                'status': 'paused',
                                'session_id': session_id,
                                'prompt_added': True,
                                'next_frame_index': next_idx,
                                'updated_at': now_ts(),
                            }
                        )
                        storage.set_video_job_state(project_id, state)
                        _write_video_default_json(project_id)
                        logger.info('video job paused project=%s during rebuild at frame=%s', project_id, next_idx)
                        return

                    rebuild_len = max(1, int(min(segment_size, rebuild_stop_idx - rebuild_from_idx)))
                    sam3.video_propagate(
                        api_base_url=api_base_url,
                        session_id=session_id,
                        propagation_direction='forward',
                        start_frame_index=rebuild_from_idx,
                        max_frame_num_to_track=rebuild_len,
                        include_mask_png=False,
                        max_detections=0,
                        max_frames=0,
                    )
                    rebuild_from_idx += rebuild_len
                state.update(
                    {
                        'session_id': session_id,
                        'prompt_added': True,
                        'next_frame_index': next_idx,
                        'updated_at': now_ts(),
                    }
                )
                storage.set_video_job_state(project_id, state)

        while next_idx < stop_idx:
            if stop_event.is_set():
                state.update(
                    {
                        'status': 'paused',
                        'session_id': session_id,
                        'prompt_added': True,
                        'next_frame_index': next_idx,
                        'updated_at': now_ts(),
                    }
                )
                storage.set_video_job_state(project_id, state)
                _write_video_default_json(project_id)
                logger.info('video job paused project=%s at frame=%s', project_id, next_idx)
                return

            frame_t0 = time.perf_counter()
            batch_start = int(next_idx)
            batch_len = max(1, int(min(segment_size, stop_idx - batch_start)))
            prop = sam3.video_propagate(
                api_base_url=api_base_url,
                session_id=session_id,
                propagation_direction='forward',
                start_frame_index=batch_start,
                max_frame_num_to_track=batch_len,
                include_mask_png=True,
                max_detections=200,
                max_frames=0,
            )
            frames = prop.get('frames', [])
            frames = frames if isinstance(frames, list) else []
            if frames:
                logger.info(
                    'video job project=%s propagate returned frames=%s first=%s last=%s',
                    project_id,
                    len(frames),
                    int(frames[0].get('frame_index', -1)),
                    int(frames[-1].get('frame_index', -1)),
                )
            else:
                logger.warning(
                    'video job project=%s propagate returned no frames at batch_start=%s batch_len=%s',
                    project_id,
                    batch_start,
                    batch_len,
                )
            seen_idx: set[int] = set()
            non_empty_frames = 0
            for fr in frames:
                idx = int(fr.get('frame_index', -1))
                if idx < batch_start or idx >= (batch_start + batch_len):
                    continue
                dets = fr.get('detections', [])
                dets = dets if isinstance(dets, list) else []
                if dets:
                    non_empty_frames += 1
                forced = classes[0] if len(classes) == 1 else ''
                converted = _convert_detections(detections=dets, classes=classes, forced_class=forced)
                image = images[idx]
                image_id = str(image.get('id') or '')
                # Session propagation returns full-frame outputs; overwrite this frame.
                storage.save_annotations(project_id, image_id, converted)
                seen_idx.add(idx)
                next_idx = max(next_idx, idx + 1)
                processed += 1
                state['current_frame_index'] = idx
            logger.info(
                'video job project=%s propagate non_empty_frames=%s/%s batch=[%s,%s]',
                project_id,
                non_empty_frames,
                max(len(frames), 0),
                batch_start,
                batch_start + batch_len - 1,
            )

            for idx in range(batch_start, batch_start + batch_len):
                if idx in seen_idx or idx < start_idx or idx >= stop_idx:
                    continue
                image = images[idx]
                image_id = str(image.get('id') or '')
                storage.save_annotations(project_id, image_id, [])
                next_idx = max(next_idx, idx + 1)
                processed += 1
                state['current_frame_index'] = idx

            frame_ms = (time.perf_counter() - frame_t0) * 1000.0
            sum_frame_ms += frame_ms
            elapsed_ms = (time.perf_counter() - worker_start) * 1000.0
            avg_frame_ms = sum_frame_ms / max(processed, 1)
            fps = 1000.0 / avg_frame_ms if avg_frame_ms > 0 else 0.0
            progress_pct = float(max(0, min(next_idx, stop_idx) - start_idx) * 100.0 / max(target_total, 1))

            state.update(
                {
                    'status': 'running',
                    'session_id': session_id,
                    'prompt_added': True,
                    'next_frame_index': next_idx,
                    'processed_frames': processed,
                    'progress_pct': progress_pct,
                    'elapsed_ms': elapsed_ms,
                    'avg_frame_ms': avg_frame_ms,
                    'fps': fps,
                    'sum_frame_ms': sum_frame_ms,
                    'updated_at': now_ts(),
                }
            )
            storage.set_video_job_state(project_id, state)

        try:
            if session_id:
                sam3.video_close_session(api_base_url=api_base_url, session_id=session_id)
        except Exception:
            pass

        state.update(
            {
                'status': 'done',
                'current_frame_index': end_idx,
                'next_frame_index': stop_idx,
                'processed_frames': processed,
                'progress_pct': 100.0,
                'elapsed_ms': (time.perf_counter() - worker_start) * 1000.0,
                'avg_frame_ms': sum_frame_ms / max(processed, 1) if processed > 0 else 0.0,
                'fps': (1000.0 * processed / max(sum_frame_ms, 1e-6)) if processed > 0 else 0.0,
                'session_id': '',
                'prompt_added': False,
                'ended_at': now_ts(),
                'updated_at': now_ts(),
            }
        )
        storage.set_video_job_state(project_id, state)
        _write_video_default_json(project_id)
        logger.info('video job done project=%s processed=%s', project_id, processed)
    except Exception as exc:  # noqa: BLE001
        logger.exception('video job failed project=%s', project_id)
        try:
            if session_id:
                current_state = storage.get_video_job_state(project_id)
                api_url = str(current_state.get('api_base_url') or DEFAULT_API_BASE_URL) if isinstance(current_state, dict) else DEFAULT_API_BASE_URL
                sam3.video_close_session(api_base_url=api_url, session_id=session_id)
        except Exception:
            pass
        try:
            state = storage.get_video_job_state(project_id)
            if not isinstance(state, dict) or not state:
                project = storage.get_project(project_id, include_images=False)
                if project and project.get('project_type') == 'video':
                    state = _video_default_state(project)
                else:
                    state = {}
            if state:
                state.update({'status': 'error', 'last_error': str(exc), 'session_id': '', 'prompt_added': False, 'updated_at': now_ts()})
                storage.set_video_job_state(project_id, state)
        except Exception:
            pass
    finally:
        with VIDEO_JOB_LOCK:
            holder = VIDEO_JOB_THREADS.get(project_id)
            if holder and holder.get('stop_event') is stop_event:
                VIDEO_JOB_THREADS.pop(project_id, None)


def _recover_video_states_on_startup() -> None:
    try:
        projects = storage.list_projects()
    except Exception:
        return
    for p in projects:
        if p.get('project_type') != 'video':
            continue
        pid = str(p.get('id') or '')
        if not pid:
            continue
        state = storage.get_video_job_state(pid)
        if not state:
            continue
        status = str(state.get('status') or '').lower()
        if status in {'running', 'pausing'}:
            state['status'] = 'paused'
            state['updated_at'] = now_ts()
            state['last_error'] = 'service restarted; job paused and can be resumed'
            storage.set_video_job_state(pid, state)


def _infer_single(
    *,
    project: dict[str, Any],
    image: dict[str, Any],
    mode: str,
    classes: list[str],
    active_class: str,
    points: list[list[float | int]],
    boxes: list[list[float | int]],
    threshold: float,
    api_base_url: str,
    save_result: bool = True,
) -> dict[str, Any]:
    final_classes = [str(c).strip() for c in classes if str(c).strip()]
    if not final_classes:
        final_classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]

    infer_mode = str(mode).strip().lower()
    visual_scope = ''
    if infer_mode == 'text':
        if not final_classes:
            raise HTTPException(status_code=400, detail='no classes selected')
        prompt = ', '.join(final_classes)
        forced_class = ''
        impacted_classes = final_classes
        infer_points = []
        infer_boxes = []
    elif infer_mode == 'points':
        if not points:
            raise HTTPException(status_code=400, detail='points mode requires points')
        if not _has_positive_visual_prompt(points, []):
            raise HTTPException(status_code=400, detail='points mode requires at least one positive prompt')
        active_hint = str(active_class).strip()
        # Points mode should not leak API placeholder labels like "visual".
        # Use active class when provided, otherwise fallback to "unknown".
        forced_class = active_hint or 'unknown'
        # Keep points mode as pure visual interactive correction (no text prompt).
        prompt = ''
        impacted_classes = []
        visual_scope = 'local'
        infer_points = points
        infer_boxes = []
    elif infer_mode == 'boxes':
        if not boxes:
            raise HTTPException(status_code=400, detail='boxes mode requires boxes')
        if not _has_positive_visual_prompt([], boxes):
            raise HTTPException(status_code=400, detail='boxes mode requires at least one positive prompt')
        active_hint = str(active_class).strip()
        forced_class = active_hint or 'unknown'
        # Boxes mode is pure visual correction only.
        # Semantic/example segmentation uses dedicated example endpoints.
        prompt = ''
        impacted_classes = []
        visual_scope = 'local'
        infer_points = []
        infer_boxes = boxes
    else:
        raise HTTPException(status_code=400, detail='mode must be text/points/boxes')

    def _run_once(*, point_box_size: float | None = None, threshold_value: float | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        result_local = sam3.infer(
            api_base_url=api_base_url,
            image_path=str(image.get('abs_path') or ''),
            mode=infer_mode,
            prompt=prompt,
            threshold=float(threshold if threshold_value is None else threshold_value),
            points=infer_points,
            boxes=infer_boxes,
            point_box_size=point_box_size,
            include_mask_png=True,
        )
        detections_local = result_local.get('detections', [])
        detections_local = detections_local if isinstance(detections_local, list) else []
        converted_local = _convert_detections(detections=detections_local, classes=final_classes, forced_class=forced_class)
        return result_local, converted_local

    def _apply_visual_scope(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if infer_mode not in {'points', 'boxes'}:
            return list(detections)
        return _filter_visual_detections(detections, points=infer_points, boxes=infer_boxes)

    # Points mode in SAM3 API is implemented via local geometric prompt boxes.
    # A too-small point box can produce tiny local patches; use ratio-based size and retry once.
    if infer_mode == 'points':
        result, converted_unfiltered = _run_once(point_box_size=0.12)
        converted = _apply_visual_scope(converted_unfiltered)
        if not converted:
            retry_threshold = max(0.2, float(threshold) * 0.8)
            result_retry, converted_retry_unfiltered = _run_once(point_box_size=0.22, threshold_value=retry_threshold)
            converted_retry = _apply_visual_scope(converted_retry_unfiltered)
            if converted_retry:
                result, converted_unfiltered, converted = result_retry, converted_retry_unfiltered, converted_retry
    else:
        result, converted_unfiltered = _run_once()
        converted = _apply_visual_scope(converted_unfiltered)

    converted_all = list(converted_unfiltered)
    if infer_mode == 'points' and not converted:
        # Fallback for click interaction: pick nearest detection(s) from unfiltered
        # candidates (with negatives removed), not from already-local-filtered set.
        fallback_pool = _filter_negative_only(converted_all, points=infer_points, boxes=infer_boxes)
        converted = _pick_by_positive_points(fallback_pool, points=infer_points)
    if infer_mode == 'points':
        converted = _reduce_points_to_single_instance(converted, points=infer_points)

    if save_result:
        old = storage.load_annotations(str(project.get('id')), str(image.get('id')))
        if infer_mode == 'text':
            merged = _replace_by_classes(
                old_annotations=old,
                impacted_classes=impacted_classes,
                new_annotations=converted,
            )
        else:
            merged = _merge_visual_annotations(
                old,
                new_annotations=converted,
                points=infer_points,
                boxes=infer_boxes,
            )
        storage.save_annotations(str(project.get('id')), str(image.get('id')), merged)
        merged = storage.load_annotations(str(project.get('id')), str(image.get('id')))
    else:
        merged = storage.load_annotations(str(project.get('id')), str(image.get('id')))

    return {
        'result': result,
        'detections': converted,
        'saved_annotations': merged,
        'impacted_classes': impacted_classes,
    }


def _infer_example_preview(
    *,
    project: dict[str, Any],
    image: dict[str, Any],
    active_class: str,
    boxes: list[list[float | int]],
    pure_visual: bool,
    threshold: float,
    api_base_url: str,
) -> dict[str, Any]:
    active = str(active_class or '').strip()
    if not active:
        raise HTTPException(status_code=400, detail='active_class is required for example preview')
    prompt_boxes = _prepare_example_prompt_boxes(
        image=image,
        boxes=boxes,
    )

    try:
        result = sam3.semantic_infer(
            api_base_url=api_base_url,
            image_path=str(image.get('abs_path') or ''),
            prompt='' if pure_visual else active,
            boxes=prompt_boxes,
            threshold=float(threshold),
            include_mask_png=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'remote semantic inference failed: {exc}') from exc

    detections = result.get('detections', [])
    detections = detections if isinstance(detections, list) else []
    converted = _convert_detections(detections=detections, classes=[active], forced_class=active)
    merged = storage.load_annotations(str(project.get('id')), str(image.get('id')))
    return {
        'result': result,
        'detections': converted,
        'saved_annotations': merged,
        'impacted_classes': [active],
    }


def _select_text_batch_target_images(
    project: dict[str, Any],
    payload: InferBatchIn,
    *,
    impacted_classes: list[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    project_id = str(project.get('id') or payload.project_id or '').strip()
    scope_mode = str(payload.scope_mode or 'all').strip().lower()
    retry_image_ids = [str(x).strip() for x in payload.retry_image_ids if str(x).strip()]
    explicit_ids = [str(x).strip() for x in payload.image_ids if str(x).strip()]
    related_classes = [str(x).strip() for x in payload.related_classes if str(x).strip()]
    if not related_classes:
        related_classes = [str(x).strip() for x in impacted_classes if str(x).strip()]

    reason = 'all_images'
    if retry_image_ids:
        target_images = storage.get_project_images_for_infer_scope(project_id, image_ids=retry_image_ids)
        reason = 'retry_image_ids'
    elif explicit_ids and not payload.all_images:
        target_images = storage.get_project_images_for_infer_scope(project_id, image_ids=explicit_ids)
        reason = 'explicit_image_ids'
    elif payload.all_images or scope_mode == 'all':
        target_images = storage.get_project_images_for_infer_scope(project_id, scope_mode='all')
        reason = 'all_images'
    elif scope_mode == 'unlabeled':
        target_images = storage.get_project_images_for_infer_scope(project_id, scope_mode='unlabeled')
        reason = 'unlabeled_only'
    else:
        target_images = storage.get_project_images_for_infer_scope(
            project_id,
            scope_mode=scope_mode,
            related_classes=related_classes,
        )
        reason = scope_mode

    return target_images, {
        'scope_mode': scope_mode,
        'reason': reason,
        'related_classes': related_classes,
        'requested_selector_count': len(retry_image_ids or explicit_ids),
        'selector_backend': 'sqlite',
    }


def _run_infer_batch(
    payload: InferBatchIn,
    *,
    progress_cb: Optional[Callable[..., None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    resume_state: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='batch infer currently supports image project only')

    classes = [str(c).strip() for c in payload.classes if str(c).strip()]
    if not classes:
        classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]
    if not classes:
        raise HTTPException(status_code=400, detail='no classes selected')

    target_images, selection_meta = _select_text_batch_target_images(project, payload, impacted_classes=classes)
    if not target_images:
        raise HTTPException(status_code=400, detail='no target images')

    requested_batch_size = _requested_batch_size(payload.batch_size)
    batch_size = _effective_sam3_batch_size(payload.batch_size)
    prior = resume_state if isinstance(resume_state, dict) else {}
    succeeded = max(0, int(prior.get('succeeded') or 0))
    failed = max(0, int(prior.get('failed') or 0))
    skipped = max(0, int(prior.get('skipped') or 0))
    total_new = max(0, int(prior.get('new_annotations') or 0))
    errors = list(prior.get('errors', [])) if isinstance(prior.get('errors'), list) else []
    failed_image_ids = [str(x).strip() for x in prior.get('failed_image_ids', []) if str(x).strip()]
    skipped_image_ids = [str(x).strip() for x in prior.get('skipped_image_ids', []) if str(x).strip()]
    image_results = list(prior.get('image_results', [])) if isinstance(prior.get('image_results'), list) else []
    class_additions = dict(prior.get('class_additions', {})) if isinstance(prior.get('class_additions'), dict) else {}
    processed = max(0, int(prior.get('progress_done') or 0))
    total = max(int(prior.get('progress_total') or 0), processed + len(target_images))
    prompt = ', '.join(classes)
    pending_images = list(target_images)

    def emit_progress(**extra: Any) -> None:
        if not progress_cb:
            return
        progress_cb(
            requested=total,
            batch_size=batch_size,
            requested_batch_size=requested_batch_size,
            max_remote_batch_size=SAM3_MAX_BATCH_FILES,
            succeeded=succeeded,
            failed=failed,
            skipped=skipped,
            new_annotations=total_new,
            failed_image_ids=failed_image_ids,
            skipped_image_ids=skipped_image_ids,
            class_additions=class_additions,
            image_results=image_results,
            selection=selection_meta,
            **_pending_image_progress_payload(pending_images),
            **extra,
        )

    emit_progress(
        message=f'Preparing text batch inference, remaining {len(target_images)} images',
        progress_done=processed,
        progress_total=total,
    )

    for batch_images in _chunked(target_images, batch_size):
        if should_stop and should_stop():
            emit_progress(
                status='paused',
                message='Paused. Adjust parameters and resume when ready.',
                progress_done=processed,
                progress_total=total,
            )
            raise InferJobPaused('Paused. Adjust parameters and resume when ready.')

        batch_paths = [str(img.get('abs_path') or '') for img in batch_images]
        try:
            batch_result = sam3.infer_batch(
                api_base_url=payload.api_base_url,
                image_paths=batch_paths,
                mode='text',
                prompt=prompt,
                threshold=payload.threshold,
                include_mask_png=True,
            )
            items = batch_result.get('items', [])
            if not isinstance(items, list) or len(items) != len(batch_images):
                raise RuntimeError(
                    f'remote batch result count mismatch: {len(items) if isinstance(items, list) else "invalid"} != {len(batch_images)}'
                )
        except Exception as exc:  # noqa: BLE001
            for image in batch_images:
                processed += 1
                failed += 1
                image_id = str(image.get('id') or '')
                rel_path = str(image.get('rel_path') or image_id)
                errors.append({'image_id': image_id, 'error': str(exc)})
                failed_image_ids.append(image_id)
                image_results.append(
                    {
                        'image_id': image_id,
                        'rel_path': rel_path,
                        'status': 'failed',
                        'reason': 'remote_batch_error',
                        'new_annotations': 0,
                        'error': str(exc),
                    }
                )
                if pending_images:
                    pending_images.pop(0)
                emit_progress(
                    message=f'Failed {processed}/{total}: {rel_path}',
                    progress_done=processed,
                    progress_total=total,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                )
            continue

        for image, item in zip(batch_images, items):
            if should_stop and should_stop():
                emit_progress(
                    status='paused',
                    message='Paused. Adjust parameters and resume when ready.',
                    progress_done=processed,
                    progress_total=total,
                )
                raise InferJobPaused('Paused. Adjust parameters and resume when ready.')

            processed += 1
            image_id = str(image.get('id') or '')
            rel_path = str(image.get('rel_path') or image_id)
            message = f'Processing {processed}/{total}: {rel_path}'
            try:
                if not isinstance(item, dict):
                    raise RuntimeError('remote batch item is not an object')
                if not bool(item.get('ok', False)):
                    raise RuntimeError(str(item.get('error') or 'remote batch item failed'))
                result = item.get('result', {})
                if not isinstance(result, dict):
                    raise RuntimeError('remote batch item result is invalid')
                detections = result.get('detections', [])
                detections = detections if isinstance(detections, list) else []
                converted = _convert_detections(detections=detections, classes=classes, forced_class='')
                old = storage.load_annotations(payload.project_id, image_id)
                merged = _replace_by_classes(
                    old_annotations=old,
                    impacted_classes=classes,
                    new_annotations=converted,
                )
                storage.save_annotations(payload.project_id, image_id, merged)
                succeeded += 1
                total_new += len(converted)
                for ann in converted:
                    cls = str(ann.get('class_name') or '').strip()
                    if cls:
                        class_additions[cls] = int(class_additions.get(cls, 0) or 0) + 1
                image_results.append(
                    {
                        'image_id': image_id,
                        'rel_path': rel_path,
                        'status': 'saved',
                        'reason': 'ok',
                        'new_annotations': len(converted),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                failed += 1
                message = f'Failed {processed}/{total}: {rel_path}'
                errors.append({'image_id': image_id, 'error': str(exc)})
                failed_image_ids.append(image_id)
                image_results.append(
                    {
                        'image_id': image_id,
                        'rel_path': rel_path,
                        'status': 'failed',
                        'reason': 'save_failed',
                        'new_annotations': 0,
                        'error': str(exc),
                    }
                )
            if pending_images:
                pending_images.pop(0)
            emit_progress(
                message=message,
                progress_done=processed,
                progress_total=total,
                current_image_id=image_id,
                current_image_rel_path=rel_path,
            )

    summary = (
        f'Text batch complete: success {succeeded}, failed {failed}, skipped {skipped}, new {total_new}, batch={batch_size}'
        if failed > 0 or skipped > 0
        else f'Text batch complete: success {succeeded}, new {total_new}, batch={batch_size}'
    )
    return {
        'project_id': payload.project_id,
        'requested': total,
        'processed_images': processed,
        'saved_images': succeeded,
        'failed_images': failed,
        'skipped_images': skipped,
        'requested_batch_size': requested_batch_size,
        'batch_size': batch_size,
        'max_remote_batch_size': SAM3_MAX_BATCH_FILES,
        'succeeded': succeeded,
        'failed': failed,
        'skipped': skipped,
        'new_annotations': total_new,
        'errors': errors,
        'failed_image_ids': failed_image_ids,
        'skipped_image_ids': skipped_image_ids,
        'retry_image_ids': failed_image_ids + skipped_image_ids,
        'class_additions': class_additions,
        'image_results': image_results,
        'selection': selection_meta,
        'message': summary,
    }


def _run_infer_batch_example(
    payload: InferExampleBatchIn,
    *,
    progress_cb: Optional[Callable[..., None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    resume_state: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='batch infer currently supports image project only')

    active_class = str(payload.active_class or '').strip()
    if not active_class:
        raise HTTPException(status_code=400, detail='active_class is required for example batch infer')
    pure_visual = bool(payload.pure_visual)

    source_image = _get_image_or_404(project, payload.source_image_id)
    prompt_boxes = _prepare_example_prompt_boxes(
        image=source_image,
        boxes=payload.boxes,
    )
    images = project.get('images', [])
    if payload.image_ids:
        wanted = {str(x) for x in payload.image_ids}
        target_images = [img for img in images if str(img.get('id') or '') in wanted]
    else:
        target_images = images
    if not target_images:
        raise HTTPException(status_code=400, detail='no target images')

    source_id = str(source_image.get('id') or '')
    if (not payload.image_ids) and source_id and not any(str(img.get('id') or '') == source_id for img in target_images):
        target_images = [source_image] + target_images

    requested_batch_size = _requested_batch_size(payload.batch_size)
    batch_size = _effective_sam3_batch_size(payload.batch_size)
    prior = resume_state if isinstance(resume_state, dict) else {}
    succeeded = max(0, int(prior.get('succeeded') or 0))
    failed = max(0, int(prior.get('failed') or 0))
    total_new = max(0, int(prior.get('new_annotations') or 0))
    errors = list(prior.get('errors', [])) if isinstance(prior.get('errors'), list) else []
    processed = max(0, int(prior.get('progress_done') or 0))
    total = max(int(prior.get('progress_total') or 0), processed + len(target_images))
    pending_images = list(target_images)

    if progress_cb:
        progress_cb(
            message=f'准备范例传播，剩余 {len(target_images)} 张',
            progress_done=processed,
            progress_total=total,
            requested=total,
            batch_size=batch_size,
            requested_batch_size=requested_batch_size,
            max_remote_batch_size=SAM3_MAX_BATCH_FILES,
            succeeded=succeeded,
            failed=failed,
            new_annotations=total_new,
            **_pending_image_progress_payload(pending_images),
        )

    for batch_images in _chunked(target_images, batch_size):
        if should_stop and should_stop():
            if progress_cb:
                progress_cb(
                    status='paused',
                    message='已停止，可调整参数后继续',
                    progress_done=processed,
                    progress_total=total,
                    requested=total,
                    batch_size=batch_size,
                    requested_batch_size=requested_batch_size,
                    max_remote_batch_size=SAM3_MAX_BATCH_FILES,
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    **_pending_image_progress_payload(pending_images),
                )
            raise InferJobPaused('已停止，可调整参数后继续')
        try:
            target_paths = [str(img.get('abs_path') or '') for img in batch_images]
            batch_result = sam3.semantic_infer_batch(
                api_base_url=payload.api_base_url,
                source_image_path=str(source_image.get('abs_path') or ''),
                target_image_paths=target_paths,
                prompt='' if pure_visual else active_class,
                boxes=prompt_boxes,
                threshold=float(payload.threshold),
                include_mask_png=True,
            )
            items = batch_result.get('items', [])
            if not isinstance(items, list) or len(items) != len(batch_images):
                raise RuntimeError(
                    f'remote semantic batch inference item count mismatch: {len(items) if isinstance(items, list) else "invalid"} != {len(batch_images)}'
                )
        except Exception as exc:  # noqa: BLE001
            for image in batch_images:
                processed += 1
                failed += 1
                rel_path = str(image.get('rel_path') or image.get('id') or '')
                errors.append({'image_id': image.get('id'), 'error': str(exc)})
                if pending_images:
                    pending_images.pop(0)
                if progress_cb:
                    progress_cb(
                        message=f'失败 {processed}/{total}: {rel_path}',
                        progress_done=processed,
                        progress_total=total,
                        requested=total,
                        batch_size=batch_size,
                        requested_batch_size=requested_batch_size,
                        max_remote_batch_size=SAM3_MAX_BATCH_FILES,
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        current_image_id=str(image.get('id') or ''),
                        current_image_rel_path=rel_path,
                        **_pending_image_progress_payload(pending_images),
                    )
            continue

        for image, item in zip(batch_images, items):
            if should_stop and should_stop():
                if progress_cb:
                    progress_cb(
                        status='paused',
                        message='已停止，可调整参数后继续',
                        progress_done=processed,
                        progress_total=total,
                        requested=total,
                        batch_size=batch_size,
                        requested_batch_size=requested_batch_size,
                        max_remote_batch_size=SAM3_MAX_BATCH_FILES,
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        **_pending_image_progress_payload(pending_images),
                    )
                raise InferJobPaused('已停止，可调整参数后继续')
            processed += 1
            image_id = str(image.get('id') or '')
            rel_path = str(image.get('rel_path') or image_id)
            message = f'处理中 {processed}/{total}: {rel_path}'
            try:
                if not isinstance(item, dict):
                    raise RuntimeError('remote batch item is not an object')
                if not bool(item.get('ok', False)):
                    raise RuntimeError(str(item.get('error') or 'remote semantic batch item failed'))
                result = item.get('result', {})
                if not isinstance(result, dict):
                    raise RuntimeError('remote batch item result is invalid')
                detections = result.get('detections', [])
                detections = detections if isinstance(detections, list) else []
                converted = _convert_detections(detections=detections, classes=[active_class], forced_class=active_class)
                old = storage.load_annotations(payload.project_id, image_id)
                merged = _replace_by_classes(
                    old_annotations=old,
                    impacted_classes=[active_class],
                    new_annotations=converted,
                )
                storage.save_annotations(payload.project_id, image_id, merged)
                total_new += len(converted)
                succeeded += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                message = f'失败 {processed}/{total}: {rel_path}'
                errors.append({'image_id': image_id, 'error': str(exc)})
            if pending_images:
                pending_images.pop(0)
            if progress_cb:
                progress_cb(
                    message=message,
                    progress_done=processed,
                    progress_total=total,
                    requested=total,
                    batch_size=batch_size,
                    requested_batch_size=requested_batch_size,
                    max_remote_batch_size=SAM3_MAX_BATCH_FILES,
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                    **_pending_image_progress_payload(pending_images),
                )

    summary = (
        f'范例传播完成: 成功 {succeeded}, 失败 {failed}, 写入 {total_new}, batch={batch_size}'
        if failed > 0
        else f'范例传播完成: 成功 {succeeded}, 写入 {total_new}, batch={batch_size}'
    )
    return {
        'project_id': payload.project_id,
        'source_image_id': payload.source_image_id,
        'active_class': active_class,
        'requested': total,
        'requested_batch_size': requested_batch_size,
        'batch_size': batch_size,
        'max_remote_batch_size': SAM3_MAX_BATCH_FILES,
        'succeeded': succeeded,
        'failed': failed,
        'new_annotations': total_new,
        'strategy': 'remote_visual_prompt_embedding_batch_chunked',
        'errors': errors,
        'message': summary,
    }


@app.on_event('startup')
def on_startup() -> None:
    AUTH_STORE.ensure_admin_from_env()
    return None


@app.get('/setup', response_class=HTMLResponse)
def setup_page(request: Request) -> Response:
    return RedirectResponse('/login', status_code=303)


@app.get('/login', response_class=HTMLResponse)
def login_page(request: Request) -> Response:
    if not AUTH_ENABLED:
        return RedirectResponse('/', status_code=303)
    AUTH_STORE.ensure_admin_from_env()
    if _request_username(request):
        return RedirectResponse('/', status_code=303)
    return HTMLResponse(_auth_page_html('login'))


@app.get('/logout')
def logout_page(request: Request) -> Response:
    token = str(request.cookies.get(SESSION_COOKIE_NAME) or '')
    AUTH_STORE.destroy_session(token)
    response = RedirectResponse('/login', status_code=303)
    _clear_session_cookie(response, request)
    return response


@app.get('/api/auth/status')
def auth_status(request: Request) -> dict[str, Any]:
    username = _request_username(request)
    return {
        'enabled': AUTH_ENABLED,
        'admin_configured': (not AUTH_ENABLED) or AUTH_STORE.has_admin(),
        'authenticated': bool(username),
        'username': username or '',
        'session_ttl_seconds': SESSION_TTL_SECONDS,
    }


@app.post('/api/auth/setup')
def auth_setup(payload: AuthSetupIn, request: Request) -> Response:
    raise HTTPException(status_code=404, detail='interactive setup is disabled; use deployment admin credentials')


@app.post('/api/auth/login')
def auth_login(payload: AuthLoginIn, request: Request) -> Response:
    if not AUTH_ENABLED:
        return JSONResponse({'ok': True, 'enabled': False})
    try:
        username = AUTH_STORE.verify_login(payload.username, payload.password)
        token = AUTH_STORE.create_session(username)
        response = JSONResponse({'ok': True, 'username': username})
        _set_session_cookie(response, request, token)
        return response
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.post('/api/auth/logout')
def auth_logout(request: Request) -> Response:
    token = str(request.cookies.get(SESSION_COOKIE_NAME) or '')
    AUTH_STORE.destroy_session(token)
    response = JSONResponse({'ok': True})
    _clear_session_cookie(response, request)
    return response


@app.post('/api/auth/password')
def auth_change_password(payload: AuthPasswordChangeIn, request: Request) -> Response:
    username = _request_username(request)
    if not username:
        raise HTTPException(status_code=401, detail='login required')
    try:
        AUTH_STORE.change_password(username, payload.current_password, payload.new_password)
        response = JSONResponse({'ok': True})
        _clear_session_cookie(response, request)
        return response
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get('/api/info')
def root_info() -> dict[str, Any]:
    return {
        'service': 'web-auto-api',
        'mode': 'api_only',
        'docs_url': '/docs',
        'openapi_url': '/openapi.json',
        'health_url': '/api/health',
        'allowed_origins': ALLOWED_ORIGINS,
        'frontend_bundled': False,
    }


@app.get('/api/health')
def health() -> dict[str, Any]:
    return {
        'status': 'ok',
        'service': 'web-auto-api',
        'mode': 'api_only',
        'timestamp': now_ts(),
        'allowed_origins': ALLOWED_ORIGINS,
    }


@app.get('/api/config/defaults')
def get_default_config() -> dict[str, Any]:
    return {
        'sam3_api_base_url': _effective_sam3_api_base_url(),
        'allowed_sam3_api_base_urls': _allowed_sam3_api_base_urls(),
        'sapiens_api_base_url': DEFAULT_SAPIENS_API_BASE_URL,
        'ops_api_configured': bool(OPS_API_BASE_URL),
        'data_dir': str(CURRENT_DATA_DIR),
        'sam3_max_batch_files': SAM3_MAX_BATCH_FILES,
    }


@app.get('/api/config/global')
def get_global_config() -> dict[str, Any]:
    return {'config': _global_config_info()}


@app.post('/api/config/global')
def set_global_config(payload: GlobalConfigUpdateIn) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    with CONFIG_LOCK:
        if payload.cache_dir is not None:
            cache_dir = str(payload.cache_dir or '').strip()
            if cache_dir:
                _ensure_no_active_jobs_for_config_change()
                new_dir = _set_storage_data_dir(cache_dir)
                changes['cache_dir'] = str(new_dir)

        if payload.upload_target_dir is not None:
            upload_target = str(payload.upload_target_dir or '').strip()
            if upload_target:
                target = _resolve_dataset_upload_dir(upload_target)
                changes['upload_target_dir'] = str(target)

        if payload.sam3_api_base_url is not None:
            api_base_url = str(payload.sam3_api_base_url or '').strip().rstrip('/')
            if api_base_url:
                try:
                    api_base_url = Sam3Client._api_root(api_base_url)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                changes['sam3_api_base_url'] = api_base_url

        if changes:
            _update_app_config(changes)

    return {'ok': True, 'config': _global_config_info()}


@app.post('/api/system/restart')
def restart_web_auto() -> dict[str, Any]:
    _ensure_no_active_jobs_for_config_change()

    def _delayed_exit() -> None:
        time.sleep(0.5)
        os._exit(0)

    thread = threading.Thread(target=_delayed_exit, daemon=True)
    thread.start()
    return {'ok': True, 'message': 'web-auto is restarting'}


@app.get('/api/config/cache_dir')
def get_cache_dir_config() -> dict[str, Any]:
    return _cache_dir_info()


@app.post('/api/config/cache_dir')
def set_cache_dir_config(payload: CacheDirUpdateIn) -> dict[str, Any]:
    with CONFIG_LOCK:
        _ensure_no_active_jobs_for_config_change()
        new_dir = _set_storage_data_dir(payload.cache_dir)
        _update_app_config({'cache_dir': str(new_dir)})
    return {
        'ok': True,
        'cache_dir': str(new_dir),
        'message': 'Storage directory updated successfully.',
    }


@app.get('/api/projects')
def list_projects(auto_discover: bool = Query(default=False)) -> dict[str, Any]:
    discovery = (
        _auto_import_project_manifests()
        if auto_discover
        else {'imported': [], 'skipped': 0, 'errors': [], 'cached': True, 'auto_discover': False}
    )
    projects = [
        p for p in storage.list_projects()
        if str(p.get('project_type') or 'image').strip().lower() in {'image', 'pose'}
    ]
    return {'projects': projects, 'discovery': discovery}


@app.get('/api/projects/discover')
def discover_existing_projects(
    scan_root: str = Query(default=''),
    max_depth: int = Query(default=8, ge=1, le=12),
) -> dict[str, Any]:
    roots = _resolve_project_discovery_roots(scan_root)
    discovery = _auto_import_project_manifests(roots=roots, force=True, max_depth=max_depth)
    candidates = storage.discover_existing_projects(roots, max_depth=max_depth)
    return {
        'candidates': candidates,
        'discovery': discovery,
        'scan_roots': _project_discovery_root_info(roots),
        'allowed_data_roots': [str(root) for root in ALLOWED_DATA_ROOTS],
        'max_depth': max_depth,
    }


@app.post('/api/projects/import_existing')
def import_existing_project(payload: ImportExistingProjectIn) -> dict[str, Any]:
    project_type = str(payload.project_type or 'image').strip().lower()
    if project_type not in {'', 'image', 'pose'}:
        _raise_video_annotation_removed()
    try:
        result = storage.import_existing_project(
            output_dir=payload.output_dir,
            manifest_path=payload.manifest_path,
            image_dir=payload.image_dir,
            name=payload.name,
            classes_text=payload.classes_text,
            project_type=project_type or 'image',
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get('/api/projects/{project_id}')
def get_project(project_id: str, include_images: bool = Query(default=True)) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=bool(include_images))
    if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
        raise HTTPException(status_code=404, detail='project not found')
    return {'project': project}


@app.post('/api/projects/open')
def open_project(payload: OpenProjectIn) -> dict[str, Any]:
    try:
        project_type = str(payload.project_type or 'image').strip().lower()
        classes_text = payload.classes_text
        if project_type == 'pose' and not str(classes_text or '').strip():
            classes_text = 'person_pose'
        logger.info(
            'open project name=%s type=%s image_dir=%s save_dir=%s',
            payload.name,
            project_type,
            payload.image_dir,
            payload.save_dir,
        )
        project = storage.create_project(
            name=payload.name,
            image_dir=payload.image_dir,
            save_dir=payload.save_dir,
            classes_text=classes_text,
            project_type=project_type,
        )
        logger.info(
            'open project done id=%s type=%s images=%s classes=%s',
            project.get('id'),
            project.get('project_type'),
            len(project.get('images', [])),
            len(project.get('classes', [])),
        )
        return {'project': project}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get('/api/uploads/config')
def get_upload_config() -> dict[str, Any]:
    target = _configured_upload_target_dir()
    return {
        'host_data_root': str(HOST_DATA_ROOT),
        'allowed_data_roots': [str(root) for root in ALLOWED_DATA_ROOTS],
        'default_target_dir': str(target),
    }


@app.post('/api/uploads/dataset')
async def upload_dataset_file(
    file: UploadFile = File(...),
    target_dir: str = Form(...),
    relative_path: str = Form(default=''),
    overwrite: bool = Form(default=False),
) -> dict[str, Any]:
    upload_root = _resolve_dataset_upload_dir(target_dir)
    safe_rel = _safe_dataset_relative_path(relative_path, file.filename or '')
    target_path = (upload_root / safe_rel).resolve()
    if not _path_within_root(target_path, upload_root):
        raise HTTPException(status_code=400, detail='relative_path escapes target_dir')
    if target_path.exists() and not overwrite:
        raise HTTPException(status_code=409, detail=f'file already exists: {target_path}')

    ensure_dir(target_path.parent)
    tmp_path = target_path.with_name(f'.{target_path.name}.upload-{new_id()}.tmp')
    bytes_written = 0
    try:
        with tmp_path.open('wb') as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                bytes_written += len(chunk)
        os.replace(tmp_path, target_path)
    except HTTPException:
        raise
    except Exception as exc:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f'failed to save file: {exc}') from exc
    finally:
        try:
            await file.close()
        except Exception:
            pass

    return {
        'ok': True,
        'path': str(target_path),
        'relative_path': safe_rel.as_posix(),
        'size': bytes_written,
    }


@app.post('/api/projects/{project_id}/images/upload')
async def upload_project_image(project_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    project = storage.get_project(project_id, enrich=False, include_images=False)
    if not project:
        raise HTTPException(status_code=404, detail='project not found')

    if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
        raise HTTPException(status_code=400, detail='only image or pose projects support uploads')

    image_dir = Path(project['image_dir'])
    if not image_dir.exists():
        ensure_dir(image_dir)

    original_filename = file.filename or 'upload.jpg'
    stem = Path(original_filename).stem
    suffix = Path(original_filename).suffix

    target_path = image_dir / original_filename
    if target_path.exists():
        counter = 1
        while True:
            new_name = f'{stem}_upload{counter}{suffix}'
            target_path = image_dir / new_name
            if not target_path.exists():
                break
            counter += 1

    try:
        with target_path.open('wb') as f:
            shutil.copyfileobj(file.file, f)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'failed to save file: {exc}') from exc

    storage.refresh_project_images(project_id)
    return {'ok': True, 'filename': target_path.name}


@app.delete('/api/projects/{project_id}')
def delete_project(project_id: str) -> dict[str, Any]:
    try:
        storage.delete_project(project_id)
        return {'ok': True}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get('/api/projects/{project_id}/images')
def list_project_images(
    project_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    image_id: str = Query(default=''),
    status: str = Query(default=''),
    class_name: str = Query(default=''),
) -> dict[str, Any]:
    try:
        items, total, safe_offset, safe_limit, image_index = storage.get_project_images_page(
            project_id,
            offset=offset,
            limit=limit,
            image_id=image_id,
            status=status,
            class_name=class_name,
        )
        return {
            'items': items,
            'total': total,
            'offset': safe_offset,
            'limit': safe_limit,
            'image_index': image_index,
            'status': status,
            'class_name': class_name,
        }
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.get('/api/projects/{project_id}/annotation_dashboard')
def get_annotation_dashboard(project_id: str) -> dict[str, Any]:
    try:
        return {'stats': storage.get_annotation_dashboard(project_id)}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/projects/{project_id}/annotation_index/rebuild')
def rebuild_annotation_index(project_id: str) -> dict[str, Any]:
    try:
        return {'ok': True, 'result': storage.rebuild_annotation_index(project_id)}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.get('/api/projects/{project_id}/images/unlabeled')
def get_unlabeled_project_image(
    project_id: str,
    after_image_id: str = Query(default=''),
    direction: str = Query(default='next', pattern='^(next|prev)$'),
) -> dict[str, Any]:
    try:
        image, image_index = storage.find_unlabeled_image(
            project_id,
            after_image_id=after_image_id,
            direction=direction,
        )
        return {'image': image, 'image_index': image_index}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/projects/{project_id}/images/refresh')
def refresh_project_images(project_id: str) -> dict[str, Any]:
    try:
        project, added = storage.refresh_project_images(project_id)
        return {'project': project, 'added_images': added}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/projects/{project_id}/images/import')
def import_project_images(project_id: str, payload: ImportImagesIn) -> dict[str, Any]:
    try:
        project, copied, added = storage.import_images_from_dir(project_id, payload.source_dir)
        return {'project': project, 'copied_files': copied, 'added_images': added}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/projects/{project_id}/images/upload')
async def upload_project_images(project_id: str, files: list[UploadFile] = File(...)) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
        raise HTTPException(status_code=400, detail='only image or pose project is supported')
    image_root = Path(str(project.get('image_dir') or '')).expanduser().resolve()
    if not image_root.exists() or not image_root.is_dir():
        raise HTTPException(status_code=400, detail=f'image_dir does not exist: {image_root}')
    if not files:
        raise HTTPException(status_code=400, detail='no files uploaded')

    saved = 0
    for up in files:
        filename = str(getattr(up, 'filename', '') or '').strip()
        target = _safe_upload_target(image_root, filename)
        try:
            ensure_dir(target.parent)
            with target.open('wb') as out:
                shutil.copyfileobj(up.file, out)
            saved += 1
        finally:
            try:
                await up.close()
            except Exception:
                pass

    refreshed, added = storage.refresh_project_images(project_id)
    return {'project': refreshed, 'saved_files': saved, 'added_images': added}


@app.post('/api/projects/{project_id}/classes')
def update_classes(project_id: str, payload: UpdateClassesIn) -> dict[str, Any]:
    try:
        project = storage.add_classes(project_id, payload.classes_text)
        return {'project': project}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/projects/{project_id}/classes/add')
def add_classes(project_id: str, payload: UpdateClassesIn) -> dict[str, Any]:
    try:
        project = storage.add_classes(project_id, payload.classes_text)
        return {'project': project}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.delete('/api/projects/{project_id}/classes/{class_name}')
def delete_class(project_id: str, class_name: str) -> dict[str, Any]:
    try:
        project = storage.delete_class(project_id, class_name)
        return {'project': project}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg == 'project not found' else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.get('/api/projects/{project_id}/images/{image_id}/file')
def get_image_file(project_id: str, image_id: str) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    image = _get_image_or_404(project, image_id)
    return FileResponse(str(_image_file_path_or_404(image)))


@app.get('/api/projects/{project_id}/images/{image_id}/tiles/info')
def get_image_tiles_info(project_id: str, image_id: str) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    image = _get_image_or_404(project, image_id)
    image_path = _image_file_path_or_404(image)
    tile_dir, metadata = _ensure_image_tiles(project_id, image_id, image_path)
    return {
        'width': metadata['width'],
        'height': metadata['height'],
        'tile_size': metadata['tile_size'],
        'overlap': metadata['overlap'],
        'format': metadata['format'],
        'dzi_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image.dzi',
        'tiles_url': f'/api/projects/{project_id}/images/{image_id}/tiles/image_files/',
        'cache_dir': str(tile_dir),
    }


@app.get('/api/projects/{project_id}/images/{image_id}/tiles/image.dzi')
def get_image_dzi(project_id: str, image_id: str) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    image = _get_image_or_404(project, image_id)
    tile_dir, _metadata = _ensure_image_tiles(project_id, image_id, _image_file_path_or_404(image))
    return FileResponse(str(_dzi_metadata_path(tile_dir)), media_type='application/xml')


@app.get('/api/projects/{project_id}/images/{image_id}/tiles/image_files/{level}/{tile_name}')
def get_image_tile(project_id: str, image_id: str, level: str, tile_name: str) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    image = _get_image_or_404(project, image_id)
    tile_dir, _metadata = _ensure_image_tiles(project_id, image_id, _image_file_path_or_404(image))
    safe_level = Path(str(level)).name
    safe_tile = Path(str(tile_name)).name
    tile_path = (tile_dir / 'image_files' / safe_level / safe_tile).resolve()
    try:
        tile_path.relative_to(tile_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='invalid tile path') from exc
    if not tile_path.exists() or not tile_path.is_file():
        raise HTTPException(status_code=404, detail='tile not found')
    return FileResponse(str(tile_path))


@app.get('/api/projects/{project_id}/images/{image_id}/annotations')
def get_annotations(project_id: str, image_id: str) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    _get_image_or_404(project, image_id)
    anns = storage.load_annotations(project_id, image_id)
    return {'annotations': anns}


@app.delete('/api/projects/{project_id}/images/{image_id}')
def delete_image(project_id: str, image_id: str) -> dict[str, Any]:
    try:
        project, deleted_image = storage.delete_image(project_id, image_id)
        return {'ok': True, 'project': project, 'deleted_image': deleted_image}
    except ValueError as exc:
        msg = str(exc)
        code = 404 if msg in {'project not found', 'image not found'} else 400
        raise HTTPException(status_code=code, detail=msg) from exc


@app.post('/api/annotations/save')
def save_annotations(payload: SaveAnnIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    _get_image_or_404(project, payload.image_id)
    storage.save_annotations(payload.project_id, payload.image_id, payload.annotations)
    saved = storage.load_annotations(payload.project_id, payload.image_id)
    return {'ok': True, 'saved_annotations': saved}


@app.post('/api/annotations/append')
def append_annotations(payload: AppendAnnIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    _get_image_or_404(project, payload.image_id)

    old = storage.load_annotations(payload.project_id, payload.image_id)
    incoming = payload.annotations if isinstance(payload.annotations, list) else []
    incoming = [a for a in incoming if isinstance(a, dict)]
    incoming = _assign_unique_annotation_ids(existing=old, incoming=incoming)
    merged = list(old) + incoming
    storage.save_annotations(payload.project_id, payload.image_id, merged)
    saved = storage.load_annotations(payload.project_id, payload.image_id)
    return {'ok': True, 'saved_annotations': saved, 'added': len(incoming)}


@app.post('/api/infer')
def infer_single(payload: InferIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
    image = _get_image_or_404(project, payload.image_id)
    out = _infer_single(
        project=project,
        image=image,
        mode=payload.mode,
        classes=payload.classes,
        active_class=payload.active_class,
        points=payload.points,
        boxes=payload.boxes,
        threshold=payload.threshold,
        api_base_url=payload.api_base_url,
        save_result=True,
    )
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


@app.post('/api/infer/preview')
def infer_preview(payload: InferIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
    image = _get_image_or_404(project, payload.image_id)
    out = _infer_single(
        project=project,
        image=image,
        mode=payload.mode,
        classes=payload.classes,
        active_class=payload.active_class,
        points=payload.points,
        boxes=payload.boxes,
        threshold=payload.threshold,
        api_base_url=payload.api_base_url,
        save_result=False,
    )
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


@app.post('/api/infer/example_preview')
def infer_example_preview(payload: InferExamplePreviewIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
    image = _get_image_or_404(project, payload.image_id)
    out = _infer_example_preview(
        project=project,
        image=image,
        active_class=payload.active_class,
        boxes=payload.boxes,
        pure_visual=bool(payload.pure_visual),
        threshold=payload.threshold,
        api_base_url=payload.api_base_url,
    )
    return {
        'project_id': payload.project_id,
        'image_id': payload.image_id,
        'mode': 'example_preview',
        'num_detections': len(out['detections']),
        'detections': out['detections'],
        'saved_annotations': out['saved_annotations'],
        'impacted_classes': out['impacted_classes'],
        'raw': out['result'],
    }


@app.post('/api/infer/batch')
def infer_batch(payload: InferBatchIn) -> dict[str, Any]:
    return _run_infer_batch(payload)


@app.post('/api/infer/batch_example')
def infer_batch_example(payload: InferExampleBatchIn) -> dict[str, Any]:
    return _run_infer_batch_example(payload)


@app.post('/api/infer/jobs/start_batch')
def start_infer_batch_job(payload: InferBatchIn) -> dict[str, Any]:
    job = _spawn_infer_job(
        project_id=payload.project_id,
        job_type='text_batch',
        payload_dict=payload.model_dump(),
        worker=lambda data, progress_cb, should_stop, resume_state: _run_infer_batch(
            InferBatchIn(**data),
            progress_cb=progress_cb,
            should_stop=should_stop,
            resume_state=resume_state,
        ),
    )
    return {'job': job}


@app.post('/api/infer/jobs/start_batch_example')
def start_infer_batch_example_job(payload: InferExampleBatchIn) -> dict[str, Any]:
    job = _spawn_infer_job(
        project_id=payload.project_id,
        job_type='example_batch',
        payload_dict=payload.model_dump(),
        worker=lambda data, progress_cb, should_stop, resume_state: _run_infer_batch_example(
            InferExampleBatchIn(**data),
            progress_cb=progress_cb,
            should_stop=should_stop,
            resume_state=resume_state,
        ),
    )
    return {'job': job}


@app.get('/api/infer/jobs/active')
def get_active_infer_job(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
    _get_project_or_404(project_id, enrich=False, include_images=False)
    job = _get_active_infer_job_for_project(project_id)
    if not job:
        job = _get_latest_infer_job_for_project(project_id, statuses={'paused', 'pausing'})
    return {'job': job}


@app.get('/api/infer/jobs/{job_id}')
def get_infer_job(job_id: str) -> dict[str, Any]:
    return {'job': _get_infer_job_state_or_404(job_id)}


@app.post('/api/infer/jobs/pause')
@app.post('/api/infer/jobs/stop')
def pause_infer_job(payload: InferJobControlIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, enrich=False, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='infer pause currently supports image project only')

    state = _get_active_infer_job_for_project(payload.project_id)
    if not _pause_infer_job(payload.project_id):
        paused = _get_latest_infer_job_for_project(payload.project_id, statuses={'paused', 'pausing'})
        return {'job': paused or state}
    if state and str(state.get('job_id') or '').strip():
        _update_infer_job_state(str(state.get('job_id') or ''), status='pausing')
    return {'job': _get_active_infer_job_for_project(payload.project_id) or _get_latest_infer_job_for_project(payload.project_id, statuses={'pausing'})}


@app.post('/api/infer/jobs/resume')
def resume_infer_job(payload: InferJobResumeIn) -> dict[str, Any]:
    return _resume_infer_job(payload)


@app.post('/api/sam3/health')
def sam3_health(payload: HealthApiIn) -> dict[str, Any]:
    try:
        result = sam3.health(payload.api_base_url)
        return {'ok': True, 'result': result}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/api/services/status')
def services_status() -> dict[str, Any]:
    try:
        result = _ops_request('GET', '/v1/services', timeout=8.0)
        result['ok'] = True
        result['ops_available'] = True
        return result
    except Exception as exc:  # noqa: BLE001
        return _service_management_unavailable(str(exc))


@app.post('/api/services/{service}/{action}')
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
        return _ops_request('POST', f'/v1/services/{clean_service}/{clean_action}', timeout=35.0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/api/services/{service}/logs')
def service_logs(service: str, tail: int = Query(default=120, ge=1, le=1000)) -> dict[str, Any]:
    clean_service = str(service or '').strip()
    if clean_service not in {'sam3-api', 'sapiens-api', 'caddy'}:
        raise HTTPException(status_code=400, detail=f'unsupported service: {clean_service}')
    try:
        return _ops_request('GET', f'/v1/services/{clean_service}/logs?tail={tail}', timeout=12.0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/api/sapiens/status')
def sapiens_status() -> dict[str, Any]:
    try:
        health_data = _sapiens_request('GET', '/health', timeout=8.0)
        pose_data = _sapiens_request('GET', '/v1/pose/status', timeout=8.0)
        return {
            'ok': True,
            'health': health_data,
            'pose': pose_data,
            'checkpoint': pose_data.get('checkpoint', {}),
            'api_base_url': DEFAULT_SAPIENS_API_BASE_URL,
        }
    except Exception as exc:  # noqa: BLE001
        return {'ok': False, 'error': str(exc), 'api_base_url': DEFAULT_SAPIENS_API_BASE_URL}


@app.post('/api/sapiens/checkpoint/download')
def sapiens_checkpoint_download() -> dict[str, Any]:
    try:
        return _sapiens_request('POST', '/v1/pose/checkpoints/download', {}, timeout=12.0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/api/sapiens/checkpoint/download/{job_id}')
def sapiens_checkpoint_download_status(job_id: str) -> dict[str, Any]:
    try:
        return _sapiens_request('GET', f'/v1/pose/checkpoints/download/{job_id}', timeout=8.0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _pose_annotations_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    links = result.get('skeleton_links') if isinstance(result.get('skeleton_links'), list) else []
    annotations: list[dict[str, Any]] = []
    instances = result.get('instances', []) if isinstance(result.get('instances'), list) else []
    for raw in instances:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        item['id'] = new_id('pose_')
        item['type'] = 'pose'
        item['label'] = str(item.get('label') or item.get('class_name') or 'person_pose')
        item['class_name'] = str(item.get('class_name') or item.get('label') or 'person_pose')
        if links and not isinstance(item.get('skeleton_links'), list):
            item['skeleton_links'] = links
        annotations.append(item)
    return annotations


@app.post('/api/pose/infer')
def infer_pose(payload: PoseInferIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if str(project.get('project_type') or 'image').strip().lower() != 'pose':
        raise HTTPException(status_code=400, detail='only pose project is supported')
    image = _get_image_or_404(project, payload.image_id)
    abs_path_raw = str(image.get('abs_path') or '').strip()
    if not abs_path_raw:
        raise HTTPException(status_code=404, detail='image file not found')
    image_path = Path(abs_path_raw).expanduser().resolve()
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail=f'image file not found: {image_path}')
    try:
        result = _sapiens_file_request(
            '/v1/pose/infer',
            file_path=image_path,
            fields={
                'bbox_threshold': max(0.0, min(1.0, float(payload.bbox_threshold))),
                'nms_threshold': max(0.0, min(1.0, float(payload.nms_threshold))),
                'keypoint_threshold': max(0.0, min(1.0, float(payload.keypoint_threshold))),
            },
            timeout=600.0,
        )
        annotations = _pose_annotations_from_result(result)
        storage.save_annotations(payload.project_id, payload.image_id, annotations)
        saved = storage.load_annotations(payload.project_id, payload.image_id)
        return {
            'project_id': payload.project_id,
            'image_id': payload.image_id,
            'num_instances': len(saved),
            'annotations': saved,
            'saved_annotations': saved,
            'raw': result,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/api/sam3/status')
def sam3_status(api_base_url: Optional[str] = Query(default=None)) -> dict[str, Any]:
    target_url = str(api_base_url or _effective_sam3_api_base_url()).strip() or DEFAULT_API_BASE_URL
    try:
        result = sam3.health(target_url)
        return {'ok': True, 'api_base_url': target_url, 'result': result}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post('/api/filter/intelligent/preview')
def preview_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')

    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
    spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
    canonical_class = str(payload.canonical_class or '').strip()
    source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
    area_mode = str(payload.area_mode or 'instance').strip().lower()
    if merge_mode == 'canonical_class' and not canonical_class:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if merge_mode == 'canonical_class' and not source_classes:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

    items: list[dict[str, Any]] = []
    total_candidates = 0
    total_images = 0
    total_relabels = 0
    for image in project.get('images', []):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        annotations = storage.load_annotations(payload.project_id, image_id)
        analysis = _analyze_smart_merge_annotations(
            annotations,
            merge_mode=merge_mode,
            spatial_mode=spatial_mode,
            coverage_threshold=coverage_threshold,
            canonical_class=canonical_class,
            source_classes=source_classes,
            area_mode=area_mode,
        )
        removed = analysis.get('removed_annotations', [])
        pairs = analysis.get('pairs', [])
        relabeled = analysis.get('relabeled_annotations', [])
        remove_count = len(removed) if isinstance(removed, list) else 0
        relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
        if remove_count <= 0 and relabel_count <= 0:
            continue
        total_candidates += remove_count
        total_relabels += relabel_count
        total_images += 1
        items.append(
            {
                'image_id': image_id,
                'rel_path': str(image.get('rel_path') or image_id),
                'candidate_count': remove_count,
                'relabel_count': relabel_count,
                'pair_count': len(pairs) if isinstance(pairs, list) else 0,
            }
        )

    items.sort(key=lambda x: (int(x.get('candidate_count') or 0), int(x.get('relabel_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    return {
        'project_id': payload.project_id,
        'image_count': total_images,
        'candidate_count': total_candidates,
        'relabel_count': total_relabels,
        'items': items,
        'rule': {
            'merge_mode': merge_mode,
            'spatial_mode': spatial_mode,
            'same_class': merge_mode == 'same_class',
            'canonical_class': canonical_class,
            'source_classes': source_classes,
            'area_mode': area_mode,
            'small_box_covered_by_large_gte': coverage_threshold,
            'keep': 'larger_area',
        },
    }


@app.post('/api/filter/intelligent/apply')
def apply_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')

    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
    spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
    canonical_class = str(payload.canonical_class or '').strip()
    source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
    area_mode = str(payload.area_mode or 'instance').strip().lower()
    if merge_mode == 'canonical_class' and not canonical_class:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if merge_mode == 'canonical_class' and not source_classes:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

    changed_images = 0
    removed_annotations = 0
    relabeled_annotations = 0
    items: list[dict[str, Any]] = []
    for image in project.get('images', []):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        annotations = storage.load_annotations(payload.project_id, image_id)
        analysis = _analyze_smart_merge_annotations(
            annotations,
            merge_mode=merge_mode,
            spatial_mode=spatial_mode,
            coverage_threshold=coverage_threshold,
            canonical_class=canonical_class,
            source_classes=source_classes,
            area_mode=area_mode,
        )
        removed = analysis.get('removed_annotations', [])
        kept_annotations = analysis.get('kept_annotations', annotations)
        relabeled = analysis.get('relabeled_annotations', [])
        remove_count = len(removed) if isinstance(removed, list) else 0
        relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
        if remove_count <= 0 and relabel_count <= 0:
            continue
        storage.save_annotations(payload.project_id, image_id, kept_annotations if isinstance(kept_annotations, list) else annotations)
        changed_images += 1
        removed_annotations += remove_count
        relabeled_annotations += relabel_count
        items.append(
            {
                'image_id': image_id,
                'rel_path': str(image.get('rel_path') or image_id),
                'removed_count': remove_count,
                'relabel_count': relabel_count,
            }
        )

    items.sort(key=lambda x: (int(x.get('removed_count') or 0), int(x.get('relabel_count') or 0), str(x.get('rel_path') or '')), reverse=True)
    return {
        'project_id': payload.project_id,
        'changed_images': changed_images,
        'removed_annotations': removed_annotations,
        'relabeled_annotations': relabeled_annotations,
        'rule': {
            'merge_mode': merge_mode,
            'spatial_mode': spatial_mode,
            'canonical_class': canonical_class,
            'source_classes': source_classes,
            'area_mode': area_mode,
            'small_box_covered_by_large_gte': coverage_threshold,
        },
        'items': items,
    }


@app.post('/api/filter/intelligent/jobs/start_preview')
def start_smart_filter_preview_job(payload: SmartFilterIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
    _normalize_smart_filter_payload(payload)
    job = _spawn_smart_filter_job(
        project_id=payload.project_id,
        job_type='preview',
        payload_dict=payload.model_dump(),
        worker=_run_smart_filter_preview_job,
    )
    return {'job': job}


@app.post('/api/filter/intelligent/jobs/start_apply')
def start_smart_filter_apply_job(payload: SmartFilterIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id, include_images=False)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
    _normalize_smart_filter_payload(payload)
    job = _spawn_smart_filter_job(
        project_id=payload.project_id,
        job_type='apply',
        payload_dict=payload.model_dump(),
        worker=_run_smart_filter_apply_job,
    )
    return {'job': job}


@app.get('/api/filter/intelligent/jobs/active')
def get_active_smart_filter_job(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
    _get_project_or_404(project_id, enrich=False, include_images=False)
    return {'job': _get_active_smart_filter_job_for_project(project_id)}


@app.get('/api/filter/intelligent/jobs/{job_id}')
def get_smart_filter_job(job_id: str) -> dict[str, Any]:
    return {'job': _get_smart_filter_job_state_or_404(job_id)}


@app.get('/api/filter/intelligent/runs/latest')
def get_latest_smart_filter_run(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
    _get_project_or_404(project_id, enrich=False, include_images=False)
    return {'run': storage.get_latest_smart_filter_run(project_id=project_id)}


@app.post('/api/filter/intelligent/runs/{run_id}/rollback')
def rollback_smart_filter_run(run_id: str, project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
    _get_project_or_404(project_id, enrich=False, include_images=False)
    try:
        result = storage.rollback_smart_filter_run(project_id=project_id, run_id=run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {'result': result}


@app.get('/api/ui_state')
def get_ui_state(project_id: Optional[str] = Query(default=None)) -> dict[str, Any]:
    return {'state': storage.get_ui_state(project_id)}


@app.post('/api/ui_state')
def set_ui_state(payload: UIStateIn) -> dict[str, Any]:
    storage.set_ui_state(state=payload.state, project_id=payload.project_id)
    return {'ok': True}


@app.post('/api/export')
def export_project(payload: ExportIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') == 'video':
        _raise_video_annotation_removed()

    images = project.get('images', [])
    all_annotations = storage.all_annotations(payload.project_id)

    include_bbox = bool(payload.include_bbox)
    include_mask = bool(payload.include_mask)
    if not include_bbox and not include_mask:
        raise HTTPException(status_code=400, detail='at least one of include_bbox/include_mask must be true')
    if payload.format == 'yolo' and include_bbox and include_mask:
        raise HTTPException(status_code=400, detail='YOLO cannot export bbox and mask together')

    out_dir = _resolve_output_dir(project, payload.output_dir)
    fmt = str(payload.format).lower()

    if fmt == 'json':
        out = export_coco(
            project=project,
            images=images,
            all_annotations=all_annotations,
            output_dir=out_dir,
            include_bbox=include_bbox,
            include_mask=include_mask,
        )
    elif fmt == 'coco':
        out = export_coco(
            project=project,
            images=images,
            all_annotations=all_annotations,
            output_dir=out_dir,
            include_bbox=include_bbox,
            include_mask=include_mask,
        )
    elif fmt == 'yolo':
        mode = 'seg' if include_mask else 'det'
        out = export_yolo(
            project=project,
            images=images,
            all_annotations=all_annotations,
            output_dir=out_dir,
            mode=mode,
        )
    else:
        raise HTTPException(status_code=400, detail='unsupported export format')

    return {'ok': True, 'output': str(out)}


def create_app() -> FastAPI:
    return app

frontend_dir = BASE_DIR / 'frontend'
if frontend_dir.exists():
    app.mount('/', StaticFiles(directory=str(frontend_dir), html=True), name='frontend')
else:
    logger.warning(f'Frontend directory not found at {frontend_dir}')
