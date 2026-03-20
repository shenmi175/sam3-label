"""Minimal compatibility shim for environments without setuptools.pkg_resources.

This project only needs ``resource_filename(package, resource_name)`` so we
provide the smallest compatible surface here instead of patching upstream sam3.
"""

from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path


def resource_filename(package_or_requirement: str, resource_name: str) -> str:
    spec = importlib.util.find_spec(package_or_requirement)
    if spec is None:
        raise ModuleNotFoundError(f"No module named '{package_or_requirement}'")
    if spec.submodule_search_locations:
        base_path = Path(next(iter(spec.submodule_search_locations))).resolve()
    elif spec.origin:
        base_path = Path(spec.origin).resolve().parent
    else:
        raise ModuleNotFoundError(
            f"Cannot resolve resources for package: {package_or_requirement}"
        )
    return str(base_path / resource_name)
