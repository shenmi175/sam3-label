from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.logging_config import InterProcessRotatingFileHandler  # noqa: E402


class LoggingRotationTest(unittest.TestCase):
    def test_rotation_keeps_at_most_configured_file_count(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            path = Path(tmp_text) / 'web-auto.log'
            handler = InterProcessRotatingFileHandler(path, max_bytes=256, file_count=3)
            handler.setFormatter(logging.Formatter('%(message)s'))
            logger = logging.getLogger(f'test.rotation.{id(self)}')
            logger.handlers = [handler]
            logger.propagate = False
            logger.setLevel(logging.INFO)
            try:
                for index in range(30):
                    logger.info('event=%02d payload=%s', index, 'x' * 40)
            finally:
                handler.close()
                logger.handlers = []

            files = sorted(path.parent.glob('web-auto.log*'))
            data_files = [item for item in files if item.name != 'web-auto.log.lock']
            self.assertEqual([item.name for item in data_files], [
                'web-auto.log', 'web-auto.log.1', 'web-auto.log.2',
            ])
            self.assertTrue(all(item.stat().st_size <= 256 for item in data_files))


if __name__ == '__main__':
    unittest.main()
