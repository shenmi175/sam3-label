from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Callable

from app.utils import ensure_dir, norm_text, read_json


class ProjectFileRepository:
    def __init__(self, *, annotation_class_name: Callable[[dict[str, Any]], str]) -> None:
        self._annotation_class_name = annotation_class_name

    @staticmethod
    def annotation_relative_paths(images: list[dict[str, Any]]) -> dict[str, Path]:
        """Return mirrored annotation paths, preserving extensions for stem collisions."""
        prepared: list[tuple[str, Path]] = []
        groups: dict[tuple[str, str], list[tuple[str, Path]]] = {}
        for image in images:
            image_id = str(image.get('id') or '').strip()
            raw_rel = str(image.get('rel_path') or '').strip().replace('\\', '/')
            if not image_id or not raw_rel:
                continue
            rel = Path(raw_rel)
            if rel.is_absolute() or '..' in rel.parts:
                raise ValueError(f'invalid image relative path: {raw_rel}')
            prepared.append((image_id, rel))
            key = (rel.parent.as_posix().casefold(), rel.stem.casefold())
            groups.setdefault(key, []).append((image_id, rel))

        out: dict[str, Path] = {}
        for image_id, rel in prepared:
            key = (rel.parent.as_posix().casefold(), rel.stem.casefold())
            filename = f'{rel.name}.json' if len(groups.get(key, [])) > 1 else f'{rel.stem}.json'
            out[image_id] = rel.parent / filename
        return out

    def annotation_path(
        self,
        project: dict[str, Any],
        image: dict[str, Any],
        relative_paths: dict[str, Path],
    ) -> Path:
        ann_dir = ensure_dir(Path(project['annotation_dir']).expanduser().resolve())
        image_id = str(image.get('id') or '').strip()
        rel = relative_paths.get(image_id)
        if rel is None:
            raise ValueError(f'annotation path unavailable for image: {image_id}')
        target = (ann_dir / rel).resolve()
        if not target.is_relative_to(ann_dir):
            raise ValueError(f'annotation path escapes annotation directory: {rel}')
        return target

    @staticmethod
    def legacy_annotation_path(project: dict[str, Any], image_id: str) -> Path:
        ann_dir = ensure_dir(Path(project['annotation_dir']).expanduser().resolve())
        return ann_dir / f'{str(image_id).strip()}.json'

    @staticmethod
    def annotation_has_items(path: Path) -> bool:
        if not path.exists():
            return False
        try:
            size = os.path.getsize(path)
            if size <= 2:
                return False
            if size > 64:
                return True
            with path.open('r', encoding='utf-8', errors='ignore') as f:
                content = f.read(256).strip()
            if not content or content == '[]':
                return False
            return True
        except Exception:
            return False

    @staticmethod
    def annotation_json_count(annotation_dir: Path) -> int:
        if not annotation_dir.exists() or not annotation_dir.is_dir():
            return 0
        try:
            return sum(
                1
                for p in annotation_dir.rglob('*.json')
                if p.is_file() and '.legacy_conflicts' not in p.parts
            )
        except OSError:
            return 0

    @staticmethod
    def legacy_annotation_dir(project_dir: Path) -> Path | None:
        candidates = [
            project_dir / 'annotations',
            project_dir / 'output' / 'annotations',
        ]
        for candidate in candidates:
            if candidate.exists() and candidate.is_dir():
                return candidate
        return None

    @staticmethod
    def existing_project_save_dir(project_dir: Path, base: dict[str, Any]) -> Path:
        candidates: list[Path] = []
        raw_save_dir = str(base.get('project_save_dir') or base.get('save_dir') or '').strip() if isinstance(base, dict) else ''
        if raw_save_dir:
            try:
                candidates.append(Path(raw_save_dir).expanduser().resolve())
            except Exception:
                pass
        candidates.append(project_dir)
        candidates.append(project_dir / 'output')
        for candidate in candidates:
            try:
                resolved = candidate.expanduser().resolve()
            except Exception:
                continue
            if (resolved / 'annotations').is_dir():
                return resolved
        return project_dir.expanduser().resolve()

    def infer_classes_from_annotations(self, annotation_dir: Path, *, max_files: int = 2000) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        if not annotation_dir.exists() or not annotation_dir.is_dir():
            return out
        try:
            files = [
                p for p in sorted(annotation_dir.rglob('*.json'))
                if p.is_file() and '.legacy_conflicts' not in p.parts
            ]
        except OSError:
            return out
        for path in files[:max(1, max_files)]:
            data = read_json(path, [])
            if not isinstance(data, list):
                continue
            for ann in data:
                if not isinstance(ann, dict):
                    continue
                class_name = self._annotation_class_name(ann)
                key = norm_text(class_name)
                if not key or key in seen:
                    continue
                seen.add(key)
                out.append(class_name)
        return out

    @staticmethod
    def unique_import_target(root: Path, rel_path: str) -> Path:
        rel_obj = Path(rel_path)
        target = (root / rel_obj).resolve()
        ensure_dir(target.parent)
        if not target.exists():
            return target

        stem = target.stem
        suffix = target.suffix
        idx = 1
        while True:
            candidate = target.with_name(f'{stem}_import{idx}{suffix}')
            if not candidate.exists():
                return candidate
            idx += 1

    @staticmethod
    def safe_rmtree(path: Path, source_path: Path) -> None:
        if not path.exists() or not path.is_dir():
            return
        path = path.resolve()
        source_path = source_path.resolve()
        if path == source_path:
            return
        if source_path.is_relative_to(path):
            return
        shutil.rmtree(path, ignore_errors=True)

    @staticmethod
    def safe_unlink(path: Path, source_path: Path) -> None:
        if not path.exists() or not path.is_file():
            return
        rp = path.resolve()
        source_path = source_path.resolve()
        if rp == source_path or source_path.is_relative_to(rp.parent):
            return
        try:
            rp.unlink(missing_ok=True)
        except Exception:
            pass
