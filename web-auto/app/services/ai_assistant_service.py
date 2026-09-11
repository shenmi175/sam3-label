from __future__ import annotations

import threading
from typing import Any, Callable

from fastapi import HTTPException

from app.annotations import infer_annotation_source
from app.schemas import AiFeatureDeleteIn, AiPointIn, AiSessionIn, AiSessionOpenIn
from app.storage import Storage


class AiAssistantService:
    def __init__(
        self,
        *,
        get_storage: Callable[[], Storage],
        sam3: Any,
        acquire_gpu: Callable[[], str],
        release_gpu: Callable[[str], None],
        active_infer_job: Callable[[str], dict[str, Any] | None],
    ) -> None:
        self._get_storage = get_storage
        self._sam3 = sam3
        self._acquire_gpu = acquire_gpu
        self._release_gpu = release_gpu
        self._active_infer_job = active_infer_job
        self._lock = threading.RLock()
        self._priority = threading.Condition(self._lock)
        self._interactive_waiters = 0
        self._project_generations: dict[str, int] = {}
        self._candidates: dict[str, dict[str, Any]] = {}
        self._session_selection: dict[str, dict[str, Any]] = {}

    @property
    def storage(self) -> Storage:
        return self._get_storage()

    def _project_image(self, project_id: str, image_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        project = self.storage.get_project(project_id, enrich=False, include_images=False)
        if not project:
            raise HTTPException(status_code=404, detail='project not found')
        if str(project.get('project_type') or '') != 'image':
            raise HTTPException(status_code=400, detail='SAM3 AI assistance supports image projects only')
        image = self.storage.find_image(project, image_id)
        if not image:
            raise HTTPException(status_code=404, detail='image not found')
        return project, image

    @staticmethod
    def _annotation_polygons(annotation: dict[str, Any]) -> list[list[list[float]]]:
        polygons = annotation.get('polygons')
        if isinstance(polygons, list):
            valid = [poly for poly in polygons if isinstance(poly, list) and len(poly) >= 3]
            if valid:
                return valid
        polygon = annotation.get('polygon')
        if isinstance(polygon, list) and len(polygon) >= 3:
            return [polygon]
        bbox = annotation.get('bbox') or annotation.get('bbox_xyxy')
        if isinstance(bbox, list) and len(bbox) == 4:
            x1, y1, x2, y2 = [float(v) for v in bbox]
            return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]]
        return []

    def _selected_annotation(self, project_id: str, image_id: str, annotation_id: str) -> tuple[dict[str, Any] | None, list]:
        if not annotation_id:
            return None, []
        annotations = self.storage.load_annotations(project_id, image_id)
        selected = next(
            (ann for ann in annotations if str(ann.get('id') or '') == str(annotation_id)),
            None,
        )
        if selected is None:
            raise HTTPException(status_code=404, detail='selected annotation not found')
        source = infer_annotation_source(selected).source_id
        if source != 'sam3':
            raise HTTPException(
                status_code=400,
                detail='当前仅支持在 SAM3 标注层上进行 AI 辅助修改',
            )
        polygons = self._annotation_polygons(selected)
        if not polygons:
            raise HTTPException(status_code=400, detail='selected annotation has no refinable geometry')
        return selected, polygons

    def cleanup_transient_features(self) -> list[dict[str, Any]]:
        cleaned: list[dict[str, Any]] = []
        for project_id in self.storage.transient_ai_projects():
            try:
                cleaned.append(self.storage.delete_transient_ai_features(project_id))
            except ValueError:
                continue
        return cleaned

    def open_session(self, payload: AiSessionOpenIn) -> tuple[dict[str, Any], list[str], int]:
        _project, image = self._project_image(payload.project_id, payload.image_id)
        selected, polygons = self._selected_annotation(
            payload.project_id, payload.image_id, payload.selected_annotation_id
        )
        lease = self._acquire_gpu()
        try:
            result = self._sam3.open_interactive_session(
                api_base_url=payload.api_base_url,
                image_path=str(image.get('abs_path') or ''),
                project_id=payload.project_id,
                image_id=payload.image_id,
                feature_root=str(self.storage.ai_feature_root(payload.project_id)),
                initial_polygons=polygons,
                persist_feature=False,
            )
        finally:
            self._release_gpu(lease)
        session_id = str(result.get('session_id') or '')
        with self._lock:
            generation = int(self._project_generations.get(payload.project_id, 0)) + 1
            self._project_generations[payload.project_id] = generation
            self._session_selection[session_id] = {
                'project_id': payload.project_id,
                'annotation': selected,
                'annotation_id': payload.selected_annotation_id,
            }
            self._candidates.pop(session_id, None)
        neighbors = self._neighbors(payload)
        result['selected_annotation_id'] = payload.selected_annotation_id
        result['refining_existing'] = selected is not None
        return result, neighbors, generation

    def _neighbors(self, payload: AiSessionOpenIn) -> list[str]:
        items, total, _offset, _limit, index = self.storage.get_project_images_page(
            payload.project_id,
            offset=0,
            limit=1,
            image_id=payload.image_id,
            status=payload.image_filter_status,
            class_name=payload.image_filter_class,
            source_model=payload.source_model,
        )
        del items
        if index < 0:
            return []
        start = max(0, index - 2)
        page, _total, _offset, _limit, _index = self.storage.get_project_images_page(
            payload.project_id,
            offset=start,
            limit=min(5, total - start),
            status=payload.image_filter_status,
            class_name=payload.image_filter_class,
            source_model=payload.source_model,
        )
        by_index = {start + idx: str(item.get('id') or '') for idx, item in enumerate(page)}
        order = [index - 1, index + 1, index - 2, index + 2]
        return [by_index[pos] for pos in order if by_index.get(pos)]

    def prefetch_neighbors(
        self,
        *,
        project_id: str,
        image_ids: list[str],
        api_base_url: str,
        generation: int,
    ) -> None:
        for image_id in image_ids:
            with self._priority:
                while self._interactive_waiters > 0:
                    self._priority.wait(timeout=0.1)
                if self._project_generations.get(project_id) != generation:
                    return
            try:
                _project, image = self._project_image(project_id, image_id)
                lease = self._acquire_gpu()
                try:
                    self._sam3.open_interactive_session(
                        api_base_url=api_base_url,
                        image_path=str(image.get('abs_path') or ''),
                        project_id=project_id,
                        image_id=image_id,
                        feature_root=str(self.storage.ai_feature_root(project_id)),
                        keep_session=False,
                        persist_feature=False,
                    )
                finally:
                    self._release_gpu(lease)
            except Exception:
                # Prefetch is best effort. A later current-image open retries synchronously.
                continue

    def _validate_session(self, project_id: str, session_id: str) -> None:
        with self._lock:
            selection = self._session_selection.get(str(session_id))
        if not selection or str(selection.get('project_id') or '') != str(project_id):
            raise HTTPException(status_code=404, detail='AI session not found for this project')

    def predict(self, payload: AiPointIn) -> dict[str, Any]:
        self._validate_session(payload.project_id, payload.session_id)
        with self._priority:
            self._interactive_waiters += 1
        lease = ''
        try:
            lease = self._acquire_gpu()
            result = self._sam3.interactive_predict(
                payload.api_base_url,
                {
                    'session_id': payload.session_id,
                    'x': payload.x,
                    'y': payload.y,
                    'label': payload.label,
                },
            )
        finally:
            if lease:
                self._release_gpu(lease)
            with self._priority:
                self._interactive_waiters = max(0, self._interactive_waiters - 1)
                self._priority.notify_all()
        with self._lock:
            candidate = dict(result.get('candidate') or {})
            if candidate:
                self._candidates[payload.session_id] = candidate
            else:
                self._candidates.pop(payload.session_id, None)
        return result

    def reset(self, payload: AiSessionIn) -> dict[str, Any]:
        self._validate_session(payload.project_id, payload.session_id)
        result = self._sam3.interactive_reset(payload.api_base_url, payload.session_id)
        with self._lock:
            self._candidates.pop(payload.session_id, None)
        return result

    def move_prompt_history(self, payload: AiSessionIn, *, direction: str) -> dict[str, Any]:
        self._validate_session(payload.project_id, payload.session_id)
        lease = self._acquire_gpu()
        try:
            if direction == 'undo':
                result = self._sam3.interactive_prompt_undo(payload.api_base_url, payload.session_id)
            else:
                result = self._sam3.interactive_prompt_redo(payload.api_base_url, payload.session_id)
        finally:
            self._release_gpu(lease)
        candidate = dict(result.get('candidate') or {})
        with self._lock:
            if candidate:
                self._candidates[payload.session_id] = candidate
            else:
                self._candidates.pop(payload.session_id, None)
        return result

    def accept(self, payload: AiSessionIn) -> dict[str, Any]:
        self._validate_session(payload.project_id, payload.session_id)
        with self._lock:
            candidate = dict(self._candidates.get(payload.session_id) or {})
            selection = dict(self._session_selection.get(payload.session_id) or {})
        if not candidate:
            raise HTTPException(status_code=409, detail='no AI mask candidate to accept')
        return {
            'session_id': payload.session_id,
            'candidate': candidate,
            'selected_annotation_id': str(selection.get('annotation_id') or ''),
            'refining_existing': bool(selection.get('annotation')),
        }

    def close(self, payload: AiSessionIn) -> dict[str, Any]:
        self._validate_session(payload.project_id, payload.session_id)
        try:
            result = self._sam3.interactive_close(payload.api_base_url, payload.session_id)
        finally:
            with self._lock:
                self._candidates.pop(payload.session_id, None)
                self._session_selection.pop(payload.session_id, None)
                self._project_generations[payload.project_id] = int(
                    self._project_generations.get(payload.project_id, 0)
                ) + 1
        return result

    def feature_status(self, project_id: str, image_id: str = '') -> dict[str, Any]:
        return self.storage.ai_feature_status(project_id, image_id)

    def delete_features(self, payload: AiFeatureDeleteIn) -> dict[str, Any]:
        if not payload.confirmed:
            raise HTTPException(status_code=400, detail='feature deletion requires confirmed=true')
        active = self._active_infer_job(payload.project_id)
        if active and str(active.get('status') or '') in {'queued', 'running', 'pausing'}:
            job_payload = active.get('payload_dict') if isinstance(active.get('payload_dict'), dict) else {}
            if bool(job_payload.get('save_ai_features')):
                raise HTTPException(status_code=409, detail='请先停止正在写入 AI 特征的批量任务')
        try:
            remote = self._sam3.interactive_clear_project(payload.api_base_url, payload.project_id)
        except Exception as exc:  # a stopped service cannot retain live GPU entries
            remote = {'ok': False, 'error': str(exc)}
        local = self.storage.delete_ai_features(payload.project_id)
        with self._lock:
            self._project_generations[payload.project_id] = int(
                self._project_generations.get(payload.project_id, 0)
            ) + 1
            for session_id, selection in list(self._session_selection.items()):
                if str(selection.get('project_id') or '') == payload.project_id:
                    self._session_selection.pop(session_id, None)
                    self._candidates.pop(session_id, None)
        return {'ok': True, **local, 'remote': remote}

    def close_project(self, project_id: str, api_base_url: str) -> None:
        try:
            self._sam3.interactive_clear_project(api_base_url, project_id)
        except Exception:
            pass
        with self._lock:
            self._project_generations[project_id] = int(self._project_generations.get(project_id, 0)) + 1
            for session_id, selection in list(self._session_selection.items()):
                if str(selection.get('project_id') or '') == project_id:
                    self._session_selection.pop(session_id, None)
                    self._candidates.pop(session_id, None)
