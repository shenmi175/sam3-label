from __future__ import annotations

import logging
import os
import socket
import threading
import time
from typing import Any

from app.main import INFERENCE_SERVICE, JOB_QUEUE, SMART_FILTER_JOBS
from app.schemas import InferBatchIn
from app.services.inference_jobs import InferJobPaused
from app.utils import now_ts


logger = logging.getLogger('web_auto.worker')


class LeaseHeartbeat:
    def __init__(self, job_id: str, worker_id: str, resource_class: str) -> None:
        self.job_id = job_id
        self.worker_id = worker_id
        self.resource_class = resource_class
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop_event.wait(10.0):
            JOB_QUEUE.heartbeat(self.job_id, self.worker_id, lease_seconds=60)
            JOB_QUEUE.worker_heartbeat(self.worker_id, self.resource_class)

    def __enter__(self) -> 'LeaseHeartbeat':
        self.thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2.0)


def _cooperative_pause(job_id: str, worker_id: str) -> bool:
    while JOB_QUEUE.interactive_gpu_waiting():
        if JOB_QUEUE.should_pause(job_id):
            return True
        JOB_QUEUE.heartbeat(job_id, worker_id, lease_seconds=60)
        time.sleep(0.2)
    return JOB_QUEUE.should_pause(job_id)


def _execute_infer(job: dict[str, Any], worker_id: str) -> dict[str, Any]:
    job_id = str(job['job_id'])
    payload = JOB_QUEUE.payload(job_id)
    slice_size = max(1, int(os.getenv('WEB_AUTO_WORKER_BATCH_SLICE', '4') or 4))
    payload['batch_size'] = min(max(1, int(payload.get('batch_size') or 1)), slice_size)
    progress = lambda **updates: JOB_QUEUE.update(job_id, **updates)
    should_stop = lambda: _cooperative_pause(job_id, worker_id)
    job_type = str(job.get('job_type') or '')
    if job_type == 'infer:text_batch':
        return INFERENCE_SERVICE.run_infer_batch(
            InferBatchIn(**payload),
            progress_cb=progress,
            should_stop=should_stop,
            resume_state=job,
        )
    raise RuntimeError(f'unsupported GPU job type: {job_type}')


def _execute_job(job: dict[str, Any], worker_id: str) -> dict[str, Any]:
    job_type = str(job.get('job_type') or '')
    if job_type.startswith('infer:'):
        return _execute_infer(job, worker_id)
    payload = JOB_QUEUE.payload(str(job['job_id']))
    def progress(**updates: Any) -> None:
        if JOB_QUEUE.should_pause(str(job['job_id'])):
            raise InferJobPaused('job paused')
        JOB_QUEUE.update(str(job['job_id']), **updates)
    if job_type == 'smart_filter:preview':
        return SMART_FILTER_JOBS.run_preview_job(payload, progress)
    if job_type == 'smart_filter:apply':
        return SMART_FILTER_JOBS.run_apply_job(payload, progress)
    raise RuntimeError(f'unsupported job type: {job_type}')


def run_forever(resource_class: str = 'gpu') -> None:
    worker_id = f'{socket.gethostname()}:{os.getpid()}:{resource_class}'
    logger.info('worker started id=%s resource=%s', worker_id, resource_class)
    next_cleanup = 0.0
    while True:
        if resource_class == 'cpu' and time.time() >= next_cleanup:
            JOB_QUEUE.cleanup_terminal(retention_days=30)
            next_cleanup = time.time() + 3600.0
        JOB_QUEUE.worker_heartbeat(worker_id, resource_class)
        job = JOB_QUEUE.claim_next(resource_class, worker_id, lease_seconds=60)
        if not job:
            time.sleep(0.5)
            continue
        job_id = str(job['job_id'])
        JOB_QUEUE.update(job_id, status='running', running=True, started_at=now_ts(), message='job started')
        try:
            with LeaseHeartbeat(job_id, worker_id, resource_class):
                result = _execute_job(job, worker_id)
            preview_entry = result.pop('_preview_entry', None)
            current_state = JOB_QUEUE.get(job_id) or {}
            total = int(current_state.get('progress_total') or result.get('requested') or result.get('image_count') or result.get('changed_images') or 0)
            done = int(current_state.get('progress_done') or total)
            JOB_QUEUE.update(
                job_id,
                status='done',
                running=False,
                finished_at=now_ts(),
                message=str(result.get('message') or 'done'),
                result=result,
                preview_entry=preview_entry if isinstance(preview_entry, dict) else current_state.get('preview_entry', {}),
                requested=int(result.get('requested') or 0),
                succeeded=int(result.get('succeeded') or 0),
                failed=int(result.get('failed') or 0),
                skipped=int(result.get('skipped') or 0),
                new_annotations=int(result.get('new_annotations') or 0),
                errors=result.get('errors', []),
                progress_done=done,
                progress_total=total,
                progress_pct=100.0 if total > 0 else 0.0,
                pending_image_ids=[],
                pending_image_count=0,
            )
        except InferJobPaused as exc:
            current_status = str((JOB_QUEUE.get(job_id) or {}).get('status') or '')
            if current_status != 'cancelled':
                JOB_QUEUE.update(job_id, status='paused', running=False, message=str(exc) or 'job paused', error='')
        except Exception as exc:  # noqa: BLE001
            logger.exception('job failed id=%s', job_id)
            attempt = int((JOB_QUEUE.get(job_id) or {}).get('attempt') or 0)
            if attempt < 3:
                JOB_QUEUE.update(job_id, status='queued', running=False, message=f'retrying after error: {exc}', error=str(exc))
                time.sleep((1, 5, 15)[max(0, attempt - 1)])
            else:
                JOB_QUEUE.update(
                    job_id,
                    status='error',
                    running=False,
                    finished_at=now_ts(),
                    message=str(exc),
                    error=str(exc),
                )


if __name__ == '__main__':
    resource = os.getenv('WEB_AUTO_WORKER_RESOURCE', 'all').strip() or 'all'
    if resource == 'all':
        cpu_thread = threading.Thread(target=run_forever, args=('cpu',), daemon=True)
        cpu_thread.start()
        run_forever('gpu')
    else:
        run_forever(resource)
