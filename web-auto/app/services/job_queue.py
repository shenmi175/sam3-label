from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from app.audit import AuditLogger, current_audit_context
from app.utils import (
    atomic_write_json,
    ensure_dir,
    InterProcessLock,
    new_id,
    now_ts,
    read_json,
)


NONTERMINAL_STATUSES = {'queued', 'running', 'pausing', 'paused'}
TERMINAL_STATUSES = {'done', 'error', 'cancelled'}

_DETAIL_FIELDS = (
    'image_results',
    'errors',
    'failed_image_ids',
    'skipped_image_ids',
    'preview_entry',
    'result',
)
_RESULT_DUPLICATE_FIELDS = (
    'image_results',
    'errors',
    'failed_image_ids',
    'skipped_image_ids',
)
_SUMMARY_OBJECT_FIELDS = {'summary', 'selection', 'class_additions', 'rule'}
_MAX_SUMMARY_OBJECT_BYTES = 16 * 1024
logger = logging.getLogger('web_auto.jobs')


def _payload_summary(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the deliberately small, path-free task parameter summary."""
    summary: dict[str, Any] = {}
    aliases = {
        'classes': 'classes',
        'related_classes': 'related_classes',
        'scope_mode': 'scope',
        'merge_mode': 'append_mode',
        'batch_size': 'batch_size',
        'save_ai_features': 'save_features',
        'all_images': 'all_images',
        'target_count': 'target_count',
    }
    for source, target in aliases.items():
        value = payload.get(source)
        if isinstance(value, list):
            summary[target] = [str(item)[:128] for item in value[:100]]
        elif value is None or isinstance(value, (str, int, float, bool)):
            summary[target] = value
    for key in ('image_ids', 'retry_image_ids', 'targets'):
        value = payload.get(key)
        if isinstance(value, list):
            summary[f'{key}_count'] = len(value)
    return summary


def summarize_error_for_audit(error: Any) -> dict[str, str]:
    if isinstance(error, dict):
        code = str(error.get('error_code') or error.get('code') or '')[:128]
        raw_message = str(error.get('message') or error.get('error') or '')
    else:
        code = type(error).__name__ if isinstance(error, BaseException) else ''
        raw_message = str(error or '')
    # Errors may contain dataset paths or upstream URLs. They are useful in the
    # durable job result, but the audit stream keeps only a bounded safe sample.
    message = re.sub(r'https?://\S+', '[UPSTREAM]', raw_message)
    message = re.sub(r'(?<!\w)/(?:[^\s:]+/?)+', '[PATH]', message)
    message = re.sub(r'[A-Za-z]:\\[^\s]+', '[PATH]', message)
    return {'code': code, 'message': message[:256]}


class PersistentJobQueue:
    """Small single-host durable queue backed by the existing SQLite database."""

    def __init__(
        self,
        db_path: Path,
        *,
        details_dir: Path | None = None,
        audit: AuditLogger | None = None,
    ) -> None:
        self.db_path = Path(db_path)
        self.details_dir = (
            Path(details_dir) if details_dir is not None else self.db_path.parent / '.job-results'
        )
        self._lock = threading.RLock()
        self.audit = audit
        self._init_db()

    def _audit(self, **event: Any) -> None:
        if self.audit is None:
            return
        try:
            self.audit.emit(**event)
        except Exception as exc:  # noqa: BLE001
            logger.warning('task audit collection failed: %s', exc)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        return conn

    def _init_db(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.executescript(
                    '''
                    CREATE TABLE IF NOT EXISTS background_jobs (
                        job_id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL,
                        job_type TEXT NOT NULL,
                        resource_class TEXT NOT NULL DEFAULT 'cpu',
                        priority INTEGER NOT NULL DEFAULT 100,
                        status TEXT NOT NULL,
                        payload_json TEXT NOT NULL DEFAULT '{}',
                        state_json TEXT NOT NULL DEFAULT '{}',
                        created_epoch REAL NOT NULL,
                        updated_epoch REAL NOT NULL,
                        lease_owner TEXT NOT NULL DEFAULT '',
                        lease_expires_epoch REAL NOT NULL DEFAULT 0,
                        attempt INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS idx_background_jobs_claim
                    ON background_jobs(status, resource_class, priority, created_epoch);
                    CREATE INDEX IF NOT EXISTS idx_background_jobs_project
                    ON background_jobs(project_id, created_epoch);
                    CREATE TABLE IF NOT EXISTS interactive_gpu_leases (
                        lease_id TEXT PRIMARY KEY,
                        expires_epoch REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS worker_heartbeats (
                        worker_id TEXT PRIMARY KEY,
                        resource_class TEXT NOT NULL,
                        heartbeat_epoch REAL NOT NULL
                    );
                    '''
                )
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def _decode(raw: Any) -> dict[str, Any]:
        try:
            value = json.loads(str(raw or '{}'))
        except Exception:
            return {}
        return value if isinstance(value, dict) else {}

    def _details_path(self, job_id: str) -> Path:
        digest = hashlib.sha256(str(job_id).encode('utf-8')).hexdigest()
        return self.details_dir / f'{digest}.json'

    def _update_lock(self, job_id: str) -> InterProcessLock:
        digest = hashlib.sha256(str(job_id).encode('utf-8')).hexdigest()
        return InterProcessLock(self.db_path.parent / '.locks' / f'job_{digest}.lock')

    @staticmethod
    def _result_summary(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        summary: dict[str, Any] = {}
        for key, item in value.items():
            if item is None or isinstance(item, (str, int, float, bool)):
                summary[str(key)] = item
                continue
            if str(key) not in _SUMMARY_OBJECT_FIELDS:
                continue
            try:
                encoded = json.dumps(item, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            except (TypeError, ValueError):
                continue
            if len(encoded) <= _MAX_SUMMARY_OBJECT_BYTES:
                summary[str(key)] = item
        return summary

    def _load_details(self, job_id: str) -> dict[str, Any]:
        payload = read_json(self._details_path(job_id), {})
        if not isinstance(payload, dict) or int(payload.get('version') or 0) != 1:
            return {}
        details = payload.get('details', {})
        return dict(details) if isinstance(details, dict) else {}

    def _hydrate_details(self, job_id: str, state: dict[str, Any]) -> dict[str, Any]:
        if not bool(state.get('details_available')):
            return state
        details = self._load_details(job_id)
        if not details:
            out = dict(state)
            out['details_missing'] = True
            return out
        out = dict(state)
        out.update(details)
        return out

    def _externalize_terminal_state(self, job_id: str, state: dict[str, Any]) -> dict[str, Any]:
        details = {key: state[key] for key in _DETAIL_FIELDS if key in state}
        result = details.get('result')
        if isinstance(result, dict):
            normalized_result = dict(result)
            for key in _RESULT_DUPLICATE_FIELDS:
                if key in details and normalized_result.get(key) == details[key]:
                    normalized_result.pop(key, None)
            if (
                normalized_result.get('items') == normalized_result.get('hits')
                and 'hits' in normalized_result
            ):
                normalized_result.pop('hits', None)
            details['result'] = normalized_result

        if not details:
            return state

        ensure_dir(self.details_dir)
        path = self._details_path(job_id)
        atomic_write_json(path, {'version': 1, 'job_id': str(job_id), 'details': details})

        compact = dict(state)
        for key in _DETAIL_FIELDS:
            compact.pop(key, None)
        compact['result'] = self._result_summary(details.get('result'))
        compact['details_available'] = True
        compact['details_version'] = 1
        compact['details_bytes'] = int(path.stat().st_size)
        compact['details_fields'] = sorted(details)
        compact['image_results_count'] = (
            len(details.get('image_results', []))
            if isinstance(details.get('image_results'), list)
            else 0
        )
        compact['errors_count'] = (
            len(details.get('errors', [])) if isinstance(details.get('errors'), list) else 0
        )
        compact['failed_image_ids_count'] = (
            len(details.get('failed_image_ids', [])) if isinstance(details.get('failed_image_ids'), list) else 0
        )
        preview_entry = details.get('preview_entry')
        if isinstance(preview_entry, dict):
            compact['preview_token'] = str(preview_entry.get('preview_token') or '')
        return compact

    def _row_state(self, row: sqlite3.Row, *, include_details: bool = False) -> dict[str, Any]:
        state = self._decode(row['state_json'])
        if include_details:
            state = self._hydrate_details(str(row['job_id']), state)
        state.update(
            {
                'job_id': str(row['job_id']),
                'project_id': str(row['project_id']),
                'job_type': str(row['job_type']),
                'resource_class': str(row['resource_class']),
                'status': str(row['status']),
                'running': str(row['status']) in {'queued', 'running', 'pausing'},
                'attempt': int(row['attempt'] or 0),
            }
        )
        for key in tuple(state):
            if key.startswith('_audit_'):
                state.pop(key, None)
        return state

    def enqueue(
        self,
        *,
        project_id: str,
        job_type: str,
        resource_class: str,
        payload: dict[str, Any],
        state: dict[str, Any],
        priority: int = 100,
        existing_job_id: str = '',
    ) -> dict[str, Any]:
        now = time.time()
        job_id = str(existing_job_id or '').strip() or new_id('job_')
        next_state = dict(state)
        next_state.update({'job_id': job_id, 'project_id': project_id, 'job_type': job_type, 'updated_at': now_ts()})
        audit_context = current_audit_context()
        next_state['_audit_actor'] = audit_context['actor']
        next_state['_audit_request_id'] = audit_context['request_id']
        with self._lock:
            conn = self._connect()
            try:
                if existing_job_id:
                    row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (job_id,)).fetchone()
                    if row is None:
                        raise KeyError(job_id)
                    conn.execute(
                        '''UPDATE background_jobs
                           SET status='queued', payload_json=?, state_json=?, updated_epoch=?,
                               lease_owner='', lease_expires_epoch=0
                           WHERE job_id=?''',
                        (json.dumps(payload, ensure_ascii=False), json.dumps(next_state, ensure_ascii=False), now, job_id),
                    )
                else:
                    conn.execute(
                        '''INSERT INTO background_jobs (
                               job_id, project_id, job_type, resource_class, priority, status,
                               payload_json, state_json, created_epoch, updated_epoch
                           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)''',
                        (
                            job_id,
                            project_id,
                            job_type,
                            resource_class,
                            int(priority),
                            json.dumps(payload, ensure_ascii=False),
                            json.dumps(next_state, ensure_ascii=False),
                            now,
                            now,
                        ),
                    )
                conn.commit()
                row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (job_id,)).fetchone()
                assert row is not None
                logger.info(
                    'job_enqueued job_id=%s project_id=%s job_type=%s status=queued resumed=%s',
                    job_id,
                    project_id,
                    job_type,
                    bool(existing_job_id),
                )
                self._audit(
                    category='task',
                    action='enqueue',
                    outcome='accepted',
                    actor=next_state['_audit_actor'],
                    request_id=next_state['_audit_request_id'],
                    project_id=project_id,
                    job_id=job_id,
                    message='Task enqueued',
                    details={
                        'job_type': job_type,
                        'resource_class': resource_class,
                        'resumed': bool(existing_job_id),
                        'parameters': _payload_summary(payload),
                    },
                )
                return self._row_state(row)
            finally:
                conn.close()

    def get(self, job_id: str, *, include_details: bool = True) -> dict[str, Any] | None:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                return self._row_state(row, include_details=include_details) if row is not None else None
            finally:
                conn.close()

    def payload(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute('SELECT payload_json FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                return self._decode(row['payload_json']) if row is not None else {}
            finally:
                conn.close()

    def update_payload(self, job_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    'UPDATE background_jobs SET payload_json=?, updated_epoch=? WHERE job_id=?',
                    (json.dumps(payload, ensure_ascii=False), time.time(), str(job_id)),
                )
                conn.commit()
            finally:
                conn.close()

    def update(self, job_id: str, **updates: Any) -> dict[str, Any] | None:
        with self._update_lock(str(job_id)), self._lock:
            conn = self._connect()
            try:
                row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                if row is None:
                    return None
                old_status = str(row['status'])
                state = self._decode(row['state_json'])
                if str(row['status']) in TERMINAL_STATUSES:
                    state = self._hydrate_details(str(job_id), state)
                state.update(updates)
                total = int(state.get('progress_total') or 0)
                done = int(state.get('progress_done') or 0)
                if total > 0 and 'progress_pct' not in updates:
                    state['progress_pct'] = max(0.0, min(100.0, float(done) * 100.0 / float(total)))
                state['updated_at'] = now_ts()
                status = str(updates.get('status') or row['status'])
                if status in TERMINAL_STATUSES:
                    state = self._externalize_terminal_state(str(job_id), state)
                conn.execute(
                    'UPDATE background_jobs SET status=?, state_json=?, updated_epoch=? WHERE job_id=?',
                    (status, json.dumps(state, ensure_ascii=False), time.time(), str(job_id)),
                )
                conn.commit()
                refreshed = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                if old_status != status:
                    logger.info(
                        'job_status_changed job_id=%s project_id=%s job_type=%s from=%s to=%s message=%s',
                        job_id,
                        str(row['project_id']),
                        str(row['job_type']),
                        old_status,
                        status,
                        str(state.get('message') or ''),
                    )
                    transition_details: dict[str, Any] = {
                        'job_type': str(row['job_type']),
                        'from': old_status,
                        'to': status,
                    }
                    if status in TERMINAL_STATUSES:
                        transition_details['duration_ms'] = max(
                            0, int((time.time() - float(row['created_epoch'] or time.time())) * 1000)
                        )
                        transition_details['summary'] = {
                            key: int(state.get(key) or 0)
                            for key in ('requested', 'succeeded', 'failed', 'skipped')
                        }
                        transition_details['error_code'] = str(state.get('error_code') or '')
                        errors = state.get('errors', [])
                        if isinstance(errors, list) and errors:
                            transition_details['representative_errors'] = [
                                summarize_error_for_audit(error) for error in errors[:3]
                            ]
                    self._audit(
                        category='task',
                        action='status_transition',
                        outcome=status,
                        level='error' if status == 'error' else 'info',
                        actor=str(state.get('_audit_actor') or 'system'),
                        request_id=str(state.get('_audit_request_id') or ''),
                        project_id=str(row['project_id']),
                        job_id=str(job_id),
                        message=f'Task status changed from {old_status} to {status}',
                        details=transition_details,
                    )
                return self._row_state(refreshed, include_details=True) if refreshed is not None else None
            finally:
                conn.close()

    def latest(self, project_id: str, *, statuses: set[str] | None = None, job_prefix: str = '') -> dict[str, Any] | None:
        clauses = ['project_id = ?']
        params: list[Any] = [str(project_id)]
        if statuses:
            placeholders = ','.join('?' for _ in statuses)
            clauses.append(f'status IN ({placeholders})')
            params.extend(sorted(statuses))
        if job_prefix:
            clauses.append('job_type LIKE ?')
            params.append(f'{job_prefix}%')
        sql = f"SELECT * FROM background_jobs WHERE {' AND '.join(clauses)} ORDER BY created_epoch DESC LIMIT 1"
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(sql, params).fetchone()
                return self._row_state(row, include_details=True) if row is not None else None
            finally:
                conn.close()

    def active(self, project_id: str, *, job_prefix: str = '') -> dict[str, Any] | None:
        clauses = ["project_id = ?", "status IN ('running','pausing','queued','paused')"]
        params: list[Any] = [str(project_id)]
        if job_prefix:
            clauses.append('job_type LIKE ?')
            params.append(f'{job_prefix}%')
        sql = f"SELECT * FROM background_jobs WHERE {' AND '.join(clauses)} ORDER BY created_epoch ASC LIMIT 1"
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(sql, params).fetchone()
                return self._row_state(row, include_details=True) if row is not None else None
            finally:
                conn.close()

    def list_jobs(self, project_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    'SELECT * FROM background_jobs WHERE project_id=? ORDER BY created_epoch DESC LIMIT ?',
                    (str(project_id), max(1, min(int(limit), 500))),
                ).fetchall()
                return [self._row_state(row, include_details=False) for row in rows]
            finally:
                conn.close()

    def request_pause(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status')) not in NONTERMINAL_STATUSES:
            self._audit(category='task', action='pause_request', outcome='rejected', job_id=job_id, message='Pause request rejected')
            return False
        if str(current.get('status')) == 'paused':
            self._audit(category='task', action='pause_request', outcome='accepted', project_id=str(current.get('project_id') or ''), job_id=job_id, message='Task already paused')
            return True
        status = 'paused' if str(current.get('status')) == 'queued' else 'pausing'
        self.update(job_id, status=status, running=status == 'pausing')
        self._audit(category='task', action='pause_request', outcome='accepted', project_id=str(current.get('project_id') or ''), job_id=job_id, message='Pause request accepted', details={'previous_status': current.get('status')})
        return True

    def resume(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status') or '') != 'paused':
            self._audit(category='task', action='resume_request', outcome='rejected', job_id=job_id, message='Resume request rejected')
            return False
        self.update(job_id, status='queued', running=False, error='', finished_at='')
        self._audit(category='task', action='resume_request', outcome='accepted', project_id=str(current.get('project_id') or ''), job_id=job_id, message='Resume request accepted')
        return True

    def cancel(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status') or '') not in NONTERMINAL_STATUSES:
            self._audit(category='task', action='cancel_request', outcome='rejected', job_id=job_id, message='Cancel request rejected')
            return False
        self.update(job_id, status='cancelled', running=False, finished_at=now_ts(), message='cancelled')
        self._audit(category='task', action='cancel_request', outcome='accepted', project_id=str(current.get('project_id') or ''), job_id=job_id, message='Cancel request accepted', details={'previous_status': current.get('status')})
        return True

    def should_pause(self, job_id: str) -> bool:
        state = self.get(job_id) or {}
        return str(state.get('status') or '') in {'pausing', 'paused', 'cancelled'}

    def count_running(self, *, job_prefix: str = '') -> int:
        with self._lock:
            conn = self._connect()
            try:
                if job_prefix:
                    row = conn.execute(
                        "SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('queued','running','pausing') AND job_type LIKE ?",
                        (f'{job_prefix}%',),
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('queued','running','pausing')"
                    ).fetchone()
                return int(row['n'] or 0) if row is not None else 0
            finally:
                conn.close()

    def claim_next(self, resource_class: str, worker_id: str, *, lease_seconds: int = 60) -> dict[str, Any] | None:
        now = time.time()
        with self._lock:
            conn = self._connect()
            try:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute(
                    "UPDATE background_jobs SET status='queued', lease_owner='', lease_expires_epoch=0 "
                    "WHERE status='running' AND lease_expires_epoch > 0 AND lease_expires_epoch < ?",
                    (now,),
                )
                row = conn.execute(
                    '''
                    SELECT j.* FROM background_jobs j
                    WHERE j.status='queued' AND j.resource_class=?
                      AND NOT EXISTS (
                        SELECT 1 FROM background_jobs earlier
                        WHERE earlier.project_id=j.project_id
                          AND earlier.created_epoch < j.created_epoch
                          AND earlier.status IN ('queued','running','pausing')
                      )
                    ORDER BY j.priority ASC, j.created_epoch ASC
                    LIMIT 1
                    ''',
                    (str(resource_class),),
                ).fetchone()
                if row is None:
                    conn.commit()
                    return None
                conn.execute(
                    '''UPDATE background_jobs SET status='running', lease_owner=?, lease_expires_epoch=?,
                       updated_epoch=?, attempt=attempt+1 WHERE job_id=?''',
                    (str(worker_id), now + max(10, int(lease_seconds)), now, str(row['job_id'])),
                )
                conn.commit()
                claimed = conn.execute('SELECT * FROM background_jobs WHERE job_id=?', (str(row['job_id']),)).fetchone()
                logger.info(
                    'job_status_changed job_id=%s project_id=%s job_type=%s from=queued to=running worker_id=%s',
                    str(row['job_id']),
                    str(row['project_id']),
                    str(row['job_type']),
                    worker_id,
                )
                claimed_state = self._decode(claimed['state_json']) if claimed is not None else {}
                self._audit(
                    category='task',
                    action='worker_claim',
                    outcome='accepted',
                    actor=str(claimed_state.get('_audit_actor') or 'system'),
                    request_id=str(claimed_state.get('_audit_request_id') or ''),
                    project_id=str(row['project_id']),
                    job_id=str(row['job_id']),
                    message='Worker claimed task',
                    details={'job_type': str(row['job_type']), 'worker_id': worker_id, 'attempt': int(row['attempt'] or 0) + 1},
                )
                self._audit(
                    category='task',
                    action='status_transition',
                    outcome='running',
                    actor=str(claimed_state.get('_audit_actor') or 'system'),
                    request_id=str(claimed_state.get('_audit_request_id') or ''),
                    project_id=str(row['project_id']),
                    job_id=str(row['job_id']),
                    message='Task status changed from queued to running',
                    details={'job_type': str(row['job_type']), 'from': 'queued', 'to': 'running'},
                )
                return self._row_state(claimed) if claimed is not None else None
            finally:
                conn.close()

    def heartbeat(self, job_id: str, worker_id: str, *, lease_seconds: int = 60) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    '''UPDATE background_jobs SET lease_expires_epoch=?, updated_epoch=?
                       WHERE job_id=? AND lease_owner=? AND status='running' ''',
                    (time.time() + max(10, int(lease_seconds)), time.time(), str(job_id), str(worker_id)),
                )
                conn.commit()
            finally:
                conn.close()

    def acquire_interactive_gpu(self, *, ttl_seconds: int = 300) -> str:
        lease_id = new_id('igpu_')
        with self._lock:
            conn = self._connect()
            try:
                now = time.time()
                conn.execute('DELETE FROM interactive_gpu_leases WHERE expires_epoch < ?', (now,))
                conn.execute(
                    'INSERT INTO interactive_gpu_leases (lease_id, expires_epoch) VALUES (?, ?)',
                    (lease_id, now + max(30, int(ttl_seconds))),
                )
                conn.commit()
            finally:
                conn.close()
        return lease_id

    def release_interactive_gpu(self, lease_id: str) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute('DELETE FROM interactive_gpu_leases WHERE lease_id=?', (str(lease_id),))
                conn.commit()
            finally:
                conn.close()

    def interactive_gpu_waiting(self) -> bool:
        with self._lock:
            conn = self._connect()
            try:
                now = time.time()
                conn.execute('DELETE FROM interactive_gpu_leases WHERE expires_epoch < ?', (now,))
                row = conn.execute('SELECT COUNT(*) AS n FROM interactive_gpu_leases').fetchone()
                conn.commit()
                return bool(row and int(row['n'] or 0) > 0)
            finally:
                conn.close()

    def worker_heartbeat(self, worker_id: str, resource_class: str) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    'DELETE FROM worker_heartbeats WHERE resource_class=? AND worker_id<>?',
                    (str(resource_class), str(worker_id)),
                )
                conn.execute(
                    '''INSERT INTO worker_heartbeats (worker_id, resource_class, heartbeat_epoch)
                       VALUES (?, ?, ?)
                       ON CONFLICT(worker_id) DO UPDATE SET
                           resource_class=excluded.resource_class,
                           heartbeat_epoch=excluded.heartbeat_epoch''',
                    (str(worker_id), str(resource_class), time.time()),
                )
                conn.commit()
            finally:
                conn.close()

    def health_summary(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    'SELECT worker_id, resource_class, heartbeat_epoch FROM worker_heartbeats ORDER BY resource_class'
                ).fetchall()
                queued = conn.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE status='queued'").fetchone()
                running = conn.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('running','pausing')").fetchone()
                workers = [
                    {
                        'worker_id': str(row['worker_id']),
                        'resource_class': str(row['resource_class']),
                        'age_seconds': round(max(0.0, now - float(row['heartbeat_epoch'] or 0)), 1),
                        'healthy': (now - float(row['heartbeat_epoch'] or 0)) < 30.0,
                    }
                    for row in rows
                ]
                return {
                    'queued': int(queued['n'] or 0) if queued else 0,
                    'running': int(running['n'] or 0) if running else 0,
                    'workers': workers,
                }
            finally:
                conn.close()

    def compact_terminal_details(self, *, limit: int = 100) -> int:
        """Move large legacy terminal state out of SQLite.

        New terminal updates are compacted immediately. This bounded migration
        lets the hourly worker maintenance convert rows written by older builds.
        """
        compacted = 0
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT * FROM background_jobs WHERE status IN ('done','error','cancelled') "
                    'ORDER BY length(state_json) DESC LIMIT ?',
                    (max(1, min(int(limit), 1000)),),
                ).fetchall()
                for row in rows:
                    raw_state = str(row['state_json'] or '{}')
                    state = self._decode(raw_state)
                    if bool(state.get('details_available')):
                        continue
                    if not any(key in state for key in _DETAIL_FIELDS):
                        continue
                    job_id = str(row['job_id'])
                    compact = self._externalize_terminal_state(job_id, state)
                    cur = conn.execute(
                        "UPDATE background_jobs SET state_json=?, updated_epoch=? WHERE job_id=? AND state_json=? "
                        "AND status IN ('done','error','cancelled')",
                        (json.dumps(compact, ensure_ascii=False), time.time(), job_id, raw_state),
                    )
                    compacted += int(cur.rowcount or 0)
                conn.commit()
            finally:
                conn.close()
        return compacted

    def cleanup_terminal(self, *, retention_days: int = 30) -> int:
        cutoff = time.time() - max(1, int(retention_days)) * 86400
        job_ids: list[str] = []
        with self._lock:
            conn = self._connect()
            try:
                conn.execute('BEGIN IMMEDIATE')
                rows = conn.execute(
                    "SELECT job_id FROM background_jobs WHERE status IN ('done','error','cancelled') "
                    'AND updated_epoch < ?',
                    (cutoff,),
                ).fetchall()
                job_ids = [str(row['job_id']) for row in rows]
                cur = conn.execute(
                    "DELETE FROM background_jobs WHERE status IN ('done','error','cancelled') AND updated_epoch < ?",
                    (cutoff,),
                )
                conn.commit()
                deleted = int(cur.rowcount or 0)
            finally:
                conn.close()
        for job_id in job_ids:
            try:
                self._details_path(job_id).unlink(missing_ok=True)
            except OSError:
                pass
        return deleted
