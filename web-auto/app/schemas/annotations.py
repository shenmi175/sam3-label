from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SaveAnnIn(BaseModel):
    project_id: str
    image_id: str
    annotations: list[dict[str, Any]] = Field(default_factory=list)


class AppendAnnIn(BaseModel):
    project_id: str
    image_id: str
    annotations: list[dict[str, Any]] = Field(default_factory=list)


class AnnotationMigrationIn(BaseModel):
    dry_run: bool = True


class UIStateIn(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)
    project_id: str | None = None
