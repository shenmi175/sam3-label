from __future__ import annotations

import hmac
import logging
import os
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings, get_settings
from .engine import LocateAnythingEngine, gpu_status_snapshot, load_image_from_bytes
from .schemas import HealthOut, InferResultOut

logger = logging.getLogger("locate_anything")


def _configured_api_token() -> str:
    return os.getenv("LOCATE_API_TOKEN", "").strip()


def _request_api_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


_TOKEN_EXEMPT_PREFIXES = ("/health", "/docs", "/openapi.json", "/redoc")


def _token_auth_exempt(path: str) -> bool:
    return any(path.startswith(p) for p in _TOKEN_EXEMPT_PREFIXES)


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    engine = LocateAnythingEngine(settings)

    app = FastAPI(
        title=settings.api_title,
        version=settings.api_version,
        description="LocateAnything-3B inference service; bbox-only subset of sam3-api contract.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_origins != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def require_internal_api_token(request: Request, call_next):
        token = _configured_api_token()
        if token and request.method.upper() != "OPTIONS" and not _token_auth_exempt(request.url.path):
            provided = _request_api_token(request)
            if not provided or not hmac.compare_digest(provided, token):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "missing or invalid locate-anything-api token"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        return await call_next(request)

    app.state.settings = settings
    app.state.engine = engine

    @app.on_event("startup")
    def startup_event() -> None:
        if settings.warmup_on_start:
            try:
                engine.warmup()
            except Exception:  # noqa: BLE001
                logger.exception("warmup failed; service still serving /health")

    # -- observability -------------------------------------------------
    @app.get("/health", response_model=HealthOut)
    def health() -> dict:
        return {
            "status": "ok",
            "model_loaded": engine.loaded,
            "device": settings.device,
            "checkpoint_path": settings.checkpoint_display,
            "attn_backend": settings.attn_backend,
            "gpu": gpu_status_snapshot(),
        }

    @app.post("/v1/warmup")
    def warmup() -> dict:
        try:
            engine.warmup()
            return {"ok": True, "model_loaded": engine.loaded}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"warmup failed: {exc}") from exc

    @app.post("/v1/unload")
    def unload() -> dict:
        engine.unload()
        return {"ok": True, "model_loaded": engine.loaded}

    # -- inference -----------------------------------------------------
    @app.post("/v1/infer", response_model=InferResultOut)
    async def infer(
        file: UploadFile = File(...),
        mode: str = Form("text"),
        prompt: Optional[str] = Form(None),
        points: Optional[str] = Form(None),
        boxes: Optional[str] = Form(None),
        point_box_size: float = Form(16.0),
        input_size: int = Form(0),
        threshold: Optional[float] = Form(None),
        include_mask_png: bool = Form(False),
        max_detections: int = Form(200),
        score_default: float = Form(0.5),
    ) -> dict:
        mode_norm = str(mode or "text").strip().lower()
        if mode_norm not in {"text"}:
            raise HTTPException(
                status_code=400,
                detail=f"LocateAnything supports text mode only (got '{mode_norm}')",
            )
        if points or boxes:
            # Accept silently but ignore — keeps wire compat with sam3-api clients.
            pass
        del point_box_size, input_size  # unused for this backend

        if not prompt or not prompt.strip():
            raise HTTPException(status_code=400, detail="prompt is required for text mode")

        try:
            raw = await file.read()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"failed to read upload: {exc}") from exc
        if not raw:
            raise HTTPException(status_code=400, detail="empty upload")
        if len(raw) > settings.max_image_bytes:
            raise HTTPException(
                status_code=400,
                detail=f"image is too large: {len(raw)} bytes > {settings.max_image_bytes} bytes",
            )

        use_threshold = (
            float(threshold) if threshold is not None else float(settings.default_threshold)
        )
        if not 0.0 <= use_threshold <= 1.0:
            raise HTTPException(status_code=400, detail="threshold must be in [0, 1]")

        use_score = float(score_default)
        if not 0.0 <= use_score <= 1.0:
            raise HTTPException(status_code=400, detail="score_default must be in [0, 1]")

        try:
            image = load_image_from_bytes(raw)
            return engine.infer(
                image=image,
                prompt=prompt.strip(),
                threshold=use_threshold,
                include_mask_png=include_mask_png,
                max_detections=max(1, int(max_detections)),
                score_default=use_score,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=f"model unavailable: {exc}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("infer failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"inference failed: {exc}") from exc

    return app
