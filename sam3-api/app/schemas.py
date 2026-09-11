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
    polygons: Optional[list[list[list[float]]]] = None
    area: Optional[int] = None
    mask_png_base64: Optional[str] = None
    model_det_id: Optional[str] = None
    contour_index: Optional[int] = None
    contour_count: Optional[int] = None


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
    feature_status: Optional[str] = None
    feature_key: Optional[str] = None
    feature_relative_path: Optional[str] = None
    feature_bytes: Optional[int] = None
    feature_error: Optional[str] = None
    image_digest: Optional[str] = None
    model_fingerprint: Optional[str] = None
    feature_input_size: Optional[int] = None
    feature_dtype: Optional[str] = None
    feature_format_version: Optional[str] = None
    feature_write_id: Optional[str] = None


class BatchInferOut(BaseModel):
    total: int
    succeeded: int
    failed: int
    items: list[BatchItemOut]


class FeatureWritesWaitIn(BaseModel):
    write_ids: list[str]


class FeatureWriteResultOut(BaseModel):
    feature_write_id: str
    feature_status: str
    feature_key: Optional[str] = None
    feature_relative_path: Optional[str] = None
    feature_bytes: int = 0
    feature_error: Optional[str] = None
    image_digest: Optional[str] = None
    model_fingerprint: Optional[str] = None
    feature_input_size: Optional[int] = None
    feature_dtype: Optional[str] = None
    feature_format_version: Optional[str] = None


class FeatureWritesWaitOut(BaseModel):
    items: list[FeatureWriteResultOut]


class HealthOut(BaseModel):
    status: str
    model_state: str = "not_loaded"
    model_loaded: bool
    semantic_model_loaded: bool = False
    video_model_loaded: bool = False
    mode: str = "lazy"
    last_load_error: Optional[str] = None
    video_last_load_error: Optional[str] = None
    device: str
    checkpoint_path: str
    checkpoint_available: bool = False
    gpu: Optional[dict[str, Any]] = None
    sam3_pin_sha: Optional[str] = None
    expected_ckpt_generation: Optional[str] = None
    instance_interactivity_enabled: bool = False
    feature_gpu_cache_count: int = 0
    feature_gpu_cache_bytes: int = 0


class InteractivePointIn(BaseModel):
    session_id: str
    x: float
    y: float
    label: int = 1


class InteractiveSessionIn(BaseModel):
    session_id: str


class InteractiveProjectIn(BaseModel):
    project_id: str


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
