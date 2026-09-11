from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

try:
    from concurrent_log_handler import ConcurrentRotatingFileHandler
except ImportError:  # pragma: no cover - production images install the dependency
    ConcurrentRotatingFileHandler = RotatingFileHandler  # type: ignore[misc,assignment]


DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_LOG_FILE_COUNT = 3


def _positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default)) or default))
    except (TypeError, ValueError):
        return default


class InterProcessRotatingFileHandler(ConcurrentRotatingFileHandler):
    """Compatibility wrapper around concurrent-log-handler.

    The public name is retained for callers and older tests while the custom
    fcntl implementation has been replaced by the maintained dependency.
    """

    def __init__(self, filename: Path, *, max_bytes: int, file_count: int) -> None:
        super().__init__(
            str(filename),
            maxBytes=max(1, int(max_bytes)),
            backupCount=max(0, int(file_count) - 1),
            encoding='utf-8',
            delay=True,
        )
        self.web_auto_persistent_handler = True


def configure_web_auto_logging(data_dir: Path) -> logging.Logger:
    logger = logging.getLogger('web_auto')
    logger.setLevel(logging.INFO)
    logger.propagate = False
    formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(name)s | %(message)s')

    if not any(getattr(handler, 'web_auto_stream_handler', False) for handler in logger.handlers):
        stream = logging.StreamHandler()
        stream.setFormatter(formatter)
        stream.web_auto_stream_handler = True
        logger.addHandler(stream)

    file_enabled = str(os.getenv('WEB_AUTO_LOG_FILE_ENABLED', '1')).strip().lower() not in {
        '0', 'false', 'no', 'off',
    }
    if file_enabled and not any(
        getattr(handler, 'web_auto_persistent_handler', False) for handler in logger.handlers
    ):
        log_dir = Path(os.getenv('WEB_AUTO_LOG_DIR', str(Path(data_dir) / 'logs'))).expanduser().resolve()
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            file_handler = InterProcessRotatingFileHandler(
                log_dir / 'web-auto.log',
                max_bytes=_positive_int_env('WEB_AUTO_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES),
                file_count=_positive_int_env('WEB_AUTO_LOG_FILE_COUNT', DEFAULT_LOG_FILE_COUNT),
            )
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except OSError as exc:
            logger.warning('persistent log initialization failed path=%s error=%s', log_dir, exc)

    return logger
