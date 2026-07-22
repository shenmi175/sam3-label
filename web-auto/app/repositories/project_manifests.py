from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from app.utils import atomic_write_json, ensure_dir, now_ts, read_json


class ProjectManifestRepository:
    MANIFEST_NAME = 'web_auto_project.json'
    MANIFEST_SCHEMA = 'web-auto.project.v2'
    LEGACY_MANIFEST_SCHEMA = 'web-auto.project.v1'

    def __init__(self, *, normalize_project: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self._normalize_project = normalize_project

    def payload(self, project: dict[str, Any]) -> dict[str, Any]:
        p = self._normalize_project(project)
        keys = [
            'id',
            'name',
            'project_type',
            'image_dir',
            'save_base_dir',
            'project_save_dir',
            'save_dir',
            'annotation_dir',
            'export_dir',
            'workspace_dir',
            'cache_dir',
            'classes',
            'num_images',
            'labeled_images',
            'unlabeled_images',
            'created_at',
            'updated_at',
            'content_rev',
            'image_set_rev',
            'annotation_legacy_fallback',
        ]
        project_payload = {key: p.get(key) for key in keys if key in p}
        return {
            'schema': self.MANIFEST_SCHEMA,
            'version': 2,
            'image_id_strategy': 'uuid5:url:rel_path',
            'annotation_layout': {
                'strategy': 'mirrored_relpath',
                'file': 'annotations/{relative_parent}/{image_stem}.json',
                'stem_collision': 'preserve_source_extension',
                'legacy_fallback': bool(p.get('annotation_legacy_fallback', False)),
            },
            'project': project_payload,
            'updated_at': now_ts(),
        }

    def write(self, project: dict[str, Any]) -> None:
        payload = self.payload(project)
        p = payload.get('project', {}) if isinstance(payload.get('project'), dict) else {}
        targets: list[Path] = []
        for raw in (p.get('project_save_dir'), p.get('workspace_dir')):
            text = str(raw or '').strip()
            if not text:
                continue
            try:
                target_dir = ensure_dir(Path(text).expanduser().resolve())
            except Exception:
                continue
            if target_dir not in targets:
                targets.append(target_dir)
        for target_dir in targets:
            atomic_write_json(target_dir / self.MANIFEST_NAME, payload)

    def read(self, manifest_path: Path) -> dict[str, Any] | None:
        data = read_json(manifest_path, {})
        if not isinstance(data, dict):
            return None
        if str(data.get('schema') or '') not in {self.MANIFEST_SCHEMA, self.LEGACY_MANIFEST_SCHEMA}:
            return None
        project = data.get('project')
        if not isinstance(project, dict):
            return None
        project_id = str(project.get('id') or '').strip()
        if not project_id:
            return None
        return data
