from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


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
