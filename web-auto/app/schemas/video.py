from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from app.schemas.common import DEFAULT_API_BASE_URL


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
