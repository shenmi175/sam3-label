from __future__ import annotations

import os

from app.main import app


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("OPS_API_HOST", "0.0.0.0")
    port = int(os.getenv("OPS_API_PORT", "8020"))
    uvicorn.run("run:app", host=host, port=port)
