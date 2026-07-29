from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.services.job_queue import PersistentJobQueue
from app.utils import now_ts


class InferJobPaused(RuntimeError):
    """Cooperative stop for long-running infer jobs."""


class InferenceJobService:
    def __init__(
        self,
        *,
        max_pending_image_ids: int,
        logger: logging.Logger,
        queue: PersistentJobQueue,
    ) -> None:
        self._max_pending_image_ids = max(0, int(max_pending_image_ids))
        self._logger = logger
        self.queue = queue

    def _state_default(self, *, project_id: str, job_type: str) -> dict[str, Any]:
        return {
            'project_id': project_id,
            'job_type': job_type,
            'status': 'queued',
            'running': False,
            'message': 'waiting',
            'progress_done': 0,
            'progress_total': 0,
            'progress_pct': 0.0,
            'requested': 0,
            'batch_size': 0,
            'succeeded': 0,
            'failed': 0,
            'skipped': 0,
            'new_annotations': 0,
            'current_image_id': '',
            'current_image_rel_path': '',
            'started_at': '',
            'updated_at': now_ts(),
            'finished_at': '',
            'error': '',
            'errors': [],
            'failed_image_ids': [],
            'skipped_image_ids': [],
            'class_additions': {},
            'image_results': [],
            'params': {},
            'pending_image_ids': [],
            'pending_image_count': 0,
            'pending_image_ids_truncated': False,
            'resume_count': 0,
            'result': {},
        }

    def _compact(self, state: dict[str, Any]) -> dict[str, Any]:
        out = dict(state)
        pending = [str(x).strip() for x in out.get('pending_image_ids', []) if str(x).strip()]
        count = int(out.get('pending_image_count') or len(pending))
        if len(pending) > self._max_pending_image_ids:
            pending = pending[:self._max_pending_image_ids]
            out['pending_image_ids_truncated'] = True
        out['pending_image_ids'] = pending
        out['pending_image_count'] = count
        return out

    def _params_from_payload(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        classes = [str(c).strip() for c in payload.get('classes', []) if str(c).strip()]
        points = payload.get('points', []) if isinstance(payload.get('points'), list) else []
        pos_points, neg_points = _count_prompt_labels(points, 2)
        return {
            'job_type': job_type,
            'classes': classes,
            'image_ids_count': len(payload.get('image_ids', []) or []),
            'retry_image_ids_count': len(payload.get('retry_image_ids', []) or []),
            'all_images': bool(payload.get('all_images')),
            'scope_mode': str(payload.get('scope_mode') or 'all'),
            'requested_batch_size': payload.get('batch_size'),
            'threshold': payload.get('threshold'),
            'api_base_url': str(payload.get('api_base_url') or ''),
            'positive_points': pos_points,
            'negative_points': neg_points,
        }

    def spawn_job(
        self,
        *,
        project_id: str,
        job_type: str,
        payload_dict: dict[str, Any],
        worker: Callable[..., dict[str, Any]],
        existing_job_id: Optional[str] = None,
    ) -> dict[str, Any]:
        del worker
        state = self._state_default(project_id=project_id, job_type=job_type)
        state['payload_dict'] = dict(payload_dict)
        state['params'] = self._params_from_payload(job_type, payload_dict)
        if existing_job_id:
            previous = self.queue.get(existing_job_id)
            if not previous:
                raise HTTPException(status_code=404, detail='infer job not found')
            state.update(previous)
            state['resume_count'] = int(previous.get('resume_count') or 0) + 1
            state['status'] = 'queued'
            state['running'] = False
            state['error'] = ''
            state['finished_at'] = ''
        return self.queue.enqueue(
            project_id=project_id,
            job_type=f'infer:{job_type}',
            resource_class='gpu',
            payload=payload_dict,
            state=state,
            priority=100,
            existing_job_id=str(existing_job_id or ''),
        )

    def update_job_state(self, job_id: str, **updates: Any) -> None:
        self.queue.update(job_id, **updates)

    def get_job_state_or_404(self, job_id: str) -> dict[str, Any]:
        state = self.queue.get(job_id)
        if not state or not str(state.get('job_type') or '').startswith('infer:'):
            raise HTTPException(status_code=404, detail='infer job not found')
        state['job_type'] = str(state['job_type']).split(':', 1)[1]
        return self._compact(state)

    def get_active_job_for_project(self, project_id: str) -> dict[str, Any] | None:
        state = self.queue.active(project_id, job_prefix='infer:')
        if not state:
            return None
        state['job_type'] = str(state['job_type']).split(':', 1)[1]
        return self._compact(state)

    def get_latest_job_for_project(
        self,
        project_id: str,
        *,
        statuses: Optional[set[str]] = None,
    ) -> dict[str, Any] | None:
        state = self.queue.latest(project_id, statuses=statuses, job_prefix='infer:')
        if not state:
            return None
        state['job_type'] = str(state['job_type']).split(':', 1)[1]
        return self._compact(state)

    def pause_job(self, project_id: str) -> bool:
        state = self.queue.active(project_id, job_prefix='infer:')
        return bool(state and self.queue.request_pause(str(state.get('job_id') or '')))

    def cancel_job(self, job_id: str) -> bool:
        return bool(job_id and self.queue.cancel(str(job_id)))

    def count_running_jobs(self) -> int:
        return self.queue.count_running(job_prefix='infer:')


def _count_prompt_labels(items: Any, label_index: int) -> tuple[int, int]:
    pos = 0
    neg = 0
    if not isinstance(items, list):
        return (pos, neg)
    for raw in items:
        if not isinstance(raw, list) or len(raw) <= label_index:
            continue
        try:
            is_pos = bool(int(float(raw[label_index])))
        except (TypeError, ValueError):
            is_pos = True
        if is_pos:
            pos += 1
        else:
            neg += 1
    return pos, neg
