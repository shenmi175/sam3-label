from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.common import DEFAULT_API_BASE_URL

# Default URL for the locate-anything-api service. Kept separate from
# the sam3-api default so the two backends can run on different ports.
DEFAULT_LOCATE_API_BASE_URL = 'http://127.0.0.1:8004'

ModelBackend = Literal['sam3', 'locate-anything']


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
    model_backend: ModelBackend = 'sam3'
    locate_api_base_url: str = DEFAULT_LOCATE_API_BASE_URL
    score_default: float = Field(default=0.5, ge=0.0, le=1.0)


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
    model_backend: ModelBackend = 'sam3'
    locate_api_base_url: str = DEFAULT_LOCATE_API_BASE_URL
    score_default: float = Field(default=0.5, ge=0.0, le=1.0)


class InferExamplePreviewIn(BaseModel):
    project_id: str
    image_id: str
    active_class: str = ''
    boxes: list[list[float | int]] = Field(default_factory=list)
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class HealthApiIn(BaseModel):
    api_base_url: str = DEFAULT_API_BASE_URL


class LocateHealthApiIn(BaseModel):
    api_base_url: str = DEFAULT_LOCATE_API_BASE_URL


class LocateUnloadApiIn(BaseModel):
    api_base_url: str = DEFAULT_LOCATE_API_BASE_URL


class InferJobControlIn(BaseModel):
    project_id: str


class InferJobResumeIn(BaseModel):
    project_id: str
    classes: Optional[list[str]] = None
    batch_size: Optional[int] = None
    threshold: Optional[float] = None
    api_base_url: Optional[str] = None
    model_backend: Optional[ModelBackend] = None
    locate_api_base_url: Optional[str] = None
    score_default: Optional[float] = None
