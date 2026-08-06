from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException

from app.exports import ExportStats, export_coco, export_yolo, resolve_class_list, select_annotations, summarize_annotations
from app.schemas import ExportIn, ExportPreviewIn
from app.storage import Storage
from app.utils import ensure_dir


def _get_project_or_404(storage: Storage, project_id: str) -> dict[str, Any]:
    project = storage.get_project(project_id, enrich=False, include_images=True)
    if not project:
        raise HTTPException(status_code=404, detail='project not found')
    return project


def _resolve_output_dir(project: dict[str, Any], output_dir: Optional[str]) -> Path:
    if output_dir and str(output_dir).strip():
        return ensure_dir(Path(str(output_dir)).expanduser().resolve())
    default_dir = project.get('export_dir') or project.get('project_save_dir') or project.get('image_dir')
    return ensure_dir(Path(str(default_dir)).expanduser().resolve())


def create_export_router(*, get_storage: Callable[[], Storage]) -> APIRouter:
    router = APIRouter()

    @router.post('/api/export/preview')
    def export_preview(payload: ExportPreviewIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)
        all_annotations = storage.all_annotations(payload.project_id)
        summary = summarize_annotations(all_annotations)
        return {
            'ok': True,
            'project_id': payload.project_id,
            'images_total': len(project.get('images', [])),
            'classes': list(project.get('classes') or []),
            **summary,
        }

    @router.post('/api/export')
    def export_project(payload: ExportIn) -> dict[str, Any]:
        storage = get_storage()
        project = _get_project_or_404(storage, payload.project_id)

        images = project.get('images', [])
        all_annotations = storage.all_annotations(payload.project_id)

        include_bbox = bool(payload.include_bbox)
        include_mask = bool(payload.include_mask)
        if not include_bbox and not include_mask:
            raise HTTPException(status_code=400, detail='at least one of include_bbox/include_mask must be true')
        if payload.format == 'yolo' and include_bbox and include_mask:
            raise HTTPException(status_code=400, detail='YOLO cannot export bbox and mask together')

        class_list = resolve_class_list(project, payload.classes)
        if not class_list:
            raise HTTPException(status_code=400, detail='no classes to export')

        stats = ExportStats()
        selected = select_annotations(
            all_annotations=all_annotations,
            source_models=list(payload.source_models),
            class_list=class_list,
            stats=stats,
        )
        if stats.annotations_total > 0 and not any(selected.values()):
            summary = summarize_annotations(all_annotations)
            raise HTTPException(
                status_code=400,
                detail={
                    'code': 'EXPORT_EMPTY',
                    'message': 'no annotations match the selected sources and classes',
                    'by_source': summary['by_source'],
                    'by_class': summary['by_class'],
                    'selected_sources': list(payload.source_models),
                },
            )

        out_dir = _resolve_output_dir(project, payload.output_dir)
        fmt = str(payload.format).lower()

        if fmt in {'json', 'coco'}:
            out, stats = export_coco(
                project=project,
                images=images,
                all_annotations=selected,
                class_list=class_list,
                output_dir=out_dir,
                include_bbox=include_bbox,
                include_mask=include_mask,
                stats=stats,
            )
        elif fmt == 'yolo':
            out, stats = export_yolo(
                project=project,
                images=images,
                all_annotations=selected,
                class_list=class_list,
                output_dir=out_dir,
                mode='seg' if include_mask else 'det',
                val_ratio=float(payload.val_ratio),
                write_data_yaml=bool(payload.write_data_yaml),
                stats=stats,
            )
        else:
            raise HTTPException(status_code=400, detail='unsupported export format')

        return {'ok': True, 'output': str(out), 'classes': class_list, 'stats': stats.as_dict()}

    return router
