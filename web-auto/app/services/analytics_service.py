from __future__ import annotations

from typing import Any, Callable

from app.services.job_queue import PersistentJobQueue
from app.storage import Storage


class AnalyticsService:
    JOB_TYPE = 'analytics:index_rebuild'

    def __init__(self, *, get_storage: Callable[[], Storage], queue: PersistentJobQueue) -> None:
        self._get_storage = get_storage
        self._queue = queue

    def status(self, project_id: str) -> dict[str, Any]:
        status = self._get_storage().get_analytics_index_status(project_id)
        active = self._queue.active(project_id, job_prefix=self.JOB_TYPE)
        latest = active or self._queue.latest(project_id, job_prefix=self.JOB_TYPE)
        if latest:
            status['job'] = latest
            if str(latest.get('status') or '') in {'queued', 'running', 'pausing', 'paused'}:
                status['status'] = 'building'
            elif status.get('status') == 'building':
                status['status'] = 'failed'
                status['last_error'] = str(latest.get('error') or latest.get('message') or 'analytics index job stopped')
        else:
            status['job'] = None
            if status.get('status') == 'building':
                status['status'] = 'stale'
                status['last_error'] = 'analytics index job is no longer active'
        return status

    def spawn_rebuild(self, project_id: str) -> dict[str, Any]:
        storage = self._get_storage()
        index_status = storage.get_analytics_index_status(project_id)
        active = self._queue.active(project_id, job_prefix=self.JOB_TYPE)
        if active:
            return active
        total = int(index_status.get('total_images') or 0)
        return self._queue.enqueue(
            project_id=project_id,
            job_type=self.JOB_TYPE,
            resource_class='cpu',
            payload={'project_id': project_id},
            state={
                'message': 'analytics index queued',
                'progress_done': 0,
                'progress_total': total,
                'progress_pct': 0.0,
            },
            priority=80,
        )

    def dimensions(self, project_id: str) -> dict[str, Any] | None:
        return self._get_storage().get_analytics_dimensions(project_id)

    def overview(
        self, project_id: str, *, task: str = 'detection', sources: list[str] | None = None
    ) -> dict[str, Any] | None:
        return self._get_storage().get_analytics_overview(project_id, task=task, sources=sources)

    def run_rebuild_job(
        self,
        payload: dict[str, Any],
        progress_cb: Callable[..., None],
    ) -> dict[str, Any]:
        project_id = str(payload.get('project_id') or '').strip()
        if not project_id:
            raise ValueError('project_id is required')
        return self._get_storage().rebuild_analytics_index(project_id, progress_cb=progress_cb)
