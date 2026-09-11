from __future__ import annotations

from typing import Any


def create_app(*args: Any, **kwargs: Any) -> Any:
    """Load the application factory without initializing it on package import."""
    from app.main import create_app as factory

    return factory(*args, **kwargs)


__all__ = ['create_app']
