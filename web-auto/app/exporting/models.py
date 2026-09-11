from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


ExportProfile = Literal[
    'native_json_v2',
    'coco_detection',
    'coco_instance',
    'yolo_detection',
    'yolo_instance',
]
YoloMultipartPolicy = Literal['official_bridge', 'reject']
ImageExportMode = Literal['none', 'symlink', 'copy']
IssueSeverity = Literal['warning', 'blocker']


@dataclass
class ExportIssue:
    code: str
    message: str
    severity: IssueSeverity
    count: int = 1
    samples: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExportRegion:
    polygon: list[list[float]]
    source_annotation_id: str
    holes: list[list[list[float]]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExportInstance:
    instance_id: str
    source_instance_id: str
    source_annotation_ids: list[str]
    class_name: str
    source_model: str
    bbox_xyxy: list[float]
    area: float
    regions: list[ExportRegion] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            'instance_id': self.instance_id,
            'source_instance_id': self.source_instance_id,
            'source_annotation_ids': list(self.source_annotation_ids),
            'class_name': self.class_name,
            'source_model': self.source_model,
            'bbox_xyxy': list(self.bbox_xyxy),
            'area': self.area,
            'regions': [region.as_dict() for region in self.regions],
            'attributes': self.attributes,
        }


@dataclass
class ExportImage:
    image_id: str
    image_rel_path: str
    width: int | None
    height: int | None
    source_path: str = ''
    instances: list[ExportInstance] = field(default_factory=list)


@dataclass
class ExportStats:
    images_total: int = 0
    images_written: int = 0
    negative_images: int = 0
    annotations_total: int = 0
    annotations_selected: int = 0
    raw_records_total: int = 0
    canonical_instances_total: int = 0
    canonical_instances_selected: int = 0
    instances_written: int = 0
    regions_written: int = 0
    multipart_instances: int = 0
    regrouped_instances: int = 0
    regrouped_components: int = 0
    bbox_only_instances: int = 0
    output_records: int = 0
    skipped_source: int = 0
    skipped_class: int = 0
    stripped_values: int = 0
    by_source: dict[str, int] = field(default_factory=dict)
    by_class: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExportSnapshot:
    profile: ExportProfile
    project_id: str
    project_name: str
    project_content_rev: int
    project_classes: list[str]
    selected_classes: list[str]
    source_models: list[str]
    images: list[ExportImage]
    stats: ExportStats
    val_ratio: float = 0.0
    yolo_multipart_policy: YoloMultipartPolicy = 'official_bridge'
    image_mode: ImageExportMode = 'none'
    warnings: list[ExportIssue] = field(default_factory=list)
    blockers: list[ExportIssue] = field(default_factory=list)
    format_details: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.blockers

    @property
    def confirmation_required_codes(self) -> list[str]:
        required = {'YOLO_MULTIPART_BRIDGE', 'SEGMENTATION_REQUIRES_POLYGON'}
        return sorted({issue.code for issue in self.warnings if issue.code in required})

    def preflight_dict(self) -> dict[str, Any]:
        output = {
            'ok': self.ok,
            'profile': self.profile,
            'project_id': self.project_id,
            'project_content_rev': self.project_content_rev,
            'stats': self.stats.as_dict(),
            'warnings': [issue.as_dict() for issue in self.warnings],
            'blockers': [issue.as_dict() for issue in self.blockers],
            'confirmation_required_codes': self.confirmation_required_codes,
            'format_details': self.format_details,
        }
        if self.profile == 'native_json_v2':
            output['schema'] = 'web-auto.annotation-bundle.v2'
        return output
