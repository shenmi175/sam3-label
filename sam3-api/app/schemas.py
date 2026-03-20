from typing import Any, Optional

from pydantic import BaseModel


class DetectionOut(BaseModel):
    id: str
    label: str
    class_id: Optional[int] = None
    score: float
    bbox_xyxy: list[float]
    bbox_xywh: list[float]
    polygon: Optional[list[list[float]]] = None
    area: Optional[int] = None
    mask_png_base64: Optional[str] = None


class InferResultOut(BaseModel):
    model: str = "sam3"
    device: str
    mode: str = "text"
    prompt: str
    threshold: float
    image: dict[str, Any]
    num_detections: int
    detections: list[DetectionOut]
    latency_ms: float


class BatchItemOut(BaseModel):
    filename: str
    ok: bool
    result: Optional[InferResultOut] = None
    error: Optional[str] = None


class BatchInferOut(BaseModel):
    total: int
    succeeded: int
    failed: int
    items: list[BatchItemOut]


class HealthOut(BaseModel):
    status: str
    model_loaded: bool
    semantic_model_loaded: bool = False
    video_model_loaded: bool = False
    device: str
    checkpoint_path: str


class VideoSessionStartIn(BaseModel):
    resource_path: str
    session_id: Optional[str] = None
    threshold: Optional[float] = None
    imgsz: Optional[int] = None


class VideoSessionControlIn(BaseModel):
    session_id: str


class VideoRemoveObjectIn(BaseModel):
    session_id: str
    obj_id: int
    is_user_action: bool = True


class VideoAddPromptIn(BaseModel):
    session_id: str
    frame_index: int
    text: Optional[str] = None
    points: list[list[float | int]] = []
    boxes: list[list[float | int]] = []
    obj_id: Optional[int] = None
    normalized: bool = False
    include_mask_png: bool = False
    max_detections: int = 200


class VideoPropagateIn(BaseModel):
    session_id: str
    propagation_direction: str = "forward"
    start_frame_index: Optional[int] = None
    max_frame_num_to_track: Optional[int] = None
    include_mask_png: bool = False
    max_detections: int = 200
    max_frames: int = 0
