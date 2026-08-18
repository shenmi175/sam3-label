"""Lightweight config for the unified model-lifecycle env vars.

Only the new lifecycle variables live here; the existing inline ``os.getenv``
calls in engine.py / pose_engine.py / main.py are intentionally untouched.
"""

from __future__ import annotations

import os

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    return default


def eager_load() -> bool:
    """Whether engines are loaded eagerly at startup (SAPIENS_EAGER_LOAD, default True)."""
    return _env_flag("SAPIENS_EAGER_LOAD", True)


def strict_eager_load() -> bool:
    """Strict mode: missing weights at startup are fatal (SAPIENS_STRICT_EAGER_LOAD, default False)."""
    return _env_flag("SAPIENS_STRICT_EAGER_LOAD", False)
