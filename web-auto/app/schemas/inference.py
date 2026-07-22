from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.common import DEFAULT_API_BASE_URL


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


class InferExamplePreviewIn(BaseModel):
    project_id: str
    image_id: str
    active_class: str = ''
    boxes: list[list[float | int]] = Field(default_factory=list)
    threshold: float = 0.5
    api_base_url: str = DEFAULT_API_BASE_URL


class HealthApiIn(BaseModel):
    api_base_url: str = DEFAULT_API_BASE_URL


class InferJobControlIn(BaseModel):
    project_id: str


class InferJobResumeIn(BaseModel):
    project_id: str
    classes: Optional[list[str]] = None
    batch_size: Optional[int] = None
    threshold: Optional[float] = None
    api_base_url: Optional[str] = None
