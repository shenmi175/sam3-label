from __future__ import annotations

import os


DEFAULT_API_BASE_URL = os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', 'http://127.0.0.1:8001').strip() or 'http://127.0.0.1:8001'
