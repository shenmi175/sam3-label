from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from app.exports import export_coco, export_yolo
from app.schemas import ExportIn
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
    if project.get('project_type') == 'video':
        return ensure_dir(Path(project.get('project_save_dir') or project.get('save_dir')).expanduser().resolve())
    return ensure_dir(Path(project.get('image_dir') or project.get('project_save_dir')).expanduser().resolve())


def create_export_router(*, storage: Storage) -> APIRouter:
    router = APIRouter()

    @router.post('/api/export')
    def export_project(payload: ExportIn) -> dict[str, Any]:
        project = _get_project_or_404(storage, payload.project_id)
        if project.get('project_type') == 'video':
            raise HTTPException(status_code=410, detail='video annotation has been removed; image projects only')

        images = project.get('images', [])
        all_annotations = storage.all_annotations(payload.project_id)

        include_bbox = bool(payload.include_bbox)
        include_mask = bool(payload.include_mask)
        if not include_bbox and not include_mask:
            raise HTTPException(status_code=400, detail='at least one of include_bbox/include_mask must be true')
        if payload.format == 'yolo' and include_bbox and include_mask:
            raise HTTPException(status_code=400, detail='YOLO cannot export bbox and mask together')

        out_dir = _resolve_output_dir(project, payload.output_dir)
        fmt = str(payload.format).lower()

        if fmt in {'json', 'coco'}:
            out = export_coco(
                project=project,
                images=images,
                all_annotations=all_annotations,
                output_dir=out_dir,
                include_bbox=include_bbox,
                include_mask=include_mask,
            )
        elif fmt == 'yolo':
            mode = 'seg' if include_mask else 'det'
            out = export_yolo(
                project=project,
                images=images,
                all_annotations=all_annotations,
                output_dir=out_dir,
                mode=mode,
            )
        else:
            raise HTTPException(status_code=400, detail='unsupported export format')

        return {'ok': True, 'output': str(out)}

    return router
