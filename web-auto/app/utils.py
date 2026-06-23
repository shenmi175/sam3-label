from __future__ import annotations

import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tiff'}

def now_ts() -> str:
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())


def new_id(prefix: str = '') -> str:
    token = uuid.uuid4().hex[:12]
    return f'{prefix}{token}' if prefix else token


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix='.tmp_', suffix='.json', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # Windows can transiently raise PermissionError when another thread/process
        # is reading the destination file. Retry a few times before failing.
        last_err: Exception | None = None
        for i in range(12):
            try:
                os.replace(tmp_name, path)
                last_err = None
                break
            except PermissionError as exc:
                last_err = exc
                # 10ms, 20ms, ... up to 120ms
                time.sleep(0.01 * float(i + 1))
        if last_err is not None:
            raise last_err
    except Exception:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with path.open('r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def norm_text(value: str) -> str:
    return ' '.join(str(value or '').strip().lower().replace('_', ' ').replace('-', ' ').split())


def parse_classes_text(text: str) -> list[str]:
    classes: list[str] = []
    seen = set()
    for raw in re.split(r'[,;\r\n\u2028\u2029\uFF0C\uFF1B]+', str(text or '')):
        name = raw.strip()
        if not name:
            continue
        key = norm_text(name)
        if key in seen:
            continue
        seen.add(key)
        classes.append(name)
    return classes


def list_images_recursive(root: Path) -> list[dict[str, str]]:
    images: list[dict[str, str]] = []
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        if p.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        rel = p.relative_to(root).as_posix()
        image_id = uuid.uuid5(uuid.NAMESPACE_URL, rel).hex[:16]
        images.append({'id': image_id, 'rel_path': rel, 'abs_path': str(p.resolve())})
    return images
