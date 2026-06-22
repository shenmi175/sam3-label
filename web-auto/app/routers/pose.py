from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from app.schemas import PoseInferIn
from app.services.integration_clients import SapiensClient
from app.storage import Storage
from app.utils import new_id


def _pose_annotations_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    links = result.get('skeleton_links') if isinstance(result.get('skeleton_links'), list) else []
    annotations: list[dict[str, Any]] = []
    instances = result.get('instances', []) if isinstance(result.get('instances'), list) else []
    for raw in instances:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        item['id'] = new_id('pose_')
        item['type'] = 'pose'
        item['label'] = str(item.get('label') or item.get('class_name') or 'person_pose')
        item['class_name'] = str(item.get('class_name') or item.get('label') or 'person_pose')
        if links and not isinstance(item.get('skeleton_links'), list):
            item['skeleton_links'] = links
        annotations.append(item)
    return annotations


def create_pose_router(*, get_storage: Callable[[], Storage], sapiens_client: SapiensClient) -> APIRouter:
    router = APIRouter()

    @router.post('/api/pose/infer')
    def infer_pose(payload: PoseInferIn) -> dict[str, Any]:
        storage = get_storage()
        project = storage.get_project(payload.project_id, include_images=False)
        if not project:
            raise HTTPException(status_code=404, detail='project not found')
        if str(project.get('project_type') or 'image').strip().lower() != 'pose':
            raise HTTPException(status_code=400, detail='only pose project is supported')
        image = storage.find_image(project, payload.image_id)
        if not image:
            raise HTTPException(status_code=404, detail='image not found')
        abs_path_raw = str(image.get('abs_path') or '').strip()
        if not abs_path_raw:
            raise HTTPException(status_code=404, detail='image file not found')
        image_path = Path(abs_path_raw).expanduser().resolve()
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail=f'image file not found: {image_path}')
        try:
            result = sapiens_client.file_request(
                '/v1/pose/infer',
                file_path=image_path,
                fields={
                    'bbox_threshold': max(0.0, min(1.0, float(payload.bbox_threshold))),
                    'nms_threshold': max(0.0, min(1.0, float(payload.nms_threshold))),
                    'keypoint_threshold': max(0.0, min(1.0, float(payload.keypoint_threshold))),
                },
                timeout=600.0,
            )
            annotations = _pose_annotations_from_result(result)
            storage.save_annotations(payload.project_id, payload.image_id, annotations)
            saved = storage.load_annotations(payload.project_id, payload.image_id)
            return {
                'project_id': payload.project_id,
                'image_id': payload.image_id,
                'num_instances': len(saved),
                'annotations': saved,
                'saved_annotations': saved,
                'raw': result,
            }
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return router
