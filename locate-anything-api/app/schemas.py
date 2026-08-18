"""LocateAnything-3B inference service.

HTTP contract mirrors ``sam3-api/app/schemas.py`` so the same web-auto
client can talk to either backend interchangeably (bbox-only subset).
Keep field names, defaults, and response shapes byte-identical with
sam3-api unless a comment explicitly says otherwise.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class DetectionOut(BaseModel):
    id: str
    label: str
    class_id: Optional[int] = None
    bbox_xyxy: list[float]
    bbox_xywh: list[float]
    polygon: Optional[list[list[float]]] = None
    area: Optional[int] = None
    mask_png_base64: Optional[str] = None
    model_det_id: Optional[str] = None
    contour_index: Optional[int] = None
    contour_count: Optional[int] = None


class InferResultOut(BaseModel):
    model: str = "locate-anything-3b"
    device: str
    mode: str = "text"
    prompt: str
    image: dict[str, Any]
    num_detections: int
    detections: list[DetectionOut]
    latency_ms: float


class HealthOut(BaseModel):
    status: str
    mode: str = "lazy"
    model_loaded: bool
    last_load_error: Optional[str] = None
    device: str
    checkpoint_path: str
    attn_backend: str = "la_flash"
    gpu: Optional[dict[str, Any]] = None


class InferFormFields(BaseModel):
    """Accepted form fields for POST /v1/infer.

    Only ``mode='text'`` is supported. ``points`` / ``boxes`` are
    accepted for forward-compat with the sam3-api wire format but
    rejected at validation time.
    """

    mode: str = "text"
    prompt: Optional[str] = None
    threshold: Optional[float] = None
    include_mask_png: bool = False
    max_detections: int = Field(default=200, ge=1, le=2000)
    score_default: float = Field(default=0.5, ge=0.0, le=1.0)

    # Accepted-and-ignored, for wire compatibility with sam3-api.
    points: Optional[str] = None
    boxes: Optional[str] = None
    point_box_size: Optional[float] = None
    input_size: Optional[int] = None
