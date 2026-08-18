from __future__ import annotations

import hmac
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import config as app_config
from app import lifecycle
from app.engine import MODEL_DOWNLOAD_URLS, SUPPORTED_SEG_MODELS, engine
from app.pose_engine import POSE_DETECTOR_REPO_ID, POSE_MODEL_DOWNLOAD_URL, pose_engine

logger = logging.getLogger(__name__)


def _configured_api_token() -> str:
    return os.getenv("SAPIENS_API_TOKEN", "").strip()


def _request_api_token(request: Request) -> str:
    auth_header = str(request.headers.get("authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return str(request.headers.get("x-sapiens-api-key") or "").strip()


def _auth_public_path(path: str) -> bool:
    return path == "/health"


def _allowed_roots() -> list[Path]:
    raw = os.getenv("SAPIENS_ALLOWED_DATA_ROOTS", "").strip()
    roots: list[Path] = []
    for item in raw.split(os.pathsep):
        item = item.strip()
        if not item:
            continue
        try:
            root = Path(item).expanduser().resolve()
        except Exception:
            continue
        if root not in roots:
            roots.append(root)
    return roots


def _path_is_allowed(path: Path) -> bool:
    roots = _allowed_roots()
    if not roots:
        return True
    try:
        resolved = path.expanduser().resolve()
    except Exception:
        return False
    return any(resolved == root or root in resolved.parents for root in roots)


class BatchSegIn(BaseModel):
    image_paths: list[str] = Field(default_factory=list)
    model_name: str = ""
    min_area: float = 64.0
    max_detections: int = 300
    include_label_map: bool = False


class JobStopIn(BaseModel):
    job_id: str


class CheckpointDownloadIn(BaseModel):
    model_name: str = ""


app = FastAPI(title="sapiens-api", version="1.1", description="Internal Sapiens2 segmentation and pose API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_token(request: Request, call_next):
    token = _configured_api_token()
    if token and not _auth_public_path(request.url.path):
        supplied = _request_api_token(request)
        if not supplied or not hmac.compare_digest(supplied, token):
            # Return directly: raising HTTPException inside middleware bypasses
            # FastAPI's exception handlers and would surface as a 500.
            return JSONResponse(status_code=401, content={"detail": "invalid sapiens api token"})
    return await call_next(request)


_JOBS_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}
_JOB_STOPS: dict[str, threading.Event] = {}
_DOWNLOADS_LOCK = threading.Lock()
_DOWNLOADS: dict[str, dict[str, Any]] = {}
_DOWNLOAD_BY_MODEL: dict[str, str] = {}


def _startup_load_engine(eng: Any, name: str, download_hint: str) -> None:
    """Eager-load one engine at startup.

    Missing weights degrade the engine to ``weights_missing`` (survive so the
    download endpoints stay reachable) unless SAPIENS_STRICT_EAGER_LOAD=1.
    Weights present but load/verify failure exits the process (fail-fast).
    """
    if not eng.weights_ready():
        expected = ", ".join(eng.expected_weight_paths())
        if app_config.strict_eager_load():
            logger.error(
                "FATAL: %s weights missing and SAPIENS_STRICT_EAGER_LOAD=1; expected paths: %s; "
                "fix by downloading weights (POST %s) or mounting them, then restart",
                name, expected, download_hint,
            )
            os._exit(1)
        logger.warning(
            "%s weights missing; engine degraded to weights_missing (service stays up for weight download). "
            "Expected paths: %s. Download via POST %s, then call POST /v1/warmup",
            name, expected, download_hint,
        )
        eng.weights_missing = True
        return
    try:
        lifecycle.eager_load(eng, name=name)
    except lifecycle.EagerLoadFailed as exc:
        logger.error("FATAL: %s — process will exit with code 1", exc)
        os._exit(1)


@app.on_event("startup")
def startup_eager_load() -> None:
    if not app_config.eager_load():
        logger.info("SAPIENS_EAGER_LOAD disabled; engines will load lazily on first request")
        return
    # Engines are loaded independently: missing seg weights must not block pose.
    _startup_load_engine(engine, "segmentation", "/v1/checkpoints/download")
    _startup_load_engine(pose_engine, "pose", "/v1/pose/checkpoints/download")


def _engine_effective_status(eng: Any) -> str:
    """Per-engine status folded into the merged /health status."""
    state = eng.state
    if state == "loaded":
        return "loaded"
    if state == "load_failed":
        return "load_failed"
    if eng.weights_missing:
        return "weights_missing"
    if not eng.repo_exists():
        # Legacy "missing_repo" semantics fold into load_failed; repo_exists
        # fields in the payload keep the detail.
        return "load_failed"
    if state == "loading":
        return "loading"
    return "not_loaded"


def _merged_engine_status() -> str:
    """Merge both engines: load_failed > weights_missing > ok (both loaded) > loading > not_loaded."""
    statuses = [_engine_effective_status(engine), _engine_effective_status(pose_engine)]
    if "load_failed" in statuses:
        return "load_failed"
    if "weights_missing" in statuses:
        return "weights_missing"
    if all(item == "loaded" for item in statuses):
        return "ok"
    if "loading" in statuses:
        return "loading"
    return "not_loaded"


def _merged_load_error() -> str:
    parts = [item for item in (engine.load_error, pose_engine.load_error) if item]
    return " | ".join(parts)


@app.get("/health")
def health() -> dict[str, Any]:
    status = engine.status()
    status["pose"] = pose_engine.status()
    status["token_required"] = bool(_configured_api_token())
    status["allowed_data_roots"] = [str(root) for root in _allowed_roots()]
    # Top-level lifecycle status (merged over both engines); the legacy
    # per-engine "status"/"missing_repo" detail survives in repo_exists fields
    # and in status["pose"].
    status["status"] = _merged_engine_status()
    status["mode"] = "eager" if app_config.eager_load() else "lazy"
    status["last_load_error"] = _merged_load_error()
    return status


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {"models": engine.models(), "default_model": engine.default_model_name()}


def _checkpoint_status(model_name: str = "") -> dict[str, Any]:
    selected = str(model_name or engine.default_model_name()).strip()
    if selected not in SUPPORTED_SEG_MODELS:
        raise HTTPException(status_code=400, detail=f"unsupported model_name: {selected}")
    cfg = engine._build_config(selected)
    path = cfg.checkpoint_path
    part_path = path.with_suffix(path.suffix + ".part")
    size = path.stat().st_size if path.exists() else 0
    part_size = part_path.stat().st_size if part_path.exists() else 0
    job_id = _DOWNLOAD_BY_MODEL.get(selected, "")
    job = _DOWNLOADS.get(job_id) if job_id else None
    return {
        "model_name": selected,
        "checkpoint_path": str(path),
        "checkpoint_exists": path.exists(),
        "checkpoint_size_bytes": size,
        "partial_path": str(part_path),
        "partial_size_bytes": part_size,
        "download_url": MODEL_DOWNLOAD_URLS[selected],
        "download_job": job,
    }


@app.get("/v1/checkpoints/status")
def checkpoint_status(model_name: str = "") -> dict[str, Any]:
    return _checkpoint_status(model_name)


def _set_download(job_id: str, **values: Any) -> None:
    with _DOWNLOADS_LOCK:
        job = _DOWNLOADS.setdefault(job_id, {})
        job.update(values)
        job["updated_at"] = time.time()


def _download_checkpoint(job_id: str, model_name: str) -> None:
    cfg = engine._build_config(model_name)
    url = MODEL_DOWNLOAD_URLS[model_name]
    target = cfg.checkpoint_path
    tmp = target.with_suffix(target.suffix + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)
    token = os.getenv("HF_TOKEN", "").strip() or os.getenv("HUGGINGFACE_HUB_TOKEN", "").strip()
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    downloaded = tmp.stat().st_size if tmp.exists() else 0
    if downloaded > 0:
        headers["Range"] = f"bytes={downloaded}-"
    _set_download(
        job_id,
        status="running",
        model_name=model_name,
        url=url,
        checkpoint_path=str(target),
        downloaded_bytes=downloaded,
        total_bytes=0,
        percent=0.0,
        error="",
    )
    try:
        with requests.get(url, headers=headers, stream=True, allow_redirects=True, timeout=(20, 120)) as response:
            if response.status_code not in {200, 206}:
                raise RuntimeError(f"download HTTP {response.status_code}: {response.text[:300]}")
            if response.status_code == 200:
                downloaded = 0
                mode = "wb"
            else:
                mode = "ab"
            content_length = int(response.headers.get("content-length") or 0)
            total = downloaded + content_length if response.status_code == 206 else content_length
            _set_download(job_id, downloaded_bytes=downloaded, total_bytes=total)
            last_update = 0.0
            with tmp.open(mode) as f:
                for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    now = time.monotonic()
                    if now - last_update >= 0.5:
                        percent = (downloaded * 100.0 / total) if total > 0 else 0.0
                        _set_download(job_id, downloaded_bytes=downloaded, total_bytes=total, percent=round(percent, 2))
                        last_update = now
            os.replace(tmp, target)
            _set_download(
                job_id,
                status="completed",
                downloaded_bytes=target.stat().st_size,
                total_bytes=target.stat().st_size,
                percent=100.0,
                finished_at=time.time(),
            )
    except Exception as exc:  # noqa: BLE001
        _set_download(job_id, status="failed", error=str(exc))


@app.post("/v1/checkpoints/download")
def start_checkpoint_download(payload: CheckpointDownloadIn) -> dict[str, Any]:
    selected = str(payload.model_name or engine.default_model_name()).strip()
    if selected not in SUPPORTED_SEG_MODELS:
        raise HTTPException(status_code=400, detail=f"unsupported model_name: {selected}")
    status = _checkpoint_status(selected)
    if status["checkpoint_exists"]:
        return {"job": {"status": "completed", "percent": 100.0, **status}, "checkpoint": status}

    with _DOWNLOADS_LOCK:
        existing_id = _DOWNLOAD_BY_MODEL.get(selected)
        existing = _DOWNLOADS.get(existing_id or "")
        if existing and existing.get("status") in {"queued", "running"}:
            return {"job": existing, "checkpoint": status}
        job_id = f"sapiens_ckpt_{uuid.uuid4().hex[:12]}"
        _DOWNLOAD_BY_MODEL[selected] = job_id
        _DOWNLOADS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "model_name": selected,
            "checkpoint_path": status["checkpoint_path"],
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "percent": 0.0,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
    thread = threading.Thread(target=_download_checkpoint, args=(job_id, selected), daemon=True)
    thread.start()
    return {"job": _DOWNLOADS[job_id], "checkpoint": status}


@app.get("/v1/checkpoints/download/{job_id}")
def get_checkpoint_download(job_id: str) -> dict[str, Any]:
    with _DOWNLOADS_LOCK:
        job = _DOWNLOADS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="download job not found")
    return {"job": job}


def _pose_checkpoint_status() -> dict[str, Any]:
    status = pose_engine.checkpoint_status()
    job_id = _DOWNLOAD_BY_MODEL.get("pose:sapiens2_5b", "")
    job = _DOWNLOADS.get(job_id) if job_id else None
    status["download_job"] = job
    return status


@app.get("/v1/pose/status")
def pose_status() -> dict[str, Any]:
    status = pose_engine.status()
    status["checkpoint"] = _pose_checkpoint_status()
    return status


def _download_pose_assets(job_id: str) -> None:
    cfg = pose_engine._build_config()
    target = cfg.checkpoint_path
    tmp = target.with_suffix(target.suffix + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)
    cfg.detector_dir.mkdir(parents=True, exist_ok=True)
    token = os.getenv("HF_TOKEN", "").strip() or os.getenv("HUGGINGFACE_HUB_TOKEN", "").strip()
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    downloaded = tmp.stat().st_size if tmp.exists() else 0
    if downloaded > 0:
        headers["Range"] = f"bytes={downloaded}-"
    _set_download(
        job_id,
        status="running",
        task="pose",
        model_name=cfg.model_name,
        url=POSE_MODEL_DOWNLOAD_URL,
        checkpoint_path=str(target),
        detector_repo_id=POSE_DETECTOR_REPO_ID,
        detector_path=str(cfg.detector_dir),
        phase="pose_checkpoint",
        downloaded_bytes=downloaded,
        total_bytes=0,
        percent=0.0,
        error="",
    )
    try:
        if not target.exists():
            with requests.get(POSE_MODEL_DOWNLOAD_URL, headers=headers, stream=True, allow_redirects=True, timeout=(20, 120)) as response:
                if response.status_code not in {200, 206}:
                    raise RuntimeError(f"pose checkpoint download HTTP {response.status_code}: {response.text[:300]}")
                if response.status_code == 200:
                    downloaded = 0
                    mode = "wb"
                else:
                    mode = "ab"
                content_length = int(response.headers.get("content-length") or 0)
                total = downloaded + content_length if response.status_code == 206 else content_length
                _set_download(job_id, downloaded_bytes=downloaded, total_bytes=total)
                last_update = 0.0
                with tmp.open(mode) as f:
                    for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if now - last_update >= 0.5:
                            base_percent = (downloaded * 90.0 / total) if total > 0 else 0.0
                            _set_download(
                                job_id,
                                downloaded_bytes=downloaded,
                                total_bytes=total,
                                percent=round(base_percent, 2),
                            )
                            last_update = now
                os.replace(tmp, target)

        if not pose_engine._detector_exists(cfg.detector_dir):
            _set_download(job_id, phase="detector", percent=92.0)
            from huggingface_hub import snapshot_download

            snapshot_download(
                repo_id=POSE_DETECTOR_REPO_ID,
                local_dir=str(cfg.detector_dir),
                token=token or None,
                resume_download=True,
            )

        _set_download(
            job_id,
            status="completed",
            phase="completed",
            downloaded_bytes=target.stat().st_size,
            total_bytes=target.stat().st_size,
            percent=100.0,
            finished_at=time.time(),
        )
    except Exception as exc:  # noqa: BLE001
        _set_download(job_id, status="failed", error=str(exc))


@app.post("/v1/pose/checkpoints/download")
def start_pose_checkpoint_download() -> dict[str, Any]:
    status = _pose_checkpoint_status()
    if status["checkpoint_exists"] and status["detector_exists"]:
        return {"job": {"status": "completed", "percent": 100.0, **status}, "checkpoint": status}

    with _DOWNLOADS_LOCK:
        key = "pose:sapiens2_5b"
        existing_id = _DOWNLOAD_BY_MODEL.get(key)
        existing = _DOWNLOADS.get(existing_id or "")
        if existing and existing.get("status") in {"queued", "running"}:
            return {"job": existing, "checkpoint": status}
        job_id = f"sapiens_pose_{uuid.uuid4().hex[:12]}"
        _DOWNLOAD_BY_MODEL[key] = job_id
        _DOWNLOADS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "task": "pose",
            "model_name": status["model_name"],
            "checkpoint_path": status["checkpoint_path"],
            "detector_path": status["detector_path"],
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "percent": 0.0,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
    thread = threading.Thread(target=_download_pose_assets, args=(job_id,), daemon=True)
    thread.start()
    return {"job": _DOWNLOADS[job_id], "checkpoint": status}


@app.get("/v1/pose/checkpoints/download/{job_id}")
def get_pose_checkpoint_download(job_id: str) -> dict[str, Any]:
    return get_checkpoint_download(job_id)


def _engine_unavailable_detail(eng: Any, download_hint: str) -> str:
    if eng.weights_missing:
        return f"weights missing; download them via POST {download_hint}, then call POST /v1/warmup"
    return f"last load error: {eng.load_error or 'unknown'}; see /health, then retry or restart"


def _inference_http_error(prefix: str, eng: Any, download_hint: str, exc: Exception) -> HTTPException:
    if lifecycle.is_oom_error(exc):
        lifecycle.cleanup_after_oom()
        return HTTPException(
            status_code=507,
            detail=f"{prefix}: CUDA out of memory; freed cached VRAM, retry or unload other models via /v1/unload",
        )
    if eng.weights_missing or eng.state == "load_failed":
        return HTTPException(
            status_code=503,
            detail=f"{prefix}: engine not ready (state={eng.state}); {_engine_unavailable_detail(eng, download_hint)}",
        )
    return HTTPException(status_code=500, detail=f"{prefix}: {exc}")


@app.post("/v1/pose/infer")
async def infer_pose(
    file: UploadFile = File(...),
    bbox_threshold: float = Form(default=0.3),
    nms_threshold: float = Form(default=0.3),
    keypoint_threshold: float = Form(default=0.3),
) -> dict[str, Any]:
    try:
        payload = await file.read()
        if not payload:
            raise ValueError("empty image file")
        return pose_engine.infer_image(
            payload,
            bbox_threshold=bbox_threshold,
            nms_threshold=nms_threshold,
            keypoint_threshold=keypoint_threshold,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _inference_http_error("pose inference failed", pose_engine, "/v1/pose/checkpoints/download", exc) from exc


@app.post("/v1/seg/infer")
async def infer_segmentation(
    file: UploadFile = File(...),
    model_name: str = Form(default=""),
    min_area: float = Form(default=64.0),
    max_detections: int = Form(default=300),
    include_label_map: bool = Form(default=False),
) -> dict[str, Any]:
    try:
        payload = await file.read()
        if not payload:
            raise ValueError("empty image file")
        return engine.infer_image(
            payload,
            model_name=model_name or None,
            min_area=min_area,
            max_detections=max_detections,
            include_label_map=include_label_map,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _inference_http_error("inference failed", engine, "/v1/checkpoints/download", exc) from exc


@app.post("/v1/warmup")
def warmup_engines() -> Any:
    """Warm up (load + verify) both engines; engines with missing weights are
    reported as weights_missing and are not treated as failures."""
    results: dict[str, Any] = {}
    failure_categories: list[str] = []
    for name, eng, download_hint in (
        ("segmentation", engine, "/v1/checkpoints/download"),
        ("pose", pose_engine, "/v1/pose/checkpoints/download"),
    ):
        if not eng.weights_ready():
            eng.weights_missing = True
            results[name] = {
                "state": "weights_missing",
                "error": "",
                "hint": f"weights missing; download via POST {download_hint}",
            }
            continue
        try:
            eng.warmup()
            results[name] = {"state": eng.state, "error": ""}
        except Exception as exc:  # noqa: BLE001
            category, _guidance = lifecycle.classify_load_error(exc)
            failure_categories.append(category)
            results[name] = {"state": eng.state, "error": str(exc), "error_category": category}
    payload = {"engines": results}
    if failure_categories:
        status_code = 507 if "cuda_oom" in failure_categories else 503
        raise HTTPException(status_code=status_code, detail=payload)
    return payload


@app.post("/v1/unload")
def unload_engines() -> dict[str, Any]:
    """Unload both engines and free their VRAM."""
    engine.unload()
    pose_engine.unload()
    return {
        "engines": {
            "segmentation": {"state": engine.state, "model_loaded": False},
            "pose": {"state": pose_engine.state, "model_loaded": False},
        }
    }


def _set_job(job_id: str, **values: Any) -> None:
    with _JOBS_LOCK:
        job = _JOBS.setdefault(job_id, {})
        job.update(values)
        job["updated_at"] = time.time()


def _run_batch_job(job_id: str, payload: BatchSegIn, stop_event: threading.Event) -> None:
    started = time.time()
    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    _set_job(job_id, status="running", started_at=started, total=len(payload.image_paths), completed=0)
    for index, raw_path in enumerate(payload.image_paths):
        if stop_event.is_set():
            _set_job(job_id, status="stopped", completed=index)
            return
        image_path = Path(raw_path).expanduser()
        try:
            resolved = image_path.resolve()
            if not resolved.exists() or not resolved.is_file():
                raise FileNotFoundError(str(resolved))
            if not _path_is_allowed(resolved):
                raise PermissionError(f"path is outside SAPIENS_ALLOWED_DATA_ROOTS: {resolved}")
            result = engine.infer_path(
                resolved,
                model_name=payload.model_name or None,
                min_area=payload.min_area,
                max_detections=payload.max_detections,
                include_label_map=payload.include_label_map,
            )
            results.append({"image_path": str(resolved), "result": result})
        except Exception as exc:  # noqa: BLE001
            if lifecycle.is_oom_error(exc):
                lifecycle.cleanup_after_oom()
            errors.append({"image_path": str(image_path), "error": str(exc)})
        _set_job(job_id, completed=index + 1, results=results, errors=errors)
    _set_job(job_id, status="completed", completed=len(payload.image_paths), finished_at=time.time(), results=results, errors=errors)


@app.post("/v1/seg/jobs/start_batch")
def start_batch_job(payload: BatchSegIn) -> dict[str, Any]:
    clean_paths = [str(Path(item).expanduser()) for item in payload.image_paths if str(item).strip()]
    if not clean_paths:
        raise HTTPException(status_code=400, detail="image_paths must not be empty")
    job_id = f"sapiens_job_{uuid.uuid4().hex[:12]}"
    stop_event = threading.Event()
    _JOB_STOPS[job_id] = stop_event
    _set_job(job_id, job_id=job_id, status="queued", total=len(clean_paths), completed=0, results=[], errors=[])
    payload.image_paths = clean_paths
    thread = threading.Thread(target=_run_batch_job, args=(job_id, payload, stop_event), daemon=True)
    thread.start()
    return {"job": _JOBS[job_id]}


@app.get("/v1/seg/jobs/{job_id}")
def get_batch_job(job_id: str) -> dict[str, Any]:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {"job": job}


@app.post("/v1/seg/jobs/stop")
def stop_batch_job(payload: JobStopIn) -> dict[str, Any]:
    stop_event = _JOB_STOPS.get(payload.job_id)
    if not stop_event:
        raise HTTPException(status_code=404, detail="job not found")
    stop_event.set()
    _set_job(payload.job_id, status="stopping")
    return {"job": _JOBS[payload.job_id]}
