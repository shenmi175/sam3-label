from __future__ import annotations

from pydantic import BaseModel, Field


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
