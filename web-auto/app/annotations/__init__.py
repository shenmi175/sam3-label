"""Canonical annotation records and interpretation shared by consumers."""

from app.annotations.models import (
    AnnotationGeometry,
    AnnotationIssue,
    AnnotationProvenance,
    BoundingBox,
    CanonicalAnnotation,
    ParseContext,
    ParsedImageAnnotations,
    SourceIdentity,
)
from app.annotations.parser import parse_annotation, parse_image_annotations
from app.annotations.masks import ResolvedAnnotationMask, resolve_annotation_mask
from app.annotations.sources import infer_annotation_source, normalize_source
from app.annotations.records import (
    ANNOTATION_SCHEMA_VERSION,
    annotation_core_fields,
    normalize_annotation_record,
    normalize_annotation_records,
)

__all__ = [
    'AnnotationGeometry',
    'AnnotationIssue',
    'AnnotationProvenance',
    'BoundingBox',
    'CanonicalAnnotation',
    'ParseContext',
    'ParsedImageAnnotations',
    'SourceIdentity',
    'normalize_source',
    'ANNOTATION_SCHEMA_VERSION',
    'annotation_core_fields',
    'normalize_annotation_record',
    'normalize_annotation_records',
    'infer_annotation_source',
    'ResolvedAnnotationMask',
    'resolve_annotation_mask',
    'parse_annotation',
    'parse_image_annotations',
]
