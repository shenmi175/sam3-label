from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


SourceModel = Literal['sam3', 'locate-anything']
ExportProfile = Literal[
    'native_json_v2',
    'coco_detection',
    'coco_instance',
    'yolo_detection',
    'yolo_instance',
]
YoloMultipartPolicy = Literal['official_bridge', 'reject']
ImageExportMode = Literal['none', 'symlink', 'copy']


class ExportOptions(BaseModel):
    project_id: str
    profile: ExportProfile
    output_dir: Optional[str] = None
    source_models: list[SourceModel] = Field(min_length=1)
    classes: list[str] = Field(min_length=1)
    val_ratio: float = Field(default=0.0, ge=0.0, le=0.9)
    yolo_multipart_policy: YoloMultipartPolicy = 'official_bridge'
    image_mode: ImageExportMode = 'none'
    link_images: bool = False
    confirmed_issue_codes: list[str] = Field(default_factory=list)

    @model_validator(mode='after')
    def apply_legacy_link_images(self) -> 'ExportOptions':
        if self.link_images and self.image_mode == 'none':
            self.image_mode = 'symlink'
        return self


class ExportPreflightIn(ExportOptions):
    expected_content_rev: Optional[int] = Field(default=None, ge=1)


class ExportIn(ExportOptions):
    expected_content_rev: int = Field(ge=1)


class ExportPreviewIn(BaseModel):
    project_id: str
