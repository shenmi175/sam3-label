from __future__ import annotations

import os

from app.main import create_app

app = create_app()

if __name__ == "__main__":
    import uvicorn

    host = os.getenv("LOCATE_API_HOST", "0.0.0.0")
    port = int(os.getenv("LOCATE_API_PORT", "8004"))
    reload = os.getenv("LOCATE_API_RELOAD", "0").strip().lower() in {"1", "true", "yes", "on"}
    uvicorn.run("run:app", host=host, port=port, reload=reload)
