from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Query

from app.schemas import SmartFilterIn
from app.storage import Storage


def create_filters_router(
    *,
    get_storage: Callable[[], Storage],
    get_project_or_404: Callable[..., dict[str, Any]],
    analyze_smart_merge_annotations: Callable[..., dict[str, Any]],
    normalize_smart_filter_payload: Callable[[SmartFilterIn], dict[str, Any]],
    spawn_smart_filter_job: Callable[..., dict[str, Any]],
    run_smart_filter_preview_job: Callable[..., dict[str, Any]],
    run_smart_filter_apply_job: Callable[..., dict[str, Any]],
    get_active_smart_filter_job_for_project: Callable[[str], dict[str, Any] | None],
    get_smart_filter_job_state_or_404: Callable[[str], dict[str, Any]],
) -> APIRouter:
    router = APIRouter()

    @router.post('/api/filter/intelligent/preview')
    def preview_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')

        merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
        spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
        coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
        canonical_class = str(payload.canonical_class or '').strip()
        source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
        area_mode = str(payload.area_mode or 'instance').strip().lower()
        if merge_mode == 'canonical_class' and not canonical_class:
            raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
        if merge_mode == 'canonical_class' and not source_classes:
            raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

        items: list[dict[str, Any]] = []
        total_candidates = 0
        total_images = 0
        total_relabels = 0
        storage = get_storage()
        for image in project.get('images', []):
            image_id = str(image.get('id') or '')
            if not image_id:
                continue
            annotations = storage.load_annotations(payload.project_id, image_id)
            analysis = analyze_smart_merge_annotations(
                annotations,
                merge_mode=merge_mode,
                spatial_mode=spatial_mode,
                coverage_threshold=coverage_threshold,
                canonical_class=canonical_class,
                source_classes=source_classes,
                area_mode=area_mode,
            )
            removed = analysis.get('removed_annotations', [])
            pairs = analysis.get('pairs', [])
            relabeled = analysis.get('relabeled_annotations', [])
            remove_count = len(removed) if isinstance(removed, list) else 0
            relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
            if remove_count <= 0 and relabel_count <= 0:
                continue
            total_candidates += remove_count
            total_relabels += relabel_count
            total_images += 1
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': str(image.get('rel_path') or image_id),
                    'candidate_count': remove_count,
                    'relabel_count': relabel_count,
                    'pair_count': len(pairs) if isinstance(pairs, list) else 0,
                }
            )

        items.sort(
            key=lambda x: (
                int(x.get('candidate_count') or 0),
                int(x.get('relabel_count') or 0),
                str(x.get('rel_path') or ''),
            ),
            reverse=True,
        )
        return {
            'project_id': payload.project_id,
            'image_count': total_images,
            'candidate_count': total_candidates,
            'relabel_count': total_relabels,
            'items': items,
            'rule': {
                'merge_mode': merge_mode,
                'spatial_mode': spatial_mode,
                'same_class': merge_mode == 'same_class',
                'canonical_class': canonical_class,
                'source_classes': source_classes,
                'area_mode': area_mode,
                'small_box_covered_by_large_gte': coverage_threshold,
                'keep': 'larger_area',
            },
        }

    @router.post('/api/filter/intelligent/apply')
    def apply_intelligent_filter(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')

        merge_mode = str(payload.merge_mode or 'same_class').strip().lower()
        spatial_mode = str(payload.spatial_mode or 'instance_cover').strip().lower()
        coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold)))
        canonical_class = str(payload.canonical_class or '').strip()
        source_classes = [str(x).strip() for x in payload.source_classes if str(x).strip()]
        area_mode = str(payload.area_mode or 'instance').strip().lower()
        if merge_mode == 'canonical_class' and not canonical_class:
            raise HTTPException(status_code=400, detail='canonical_class is required for canonical_class merge mode')
        if merge_mode == 'canonical_class' and not source_classes:
            raise HTTPException(status_code=400, detail='source_classes is required for canonical_class merge mode')

        changed_images = 0
        removed_annotations = 0
        relabeled_annotations = 0
        items: list[dict[str, Any]] = []
        storage = get_storage()
        for image in project.get('images', []):
            image_id = str(image.get('id') or '')
            if not image_id:
                continue
            annotations = storage.load_annotations(payload.project_id, image_id)
            analysis = analyze_smart_merge_annotations(
                annotations,
                merge_mode=merge_mode,
                spatial_mode=spatial_mode,
                coverage_threshold=coverage_threshold,
                canonical_class=canonical_class,
                source_classes=source_classes,
                area_mode=area_mode,
            )
            removed = analysis.get('removed_annotations', [])
            kept_annotations = analysis.get('kept_annotations', annotations)
            relabeled = analysis.get('relabeled_annotations', [])
            remove_count = len(removed) if isinstance(removed, list) else 0
            relabel_count = len(relabeled) if isinstance(relabeled, list) else 0
            if remove_count <= 0 and relabel_count <= 0:
                continue
            storage.save_annotations(
                payload.project_id,
                image_id,
                kept_annotations if isinstance(kept_annotations, list) else annotations,
            )
            changed_images += 1
            removed_annotations += remove_count
            relabeled_annotations += relabel_count
            items.append(
                {
                    'image_id': image_id,
                    'rel_path': str(image.get('rel_path') or image_id),
                    'removed_count': remove_count,
                    'relabel_count': relabel_count,
                }
            )

        items.sort(
            key=lambda x: (
                int(x.get('removed_count') or 0),
                int(x.get('relabel_count') or 0),
                str(x.get('rel_path') or ''),
            ),
            reverse=True,
        )
        return {
            'project_id': payload.project_id,
            'changed_images': changed_images,
            'removed_annotations': removed_annotations,
            'relabeled_annotations': relabeled_annotations,
            'rule': {
                'merge_mode': merge_mode,
                'spatial_mode': spatial_mode,
                'canonical_class': canonical_class,
                'source_classes': source_classes,
                'area_mode': area_mode,
                'small_box_covered_by_large_gte': coverage_threshold,
            },
            'items': items,
        }

    @router.post('/api/filter/intelligent/jobs/start_preview')
    def start_smart_filter_preview_job(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')
        normalize_smart_filter_payload(payload)
        job = spawn_smart_filter_job(
            project_id=payload.project_id,
            job_type='preview',
            payload_dict=payload.model_dump(),
            worker=run_smart_filter_preview_job,
        )
        return {'job': job}

    @router.post('/api/filter/intelligent/jobs/start_apply')
    def start_smart_filter_apply_job(payload: SmartFilterIn) -> dict[str, Any]:
        project = get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='only image project is supported')
        normalize_smart_filter_payload(payload)
        job = spawn_smart_filter_job(
            project_id=payload.project_id,
            job_type='apply',
            payload_dict=payload.model_dump(),
            worker=run_smart_filter_apply_job,
        )
        return {'job': job}

    @router.get('/api/filter/intelligent/jobs/active')
    def get_active_smart_filter_job(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        return {'job': get_active_smart_filter_job_for_project(project_id)}

    @router.get('/api/filter/intelligent/jobs/{job_id}')
    def get_smart_filter_job(job_id: str) -> dict[str, Any]:
        return {'job': get_smart_filter_job_state_or_404(job_id)}

    @router.get('/api/filter/intelligent/runs/latest')
    def get_latest_smart_filter_run(project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        return {'run': get_storage().get_latest_smart_filter_run(project_id=project_id)}

    @router.post('/api/filter/intelligent/runs/{run_id}/rollback')
    def rollback_smart_filter_run(run_id: str, project_id: str = Query(..., min_length=1)) -> dict[str, Any]:
        get_project_or_404(project_id, enrich=False, include_images=False)
        try:
            result = get_storage().rollback_smart_filter_run(project_id=project_id, run_id=run_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {'result': result}

    return router
