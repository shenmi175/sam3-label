
from __future__ import annotations

import base64
import logging
import mimetypes
import os
import shutil
import subprocess
import threading
import time
import re
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from app.exports import export_coco, export_video_json, export_yolo
from app.sam3_client import Sam3Client
from app.storage import Storage
from app.utils import IMAGE_EXTENSIONS, ensure_dir, list_video_files_recursive, new_id, norm_text, now_ts


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ensure_dir(BASE_DIR / 'data')
DEFAULT_API_BASE_URL = 'http://172.16.1.65:8001'


logger = logging.getLogger('web_auto')
logger.setLevel(logging.INFO)
if not logger.handlers:
    fmt = logging.Formatter('%(asctime)s | %(levelname)s | %(name)s | %(message)s')
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    logger.addHandler(ch)


storage = Storage(DATA_DIR)
sam3 = Sam3Client(timeout_sec=180)
CURRENT_DATA_DIR = Path(DATA_DIR)

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


class OpenProjectIn(BaseModel):
    name: str = ''
    project_type: str = Field(default='image', pattern='^(image|video)$')
    image_dir: str = ''
    video_path: str = ''
    save_dir: Optional[str] = None
    classes_text: str = ''


class UpdateClassesIn(BaseModel):
    classes_text: str = ''


class ImportImagesIn(BaseModel):
    source_dir: str


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
    all_images: bool = False
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


class ExportIn(BaseModel):
    project_id: str
    format: str = Field(pattern='^(coco|json|yolo)$')
    include_bbox: bool = True
    include_mask: bool = False
    output_dir: Optional[str] = None


class SmartFilterIn(BaseModel):
    project_id: str
    merge_mode: str = Field(default='same_class', pattern='^(same_class|canonical_class)$')
    coverage_threshold: float = 0.98
    canonical_class: str = ''
    source_classes: list[str] = Field(default_factory=list)
    area_mode: str = Field(default='instance', pattern='^(instance|bbox)$')
    preview_token: str = ''


class HealthApiIn(BaseModel):
    api_base_url: str = DEFAULT_API_BASE_URL


class CacheDirUpdateIn(BaseModel):
    cache_dir: str


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
    impacted_alias_norm: set[str] = set()
    for c in impacted_classes:
        raw = str(c).strip()
        if not raw:
            continue
        n = norm_text(raw)
        if n:
            impacted_norm.add(n)
        # For renamed multi-word classes (e.g. "human face"), also clear
        # stale single-word legacy labels (e.g. "face") on overwrite.
        parts = [norm_text(p) for p in re.split(r'[\s_\-]+', raw) if norm_text(p)]
        if len(parts) >= 2:
            impacted_alias_norm.add(parts[-1])

    if not impacted_norm and not impacted_alias_norm:
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
        if cls_norm in impacted_alias_norm:
            continue
        kept.append(a)

    kept.extend(new_annotations)
    return kept


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
        'new_annotations': 0,
        'current_image_id': '',
        'current_image_rel_path': '',
        'started_at': '',
        'updated_at': now_ts(),
        'finished_at': '',
        'error': '',
        'errors': [],
        'params': {},
        'payload_dict': {},
        'pending_image_ids': [],
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
        return out


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
        return out


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
        return out


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
    merge_mode: str,
    coverage_threshold: float,
    canonical_class: str,
    source_classes: list[str],
    area_mode: str,
) -> str:
    source = sorted(str(x).strip() for x in source_classes if str(x).strip())
    return '|'.join(
        [
            str(merge_mode or 'same_class').strip().lower(),
            f'{float(coverage_threshold):.6f}',
            str(canonical_class or '').strip(),
            ','.join(source),
            str(area_mode or 'instance').strip().lower(),
        ]
    )


def _normalize_smart_filter_payload(payload: SmartFilterIn) -> dict[str, Any]:
    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
    canonical_class = str(payload.canonical_class or '').strip()
    source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
    area_mode = str(payload.area_mode or 'instance').strip().lower()
    if merge_mode == 'canonical_class' and not canonical_class:
        raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
    if merge_mode == 'canonical_class' and not source_classes:
        raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')
    return {
        'project_id': str(payload.project_id or '').strip(),
        'merge_mode': merge_mode,
        'coverage_threshold': coverage_threshold,
        'canonical_class': canonical_class,
        'source_classes': source_classes,
        'area_mode': area_mode,
        'preview_token': str(payload.preview_token or '').strip(),
        'signature': _smart_filter_signature(
            merge_mode=merge_mode,
            coverage_threshold=coverage_threshold,
            canonical_class=canonical_class,
            source_classes=source_classes,
            area_mode=area_mode,
        ),
    }


def _analyze_smart_filter_project(
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

    for idx, image in enumerate(images, start=1):
        image_id = str(image.get('id') or '')
        if not image_id:
            continue
        rel_path = str(image.get('rel_path') or image_id)
        annotations = storage.load_annotations(str(project.get('id') or ''), image_id)
        analysis = _analyze_smart_merge_annotations(
            annotations,
            merge_mode=str(config.get('merge_mode') or 'same_class'),
            coverage_threshold=float(config.get('coverage_threshold') or 0.98),
            canonical_class=str(config.get('canonical_class') or ''),
            source_classes=list(config.get('source_classes') or []),
            area_mode=str(config.get('area_mode') or 'instance'),
        )
        removed = analysis.get('removed_annotations', [])
        pairs = analysis.get('pairs', [])
        relabeled = analysis.get('relabeled_annotations', [])
        kept_annotations = analysis.get('kept_annotations', annotations)
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
                }
            )
            apply_items.append(
                {
                    'image_id': image_id,
                    'rel_path': rel_path,
                    'removed_count': remove_count,
                    'relabel_count': relabel_count,
                    'kept_annotations': kept_annotations if isinstance(kept_annotations, list) else annotations,
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
    preview_entry = {
        'preview_token': preview_token,
        'project_id': config['project_id'],
        'project_content_rev': project_rev,
        'signature': str(config['signature']),
        'config': {
            'merge_mode': config['merge_mode'],
            'coverage_threshold': float(config['coverage_threshold']),
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
        },
        'result': analysis,
    }
    with SMART_FILTER_JOB_LOCK:
        SMART_FILTER_PREVIEW_CACHE[config['project_id']] = preview_entry

    candidate_count = int(analysis.get('candidate_count') or 0)
    relabel_count = int(analysis.get('relabel_count') or 0)
    return {
        'project_id': config['project_id'],
        'preview_token': preview_token,
        'project_content_rev': project_rev,
        'image_count': int(analysis.get('image_count') or 0),
        'candidate_count': candidate_count,
        'relabel_count': relabel_count,
        'items': analysis.get('items', []),
        'rule': {
            'merge_mode': config['merge_mode'],
            'same_class': config['merge_mode'] == 'same_class',
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
            'small_box_covered_by_large_gte': float(config['coverage_threshold']),
            'keep': 'larger_area',
        },
        'message': (
            f'智能过滤分析完成: 可移除 {candidate_count} 个目标'
            + (f'，改类 {relabel_count} 个目标' if relabel_count > 0 else '')
            if (candidate_count > 0 or relabel_count > 0)
            else '智能过滤分析完成: 无可合并目标'
        ),
    }


def _run_smart_filter_apply_job(payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
    payload = SmartFilterIn(**payload_dict)
    config = _normalize_smart_filter_payload(payload)
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
    changed_images = 0
    removed_annotations = 0
    relabeled_annotations = 0
    items: list[dict[str, Any]] = []

    if progress_cb:
        progress_cb(
            message=f'准备执行智能过滤，待写回 {total} 张',
            progress_done=0,
            progress_total=total,
        )

    for idx, item in enumerate(apply_items, start=1):
        image_id = str(item.get('image_id') or '')
        rel_path = str(item.get('rel_path') or image_id)
        kept_annotations = item.get('kept_annotations', [])
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
                message=f'写回 {idx}/{total}: {rel_path}',
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
    return {
        'project_id': config['project_id'],
        'changed_images': changed_images,
        'removed_annotations': removed_annotations,
        'relabeled_annotations': relabeled_annotations,
        'rule': {
            'merge_mode': config['merge_mode'],
            'canonical_class': config['canonical_class'],
            'source_classes': list(config['source_classes']),
            'area_mode': config['area_mode'],
            'small_box_covered_by_large_gte': float(config['coverage_threshold']),
        },
        'items': items,
        'message': (
            f'智能过滤完成: 处理 {changed_images} 张图片, 移除 {removed_annotations} 个目标'
            + (f', 改类 {relabeled_annotations} 个目标' if relabeled_annotations > 0 else '')
        ),
    }


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
        state = _smart_filter_job_state_default(job_id=job_id, project_id=project_id, job_type=job_type)
        state['payload_dict'] = dict(payload_dict)
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
                result = worker(payload_dict, lambda **kw: _update_smart_filter_job_state(job_id, **kw))
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


def _infer_job_image_ids(items: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for image in items:
        image_id = str(image.get('id') or '').strip()
        if image_id:
            out.append(image_id)
    return out


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
    if not pending_image_ids:
        raise HTTPException(status_code=409, detail='paused infer job has no remaining images to continue')

    overrides = payload.model_dump(exclude_unset=True, exclude_none=True)
    merged = _merge_infer_resume_payload(job_type, paused.get('payload_dict') or {}, overrides)

    if job_type == 'text_batch':
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
                cover = _bbox_intersection_area(bigger['bbox'], smaller['bbox']) / smaller_area
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
                    cover = _bbox_intersection_area(bigger['bbox'], smaller['bbox']) / smaller_area
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
        raise HTTPException(status_code=409, detail='cannot change cache_dir while background jobs are running')


def _set_storage_data_dir(path_text: str) -> Path:
    global storage, CURRENT_DATA_DIR
    new_dir = ensure_dir(Path(str(path_text or '')).expanduser().resolve())
    storage = Storage(new_dir)
    CURRENT_DATA_DIR = new_dir
    return new_dir


def _cache_dir_info() -> dict[str, Any]:
    return {
        'cache_dir': str(CURRENT_DATA_DIR),
        'default_dir': str(BASE_DIR),
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
            # Text inference should reflect latest run result directly.
            merged = converted
        else:
            merged = _merge_visual_annotations(
                old,
                new_annotations=converted,
                points=infer_points,
                boxes=infer_boxes,
            )
        storage.save_annotations(str(project.get('id')), str(image.get('id')), merged)
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


def _run_infer_batch(
    payload: InferBatchIn,
    *,
    progress_cb: Optional[Callable[..., None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    resume_state: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='batch infer currently supports image project only')

    classes = [str(c).strip() for c in payload.classes if str(c).strip()]
    if not classes:
        classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]
    if not classes:
        raise HTTPException(status_code=400, detail='no classes selected')

    images = project.get('images', [])
    if payload.all_images:
        target_images = images
    else:
        wanted = {str(x) for x in payload.image_ids}
        target_images = [img for img in images if str(img.get('id') or '') in wanted]
    if not target_images:
        raise HTTPException(status_code=400, detail='no target images')

    batch_size = max(1, int(payload.batch_size or 1))
    prior = resume_state if isinstance(resume_state, dict) else {}
    succeeded = max(0, int(prior.get('succeeded') or 0))
    failed = max(0, int(prior.get('failed') or 0))
    total_new = max(0, int(prior.get('new_annotations') or 0))
    errors = list(prior.get('errors', [])) if isinstance(prior.get('errors'), list) else []
    processed = max(0, int(prior.get('progress_done') or 0))
    total = max(int(prior.get('progress_total') or 0), processed + len(target_images))
    prompt = ', '.join(classes)
    pending_images = list(target_images)

    if progress_cb:
        progress_cb(
            message=f'准备文本批量推理，剩余 {len(target_images)} 张',
            progress_done=processed,
            progress_total=total,
            requested=total,
            batch_size=batch_size,
            succeeded=succeeded,
            failed=failed,
            new_annotations=total_new,
            pending_image_ids=_infer_job_image_ids(pending_images),
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
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    pending_image_ids=_infer_job_image_ids(pending_images),
                )
            raise InferJobPaused('已停止，可调整参数后继续')
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
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        current_image_id=str(image.get('id') or ''),
                        current_image_rel_path=rel_path,
                        pending_image_ids=_infer_job_image_ids(pending_images),
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
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        pending_image_ids=_infer_job_image_ids(pending_images),
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
                    raise RuntimeError(str(item.get('error') or 'remote batch item failed'))
                result = item.get('result', {})
                if not isinstance(result, dict):
                    raise RuntimeError('remote batch item result is invalid')
                detections = result.get('detections', [])
                detections = detections if isinstance(detections, list) else []
                converted = _convert_detections(detections=detections, classes=classes, forced_class='')
                storage.save_annotations(payload.project_id, image_id, converted)
                succeeded += 1
                total_new += len(converted)
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
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                    pending_image_ids=_infer_job_image_ids(pending_images),
                )

    summary = (
        f'文本批推完成: 成功 {succeeded}, 失败 {failed}, 新增 {total_new}, batch={batch_size}'
        if failed > 0
        else f'文本批推完成: 成功 {succeeded}, 新增 {total_new}, batch={batch_size}'
    )
    return {
        'project_id': payload.project_id,
        'requested': total,
        'batch_size': batch_size,
        'succeeded': succeeded,
        'failed': failed,
        'new_annotations': total_new,
        'errors': errors,
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

    batch_size = max(1, int(payload.batch_size or 1))
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
            succeeded=succeeded,
            failed=failed,
            new_annotations=total_new,
            pending_image_ids=_infer_job_image_ids(pending_images),
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
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    pending_image_ids=_infer_job_image_ids(pending_images),
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
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        current_image_id=str(image.get('id') or ''),
                        current_image_rel_path=rel_path,
                        pending_image_ids=_infer_job_image_ids(pending_images),
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
                        succeeded=succeeded,
                        failed=failed,
                        new_annotations=total_new,
                        pending_image_ids=_infer_job_image_ids(pending_images),
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
                    succeeded=succeeded,
                    failed=failed,
                    new_annotations=total_new,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                    pending_image_ids=_infer_job_image_ids(pending_images),
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
        'batch_size': batch_size,
        'succeeded': succeeded,
        'failed': failed,
        'new_annotations': total_new,
        'strategy': 'remote_visual_prompt_embedding_batch_chunked',
        'errors': errors,
        'message': summary,
    }


@app.on_event('startup')
def on_startup() -> None:
    _recover_video_states_on_startup()
    return None


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
        'projects': len(storage.list_projects()),
        'allowed_origins': ALLOWED_ORIGINS,
    }


@app.get('/api/config/cache_dir')
def get_cache_dir_config() -> dict[str, Any]:
    return _cache_dir_info()


@app.post('/api/config/cache_dir')
def set_cache_dir_config(payload: CacheDirUpdateIn) -> dict[str, Any]:
    with CONFIG_LOCK:
        _ensure_no_active_jobs_for_config_change()
        new_dir = _set_storage_data_dir(payload.cache_dir)
    return {
        'ok': True,
        'cache_dir': str(new_dir),
        'message': 'Storage directory updated successfully.',
    }


@app.get('/api/projects')
def list_projects() -> dict[str, Any]:
    return {'projects': storage.list_projects()}


@app.get('/api/projects/{project_id}')
def get_project(project_id: str, include_images: bool = Query(default=True)) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=bool(include_images))
    return {'project': project}


@app.post('/api/projects/open')
def open_project(payload: OpenProjectIn) -> dict[str, Any]:
    try:
        logger.info(
            'open project name=%s type=%s image_dir=%s video_path=%s save_dir=%s',
            payload.name,
            payload.project_type,
            payload.image_dir,
            payload.video_path,
            payload.save_dir,
        )
        project = storage.create_project(
            name=payload.name,
            image_dir=payload.image_dir,
            save_dir=payload.save_dir,
            classes_text=payload.classes_text,
            project_type=payload.project_type,
            video_path=payload.video_path,
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
) -> dict[str, Any]:
    try:
        items, total, safe_offset, safe_limit, image_index = storage.get_project_images_page(
            project_id,
            offset=offset,
            limit=limit,
            image_id=image_id,
        )
        return {
            'items': items,
            'total': total,
            'offset': safe_offset,
            'limit': safe_limit,
            'image_index': image_index,
        }
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
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')
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


@app.get('/api/projects/{project_id}/video/file')
def get_video_file(project_id: str, request: Request) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    try:
        video_path = _resolve_project_video_file(project)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    file_size = int(video_path.stat().st_size)
    media_type = mimetypes.guess_type(str(video_path))[0] or 'video/mp4'
    headers = {'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'}
    range_header = str(request.headers.get('range') or '').strip()
    if not range_header:
        return FileResponse(str(video_path), media_type=media_type, filename=video_path.name, headers=headers)

    try:
        start, end = _parse_range_header(range_header, file_size)
    except ValueError as exc:
        raise HTTPException(status_code=416, detail=str(exc)) from exc

    headers.update(
        {
            'Content-Range': f'bytes {start}-{end}/{file_size}',
            'Content-Length': str((end - start) + 1),
        }
    )
    return StreamingResponse(
        _iter_file_range(video_path, start, end),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


@app.get('/api/projects/{project_id}/video/stream')
def get_video_stream(project_id: str, request: Request) -> Response:
    return get_video_file(project_id, request)


@app.get('/api/projects/{project_id}/video/frame/{frame_index}')
def get_video_frame(project_id: str, frame_index: int) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    try:
        video_path = _resolve_project_video_file(project)
        jpeg = _read_video_frame_jpeg(str(video_path), frame_index)
        return Response(content=jpeg, media_type='image/jpeg', headers={'Cache-Control': 'no-cache'})
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get('/api/projects/{project_id}/video/annotations')
def get_video_annotations(project_id: str) -> dict[str, Any]:
    payload = _build_video_annotations_payload(project_id)
    try:
        path = storage.video_annotation_json_path(project_id)
    except ValueError:
        path = Path('')
    return {
        'annotations': payload,
        'annotation_json_path': str(path) if str(path) else '',
    }


@app.post('/api/projects/{project_id}/video/annotations/save')
def save_video_annotations(project_id: str, payload: VideoAnnotationsSaveIn) -> dict[str, Any]:
    if str(payload.project_id or '').strip() != str(project_id or '').strip():
        raise HTTPException(status_code=400, detail='project_id in path/body mismatch')
    out = _save_video_annotations_payload(payload)
    try:
        path = storage.video_annotation_json_path(project_id)
    except ValueError:
        path = Path('')
    return {
        'ok': True,
        'annotations': out,
        'annotation_json_path': str(path) if str(path) else '',
    }


@app.post('/api/projects/{project_id}/video/transcode_h264')
def transcode_video_h264(project_id: str) -> dict[str, Any]:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    try:
        video_path = _resolve_project_video_file(project)
        out = _transcode_video_h264_inplace(video_path)
        refreshed = _get_project_or_404(project_id, enrich=False, include_images=False)
        return {'ok': True, 'project': refreshed, 'video': out}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get('/api/projects/{project_id}/images/{image_id}/file')
def get_image_file(project_id: str, image_id: str) -> Response:
    project = _get_project_or_404(project_id, enrich=False, include_images=False)
    image = _get_image_or_404(project, image_id)
    abs_path_raw = str(image.get('abs_path') or '').strip()
    if abs_path_raw:
        path = Path(abs_path_raw).expanduser().resolve()
        if path.exists() and path.is_file():
            return FileResponse(str(path))

    raise HTTPException(status_code=404, detail='image file not found')


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
    return {'ok': True}


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
    return {'ok': True, 'saved_annotations': merged, 'added': len(incoming)}


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


@app.post('/api/filter/intelligent/preview')
def preview_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'image':
        raise HTTPException(status_code=400, detail='only image project is supported')

    merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
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
    images = project.get('images', [])
    all_annotations = storage.all_annotations(payload.project_id)

    if project.get('project_type') == 'video':
        if str(payload.format).lower() != 'json':
            raise HTTPException(status_code=400, detail='video project only supports json export')
        out_dir = _resolve_output_dir(project, payload.output_dir)
        out = export_video_json(
            project=project,
            images=images,
            all_annotations=all_annotations,
            output_dir=out_dir,
        )
        return {'ok': True, 'output': str(out)}

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


@app.get('/api/video/jobs/{project_id}')
def get_video_job(project_id: str) -> dict[str, Any]:
    return {'job': _get_video_state(project_id)}


@app.post('/api/video/jobs/start')
def start_video_job(payload: VideoJobStartIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')

    state = _video_default_state(project)
    state.update(
        {
            'status': 'queued',
            'mode': str(payload.mode or 'keyframe').strip().lower(),
            'classes': [str(x).strip() for x in payload.classes if str(x).strip()],
            'prompt_mode': str(payload.prompt_mode or 'text').strip().lower(),
            'prompt_frame_index': int(payload.prompt_frame_index if payload.prompt_frame_index is not None else payload.start_frame_index),
            'active_class': str(payload.active_class or '').strip(),
            'prompt_points': payload.points,
            'prompt_boxes': payload.boxes,
            'api_base_url': str(payload.api_base_url or DEFAULT_API_BASE_URL).strip(),
            'threshold': float(payload.threshold),
            'imgsz': max(128, int(payload.imgsz or 0)),
            'segment_size_frames': int(payload.segment_size_frames),
            'start_frame_index': int(payload.start_frame_index),
            'end_frame_index': int(payload.end_frame_index if payload.end_frame_index is not None else max(len(project.get('images', [])) - 1, 0)),
            'next_frame_index': int(payload.start_frame_index),
            'current_frame_index': -1,
            'processed_frames': 0,
            'progress_pct': 0.0,
            'elapsed_ms': 0.0,
            'avg_frame_ms': 0.0,
            'fps': 0.0,
            'started_at': '',
            'ended_at': '',
            'last_error': '',
            'session_id': '',
            'prompt_added': False,
            'updated_at': now_ts(),
        }
    )
    storage.set_video_job_state(payload.project_id, state)
    try:
        _spawn_video_worker(payload.project_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {'job': _get_video_state(payload.project_id)}


@app.post('/api/video/jobs/pause')
@app.post('/api/video/jobs/stop')
def pause_video_job(payload: VideoJobControlIn) -> dict[str, Any]:
    state = _get_video_state(payload.project_id)
    if not _pause_video_worker(payload.project_id):
        return {'job': state}
    state['status'] = 'pausing'
    state['updated_at'] = now_ts()
    storage.set_video_job_state(payload.project_id, state)
    return {'job': _get_video_state(payload.project_id)}


@app.post('/api/video/jobs/resume')
def resume_video_job(payload: VideoJobResumeIn) -> dict[str, Any]:
    project = _get_project_or_404(payload.project_id)
    if project.get('project_type') != 'video':
        raise HTTPException(status_code=400, detail='project is not video type')
    state = storage.get_video_job_state(payload.project_id)
    if not state:
        state = _video_default_state(project)

    before_signature = {
        'api_base_url': str(state.get('api_base_url') or DEFAULT_API_BASE_URL).strip(),
        'threshold': float(state.get('threshold') or 0.5),
        'imgsz': max(128, int(state.get('imgsz') or 640)),
        'prompt_mode': str(state.get('prompt_mode') or 'text').strip().lower(),
        'prompt_frame_index': int(state.get('prompt_frame_index') or 0),
        'active_class': str(state.get('active_class') or '').strip(),
        'classes': [str(x).strip() for x in state.get('classes', []) if str(x).strip()],
        'prompt_boxes': _normalize_prompt_boxes(state.get('prompt_boxes', [])),
    }

    overrides = payload.model_dump(exclude_unset=True, exclude_none=True)
    if 'classes' in overrides:
        state['classes'] = [str(x).strip() for x in overrides.get('classes', []) if str(x).strip()]
    if 'segment_size_frames' in overrides:
        state['segment_size_frames'] = _normalize_segment_size(overrides.get('segment_size_frames'))
    if 'threshold' in overrides:
        state['threshold'] = float(overrides.get('threshold'))
    if 'imgsz' in overrides:
        state['imgsz'] = max(128, int(overrides.get('imgsz') or 0))
    if 'api_base_url' in overrides:
        state['api_base_url'] = str(overrides.get('api_base_url') or '').strip() or DEFAULT_API_BASE_URL
    if 'prompt_mode' in overrides:
        state['prompt_mode'] = str(overrides.get('prompt_mode') or 'text').strip().lower()
    if 'prompt_frame_index' in overrides:
        state['prompt_frame_index'] = max(0, int(overrides.get('prompt_frame_index') or 0))
    if 'active_class' in overrides:
        state['active_class'] = str(overrides.get('active_class') or '').strip()
    if 'boxes' in overrides:
        state['prompt_boxes'] = overrides.get('boxes') or []
        state['prompt_points'] = []

    if str(state.get('prompt_mode') or 'text').strip().lower() == 'boxes':
        active = str(state.get('active_class') or '').strip()
        if active:
            state['classes'] = [active]
    else:
        state['active_class'] = ''

    after_signature = {
        'api_base_url': str(state.get('api_base_url') or DEFAULT_API_BASE_URL).strip(),
        'threshold': float(state.get('threshold') or 0.5),
        'imgsz': max(128, int(state.get('imgsz') or 640)),
        'prompt_mode': str(state.get('prompt_mode') or 'text').strip().lower(),
        'prompt_frame_index': int(state.get('prompt_frame_index') or 0),
        'active_class': str(state.get('active_class') or '').strip(),
        'classes': [str(x).strip() for x in state.get('classes', []) if str(x).strip()],
        'prompt_boxes': _normalize_prompt_boxes(state.get('prompt_boxes', [])),
    }

    if before_signature != after_signature:
        state['session_id'] = ''
        state['prompt_added'] = False

    state['status'] = 'queued'
    state['last_error'] = ''
    state['updated_at'] = now_ts()
    storage.set_video_job_state(payload.project_id, state)
    try:
        _spawn_video_worker(payload.project_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {'job': _get_video_state(payload.project_id)}

def create_app() -> FastAPI:
    return app
