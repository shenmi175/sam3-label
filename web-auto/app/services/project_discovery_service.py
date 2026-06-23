from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


class ProjectDiscoveryService:
    def __init__(
        self,
        *,
        manifest_name: str,
        known_project_ids: Callable[[], set[str]],
        legacy_annotation_dir: Callable[[Path], Path | None],
        read_project_manifest: Callable[[Path], dict[str, Any] | None],
        existing_project_save_dir: Callable[[Path, dict[str, Any]], Path],
        annotation_json_count: Callable[[Path], int],
        import_existing_project: Callable[..., dict[str, Any]],
    ) -> None:
        self._manifest_name = manifest_name
        self._known_project_ids = known_project_ids
        self._legacy_annotation_dir = legacy_annotation_dir
        self._read_project_manifest = read_project_manifest
        self._existing_project_save_dir = existing_project_save_dir
        self._annotation_json_count = annotation_json_count
        self._import_existing_project = import_existing_project

    def candidate_dirs(self, roots: list[Path], *, max_depth: int = 3) -> list[Path]:
        candidates: list[Path] = []
        seen: set[str] = set()

        def add_candidate(path: Path) -> None:
            key = str(path)
            if key in seen:
                return
            seen.add(key)
            candidates.append(path)

        def walk(path: Path, depth: int) -> None:
            try:
                current = path.expanduser().resolve()
            except Exception:
                return
            if not current.exists() or not current.is_dir():
                return

            has_manifest = (current / self._manifest_name).is_file()
            has_legacy_annotations = current.name.startswith('prj_') and self._legacy_annotation_dir(current) is not None
            if has_manifest or has_legacy_annotations:
                add_candidate(current)

            if depth <= 0:
                return
            try:
                children = list(current.iterdir())
            except OSError:
                return
            for child in children:
                if not child.is_dir():
                    continue
                if child.name.startswith('.') or child.name in {'annotations', 'exports', 'cache', '__pycache__'}:
                    continue
                walk(child, depth - 1)

        for root in roots:
            walk(root, max_depth)
        return candidates

    def discover_existing_projects(self, roots: list[Path], *, max_depth: int = 3) -> list[dict[str, Any]]:
        known = self._known_project_ids()
        out: list[dict[str, Any]] = []
        for project_dir in self.candidate_dirs(roots, max_depth=max_depth):
            manifest_path = project_dir / self._manifest_name
            if manifest_path.is_file():
                manifest = self._read_project_manifest(manifest_path)
                if not manifest:
                    continue
                project = manifest.get('project', {})
                project_id = str(project.get('id') or '').strip()
                ptype = str(project.get('project_type') or 'image').strip().lower()
                if ptype not in {'image', 'pose'}:
                    continue
                out.append(
                    {
                        'kind': 'manifest',
                        'project_id': project_id,
                        'name': str(project.get('name') or project_id),
                        'project_type': ptype if ptype in {'image', 'pose'} else 'image',
                        'image_dir': str(project.get('image_dir') or ''),
                        'output_dir': str(project_dir),
                        'manifest_path': str(manifest_path),
                        'annotation_count': self._annotation_json_count(self._existing_project_save_dir(project_dir, project) / 'annotations'),
                        'imported': project_id in known,
                        'requires_image_dir': False,
                    }
                )
                continue

            project_id = project_dir.name if project_dir.name.startswith('prj_') else ''
            if not project_id:
                continue
            legacy_annotation_dir = self._legacy_annotation_dir(project_dir) or (project_dir / 'annotations')
            out.append(
                {
                    'kind': 'legacy',
                    'project_id': project_id,
                    'name': project_id,
                    'project_type': 'image',
                    'image_dir': '',
                    'output_dir': str(project_dir),
                    'manifest_path': '',
                    'annotation_count': self._annotation_json_count(legacy_annotation_dir),
                    'imported': project_id in known,
                    'requires_image_dir': True,
                }
            )
        out.sort(key=lambda item: (bool(item.get('imported')), str(item.get('name') or ''), str(item.get('output_dir') or '')))
        return out

    def auto_import_manifests(self, roots: list[Path], *, max_depth: int = 3) -> dict[str, Any]:
        imported: list[str] = []
        skipped = 0
        errors: list[dict[str, str]] = []
        known = self._known_project_ids()
        for project_dir in self.candidate_dirs(roots, max_depth=max_depth):
            manifest_path = project_dir / self._manifest_name
            if not manifest_path.is_file():
                continue
            manifest = self._read_project_manifest(manifest_path)
            project = manifest.get('project', {}) if isinstance(manifest, dict) else {}
            ptype = str(project.get('project_type') or 'image').strip().lower() if isinstance(project, dict) else 'image'
            if ptype not in {'image', 'pose'}:
                skipped += 1
                continue
            project_id = str(project.get('id') or '').strip() if isinstance(project, dict) else ''
            if not project_id or project_id in known:
                skipped += 1
                continue
            try:
                result = self._import_existing_project(manifest_path=str(manifest_path))
                imported_id = str((result.get('project') or {}).get('id') or project_id)
                imported.append(imported_id)
                known.add(imported_id)
            except Exception as exc:  # noqa: BLE001
                errors.append({'manifest_path': str(manifest_path), 'error': str(exc)})
        return {'imported': imported, 'skipped': skipped, 'errors': errors}
