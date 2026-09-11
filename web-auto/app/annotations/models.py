from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
from types import MappingProxyType
from typing import Any, Literal, Mapping


IssueSeverity = Literal['warning', 'error']
BboxOrigin = Literal['provided', 'derived_polygon', 'derived_mask', 'none']
PrimaryGeometry = Literal['bbox_only', 'polygon', 'multi_polygon', 'mask', 'invalid']
AnnotationCapability = Literal['detection', 'instance_segmentation']
Point = tuple[float, float]
Polygon = tuple[Point, ...]


@dataclass(frozen=True)
class AnnotationIssue:
    code: str
    severity: IssueSeverity
    field: str = ''
    details: Mapping[str, Any] = dataclass_field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True)
class SourceIdentity:
    source_id: str
    display_name: str
    raw_value: str
    is_unknown: bool = False


@dataclass(frozen=True)
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def center(self) -> Point:
        return ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)


@dataclass(frozen=True)
class AnnotationGeometry:
    bbox: BoundingBox | None
    bbox_origin: BboxOrigin
    regions: tuple[Polygon, ...]
    mask_refs: tuple[str, ...]
    primary_geometry: PrimaryGeometry
    bbox_area_px: float | None
    segmentation_area_px: float | None
    bbox_fill_ratio: float | None
    component_count: int
    is_out_of_bounds: bool = False


@dataclass(frozen=True)
class AnnotationProvenance:
    producer: SourceIdentity


@dataclass(frozen=True)
class CanonicalAnnotation:
    instance_id: str
    source_annotation_ids: tuple[str, ...]
    class_name: str
    score: float | None
    capabilities: frozenset[AnnotationCapability]
    geometry: AnnotationGeometry
    provenance: AnnotationProvenance
    issues: tuple[AnnotationIssue, ...]
    raw_record_count: int
    attributes: Mapping[str, Any]

    @property
    def has_detection(self) -> bool:
        return 'detection' in self.capabilities

    @property
    def has_instance_segmentation(self) -> bool:
        return 'instance_segmentation' in self.capabilities


@dataclass(frozen=True)
class ParseContext:
    image_id: str = ''
    image_width: int | None = None
    image_height: int | None = None


@dataclass(frozen=True)
class ParsedImageAnnotations:
    instances: tuple[CanonicalAnnotation, ...]
    raw_record_count: int

    @property
    def issues(self) -> tuple[AnnotationIssue, ...]:
        return tuple(issue for instance in self.instances for issue in instance.issues)
