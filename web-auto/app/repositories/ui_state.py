from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from app.utils import atomic_write_json, read_json


class UIStateRepository:
    def __init__(
        self,
        *,
        global_state_file: Path,
        get_project: Callable[[str], dict[str, Any] | None],
    ) -> None:
        self._global_state_file = global_state_file
        self._get_project = get_project

    def get(self, project_id: str | None = None) -> dict[str, Any]:
        if project_id:
            project = self._get_project(project_id)
            if not project:
                return {}
            path = Path(project['workspace_dir']) / 'ui_state.json'
            data = read_json(path, {})
            return data if isinstance(data, dict) else {}
        data = read_json(self._global_state_file, {})
        return data if isinstance(data, dict) else {}

    def set(self, *, state: dict[str, Any], project_id: str | None = None) -> None:
        payload = state if isinstance(state, dict) else {}
        if project_id:
            project = self._get_project(project_id)
            if not project:
                return
            path = Path(project['workspace_dir']) / 'ui_state.json'
            atomic_write_json(path, payload)
            return
        atomic_write_json(self._global_state_file, payload)
