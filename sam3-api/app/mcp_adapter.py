from __future__ import annotations

import json
import mimetypes
from contextlib import ExitStack
from pathlib import Path
from typing import Any, Optional

import httpx


class Sam3ApiHttpError(RuntimeError):
    def __init__(self, *, status_code: int, message: str, payload: Any | None = None) -> None:
        super().__init__(message)
        self.status_code = int(status_code)
        self.payload = payload


def _stringify_bool(value: bool) -> str:
    return "true" if bool(value) else "false"


def _json_field(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _resolve_path(path_text: str, *, kind: str) -> Path:
    path = Path(str(path_text or "")).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"{kind} not found: {path}")
    if not path.is_file():
        raise ValueError(f"{kind} must be a file: {path}")
    return path


def _mime_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


class Sam3ApiHttpClient:
    def __init__(self, *, base_url: str, timeout_sec: float = 180.0) -> None:
        base = str(base_url or "").strip().rstrip("/")
        if not base:
            raise ValueError("base_url is required")
        self.base_url = base
        self.timeout_sec = float(timeout_sec)
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=httpx.Timeout(self.timeout_sec),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Sam3ApiHttpClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _request(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        response = self._client.request(method, url, **kwargs)
        if response.status_code >= 400:
            try:
                payload = response.json()
            except Exception:
                payload = None
            detail = ""
            if isinstance(payload, dict):
                detail = str(payload.get("detail") or payload.get("error") or "").strip()
            if not detail:
                detail = response.text.strip()
            raise Sam3ApiHttpError(
                status_code=response.status_code,
                message=detail or f"HTTP {response.status_code}",
                payload=payload,
            )
        try:
            return response.json()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"non-JSON response from {url}: {exc}") from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def warmup(self, *, target: str) -> dict[str, Any]:
        target_norm = str(target or "image").strip().lower()
        if target_norm == "image":
            return self._request("POST", "/v1/warmup")
        if target_norm == "semantic":
            return self._request("POST", "/v1/semantic/warmup")
        if target_norm == "video":
            return self._request("POST", "/v1/video/warmup")
        raise ValueError("target must be one of: image, semantic, video")

    def image_infer(
        self,
        *,
        image_path: str,
        mode: str,
        prompt: Optional[str] = None,
        points: Optional[list[list[float | int]]] = None,
        boxes: Optional[list[list[float | int]]] = None,
        point_box_size: float = 16.0,
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> dict[str, Any]:
        image = _resolve_path(image_path, kind="image")
        data: dict[str, str] = {
            "mode": str(mode or "text").strip().lower(),
            "point_box_size": str(float(point_box_size)),
            "threshold": str(float(threshold)),
            "include_mask_png": _stringify_bool(include_mask_png),
            "max_detections": str(max(0, int(max_detections))),
        }
        if prompt is not None:
            data["prompt"] = str(prompt)
        if points:
            data["points"] = _json_field(points)
        if boxes:
            data["boxes"] = _json_field(boxes)
        with image.open("rb") as fh:
            files = {"file": (image.name, fh, _mime_type(image))}
            return self._request("POST", "/v1/infer", data=data, files=files)

    def image_infer_batch_text(
        self,
        *,
        image_paths: list[str],
        prompt: str,
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> dict[str, Any]:
        paths = [_resolve_path(p, kind="image") for p in image_paths]
        data = {
            "mode": "text",
            "prompt": str(prompt),
            "threshold": str(float(threshold)),
            "include_mask_png": _stringify_bool(include_mask_png),
            "max_detections": str(max(0, int(max_detections))),
        }
        with ExitStack() as stack:
            files: list[tuple[str, tuple[str, Any, str]]] = []
            for path in paths:
                fh = stack.enter_context(path.open("rb"))
                files.append(("files", (path.name, fh, _mime_type(path))))
            return self._request("POST", "/v1/infer_batch", data=data, files=files)

    def semantic_infer(
        self,
        *,
        image_path: str,
        prompt: str,
        boxes: list[list[float | int]],
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
        input_size: int = 0,
    ) -> dict[str, Any]:
        image = _resolve_path(image_path, kind="image")
        data = {
            "prompt": str(prompt),
            "boxes": _json_field(boxes),
            "threshold": str(float(threshold)),
            "include_mask_png": _stringify_bool(include_mask_png),
            "max_detections": str(max(0, int(max_detections))),
            "input_size": str(max(0, int(input_size))),
        }
        with image.open("rb") as fh:
            files = {"file": (image.name, fh, _mime_type(image))}
            return self._request("POST", "/v1/semantic/infer", data=data, files=files)

    def semantic_infer_batch(
        self,
        *,
        source_image_path: str,
        target_image_paths: list[str],
        prompt: str,
        boxes: list[list[float | int]],
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
        input_size: int = 0,
    ) -> dict[str, Any]:
        source = _resolve_path(source_image_path, kind="source image")
        targets = [_resolve_path(p, kind="target image") for p in target_image_paths]
        data = {
            "prompt": str(prompt),
            "boxes": _json_field(boxes),
            "threshold": str(float(threshold)),
            "include_mask_png": _stringify_bool(include_mask_png),
            "max_detections": str(max(0, int(max_detections))),
            "input_size": str(max(0, int(input_size))),
        }
        with ExitStack() as stack:
            files: list[tuple[str, tuple[str, Any, str]]] = []
            source_fh = stack.enter_context(source.open("rb"))
            files.append(("source_file", (source.name, source_fh, _mime_type(source))))
            for path in targets:
                fh = stack.enter_context(path.open("rb"))
                files.append(("files", (path.name, fh, _mime_type(path))))
            return self._request("POST", "/v1/semantic/infer_batch", data=data, files=files)

    def video_start_session(
        self,
        *,
        video_path: str,
        session_id: Optional[str] = None,
        threshold: Optional[float] = None,
        imgsz: Optional[int] = None,
        upload: bool = True,
    ) -> dict[str, Any]:
        video = _resolve_path(video_path, kind="video")
        if upload:
            data: dict[str, str] = {}
            if session_id:
                data["session_id"] = str(session_id)
            if threshold is not None:
                data["threshold"] = str(float(threshold))
            if imgsz is not None:
                data["imgsz"] = str(int(imgsz))
            with video.open("rb") as fh:
                files = {"file": (video.name, fh, _mime_type(video))}
                return self._request("POST", "/v1/video/session/start_upload", data=data, files=files)
        payload: dict[str, Any] = {"resource_path": str(video)}
        if session_id:
            payload["session_id"] = str(session_id)
        if threshold is not None:
            payload["threshold"] = float(threshold)
        if imgsz is not None:
            payload["imgsz"] = int(imgsz)
        return self._request("POST", "/v1/video/session/start", json=payload)

    def video_get_session(self, *, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/video/session/{session_id}")

    def video_add_prompt(
        self,
        *,
        session_id: str,
        frame_index: int,
        text: Optional[str] = None,
        boxes: Optional[list[list[float | int]]] = None,
        normalized: bool = False,
        include_mask_png: bool = False,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "session_id": str(session_id),
            "frame_index": int(frame_index),
            "normalized": bool(normalized),
            "include_mask_png": bool(include_mask_png),
            "max_detections": max(0, int(max_detections)),
        }
        if text is not None and str(text).strip():
            payload["text"] = str(text)
        if boxes:
            payload["boxes"] = boxes
        return self._request("POST", "/v1/video/session/add_prompt", json=payload)

    def video_propagate(
        self,
        *,
        session_id: str,
        propagation_direction: str = "forward",
        start_frame_index: Optional[int] = None,
        max_frame_num_to_track: Optional[int] = None,
        include_mask_png: bool = False,
        max_detections: int = 200,
        max_frames: int = 0,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "session_id": str(session_id),
            "propagation_direction": str(propagation_direction or "forward"),
            "include_mask_png": bool(include_mask_png),
            "max_detections": max(0, int(max_detections)),
            "max_frames": max(0, int(max_frames)),
        }
        if start_frame_index is not None:
            payload["start_frame_index"] = int(start_frame_index)
        if max_frame_num_to_track is not None:
            payload["max_frame_num_to_track"] = int(max_frame_num_to_track)
        return self._request("POST", "/v1/video/session/propagate", json=payload)

    def video_reset_session(self, *, session_id: str) -> dict[str, Any]:
        return self._request("POST", "/v1/video/session/reset", json={"session_id": str(session_id)})

    def video_close_session(self, *, session_id: str) -> dict[str, Any]:
        return self._request("POST", "/v1/video/session/close", json={"session_id": str(session_id)})
