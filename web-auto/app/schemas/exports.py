from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SourceModel = Literal['sam3', 'locate-anything', 'manual']


class ExportIn(BaseModel):
    project_id: str
    format: str = Field(pattern='^(coco|json|yolo)$')
    include_bbox: bool = True
    include_mask: bool = False
    output_dir: Optional[str] = None
    # locate-anything annotations are bbox-only, so exporting them next to the
    # sam3 masks derived from the same boxes would duplicate every instance.
    source_models: list[SourceModel] = Field(default_factory=lambda: ['sam3', 'manual'])
    classes: list[str] = Field(default_factory=list)
    val_ratio: float = Field(default=0.0, ge=0.0, le=0.9)
    write_data_yaml: bool = True


class ExportPreviewIn(BaseModel):
    project_id: str
