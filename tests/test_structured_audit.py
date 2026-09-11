from __future__ import annotations

import json
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.audit import AuditLogger, reset_audit_context, set_audit_context  # noqa: E402
from app.routers.audit_events import create_audit_events_router  # noqa: E402
from app.services.job_queue import PersistentJobQueue  # noqa: E402


class StructuredAuditTest(unittest.TestCase):
    def test_event_schema_context_utc_and_recursive_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text, patch.dict(
            os.environ, {'WEB_AUTO_LOG_DIR': tmp_text}, clear=False
        ):
            audit = AuditLogger(Path(tmp_text), service='test-service')
            tokens = set_audit_context('req-123', 'alice')
            try:
                audit.emit(
                    category='test',
                    action='redact',
                    project_id='project-1',
                    details={
                        'password': 'do-not-log',
                        'nested': {'authorization': 'Bearer secret', 'safe': 'yes'},
                        'items': [{'api_token': 'secret-token'}],
                    },
                )
            finally:
                reset_audit_context(tokens)
                for handler in audit.logger.handlers:
                    handler.flush()
                    handler.close()
                audit.logger.handlers = []

            event = json.loads((Path(tmp_text) / 'events.jsonl').read_text(encoding='utf-8'))
            required = {
                'schema_version', 'event_id', 'timestamp', 'source', 'service',
                'category', 'action', 'outcome', 'level', 'actor', 'request_id',
                'project_id', 'job_id', 'message', 'details',
            }
            self.assertEqual(set(event), required)
            self.assertTrue(event['timestamp'].endswith('Z'))
            self.assertEqual(event['actor'], 'alice')
            self.assertEqual(event['request_id'], 'req-123')
            self.assertEqual(event['details']['password'], '[REDACTED]')
            self.assertEqual(event['details']['nested']['authorization'], '[REDACTED]')
            self.assertEqual(event['details']['nested']['safe'], 'yes')
            self.assertEqual(event['details']['items'][0]['api_token'], '[REDACTED]')

    def test_ui_event_allowlist_and_size_limits(self) -> None:
        class CaptureAudit:
            def __init__(self) -> None:
                self.events: list[dict[str, object]] = []

            def emit(self, **event):
                self.events.append(event)
                return {'event_id': 'event-1'}

        capture = CaptureAudit()
        router = create_audit_events_router(audit=capture)  # type: ignore[arg-type]
        endpoint = next(route.endpoint for route in router.routes if route.path == '/api/log/events')

        async def invoke(payload: dict[str, object]):
            body = json.dumps(payload).encode('utf-8')
            sent = False

            async def receive():
                nonlocal sent
                if sent:
                    return {'type': 'http.disconnect'}
                sent = True
                return {'type': 'http.request', 'body': body, 'more_body': False}

            request = Request({
                'type': 'http', 'http_version': '1.1', 'method': 'POST',
                'scheme': 'http', 'path': '/api/log/events', 'raw_path': b'/api/log/events',
                'query_string': b'', 'headers': [(b'content-length', str(len(body)).encode('ascii'))],
                'client': None, 'server': None,
            }, receive)
            return await endpoint(request)

        accepted = asyncio.run(invoke({
            'action': 'open_data_cleaning', 'project_id': 'project-1', 'details': {'entry': 'toolbar'},
        }))
        self.assertTrue(accepted['accepted'])
        self.assertEqual(capture.events[0]['source'], 'frontend')

        with self.assertRaises(HTTPException) as unknown:
            asyncio.run(invoke({'action': 'clicked_every_pixel'}))
        self.assertEqual(unknown.exception.status_code, 422)
        with self.assertRaises(HTTPException) as oversized_details:
            asyncio.run(invoke({'action': 'open_data_cleaning', 'details': {'value': 'x' * (9 * 1024)}}))
        self.assertEqual(oversized_details.exception.status_code, 413)
        with self.assertRaises(HTTPException) as oversized_body:
            asyncio.run(invoke({'action': 'open_data_cleaning', 'details': {'value': 'x' * (17 * 1024)}}))
        self.assertEqual(oversized_body.exception.status_code, 413)

    def test_task_lifecycle_order_and_parameter_summary(self) -> None:
        class CaptureAudit:
            def __init__(self) -> None:
                self.events: list[dict[str, object]] = []

            def emit(self, **event):
                self.events.append(event)
                return {'event_id': f"event-{len(self.events)}"}

        with tempfile.TemporaryDirectory() as tmp_text:
            capture = CaptureAudit()
            queue = PersistentJobQueue(Path(tmp_text) / 'jobs.sqlite3', audit=capture)  # type: ignore[arg-type]
            tokens = set_audit_context('request-9', 'admin')
            try:
                job = queue.enqueue(
                    project_id='project-1',
                    job_type='infer:text_batch',
                    resource_class='gpu',
                    payload={
                        'classes': ['cat'], 'scope_mode': 'all', 'batch_size': 4,
                        'image_ids': ['image-secret-1', 'image-secret-2'],
                        'api_base_url': 'http://internal-secret',
                    },
                    state={},
                )
            finally:
                reset_audit_context(tokens)
            claimed = queue.claim_next('gpu', 'worker-1')
            self.assertEqual(claimed['job_id'], job['job_id'])
            queue.update(job['job_id'], status='done', requested=2, succeeded=2, failed=0, skipped=0)

            lifecycle = [
                (event['action'], event['outcome']) for event in capture.events
                if event['action'] in {'enqueue', 'worker_claim', 'status_transition'}
            ]
            self.assertEqual(lifecycle, [
                ('enqueue', 'accepted'),
                ('worker_claim', 'accepted'),
                ('status_transition', 'running'),
                ('status_transition', 'done'),
            ])
            enqueue_details = capture.events[0]['details']
            encoded = json.dumps(enqueue_details)
            self.assertIn('image_ids_count', encoded)
            self.assertNotIn('image-secret-1', encoded)
            self.assertNotIn('internal-secret', encoded)
            self.assertEqual(capture.events[-1]['actor'], 'admin')
            self.assertEqual(capture.events[-1]['request_id'], 'request-9')


if __name__ == '__main__':
    unittest.main()
