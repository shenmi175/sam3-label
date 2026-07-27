from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class CacheDirUpdateIn(BaseModel):
    cache_dir: str


class GlobalConfigUpdateIn(BaseModel):
    cache_dir: Optional[str] = None
    upload_target_dir: Optional[str] = None
    sam3_api_base_url: Optional[str] = None
    locate_api_base_url: Optional[str] = None
