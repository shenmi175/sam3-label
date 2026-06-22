from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.utils import ensure_dir


def parse_positive_int_env(key: str, default: int) -> int:
    try:
        value = int(os.getenv(key, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(1, value)


def parse_allowed_data_roots(host_data_root: Path) -> list[Path]:
    roots: list[Path] = []
    raw = os.getenv('WEB_AUTO_ALLOWED_DATA_ROOTS', '').strip()
    items = [str(host_data_root)]
    if raw:
        items.extend(item for item in raw.split(os.pathsep) if item.strip())
    for item in items:
        try:
            root = Path(item).expanduser().resolve()
        except Exception:
            continue
        if root not in roots:
            roots.append(root)
    return roots or [host_data_root]


class AppConfigStore:
    def __init__(self, path: Path):
        self.path = path

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            with self.path.open('r', encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def write(self, data: dict[str, Any]) -> dict[str, Any]:
        ensure_dir(self.path.parent)
        tmp = self.path.with_suffix(self.path.suffix + '.tmp')
        clean = data if isinstance(data, dict) else {}
        with tmp.open('w', encoding='utf-8') as f:
            json.dump(clean, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write('\n')
        os.replace(tmp, self.path)
        return clean

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        data = self.read()
        for key, value in values.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        return self.write(data)

    def initial_storage_dir(self, default_dir: Path) -> Path:
        configured = str(self.read().get('cache_dir') or '').strip()
        if configured:
            try:
                return ensure_dir(Path(configured).expanduser().resolve())
            except Exception:
                pass
        return default_dir
