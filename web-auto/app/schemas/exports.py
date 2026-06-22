from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class ExportIn(BaseModel):
    project_id: str
    format: str = Field(pattern='^(coco|json|yolo)$')
    include_bbox: bool = True
    include_mask: bool = False
    output_dir: Optional[str] = None
