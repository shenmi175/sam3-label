from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from app.annotations import ParseContext, parse_image_annotations
from app.exporting.artifacts import publish_unique_file, temporary_zip_path
from app.exporting.models import ImageExportMode, ExportProfile, ExportSnapshot, ExportStats, YoloMultipartPolicy
from app.exporting.normalization import IssueCollector, normalize_image
from app.exporting.selection import resolve_class_list
from app.exporting.validation import add_common_preflight_issues
from app.exporting.writers import write_coco, write_native_json_v2, write_native_json_v2_directory, write_yolo
from app.exporting.writers.yolo import summarize_bridges


SEGMENTATION_PROFILES = frozenset({'coco_instance', 'yolo_instance'})
TRAINING_PROFILES = frozenset({'coco_detection', 'coco_instance', 'yolo_detection', 'yolo_instance'})


class ExportService:
    def preflight(
        self,
        *,
        profile: ExportProfile = 'native_json_v2',
        project: dict[str, Any],
        all_annotations: dict[str, list[dict[str, Any]]],
        source_models: list[str],
        classes: list[str],
        val_ratio: float = 0.0,
        yolo_multipart_policy: YoloMultipartPolicy = 'official_bridge',
        image_mode: ImageExportMode = 'none',
    ) -> ExportSnapshot:
        images = list(project.get('images') or [])
        stats = ExportStats(images_total=len(images))
        issues = IssueCollector()
        class_list = resolve_class_list(project, classes)
        if profile in {'yolo_detection', 'yolo_instance'}:
            for class_name in class_list:
                if '\n' in class_name or '\r' in class_name:
                    issues.add(
                        code='INVALID_YOLO_CLASS_NAME',
                        message='YOLO class names cannot contain line breaks.',
                        severity='blocker',
                    )
        allowed_sources = {str(value).strip() for value in source_models if str(value).strip()}
        allowed_classes = set(class_list)

        normalized_images = []
        known_image_ids: set[str] = set()
        for image in images:
            export_image = dict(image)
            if not str(export_image.get('abs_path') or '').strip():
                image_root = str(project.get('image_dir') or '').strip()
                image_rel_path = str(export_image.get('rel_path') or '').strip()
                if image_root and image_rel_path:
                    export_image['abs_path'] = str((Path(image_root).expanduser() / image_rel_path).resolve())
            image_id = str(image.get('id') or '').strip()
            if image_id:
                known_image_ids.add(image_id)
            raw_annotations = all_annotations.get(image_id, [])
            width = image.get('width') if isinstance(image.get('width'), int) else None
            height = image.get('height') if isinstance(image.get('height'), int) else None
            parsed = parse_image_annotations(
                raw_annotations,
                ParseContext(image_id=image_id, image_width=width, image_height=height),
            )
            stats.raw_records_total += parsed.raw_record_count
            stats.canonical_instances_total += len(parsed.instances)
            stats.annotations_total += len(parsed.instances)
            image_annotations = []
            for instance in parsed.instances:
                source = instance.provenance.producer.source_id
                class_name = instance.class_name
                if source not in allowed_sources:
                    stats.skipped_source += 1
                    continue
                if class_name not in allowed_classes:
                    stats.skipped_class += 1
                    continue
                image_annotations.append(instance)
                stats.annotations_selected += 1
                stats.canonical_instances_selected += 1
                stats.by_source[source] = stats.by_source.get(source, 0) + 1
                stats.by_class[class_name] = stats.by_class.get(class_name, 0) + 1
            normalized = normalize_image(
                image=export_image,
                annotations=image_annotations,
                stats=stats,
                issues=issues,
                require_dimensions=profile in TRAINING_PROFILES,
                allow_polygon_bbox_fallback=profile in {'coco_detection', 'yolo_detection'},
            )
            if normalized is not None:
                normalized_images.append(normalized)
                if image_mode != 'none':
                    source_path = Path(normalized.source_path).expanduser() if normalized.source_path else None
                    if source_path is None or not source_path.is_file():
                        issues.add(
                            code='IMAGE_SOURCE_UNAVAILABLE_FOR_LINK',
                            message='An original image is unavailable, so it cannot be retained for training.',
                            severity='blocker',
                            image_id=normalized.image_id,
                        )

        for image_id, annotations in all_annotations.items():
            if annotations and image_id not in known_image_ids:
                issues.add(
                    code='ANNOTATION_IMAGE_MISSING',
                    message='Selected annotations reference an image that is not in the project.',
                    severity='blocker',
                    image_id=image_id,
                )

        if profile in SEGMENTATION_PROFILES:
            bbox_only_instances = [
                (image, instance)
                for image in normalized_images
                for instance in image.instances
                if not instance.regions
            ]
            bbox_only_by_source: dict[str, int] = {}
            for _image, instance in bbox_only_instances:
                source_model = instance.source_model or 'unknown'
                bbox_only_by_source[source_model] = bbox_only_by_source.get(source_model, 0) + 1
            segmentation_details = {
                'profile': profile,
                'by_source': bbox_only_by_source,
                'selected_sources': list(source_models),
                'skipped_sources': list(bbox_only_by_source),
            }
            for index, (image, instance) in enumerate(bbox_only_instances):
                issues.add(
                    code='SEGMENTATION_REQUIRES_POLYGON',
                    message='A bbox-only instance will be skipped after explicit confirmation.',
                    severity='warning',
                    image_id=image.image_id,
                    annotation_id=instance.source_annotation_ids[0],
                    sample={
                        'source_model': instance.source_model or 'unknown',
                        'class_name': instance.class_name,
                    },
                    details=segmentation_details if index == 0 else None,
                )
            if bbox_only_instances:
                for image in normalized_images:
                    image.instances = [instance for instance in image.instances if instance.regions]
                stats.instances_written -= len(bbox_only_instances)

        format_details: dict[str, Any] = {}
        multipart = [
            (image, instance)
            for image in normalized_images
            for instance in image.instances
            if len(instance.regions) > 1
        ]
        if profile == 'yolo_instance' and multipart:
            if yolo_multipart_policy == 'reject':
                for image, instance in multipart:
                    issues.add(
                        code='YOLO_MULTIPART_REJECTED',
                        message='YOLO multipart policy is reject, but a multipart instance was selected.',
                        severity='blocker',
                        image_id=image.image_id,
                        annotation_id=instance.source_annotation_ids[0],
                    )
            else:
                bridge_summary = summarize_bridges(normalized_images)
                format_details['multipart_bridge'] = bridge_summary
                first_sample = bridge_summary['samples'][0]
                issues.add(
                    code='YOLO_MULTIPART_BRIDGE',
                    message='Multipart instances will be bridged with Ultralytics official merge_multi_segment and require confirmation.',
                    severity='warning',
                    image_id=first_sample['image_id'],
                    annotation_id=first_sample['instance_id'],
                    sample=first_sample,
                    details={key: value for key, value in bridge_summary.items() if key != 'samples'},
                    occurrences=bridge_summary['affected_instances'],
                )

        stats.negative_images = sum(1 for image in normalized_images if not image.instances)
        stats.images_written = len(normalized_images)
        stats.output_records = stats.images_written
        add_common_preflight_issues(
            stats=stats,
            issues=issues,
            allow_no_valid_instances=profile in SEGMENTATION_PROFILES and bool(bbox_only_instances),
        )
        warnings, blockers = issues.split()
        try:
            content_rev = max(1, int(project.get('content_rev', 1) or 1))
        except (TypeError, ValueError):
            content_rev = 1
        return ExportSnapshot(
            profile=profile,
            project_id=str(project.get('id') or ''),
            project_name=str(project.get('name') or ''),
            project_content_rev=content_rev,
            project_classes=[str(value) for value in project.get('classes') or []],
            selected_classes=class_list,
            source_models=list(source_models),
            images=normalized_images,
            stats=stats,
            val_ratio=val_ratio,
            yolo_multipart_policy=yolo_multipart_policy,
            image_mode=image_mode,
            warnings=warnings,
            blockers=blockers,
            format_details=format_details,
        )

    def build_to_directory(
        self,
        *,
        snapshot: ExportSnapshot,
        output_dir: Path,
        created_at: datetime,
        filename_stem: str,
    ) -> tuple[Path, dict[str, Any]]:
        if not snapshot.ok:
            raise ValueError('cannot build an export with preflight blockers')
        output_dir.mkdir(parents=True, exist_ok=True)
        if snapshot.profile in {'coco_detection', 'coco_instance'}:
            return write_coco(snapshot=snapshot, output_dir=output_dir, created_at=created_at)
        if snapshot.profile in {'yolo_detection', 'yolo_instance'}:
            return write_yolo(snapshot=snapshot, output_dir=output_dir, created_at=created_at)
        if snapshot.profile != 'native_json_v2':
            raise ValueError(f'unsupported export profile: {snapshot.profile}')

        if snapshot.image_mode != 'none':
            return write_native_json_v2_directory(
                snapshot=snapshot,
                output_dir=output_dir,
                created_at=created_at,
                filename_stem=filename_stem,
            )

        filename = f"{filename_stem}_native_json_v2_{created_at.strftime('%Y%m%d_%H%M%S')}.zip"
        requested_path = output_dir / filename
        temporary_path = temporary_zip_path(output_dir)
        try:
            manifest = write_native_json_v2(snapshot=snapshot, archive_path=temporary_path, created_at=created_at)
            output_path = publish_unique_file(temporary_path, requested_path)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
        return output_path, manifest


# Kept as a source-compatible name for internal callers while every profile now
# uses the same service and normalization path.
NativeJsonExportService = ExportService
