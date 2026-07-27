from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from app.utils import new_id, now_ts


NONTERMINAL_STATUSES = {'queued', 'running', 'pausing', 'paused'}


class PersistentJobQueue:
    """Small single-host durable queue backed by the existing SQLite database."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self._init_db()

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

    def _row_state(self, row: sqlite3.Row) -> dict[str, Any]:
        state = self._decode(row['state_json'])
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
                return self._row_state(row)
            finally:
                conn.close()

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                return self._row_state(row) if row is not None else None
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
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                if row is None:
                    return None
                state = self._decode(row['state_json'])
                state.update(updates)
                total = int(state.get('progress_total') or 0)
                done = int(state.get('progress_done') or 0)
                if total > 0 and 'progress_pct' not in updates:
                    state['progress_pct'] = max(0.0, min(100.0, float(done) * 100.0 / float(total)))
                state['updated_at'] = now_ts()
                status = str(updates.get('status') or row['status'])
                conn.execute(
                    'UPDATE background_jobs SET status=?, state_json=?, updated_epoch=? WHERE job_id=?',
                    (status, json.dumps(state, ensure_ascii=False), time.time(), str(job_id)),
                )
                conn.commit()
                refreshed = conn.execute('SELECT * FROM background_jobs WHERE job_id = ?', (str(job_id),)).fetchone()
                return self._row_state(refreshed) if refreshed is not None else None
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
                return self._row_state(row) if row is not None else None
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
                return self._row_state(row) if row is not None else None
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
                return [self._row_state(row) for row in rows]
            finally:
                conn.close()

    def request_pause(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status')) not in NONTERMINAL_STATUSES:
            return False
        if str(current.get('status')) == 'paused':
            return True
        status = 'paused' if str(current.get('status')) == 'queued' else 'pausing'
        self.update(job_id, status=status, running=status == 'pausing')
        return True

    def resume(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status') or '') != 'paused':
            return False
        self.update(job_id, status='queued', running=False, error='', finished_at='')
        return True

    def cancel(self, job_id: str) -> bool:
        current = self.get(job_id)
        if not current or str(current.get('status') or '') not in NONTERMINAL_STATUSES:
            return False
        self.update(job_id, status='cancelled', running=False, finished_at=now_ts(), message='cancelled')
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

    def cleanup_terminal(self, *, retention_days: int = 30) -> int:
        cutoff = time.time() - max(1, int(retention_days)) * 86400
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    "DELETE FROM background_jobs WHERE status IN ('done','error','cancelled') AND updated_epoch < ?",
                    (cutoff,),
                )
                conn.commit()
                return int(cur.rowcount or 0)
            finally:
                conn.close()
