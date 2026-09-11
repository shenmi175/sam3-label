from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.common import DEFAULT_API_BASE_URL


class AiSessionOpenIn(BaseModel):
    project_id: str
    image_id: str
    selected_annotation_id: str = ''
    image_filter_status: str = ''
    image_filter_class: str = ''
    source_model: str = ''
    api_base_url: str = DEFAULT_API_BASE_URL


class AiPointIn(BaseModel):
    project_id: str
    session_id: str
    x: float
    y: float
    label: int = Field(default=1, ge=0, le=1)
    api_base_url: str = DEFAULT_API_BASE_URL


class AiSessionIn(BaseModel):
    project_id: str
    session_id: str
    api_base_url: str = DEFAULT_API_BASE_URL


class AiFeatureDeleteIn(BaseModel):
    project_id: str
    confirmed: bool = False
    api_base_url: str = DEFAULT_API_BASE_URL
