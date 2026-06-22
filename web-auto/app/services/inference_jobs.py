from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.utils import new_id, now_ts


class InferJobPaused(RuntimeError):
    """Cooperative stop for long-running infer jobs."""


class InferenceJobService:
    def __init__(self, *, max_pending_image_ids: int, logger: logging.Logger) -> None:
        self._max_pending_image_ids = max(0, int(max_pending_image_ids))
        self._logger = logger
        self._lock = threading.Lock()
        self._threads: dict[str, dict[str, Any]] = {}
        self._states: dict[str, dict[str, Any]] = {}
        self._project_active: dict[str, str] = {}

    def _state_default(self, *, job_id: str, project_id: str, job_type: str) -> dict[str, Any]:
        return {
            'job_id': job_id,
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
            'payload_dict': {},
            'pending_image_ids': [],
            'pending_image_count': 0,
            'pending_image_ids_truncated': False,
            'resume_count': 0,
            'result': {},
        }

    def _cleanup_project_slot(self, project_id: str) -> None:
        active_job_id = str(self._project_active.get(project_id) or '').strip()
        if not active_job_id:
            return
        holder = self._threads.get(active_job_id) or {}
        thread = holder.get('thread')
        if thread and thread.is_alive():
            return
        self._threads.pop(active_job_id, None)
        if self._project_active.get(project_id) == active_job_id:
            self._project_active.pop(project_id, None)
        state = self._states.get(active_job_id)
        if isinstance(state, dict):
            state['running'] = False
            state['updated_at'] = now_ts()

    def update_job_state(self, job_id: str, **updates: Any) -> None:
        with self._lock:
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                return
            state.update(updates)
            progress_total = int(state.get('progress_total') or 0)
            progress_done = int(state.get('progress_done') or 0)
            if progress_total > 0 and 'progress_pct' not in updates:
                state['progress_pct'] = float(
                    max(0, min(progress_done, progress_total)) * 100.0 / max(progress_total, 1)
                )
            state['updated_at'] = now_ts()

    def _compact_state_for_response(self, state: dict[str, Any]) -> dict[str, Any]:
        out = dict(state)
        pending = (
            [str(x).strip() for x in out.get('pending_image_ids', []) if str(x).strip()]
            if isinstance(out.get('pending_image_ids'), list)
            else []
        )
        pending_count = int(out.get('pending_image_count') or len(pending))
        if len(pending) > self._max_pending_image_ids:
            out['pending_image_ids'] = pending[:self._max_pending_image_ids]
            out['pending_image_ids_truncated'] = True
        else:
            out['pending_image_ids'] = pending
            out['pending_image_ids_truncated'] = bool(out.get('pending_image_ids_truncated')) and pending_count > len(pending)
        out['pending_image_count'] = pending_count
        return out

    def get_job_state_or_404(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                raise HTTPException(status_code=404, detail='infer job not found')
            holder = self._threads.get(job_id) or {}
            thread = holder.get('thread')
            running = bool(thread and thread.is_alive())
            out = dict(state)
            out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
            return self._compact_state_for_response(out)

    def get_active_job_for_project(self, project_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._cleanup_project_slot(project_id)
            job_id = str(self._project_active.get(project_id) or '').strip()
            if not job_id:
                return None
            state = self._states.get(job_id)
            if not isinstance(state, dict):
                self._project_active.pop(project_id, None)
                return None
            holder = self._threads.get(job_id) or {}
            thread = holder.get('thread')
            running = bool(thread and thread.is_alive())
            out = dict(state)
            out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
            return self._compact_state_for_response(out)

    def get_latest_job_for_project(
        self,
        project_id: str,
        *,
        statuses: Optional[set[str]] = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            matches: list[dict[str, Any]] = []
            for state in self._states.values():
                if str(state.get('project_id') or '').strip() != project_id:
                    continue
                status = str(state.get('status') or '').strip().lower()
                if statuses and status not in statuses:
                    continue
                matches.append(dict(state))
            if not matches:
                return None
            matches.sort(key=lambda item: (str(item.get('updated_at') or ''), str(item.get('job_id') or '')), reverse=True)
            out = matches[0]
            holder = self._threads.get(str(out.get('job_id') or '')) or {}
            thread = holder.get('thread')
            running = bool(thread and thread.is_alive())
            out['running'] = running or str(out.get('status') or '').lower() in {'queued', 'running'}
            return self._compact_state_for_response(out)

    def pause_job(self, project_id: str) -> bool:
        with self._lock:
            self._cleanup_project_slot(project_id)
            job_id = str(self._project_active.get(project_id) or '').strip()
            if not job_id:
                return False
            holder = self._threads.get(job_id) or {}
            ev = holder.get('stop_event')
            if not ev:
                return False
            ev.set()
            return True

    def _params_from_payload(self, job_type: str, payload_dict: dict[str, Any]) -> dict[str, Any]:
        payload = payload_dict or {}
        classes = [str(c).strip() for c in payload.get('classes', []) if str(c).strip()]
        active_class = str(payload.get('active_class') or '').strip()
        image_ids = [str(x).strip() for x in payload.get('image_ids', []) if str(x).strip()]
        retry_image_ids = [str(x).strip() for x in payload.get('retry_image_ids', []) if str(x).strip()]
        boxes = payload.get('boxes', []) if isinstance(payload.get('boxes', []), list) else []
        points = payload.get('points', []) if isinstance(payload.get('points', []), list) else []
        pos_points, neg_points = _count_prompt_labels(points, 2)
        pos_boxes, neg_boxes = _count_prompt_labels(boxes, 4)
        return {
            'job_type': job_type,
            'classes': classes,
            'active_class': active_class,
            'source_image_id': str(payload.get('source_image_id') or '').strip(),
            'image_ids_count': len(image_ids),
            'retry_image_ids_count': len(retry_image_ids),
            'all_images': bool(payload.get('all_images')),
            'scope_mode': str(payload.get('scope_mode') or 'all'),
            'related_classes': [str(c).strip() for c in payload.get('related_classes', []) if str(c).strip()],
            'requested_batch_size': payload.get('batch_size'),
            'threshold': payload.get('threshold'),
            'api_base_url': str(payload.get('api_base_url') or ''),
            'pure_visual': bool(payload.get('pure_visual')),
            'positive_points': pos_points,
            'negative_points': neg_points,
            'positive_boxes': pos_boxes,
            'negative_boxes': neg_boxes,
        }

    def spawn_job(
        self,
        *,
        project_id: str,
        job_type: str,
        payload_dict: dict[str, Any],
        worker: Callable[[dict[str, Any], Callable[..., None], Callable[[], bool], Optional[dict[str, Any]]], dict[str, Any]],
        existing_job_id: Optional[str] = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._cleanup_project_slot(project_id)
            active_job_id = str(self._project_active.get(project_id) or '').strip()
            if active_job_id:
                raise HTTPException(status_code=409, detail='another infer job is already running for this project')

            if existing_job_id:
                job_id = str(existing_job_id).strip()
                state = self._states.get(job_id)
                if not isinstance(state, dict):
                    raise HTTPException(status_code=404, detail='infer job not found')
                if str(state.get('project_id') or '').strip() != project_id:
                    raise HTTPException(status_code=400, detail='infer job does not belong to this project')
                state['resume_count'] = int(state.get('resume_count') or 0) + 1
            else:
                job_id = new_id('ijob_')
                state = self._state_default(job_id=job_id, project_id=project_id, job_type=job_type)
                self._states[job_id] = state

            state['job_type'] = job_type
            state['payload_dict'] = dict(payload_dict)
            state['params'] = self._params_from_payload(job_type, payload_dict)
            state['status'] = 'queued'
            state['running'] = False
            state['message'] = 'waiting'
            state['error'] = ''
            state['finished_at'] = ''
            state['updated_at'] = now_ts()
            self._project_active[project_id] = job_id
            resume_state = dict(state)
            stop_event = threading.Event()

            def _worker_entry() -> None:
                self.update_job_state(
                    job_id,
                    status='running',
                    running=True,
                    started_at=now_ts(),
                    message='job started',
                )
                try:
                    result = worker(
                        payload_dict,
                        lambda **kw: self.update_job_state(job_id, **kw),
                        lambda: bool(stop_event.is_set()),
                        resume_state,
                    )
                    self.update_job_state(
                        job_id,
                        status='done',
                        running=False,
                        finished_at=now_ts(),
                        message=str(result.get('message') or 'done'),
                        result=result,
                        requested=int(result.get('requested') or 0),
                        batch_size=int(result.get('batch_size') or 0),
                        succeeded=int(result.get('succeeded') or 0),
                        failed=int(result.get('failed') or 0),
                        new_annotations=int(result.get('new_annotations') or 0),
                        errors=result.get('errors', []),
                        progress_done=int(result.get('requested') or 0),
                        progress_total=int(result.get('requested') or 0),
                        progress_pct=100.0,
                        pending_image_ids=[],
                        pending_image_count=0,
                        pending_image_ids_truncated=False,
                    )
                except InferJobPaused as exc:
                    self.update_job_state(
                        job_id,
                        status='paused',
                        running=False,
                        message=str(exc) or 'job paused',
                        error='',
                    )
                except Exception as exc:  # noqa: BLE001
                    self._logger.exception('infer job failed project=%s type=%s', project_id, job_type)
                    self.update_job_state(
                        job_id,
                        status='error',
                        running=False,
                        finished_at=now_ts(),
                        message=str(exc),
                        error=str(exc),
                    )
                finally:
                    with self._lock:
                        self._threads.pop(job_id, None)
                        if self._project_active.get(project_id) == job_id:
                            self._project_active.pop(project_id, None)

            thread = threading.Thread(target=_worker_entry, daemon=True)
            self._threads[job_id] = {'thread': thread, 'project_id': project_id, 'stop_event': stop_event}
            thread.start()
            return dict(state)

    def count_running_jobs(self) -> int:
        with self._lock:
            total = 0
            for holder in self._threads.values():
                thread = holder.get('thread') if isinstance(holder, dict) else None
                if thread and thread.is_alive():
                    total += 1
            return total


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
