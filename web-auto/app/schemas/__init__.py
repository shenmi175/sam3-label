from __future__ import annotations

import os
from typing import Any, Optional

from pydantic import BaseModel, Field


DEFAULT_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', 'http://127.0.0.1:8001').strip() or 'http://127.0.0.1:8001'


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
    operation_mode: str = Field(default='merge', pattern='^(merge|rule|delete_unlabeled)$')
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
