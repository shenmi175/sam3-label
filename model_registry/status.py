from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from model_registry.registry import ModelSpec


def repo_root() -> Path:
    # model_registry/status.py -> repo root
    return Path(__file__).resolve().parents[1]


def load_env_file(root: Path | None = None) -> dict[str, str]:
    """Parse KEY=VALUE pairs from <root>/.env (no interpolation)."""
    root = root or repo_root()
    env_path = root / ".env"
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def resolve_host_dir(
    spec: ModelSpec,
    root: Path | None = None,
    env_file: dict[str, str] | None = None,
) -> Path:
    """Checkpoint directory on the host: os.environ > .env > registry default."""
    root = root or repo_root()
    raw = (
        os.environ.get(spec.host_dir_env, "").strip()
        or (env_file or {}).get(spec.host_dir_env, "").strip()
        or spec.default_host_dir
    )
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = root / path
    return path


def _path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    if path.is_dir():
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return 0


@dataclass(frozen=True)
class FileStatus:
    rel_path: str
    exists: bool
    optional: bool
    size_bytes: int


@dataclass(frozen=True)
class ModelStatus:
    model_id: str
    host_dir: str
    host_dir_exists: bool
    files: tuple[FileStatus, ...]
    state: str  # ready | incomplete | missing

    @property
    def total_bytes(self) -> int:
        return sum(f.size_bytes for f in self.files)


def status(
    spec: ModelSpec,
    root: Path | None = None,
    env_file: dict[str, str] | None = None,
) -> ModelStatus:
    host_dir = resolve_host_dir(spec, root=root, env_file=env_file)
    files: list[FileStatus] = []
    for rel in spec.expected_files + spec.optional_files:
        path = host_dir / rel
        exists = path.exists()
        files.append(
            FileStatus(
                rel_path=rel,
                exists=exists,
                optional=rel in spec.optional_files,
                size_bytes=_path_size(path) if exists else 0,
            )
        )

    required = [f for f in files if not f.optional]
    if required and all(f.exists for f in required):
        state = "ready"
    elif any(f.exists for f in files) or host_dir.exists():
        state = "incomplete"
    else:
        state = "missing"

    return ModelStatus(
        model_id=spec.id,
        host_dir=str(host_dir),
        host_dir_exists=host_dir.exists(),
        files=tuple(files),
        state=state,
    )
