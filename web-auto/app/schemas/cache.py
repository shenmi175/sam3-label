from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


CacheScope = Literal['previews', 'tiles', 'composites']


class CacheCleanupIn(BaseModel):
    scopes: list[CacheScope]
    confirm: bool = False
