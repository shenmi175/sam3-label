from __future__ import annotations

from pathlib import Path
from typing import Any

from app.utils import atomic_write_json, read_json


class ProjectCatalogRepository:
    def __init__(self, *, projects_file: Path) -> None:
        self._projects_file = projects_file

    def load(self) -> list[dict[str, Any]]:
        data = read_json(self._projects_file, [])
        return data if isinstance(data, list) else []

    def save(self, projects: list[dict[str, Any]]) -> None:
        atomic_write_json(self._projects_file, projects)

    def known_ids(self) -> set[str]:
        return {str(p.get('id') or '').strip() for p in self.load() if str(p.get('id') or '').strip()}
