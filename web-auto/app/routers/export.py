from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException

from app.audit import AuditLogger
from app.exporting import ExportService
from app.exports import summarize_annotations
from app.schemas import ExportIn, ExportPreflightIn, ExportPreviewIn
from app.storage import Storage
from app.utils import ensure_dir


def _get_project_or_404(storage: Storage, project_id: str) -> dict[str, Any]:
    project = storage.get_project(project_id, enrich=False, include_images=True)
    if not project:
        raise HTTPException(status_code=404, detail='project not found')
    return project


def _content_rev(project: dict[str, Any]) -> int:
    try:
        return max(1, int(project.get('content_rev', 1) or 1))
    except (TypeError, ValueError):
        return 1


def _resolve_output_dir(project: dict[str, Any], output_dir: Optional[str]) -> Path:
    if output_dir and str(output_dir).strip():
        return ensure_dir(Path(str(output_dir)).expanduser().resolve())
    default_dir = project.get('export_dir') or project.get('project_save_dir') or project.get('image_dir')
    return ensure_dir(Path(str(default_dir)).expanduser().resolve())


def _export_stem(project_name: Any) -> str:
    raw = str(project_name or '').strip()
    safe = re.sub(r'[^\w.-]+', '_', raw, flags=re.UNICODE).strip('._')
    return safe[:80] or 'project'


def _snapshot(service: ExportService, payload: ExportPreflightIn | ExportIn, project: dict[str, Any], annotations: dict[str, list[dict[str, Any]]]):
    return service.preflight(
        profile=payload.profile,
        project=project,
        all_annotations=annotations,
        source_models=list(payload.source_models),
        classes=list(payload.classes),
        val_ratio=float(payload.val_ratio),
        yolo_multipart_policy=payload.yolo_multipart_policy,
        image_mode=payload.image_mode,
    )


def create_export_router(*, get_storage: Callable[[], Storage], audit: AuditLogger | None = None) -> APIRouter:
    router = APIRouter()
    exports = ExportService()

    @router.post('/api/export/preview')
    def export_preview(payload: ExportPreviewIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        summary = summarize_annotations(storage.all_annotations(payload.project_id))
        return {
            'ok': True,
            'project_id': payload.project_id,
            'images_total': len(project.get('images', [])),
            'classes': list(project.get('classes') or []),
            **summary,
        }

    @router.post('/api/export/preflight')
    def export_preflight(payload: ExportPreflightIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        current_rev = _content_rev(project)
        if payload.expected_content_rev is not None and payload.expected_content_rev != current_rev:
            raise HTTPException(
                status_code=409,
                detail={
                    'code': 'EXPORT_STALE',
                    'message': 'project annotations changed before preflight',
                    'expected_content_rev': payload.expected_content_rev,
                    'current_content_rev': current_rev,
                },
            )
        return _snapshot(exports, payload, project, storage.all_annotations(payload.project_id)).preflight_dict()

    @router.post('/api/export')
    def export_project(payload: ExportIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        current_rev = _content_rev(project)
        if payload.expected_content_rev != current_rev:
            raise HTTPException(
                status_code=409,
                detail={
                    'code': 'EXPORT_STALE',
                    'message': 'project annotations changed after preflight',
                    'expected_content_rev': payload.expected_content_rev,
                    'current_content_rev': current_rev,
                },
            )

        snapshot = _snapshot(exports, payload, project, storage.all_annotations(payload.project_id))
        if snapshot.blockers:
            raise HTTPException(
                status_code=400,
                detail={
                    'code': 'EXPORT_PREFLIGHT_BLOCKED',
                    'message': 'export preflight failed',
                    'preflight': snapshot.preflight_dict(),
                },
            )
        missing_confirmations = sorted(set(snapshot.confirmation_required_codes) - set(payload.confirmed_issue_codes))
        if missing_confirmations:
            raise HTTPException(
                status_code=409,
                detail={
                    'code': 'EXPORT_CONFIRMATION_REQUIRED',
                    'message': 'export contains issues that require explicit confirmation',
                    'required_issue_codes': missing_confirmations,
                    'preflight': snapshot.preflight_dict(),
                },
            )

        latest_project = _get_project_or_404(storage, payload.project_id)
        latest_rev = _content_rev(latest_project)
        if latest_rev != snapshot.project_content_rev:
            raise HTTPException(
                status_code=409,
                detail={
                    'code': 'EXPORT_STALE',
                    'message': 'project annotations changed while preparing the export',
                    'expected_content_rev': snapshot.project_content_rev,
                    'current_content_rev': latest_rev,
                },
            )

        output_path, manifest = exports.build_to_directory(
            snapshot=snapshot,
            output_dir=_resolve_output_dir(project, payload.output_dir),
            created_at=datetime.now(timezone.utc),
            filename_stem=_export_stem(project.get('name')),
        )
        if audit:
            audit.emit(category='data_transfer', action='export', project_id=payload.project_id, message='Project export completed', details={'profile': snapshot.profile, 'classes': snapshot.selected_classes, 'stats': snapshot.stats.as_dict(), 'warning_count': len(snapshot.warnings)})
        return {
            'ok': True,
            'profile': snapshot.profile,
            'output': str(output_path),
            'classes': snapshot.selected_classes,
            'schema': manifest.get('schema'),
            'stats': snapshot.stats.as_dict(),
            'warnings': [issue.as_dict() for issue in snapshot.warnings],
            'format_details': snapshot.format_details,
        }

    return router
