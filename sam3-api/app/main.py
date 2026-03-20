import json
import logging
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.engine import Sam3InferenceEngine
from app.semantic_engine import Sam3SemanticEngine
from app.video_semantic_engine import Sam3VideoSemanticSessionEngine
from app.schemas import (
    BatchInferOut,
    BatchItemOut,
    HealthOut,
    InferResultOut,
    VideoAddPromptIn,
    VideoPropagateIn,
    VideoRemoveObjectIn,
    VideoSessionControlIn,
    VideoSessionStartIn,
)
from app.utils import load_image_from_bytes

logger = logging.getLogger("sam3_api")


def _parse_bool_label(raw: object, default: bool = True) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw != 0
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "on", "+1"}:
        return True
    if text in {"0", "false", "no", "off", "-1"}:
        return False
    return default


def _parse_json_list(raw: Optional[str], field_name: str) -> list:
    if raw is None:
        return []
    text = str(raw).strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} must be valid JSON") from exc
    if not isinstance(data, list):
        raise ValueError(f"{field_name} must be a JSON list")
    return data


def _parse_points(raw: Optional[str]) -> list[tuple[float, float, bool]]:
    payload = _parse_json_list(raw, "points")
    points: list[tuple[float, float, bool]] = []
    for item in payload:
        if isinstance(item, dict):
            x = float(item.get("x"))
            y = float(item.get("y"))
            label = _parse_bool_label(item.get("label", 1), True)
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            x = float(item[0])
            y = float(item[1])
            label = _parse_bool_label(item[2] if len(item) > 2 else 1, True)
        else:
            continue
        points.append((x, y, label))
    return points


def _parse_boxes(raw: Optional[str]) -> list[tuple[float, float, float, float, bool]]:
    payload = _parse_json_list(raw, "boxes")
    boxes: list[tuple[float, float, float, float, bool]] = []
    for item in payload:
        if isinstance(item, dict):
            x1 = float(item.get("x1"))
            y1 = float(item.get("y1"))
            x2 = float(item.get("x2"))
            y2 = float(item.get("y2"))
            label = _parse_bool_label(item.get("label", 1), True)
        elif isinstance(item, (list, tuple)) and len(item) >= 4:
            x1 = float(item[0])
            y1 = float(item[1])
            x2 = float(item[2])
            y2 = float(item[3])
            label = _parse_bool_label(item[4] if len(item) > 4 else 1, True)
        else:
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        boxes.append((x1, y1, x2, y2, label))
    return boxes


def _is_oom_error(exc: BaseException) -> bool:
    text = str(exc or "").lower()
    return ("out of memory" in text) or ("cuda oom" in text) or ("cuda out of memory" in text)


def _is_not_found_error(exc: BaseException) -> bool:
    text = str(exc or "").lower()
    return ("session not found" in text) or ("cannot find session" in text)


def _format_exc_message(exc: BaseException) -> str:
    text = str(exc or "").strip()
    return text or type(exc).__name__


def _normalize_image_engine_input_size(
    engine: Sam3InferenceEngine,
    input_size: object,
    *,
    route_label: str,
) -> int:
    try:
        requested_size = int(input_size or 0)
    except Exception:
        requested_size = 0
    default_size = int(getattr(engine, "default_input_size", 1008) or 1008)
    if requested_size <= 0 or requested_size == default_size:
        return requested_size
    logger.warning(
        "%s requested unsupported input_size=%s; using default input_size=%s",
        route_label,
        requested_size,
        default_size,
    )
    return default_size


def _infer_with_default_size_fallback(
    engine: Sam3InferenceEngine,
    *,
    infer_kwargs: dict,
) -> dict:
    requested_size = int(infer_kwargs.get("input_size") or 0)
    default_size = int(getattr(engine, "default_input_size", 1008) or 1008)
    try:
        return engine.infer(**infer_kwargs)
    except Exception as exc:
        if requested_size <= 0 or requested_size == default_size:
            raise
        logger.warning(
            "single inference failed with input_size=%s (%s); retrying with default input_size=%s",
            requested_size,
            _format_exc_message(exc),
            default_size,
        )
        retry_kwargs = dict(infer_kwargs)
        retry_kwargs["input_size"] = default_size
        return engine.infer(**retry_kwargs)


async def _read_upload_image(file: UploadFile, max_image_bytes: int):
    raw = await file.read()
    if not raw:
        raise ValueError("empty file")
    if len(raw) > max_image_bytes:
        raise ValueError(f"image is too large: {len(raw)} bytes > {max_image_bytes} bytes")
    return load_image_from_bytes(raw)


def create_app() -> FastAPI:
    settings = get_settings()
    engine = Sam3InferenceEngine(settings)
    semantic_engine = Sam3SemanticEngine(settings)
    video_engine = Sam3VideoSemanticSessionEngine(settings)

    app = FastAPI(
        title=settings.api_title,
        version=settings.api_version,
        description="SAM3 inference service for remote deployment.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_origins != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.engine = engine
    app.state.semantic_engine = semantic_engine
    app.state.video_engine = video_engine

    @app.on_event("startup")
    def startup_event() -> None:
        if settings.warmup_on_start:
            engine.warmup()
            try:
                video_engine.warmup()
            except Exception:
                pass

    @app.get("/health", response_model=HealthOut)
    def health() -> dict:
        return {
            "status": "ok",
            "model_loaded": engine.loaded,
            "semantic_model_loaded": semantic_engine.loaded,
            "video_model_loaded": video_engine.loaded,
            "device": settings.device,
            "checkpoint_path": str(settings.checkpoint_path),
        }

    @app.post("/v1/warmup")
    def warmup() -> dict:
        try:
            engine.warmup()
            return {"ok": True, "model_loaded": engine.loaded}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"warmup failed: {exc}") from exc

    @app.post("/v1/semantic/warmup")
    def semantic_warmup() -> dict:
        try:
            semantic_engine.warmup()
            return {"ok": True, "semantic_model_loaded": semantic_engine.loaded}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"semantic warmup failed: {exc}") from exc

    @app.post("/v1/video/warmup")
    def video_warmup() -> dict:
        try:
            video_engine.warmup()
            return {"ok": True, "video_model_loaded": video_engine.loaded}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video warmup failed: {exc}") from exc

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
        max_detections: int = Form(100),
    ) -> dict:
        try:
            mode_norm = str(mode or "text").strip().lower()
            points_payload = _parse_points(points) if mode_norm in {"points", "point"} else []
            boxes_payload = _parse_boxes(boxes) if mode_norm in {"boxes", "box"} else []

            image = await _read_upload_image(file, settings.max_image_bytes)
            use_threshold = (
                float(threshold)
                if threshold is not None
                else float(settings.default_threshold)
            )
            if use_threshold < 0.0 or use_threshold > 1.0:
                raise ValueError("threshold must be in [0, 1]")

            return _infer_with_default_size_fallback(
                engine,
                infer_kwargs={
                    "image": image,
                    "mode": mode_norm,
                    "prompt": str(prompt or ""),
                    "points": points_payload,
                    "boxes": boxes_payload,
                    "point_box_size": float(point_box_size),
                    "input_size": _normalize_image_engine_input_size(
                        engine,
                        input_size,
                        route_label="/v1/infer",
                    ),
                    "threshold": use_threshold,
                    "include_mask_png": bool(include_mask_png),
                    "max_detections": max(0, int(max_detections)),
                },
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("single infer failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"inference failed: {_format_exc_message(exc)}") from exc

    @app.post("/v1/semantic/infer", response_model=InferResultOut)
    async def semantic_infer(
        file: UploadFile = File(...),
        prompt: Optional[str] = Form(None),
        boxes: Optional[str] = Form(None),
        input_size: int = Form(0),
        threshold: Optional[float] = Form(None),
        include_mask_png: bool = Form(False),
        max_detections: int = Form(100),
    ) -> dict:
        try:
            image = await _read_upload_image(file, settings.max_image_bytes)
            boxes_payload = _parse_boxes(boxes)
            use_threshold = float(threshold) if threshold is not None else float(settings.default_threshold)
            if use_threshold < 0.0 or use_threshold > 1.0:
                raise ValueError("threshold must be in [0, 1]")
            return semantic_engine.infer_current(
                image=image,
                prompt=str(prompt or ""),
                boxes=boxes_payload,
                input_size=int(input_size or 0),
                threshold=use_threshold,
                include_mask_png=bool(include_mask_png),
                max_detections=max(0, int(max_detections)),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("semantic infer failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"semantic inference failed: {exc}") from exc

    @app.post("/v1/infer_batch", response_model=BatchInferOut)
    async def infer_batch(
        files: list[UploadFile] = File(...),
        mode: str = Form("text"),
        prompt: Optional[str] = Form(None),
        points: Optional[str] = Form(None),
        boxes: Optional[str] = Form(None),
        point_box_size: float = Form(16.0),
        input_size: int = Form(0),
        threshold: Optional[float] = Form(None),
        include_mask_png: bool = Form(False),
        max_detections: int = Form(100),
    ) -> dict:
        if len(files) > settings.max_batch_files:
            raise HTTPException(
                status_code=400,
                detail=f"too many files: {len(files)} > {settings.max_batch_files}",
            )

        use_threshold = (
            float(threshold)
            if threshold is not None
            else float(settings.default_threshold)
        )
        if use_threshold < 0.0 or use_threshold > 1.0:
            raise HTTPException(status_code=400, detail="threshold must be in [0, 1]")

        mode_norm = str(mode or "text").strip().lower()
        try:
            points_payload = _parse_points(points) if mode_norm in {"points", "point"} else []
            boxes_payload = _parse_boxes(boxes) if mode_norm in {"boxes", "box"} else []
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        items: list[BatchItemOut] = []
        succeeded = 0
        failed = 0
        image_engine_input_size = _normalize_image_engine_input_size(
            engine,
            input_size,
            route_label="/v1/infer_batch",
        )

        if mode_norm == "text" and len(files) > 1:
            loaded: list[tuple[str, Any]] = []
            try:
                for f in files:
                    loaded.append((f.filename or "unnamed", await _read_upload_image(f, settings.max_image_bytes)))
                results = engine.infer_text_batch(
                    images=[image for _, image in loaded],
                    prompt=str(prompt or ""),
                    input_size=image_engine_input_size,
                    threshold=use_threshold,
                    include_mask_png=bool(include_mask_png),
                    max_detections=max(0, int(max_detections)),
                )
                if len(results) != len(loaded):
                    raise RuntimeError(f"batch result count mismatch: {len(results)} != {len(loaded)}")
                for (filename, _), result in zip(loaded, results):
                    items.append(BatchItemOut(filename=filename, ok=True, result=InferResultOut(**result)))
                    succeeded += 1
                return {
                    "total": len(files),
                    "succeeded": succeeded,
                    "failed": failed,
                    "items": items,
                }
            except Exception as exc:  # noqa: BLE001
                logger.exception("batched text inference failed, fallback to per-image mode: %s", exc)
                if not loaded:
                    raise HTTPException(status_code=500, detail=f"inference batch failed: {exc}") from exc
                items = []
                succeeded = 0
                failed = 0
                for filename, image in loaded:
                    try:
                        result = engine.infer(
                            image=image,
                            mode="text",
                            prompt=str(prompt or ""),
                            points=[],
                            boxes=[],
                            point_box_size=float(point_box_size),
                            input_size=image_engine_input_size,
                            threshold=use_threshold,
                            include_mask_png=bool(include_mask_png),
                            max_detections=max(0, int(max_detections)),
                        )
                        items.append(BatchItemOut(filename=filename, ok=True, result=InferResultOut(**result)))
                        succeeded += 1
                    except Exception as item_exc:  # noqa: BLE001
                        items.append(BatchItemOut(filename=filename, ok=False, error=str(item_exc)))
                        failed += 1
                return {
                    "total": len(loaded),
                    "succeeded": succeeded,
                    "failed": failed,
                    "items": items,
                }

        for f in files:
            filename = f.filename or "unnamed"
            try:
                image = await _read_upload_image(f, settings.max_image_bytes)
                result = engine.infer(
                    image=image,
                    mode=mode_norm,
                    prompt=str(prompt or ""),
                    points=points_payload,
                    boxes=boxes_payload,
                    point_box_size=float(point_box_size),
                    input_size=image_engine_input_size,
                    threshold=use_threshold,
                    include_mask_png=bool(include_mask_png),
                    max_detections=max(0, int(max_detections)),
                )
                items.append(BatchItemOut(filename=filename, ok=True, result=InferResultOut(**result)))
                succeeded += 1
            except Exception as exc:  # noqa: BLE001
                items.append(BatchItemOut(filename=filename, ok=False, error=str(exc)))
                failed += 1

        return {
            "total": len(files),
            "succeeded": succeeded,
            "failed": failed,
            "items": items,
        }

    @app.post("/v1/semantic/infer_batch", response_model=BatchInferOut)
    async def semantic_infer_batch(
        source_file: UploadFile = File(...),
        files: list[UploadFile] = File(...),
        prompt: Optional[str] = Form(None),
        boxes: Optional[str] = Form(None),
        input_size: int = Form(0),
        threshold: Optional[float] = Form(None),
        include_mask_png: bool = Form(False),
        max_detections: int = Form(100),
    ) -> dict:
        if len(files) > settings.max_batch_files:
            raise HTTPException(
                status_code=400,
                detail=f"too many files: {len(files)} > {settings.max_batch_files}",
            )
        try:
            source_image = await _read_upload_image(source_file, settings.max_image_bytes)
            target_items: list[tuple[str, Any]] = []
            for f in files:
                image = await _read_upload_image(f, settings.max_image_bytes)
                target_items.append((f.filename or "unnamed", image))
            boxes_payload = _parse_boxes(boxes)
            use_threshold = float(threshold) if threshold is not None else float(settings.default_threshold)
            if use_threshold < 0.0 or use_threshold > 1.0:
                raise ValueError("threshold must be in [0, 1]")

            results = semantic_engine.infer_batch(
                source_image=source_image,
                prompt=str(prompt or ""),
                boxes=boxes_payload,
                targets=target_items,
                input_size=int(input_size or 0),
                threshold=use_threshold,
                include_mask_png=bool(include_mask_png),
                max_detections=max(0, int(max_detections)),
            )
            items = [
                BatchItemOut(filename=item["filename"], ok=True, result=InferResultOut(**item["result"]))
                for item in results
            ]
            return {
                "total": len(target_items),
                "succeeded": len(items),
                "failed": 0,
                "items": items,
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("semantic infer_batch failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"semantic batch inference failed: {exc}") from exc

    @app.post("/v1/video/session/start")
    def video_session_start(payload: VideoSessionStartIn) -> dict:
        try:
            return video_engine.start_session(
                resource_path=payload.resource_path,
                session_id=payload.session_id,
                threshold=payload.threshold,
                imgsz=payload.imgsz,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            code = 507 if _is_oom_error(exc) else 500
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video start_session failed: {exc}") from exc

    @app.post("/v1/video/session/start_upload")
    async def video_session_start_upload(
        file: UploadFile = File(...),
        session_id: Optional[str] = Form(None),
        threshold: Optional[float] = Form(None),
        imgsz: Optional[int] = Form(None),
    ) -> dict:
        upload_dir = settings.video_upload_dir
        upload_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(file.filename or "").suffix.lower() or ".mp4"
        target_path = (upload_dir / f"{uuid.uuid4().hex}{suffix}").resolve()

        total_size = 0
        try:
            with target_path.open("wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total_size += len(chunk)
                    if total_size > settings.max_video_bytes:
                        raise ValueError(
                            f"video is too large: {total_size} bytes > {settings.max_video_bytes} bytes"
                        )
                    out.write(chunk)
            if total_size <= 0:
                raise ValueError("empty video file")

            return video_engine.start_session(
                resource_path=str(target_path),
                session_id=session_id,
                cleanup_resource_on_close=True,
                threshold=threshold,
                imgsz=imgsz,
            )
        except ValueError as exc:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            code = 507 if _is_oom_error(exc) else 500
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"video start_upload failed: {exc}") from exc

    @app.get("/v1/video/session/{session_id}")
    def video_session_info(session_id: str) -> dict:
        try:
            return video_engine.get_session_info(session_id)
        except RuntimeError as exc:
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video session info failed: {exc}") from exc

    @app.post("/v1/video/session/add_prompt")
    def video_add_prompt(payload: VideoAddPromptIn) -> dict:
        try:
            return video_engine.add_prompt(
                session_id=payload.session_id,
                frame_index=payload.frame_index,
                text=payload.text,
                points=payload.points,
                boxes=payload.boxes,
                obj_id=payload.obj_id,
                normalized=payload.normalized,
                include_mask_png=payload.include_mask_png,
                max_detections=payload.max_detections,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            logger.exception("video add_prompt runtime failed: %s", exc)
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("video add_prompt failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"video add_prompt failed: {exc}") from exc

    @app.post("/v1/video/session/propagate")
    def video_propagate(payload: VideoPropagateIn) -> dict:
        try:
            return video_engine.propagate(
                session_id=payload.session_id,
                propagation_direction=payload.propagation_direction,
                start_frame_index=payload.start_frame_index,
                max_frame_num_to_track=payload.max_frame_num_to_track,
                include_mask_png=payload.include_mask_png,
                max_detections=payload.max_detections,
                max_frames=payload.max_frames,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video propagate failed: {exc}") from exc

    @app.post("/v1/video/session/remove_object")
    def video_remove_object(payload: VideoRemoveObjectIn) -> dict:
        try:
            return video_engine.remove_object(
                session_id=payload.session_id,
                obj_id=payload.obj_id,
                is_user_action=payload.is_user_action,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video remove_object failed: {exc}") from exc

    @app.post("/v1/video/session/reset")
    def video_reset_session(payload: VideoSessionControlIn) -> dict:
        try:
            return video_engine.reset_session(payload.session_id)
        except RuntimeError as exc:
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video reset_session failed: {exc}") from exc

    @app.post("/v1/video/session/close")
    def video_close_session(payload: VideoSessionControlIn) -> dict:
        try:
            return video_engine.close_session(payload.session_id)
        except RuntimeError as exc:
            code = 404 if _is_not_found_error(exc) else (507 if _is_oom_error(exc) else 500)
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"video close_session failed: {exc}") from exc

    return app
