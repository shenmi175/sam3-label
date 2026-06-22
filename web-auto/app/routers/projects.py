from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query

from app.schemas import ImportExistingProjectIn, OpenProjectIn
from app.storage import Storage


def create_projects_router(
    *,
    get_storage: Callable[[], Storage],
    logger: logging.Logger,
    allowed_data_roots: list[Path],
    auto_import_project_manifests: Callable[..., dict[str, Any]],
    resolve_project_discovery_roots: Callable[[str], list[Path]],
    project_discovery_root_info: Callable[[list[Path]], list[dict[str, Any]]],
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/projects')
    def list_projects(auto_discover: bool = Query(default=False)) -> dict[str, Any]:
        discovery = (
            auto_import_project_manifests()
            if auto_discover
            else {'imported': [], 'skipped': 0, 'errors': [], 'cached': True, 'auto_discover': False}
        )
        projects = [
            project for project in get_storage().list_projects()
            if str(project.get('project_type') or 'image').strip().lower() in {'image', 'pose'}
        ]
        return {'projects': projects, 'discovery': discovery}

    @router.get('/api/projects/discover')
    def discover_existing_projects(
        scan_root: str = Query(default=''),
        max_depth: int = Query(default=8, ge=1, le=12),
    ) -> dict[str, Any]:
        roots = resolve_project_discovery_roots(scan_root)
        discovery = auto_import_project_manifests(roots=roots, force=True, max_depth=max_depth)
        candidates = get_storage().discover_existing_projects(roots, max_depth=max_depth)
        return {
            'candidates': candidates,
            'discovery': discovery,
            'scan_roots': project_discovery_root_info(roots),
            'allowed_data_roots': [str(root) for root in allowed_data_roots],
            'max_depth': max_depth,
        }

    @router.post('/api/projects/import_existing')
    def import_existing_project(payload: ImportExistingProjectIn) -> dict[str, Any]:
        project_type = str(payload.project_type or 'image').strip().lower()
        if project_type not in {'', 'image', 'pose'}:
            raise HTTPException(status_code=410, detail='video annotation has been removed; image projects only')
        try:
            return get_storage().import_existing_project(
                output_dir=payload.output_dir,
                manifest_path=payload.manifest_path,
                image_dir=payload.image_dir,
                name=payload.name,
                classes_text=payload.classes_text,
                project_type=project_type or 'image',
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get('/api/projects/{project_id}')
    def get_project(project_id: str, include_images: bool = Query(default=True)) -> dict[str, Any]:
        project = get_storage().get_project(project_id, enrich=False, include_images=bool(include_images))
        if not project:
            raise HTTPException(status_code=404, detail='project not found')
        if str(project.get('project_type') or 'image').strip().lower() not in {'image', 'pose'}:
            raise HTTPException(status_code=404, detail='project not found')
        return {'project': project}

    @router.post('/api/projects/open')
    def open_project(payload: OpenProjectIn) -> dict[str, Any]:
        try:
            project_type = str(payload.project_type or 'image').strip().lower()
            classes_text = payload.classes_text
            if project_type == 'pose' and not str(classes_text or '').strip():
                classes_text = 'person_pose'
            logger.info(
                'open project name=%s type=%s image_dir=%s save_dir=%s',
                payload.name,
                project_type,
                payload.image_dir,
                payload.save_dir,
            )
            project = get_storage().create_project(
                name=payload.name,
                image_dir=payload.image_dir,
                save_dir=payload.save_dir,
                classes_text=classes_text,
                project_type=project_type,
            )
            logger.info(
                'open project done id=%s type=%s images=%s classes=%s',
                project.get('id'),
                project.get('project_type'),
                len(project.get('images', [])),
                len(project.get('classes', [])),
            )
            return {'project': project}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.delete('/api/projects/{project_id}')
    def delete_project(project_id: str) -> dict[str, Any]:
        try:
            get_storage().delete_project(project_id)
            return {'ok': True}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return router
