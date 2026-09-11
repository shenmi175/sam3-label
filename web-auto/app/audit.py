from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.logging_config import (
    DEFAULT_LOG_FILE_COUNT,
    DEFAULT_LOG_MAX_BYTES,
    InterProcessRotatingFileHandler,
    _positive_int_env,
)

try:
    from pythonjsonlogger.json import JsonFormatter
except ImportError:  # pragma: no cover - production images install the dependency
    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            return json.dumps(getattr(record, 'audit_event', {}), ensure_ascii=False, separators=(',', ':'))


SCHEMA_VERSION = '1.0'
MAX_DETAILS_BYTES = 8 * 1024
SENSITIVE_KEYS = {
    'authorization', 'cookie', 'cookies', 'password', 'passwd', 'secret',
    'token', 'access_token', 'refresh_token', 'api_key', 'x-api-key',
    'x-ops-api-key', 'session', 'session_id', 'mask', 'masks',
}

_request_id: contextvars.ContextVar[str] = contextvars.ContextVar('audit_request_id', default='')
_actor: contextvars.ContextVar[str] = contextvars.ContextVar('audit_actor', default='anonymous')


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def set_audit_context(request_id: str, actor: str) -> tuple[contextvars.Token[str], contextvars.Token[str]]:
    return _request_id.set(str(request_id or '')), _actor.set(str(actor or 'anonymous'))


def reset_audit_context(tokens: tuple[contextvars.Token[str], contextvars.Token[str]]) -> None:
    _request_id.reset(tokens[0])
    _actor.reset(tokens[1])


def current_audit_context() -> dict[str, str]:
    return {'request_id': _request_id.get(), 'actor': _actor.get() or 'anonymous'}


def _is_sensitive_key(key: Any) -> bool:
    clean = str(key or '').strip().lower().replace('-', '_')
    return clean in {item.replace('-', '_') for item in SENSITIVE_KEYS} or any(
        marker in clean for marker in ('password', 'authorization', 'cookie', 'token', 'secret')
    )


def redact_sensitive(value: Any, *, depth: int = 0) -> Any:
    if depth >= 8:
        return '[MAX_DEPTH]'
    if isinstance(value, dict):
        return {
            str(key): '[REDACTED]' if _is_sensitive_key(key) else redact_sensitive(item, depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact_sensitive(item, depth=depth + 1) for item in list(value)[:100]]
    if value is None or isinstance(value, (str, int, float, bool)):
        text = value if not isinstance(value, str) else value[:2048]
        return text
    return str(value)[:2048]


def bounded_details(details: Any) -> dict[str, Any]:
    clean = redact_sensitive(details if isinstance(details, dict) else {})
    if not isinstance(clean, dict):
        return {}
    encoded = json.dumps(clean, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) <= MAX_DETAILS_BYTES:
        return clean
    # Details are intentionally dropped rather than byte-truncated into invalid JSON.
    return {'truncated': True, 'original_bytes': len(encoded)}


class _AuditJsonFormatter(JsonFormatter):
    def format(self, record: logging.LogRecord) -> str:
        event = getattr(record, 'audit_event', {})
        return json.dumps(event, ensure_ascii=False, separators=(',', ':'), sort_keys=False)


class AuditLogger:
    def __init__(self, data_dir: Path, *, service: str = '') -> None:
        self.service = str(service or os.getenv('WEB_AUTO_SERVICE_NAME', 'web-auto')).strip() or 'web-auto'
        log_dir = Path(os.getenv('WEB_AUTO_LOG_DIR', str(Path(data_dir) / 'logs'))).expanduser().resolve()
        logger_suffix = uuid.uuid5(uuid.NAMESPACE_URL, str(log_dir)).hex[:12]
        self.logger = logging.getLogger(f'web_auto.audit.{self.service}.{logger_suffix}')
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        if not any(getattr(handler, 'web_auto_audit_handler', False) for handler in self.logger.handlers):
            try:
                log_dir.mkdir(parents=True, exist_ok=True)
                handler = InterProcessRotatingFileHandler(
                    log_dir / 'events.jsonl',
                    max_bytes=_positive_int_env('WEB_AUTO_EVENT_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES),
                    file_count=_positive_int_env('WEB_AUTO_EVENT_LOG_FILE_COUNT', DEFAULT_LOG_FILE_COUNT),
                )
                handler.setFormatter(_AuditJsonFormatter())
                handler.web_auto_audit_handler = True
                self.logger.addHandler(handler)
            except Exception as exc:  # noqa: BLE001
                print(f'audit log initialization failed: {exc}', file=sys.stderr)

    def emit(
        self,
        *,
        category: str,
        action: str,
        outcome: str = 'success',
        level: str = 'info',
        message: str = '',
        details: dict[str, Any] | None = None,
        source: str = 'backend',
        actor: str | None = None,
        request_id: str | None = None,
        project_id: str = '',
        job_id: str = '',
        service: str | None = None,
    ) -> dict[str, Any]:
        context = current_audit_context()
        event = {
            'schema_version': SCHEMA_VERSION,
            'event_id': str(uuid.uuid4()),
            'timestamp': utc_now(),
            'source': str(source or 'backend'),
            'service': str(service or self.service),
            'category': str(category or 'business')[:64],
            'action': str(action or 'unknown')[:128],
            'outcome': str(outcome or 'unknown')[:32],
            'level': str(level or 'info').lower()[:16],
            'actor': str(actor if actor is not None else context['actor'] or 'anonymous')[:128],
            'request_id': str(request_id if request_id is not None else context['request_id'])[:128],
            'project_id': str(project_id or '')[:128],
            'job_id': str(job_id or '')[:128],
            'message': str(message or '')[:2048],
            'details': bounded_details(details or {}),
        }
        try:
            log_method = getattr(self.logger, event['level'], self.logger.info)
            log_method('', extra={'audit_event': event})
        except Exception as exc:  # noqa: BLE001
            print(f'audit event collection failed: {exc}', file=sys.stderr)
        return event
