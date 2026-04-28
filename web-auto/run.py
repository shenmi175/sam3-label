from __future__ import annotations

import os
from pathlib import Path

import uvicorn


if __name__ == '__main__':
    base_dir = Path(__file__).resolve().parent
    host = os.getenv('WEB_AUTO_HOST', '127.0.0.1')
    port = int(os.getenv('WEB_AUTO_PORT', '8000'))
    print(f'web-auto API: http://{host}:{port}')
    print(f'OpenAPI 文档: http://{host}:{port}/docs')

    # Windows 下默认禁用 reload，避免热重载导致请求不进入应用进程。
    use_reload = os.getenv('WEB_AUTO_RELOAD', '0') == '1'

    uvicorn.run(
        'app.main:app',
        host=host,
        port=port,
        reload=use_reload,
        reload_dirs=[str(base_dir)],
    )
