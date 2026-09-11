from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


TaskType = Literal[
    'remove_small_components',
    'remove_edge_spurs',
    'shortest_bridge',
    'morph_close',
    'fill_small_holes',
    'deduplicate_same_class',
    'remove_small_instances',
    'remove_confidence_range',
    'remove_position_region',
    'delete_by_box_count',
    'normalize_classes',
    'delete_unlabeled_images',
]


class StrictParams(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ClassScope(BaseModel):
    model_config = ConfigDict(extra='forbid')

    mode: Literal['all', 'selected'] = 'all'
    classes: list[str] = Field(default_factory=list)

    @model_validator(mode='after')
    def validate_scope(self) -> 'ClassScope':
        self.classes = list(dict.fromkeys(str(value).strip() for value in self.classes if str(value).strip()))
        if self.mode == 'selected' and not self.classes:
            raise ValueError('class_scope.classes is required when mode is selected')
        if self.mode == 'all' and self.classes:
            raise ValueError('class_scope.classes must be empty when mode is all')
        return self


class SmallComponentsParams(StrictParams):
    absolute_area_enabled: bool = True
    max_area_px: int = Field(default=128, ge=0)
    relative_area_enabled: bool = True
    max_main_ratio: float = Field(default=0.001, ge=0)
    threshold_mode: Literal['and', 'or'] = 'and'

    @model_validator(mode='after')
    def require_threshold(self) -> 'SmallComponentsParams':
        if not (self.absolute_area_enabled or self.relative_area_enabled):
            raise ValueError('at least one component threshold is required')
        return self


class OpeningParams(StrictParams):
    radius_px: int = Field(default=1, ge=1, le=32)
    iterations: int = Field(default=1, ge=1, le=8)


class ShortestBridgeParams(StrictParams):
    max_gap_px: int = Field(default=16, ge=1, le=256)
    bridge_width_px: int = Field(default=3, ge=1, le=64)
    topology: Literal['mst', 'main_only'] = 'mst'
    avoid_other_instances: bool = True


class MorphCloseParams(StrictParams):
    radius_px: int = Field(default=8, ge=1, le=128)
    iterations: int = Field(default=1, ge=1, le=8)
    avoid_other_instances: bool = True


class FillHolesParams(StrictParams):
    absolute_area_enabled: bool = True
    max_area_px: int = Field(default=128, ge=0)
    relative_area_enabled: bool = True
    max_main_ratio: float = Field(default=0.001, ge=0)
    threshold_mode: Literal['and', 'or'] = 'and'

    @model_validator(mode='after')
    def require_threshold(self) -> 'FillHolesParams':
        if not (self.absolute_area_enabled or self.relative_area_enabled):
            raise ValueError('hole fill requires at least one threshold')
        return self


class DeduplicateParams(StrictParams):
    spatial_mode: Literal['instance_cover', 'bbox_cover'] = 'instance_cover'
    coverage_threshold: float = Field(default=0.98, ge=0, le=1)


class SmallInstancesParams(StrictParams):
    max_image_ratio: float = Field(default=0.02, ge=0, le=1)


class ConfidenceRangeParams(StrictParams):
    min_confidence: float = Field(default=0, ge=0, le=1)
    max_confidence: float = Field(default=1, ge=0, le=1)

    @model_validator(mode='after')
    def validate_range(self) -> 'ConfidenceRangeParams':
        if self.max_confidence < self.min_confidence:
            raise ValueError('max_confidence must be >= min_confidence')
        return self


class PositionRegionParams(StrictParams):
    center_x_half_width: float = Field(default=0.25, ge=0, le=0.5)
    center_y_half_height: float = Field(default=0.05, ge=0, le=0.5)
    relation: Literal['inside', 'outside'] = 'outside'


class BoxCountParams(StrictParams):
    min_boxes: int = Field(default=1, ge=0)
    max_boxes: int = Field(default=0, ge=0)

    @model_validator(mode='after')
    def validate_range(self) -> 'BoxCountParams':
        if self.max_boxes and self.max_boxes < self.min_boxes:
            raise ValueError('max_boxes must be zero or >= min_boxes')
        return self


class NormalizeClassesParams(StrictParams):
    target_class: str = Field(min_length=1)

    @model_validator(mode='after')
    def normalize_target(self) -> 'NormalizeClassesParams':
        self.target_class = self.target_class.strip()
        if not self.target_class:
            raise ValueError('target_class is required')
        return self


class EmptyParams(StrictParams):
    pass


TaskParams = Annotated[
    Union[
        SmallComponentsParams,
        OpeningParams,
        ShortestBridgeParams,
        MorphCloseParams,
        FillHolesParams,
        DeduplicateParams,
        SmallInstancesParams,
        ConfidenceRangeParams,
        PositionRegionParams,
        BoxCountParams,
        NormalizeClassesParams,
        EmptyParams,
    ],
    Field(union_mode='left_to_right'),
]


_PARAM_MODEL: dict[str, type[StrictParams]] = {
    'remove_small_components': SmallComponentsParams,
    'remove_edge_spurs': OpeningParams,
    'shortest_bridge': ShortestBridgeParams,
    'morph_close': MorphCloseParams,
    'fill_small_holes': FillHolesParams,
    'deduplicate_same_class': DeduplicateParams,
    'remove_small_instances': SmallInstancesParams,
    'remove_confidence_range': ConfidenceRangeParams,
    'remove_position_region': PositionRegionParams,
    'delete_by_box_count': BoxCountParams,
    'normalize_classes': NormalizeClassesParams,
    'delete_unlabeled_images': EmptyParams,
}


class SmartFilterIn(BaseModel):
    """Versioned single-task request with a one-release v1 compatibility surface."""

    model_config = ConfigDict(extra='forbid')

    project_id: str
    schema_version: Literal[1, 2] = 1
    task_type: TaskType | None = None
    class_scope: ClassScope | None = None
    params: dict[str, Any] | None = None
    preview_token: str = ''
    confirm_preview_failure: bool = False

    # v1 compatibility fields. They are rejected whenever schema_version=2.
    operation_mode: str = Field(default='merge', pattern='^(merge|rule|component_noise|delete_unlabeled)$')
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
    include_missing_confidence: bool = True
    rule_match_mode: str = Field(default='all', pattern='^(all|any)$')
    position_match_mode: str = Field(default='inside', pattern='^(inside|outside)$')
    component_abs_area_enabled: bool = True
    component_max_area_px: int = 128
    component_relative_area_enabled: bool = True
    component_max_main_ratio: float = 0.001
    component_require_all_thresholds: bool = True
    component_opening_enabled: bool = False
    component_opening_radius_px: int = 1
    component_opening_iterations: int = 1
    component_gap_repair_enabled: bool = False
    component_gap_repair_method: str = Field(default='shortest_bridge', pattern='^(shortest_bridge|morph_close)$')
    component_bridge_max_gap_px: int = 16
    component_bridge_width_px: int = 3
    component_bridge_topology: str = Field(default='mst', pattern='^(mst|main_only)$')
    component_closing_radius_px: int = 8
    component_closing_iterations: int = 1
    component_gap_avoid_other_instances: bool = True
    component_hole_fill_enabled: bool = False
    component_hole_abs_area_enabled: bool = True
    component_max_hole_area_px: int = 128
    component_hole_relative_area_enabled: bool = True
    component_max_hole_main_ratio: float = 0.001
    component_hole_require_all_thresholds: bool = True

    @model_validator(mode='after')
    def validate_versioned_request(self) -> 'SmartFilterIn':
        self.project_id = self.project_id.strip()
        if not self.project_id:
            raise ValueError('project_id is required')
        if self.schema_version == 1:
            if self.task_type is not None or self.class_scope is not None or self.params is not None:
                raise ValueError('v2 task fields require schema_version=2')
            return self
        legacy = self.model_fields_set - {
            'project_id', 'schema_version', 'task_type', 'class_scope', 'params',
            'preview_token', 'confirm_preview_failure',
        }
        if legacy:
            raise ValueError(f'v2 request contains legacy fields: {", ".join(sorted(legacy))}')
        if self.task_type is None or self.class_scope is None or self.params is None:
            raise ValueError('task_type, class_scope and params are required for schema_version=2')
        model = _PARAM_MODEL[self.task_type]
        self.params = model.model_validate(self.params).model_dump()
        return self
