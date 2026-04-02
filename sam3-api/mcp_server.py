from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Optional

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.types import CallToolResult, TextContent
except ImportError as exc:  # pragma: no cover
    raise RuntimeError(
        "Missing optional MCP dependencies. Install with `pip install -r requirements-mcp.txt`."
    ) from exc

from starlette.applications import Starlette
from starlette.routing import Mount

from app.mcp_adapter import Sam3ApiHttpClient, Sam3ApiHttpError


@dataclass(frozen=True)
class Sam3McpConfig:
    api_base_url: str
    timeout_sec: float
    http_mount_path: str


def load_mcp_config() -> Sam3McpConfig:
    base_url = str(os.getenv("SAM3_API_BASE_URL", "http://127.0.0.1:8001")).strip().rstrip("/")
    timeout_sec = float(os.getenv("SAM3_MCP_TIMEOUT_SEC", "180"))
    mount_path = str(os.getenv("SAM3_MCP_HTTP_MOUNT_PATH", "/mcp")).strip() or "/mcp"
    if not mount_path.startswith("/"):
        mount_path = f"/{mount_path}"
    return Sam3McpConfig(
        api_base_url=base_url,
        timeout_sec=timeout_sec,
        http_mount_path=mount_path,
    )


def _tool_result(payload: dict[str, Any], *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2))],
        structuredContent=payload,
        isError=is_error,
    )


def _tool_error(operation: str, exc: Exception) -> CallToolResult:
    payload: dict[str, Any] = {
        "ok": False,
        "operation": operation,
        "error": str(exc),
    }
    if isinstance(exc, Sam3ApiHttpError):
        payload["status_code"] = exc.status_code
        if exc.payload is not None:
            payload["payload"] = exc.payload
    return _tool_result(payload, is_error=True)


def build_mcp_server(config: Optional[Sam3McpConfig] = None) -> FastMCP:
    cfg = config or load_mcp_config()
    mcp = FastMCP(
        "sam3-api",
        instructions=(
            "Tools for the local sam3-api REST service. "
            "Prefer include_mask_png=false unless masks are explicitly required. "
            "Video prompting supports text and boxes."
        ),
        streamable_http_path="/",
    )

    def _client() -> Sam3ApiHttpClient:
        return Sam3ApiHttpClient(base_url=cfg.api_base_url, timeout_sec=cfg.timeout_sec)

    @mcp.tool()
    def sam3_server_info() -> CallToolResult:
        """Return MCP adapter settings and the upstream sam3-api base URL."""
        payload = {
            "ok": True,
            "server": "sam3-api-mcp",
            "api_base_url": cfg.api_base_url,
            "timeout_sec": cfg.timeout_sec,
            "supported_transports": ["stdio", "streamable-http"],
            "http_mount_path": cfg.http_mount_path,
        }
        return _tool_result(payload)

    @mcp.tool()
    def sam3_health() -> CallToolResult:
        """Check the upstream sam3-api health endpoint."""
        try:
            with _client() as client:
                return _tool_result(client.health())
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_health", exc)

    @mcp.tool()
    def sam3_warmup(target: str = "all") -> CallToolResult:
        """Warm up one model family or all of them: image, semantic, video, or all."""
        target_norm = str(target or "all").strip().lower()
        try:
            with _client() as client:
                if target_norm == "all":
                    payload = {
                        "ok": True,
                        "image": client.warmup(target="image"),
                        "semantic": client.warmup(target="semantic"),
                        "video": client.warmup(target="video"),
                    }
                    return _tool_result(payload)
                return _tool_result(client.warmup(target=target_norm))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_warmup", exc)

    @mcp.tool()
    def sam3_image_infer_text(
        image_path: str,
        prompt: str,
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> CallToolResult:
        """Run single-image text prompting through /v1/infer."""
        try:
            with _client() as client:
                payload = client.image_infer(
                    image_path=image_path,
                    mode="text",
                    prompt=prompt,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_image_infer_text", exc)

    @mcp.tool()
    def sam3_image_infer_points(
        image_path: str,
        points: list[list[float | int]],
        point_box_size: float = 16.0,
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> CallToolResult:
        """Run single-image point prompting through /v1/infer."""
        try:
            with _client() as client:
                payload = client.image_infer(
                    image_path=image_path,
                    mode="points",
                    points=points,
                    point_box_size=point_box_size,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_image_infer_points", exc)

    @mcp.tool()
    def sam3_image_infer_boxes(
        image_path: str,
        boxes: list[list[float | int]],
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> CallToolResult:
        """Run single-image box prompting through /v1/infer."""
        try:
            with _client() as client:
                payload = client.image_infer(
                    image_path=image_path,
                    mode="boxes",
                    boxes=boxes,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_image_infer_boxes", exc)

    @mcp.tool()
    def sam3_image_infer_batch_text(
        image_paths: list[str],
        prompt: str,
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
    ) -> CallToolResult:
        """Run text prompting over multiple images through /v1/infer_batch."""
        try:
            with _client() as client:
                payload = client.image_infer_batch_text(
                    image_paths=image_paths,
                    prompt=prompt,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_image_infer_batch_text", exc)

    @mcp.tool()
    def sam3_semantic_infer(
        image_path: str,
        prompt: str,
        boxes: list[list[float | int]],
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
        input_size: int = 0,
    ) -> CallToolResult:
        """Run official semantic exemplar segmentation through /v1/semantic/infer."""
        try:
            with _client() as client:
                payload = client.semantic_infer(
                    image_path=image_path,
                    prompt=prompt,
                    boxes=boxes,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    input_size=input_size,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_semantic_infer", exc)

    @mcp.tool()
    def sam3_semantic_batch(
        source_image_path: str,
        target_image_paths: list[str],
        prompt: str,
        boxes: list[list[float | int]],
        threshold: float = 0.5,
        include_mask_png: bool = False,
        max_detections: int = 100,
        input_size: int = 0,
    ) -> CallToolResult:
        """Run semantic exemplar propagation through /v1/semantic/infer_batch."""
        try:
            with _client() as client:
                payload = client.semantic_infer_batch(
                    source_image_path=source_image_path,
                    target_image_paths=target_image_paths,
                    prompt=prompt,
                    boxes=boxes,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    input_size=input_size,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_semantic_batch", exc)

    @mcp.tool()
    def sam3_video_start_session(
        video_path: str,
        session_id: Optional[str] = None,
        threshold: Optional[float] = None,
        imgsz: Optional[int] = None,
        upload: bool = True,
    ) -> CallToolResult:
        """Start a video session. Use upload=true for the most portable LiteLLM setup."""
        try:
            with _client() as client:
                payload = client.video_start_session(
                    video_path=video_path,
                    session_id=session_id,
                    threshold=threshold,
                    imgsz=imgsz,
                    upload=upload,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_start_session", exc)

    @mcp.tool()
    def sam3_video_get_session(session_id: str) -> CallToolResult:
        """Fetch current video session info."""
        try:
            with _client() as client:
                payload = client.video_get_session(session_id=session_id)
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_get_session", exc)

    @mcp.tool()
    def sam3_video_add_prompt(
        session_id: str,
        frame_index: int,
        text: Optional[str] = None,
        boxes: Optional[list[list[float | int]]] = None,
        normalized: bool = False,
        include_mask_png: bool = False,
        max_detections: int = 200,
    ) -> CallToolResult:
        """Add a text or box prompt to a video frame."""
        try:
            with _client() as client:
                payload = client.video_add_prompt(
                    session_id=session_id,
                    frame_index=frame_index,
                    text=text,
                    boxes=boxes,
                    normalized=normalized,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_add_prompt", exc)

    @mcp.tool()
    def sam3_video_propagate(
        session_id: str,
        propagation_direction: str = "forward",
        start_frame_index: Optional[int] = None,
        max_frame_num_to_track: Optional[int] = None,
        include_mask_png: bool = False,
        max_detections: int = 200,
        max_frames: int = 0,
    ) -> CallToolResult:
        """Propagate the current video prompt state through the video session."""
        try:
            with _client() as client:
                payload = client.video_propagate(
                    session_id=session_id,
                    propagation_direction=propagation_direction,
                    start_frame_index=start_frame_index,
                    max_frame_num_to_track=max_frame_num_to_track,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    max_frames=max_frames,
                )
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_propagate", exc)

    @mcp.tool()
    def sam3_video_reset_session(session_id: str) -> CallToolResult:
        """Reset prompt state for an existing video session."""
        try:
            with _client() as client:
                payload = client.video_reset_session(session_id=session_id)
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_reset_session", exc)

    @mcp.tool()
    def sam3_video_close_session(session_id: str) -> CallToolResult:
        """Close a video session and release its resources."""
        try:
            with _client() as client:
                payload = client.video_close_session(session_id=session_id)
            return _tool_result(payload)
        except Exception as exc:  # noqa: BLE001
            return _tool_error("sam3_video_close_session", exc)

    return mcp


def create_streamable_http_app(config: Optional[Sam3McpConfig] = None) -> Starlette:
    cfg = config or load_mcp_config()
    mcp = build_mcp_server(cfg)

    @asynccontextmanager
    async def lifespan(app):
        async with mcp.session_manager.run():
            yield

    return Starlette(
        debug=False,
        routes=[Mount(cfg.http_mount_path, app=mcp.streamable_http_app())],
        lifespan=lifespan,
    )
