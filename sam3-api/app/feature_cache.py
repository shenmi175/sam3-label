from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import torch
from safetensors import safe_open


FEATURE_TENSOR_NAMES = ("high_res_0", "high_res_1", "image_embed")


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def feature_key(
    *,
    image_digest: str,
    model_fingerprint: str,
    input_size: int,
    format_version: str,
    width: int,
    height: int,
) -> str:
    raw = "\0".join(
        [
            image_digest,
            model_fingerprint,
            str(int(input_size)),
            format_version,
            f"{int(width)}x{int(height)}",
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def resolve_feature_root(raw: str, allowed_roots: list[Path]) -> Path:
    if not str(raw or "").strip():
        raise ValueError("feature_root is required when saving AI features")
    root = Path(str(raw)).expanduser().resolve()
    if root.name != "feature":
        raise ValueError("feature_root must end with the fixed directory name 'feature'")
    if not any(root == allowed or allowed in root.parents for allowed in allowed_roots):
        raise ValueError("feature_root is outside configured allowed roots")
    return root


def metadata_matches(path: Path, expected: dict[str, str]) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        with safe_open(str(path), framework="pt", device="cpu") as handle:
            metadata = handle.metadata() or {}
            if any(str(metadata.get(key) or "") != str(value) for key, value in expected.items()):
                return False
            return all(name in handle.keys() for name in FEATURE_TENSOR_NAMES)
    except Exception:
        return False


def load_feature(path: Path, *, device: str) -> tuple[dict[str, torch.Tensor], dict[str, str]]:
    from safetensors.torch import load_file

    with safe_open(str(path), framework="pt", device="cpu") as handle:
        metadata = {str(k): str(v) for k, v in (handle.metadata() or {}).items()}
    tensors = load_file(str(path), device="cpu")
    missing = [name for name in FEATURE_TENSOR_NAMES if name not in tensors]
    if missing:
        raise ValueError(f"feature file is missing tensors: {', '.join(missing)}")
    return (
        {name: tensors[name].to(device=device, non_blocking=True) for name in FEATURE_TENSOR_NAMES},
        metadata,
    )


def save_feature_atomic(
    path: Path,
    *,
    tensors: dict[str, torch.Tensor],
    metadata: dict[str, Any],
) -> int:
    from safetensors.torch import save_file

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.stem}.", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    temp_path = Path(temporary)
    try:
        cpu_tensors = {
            name: tensors[name].detach().contiguous().to(device="cpu")
            for name in FEATURE_TENSOR_NAMES
        }
        save_file(cpu_tensors, str(temp_path), metadata={str(k): str(v) for k, v in metadata.items()})
        os.replace(temp_path, path)
        return int(path.stat().st_size)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass


def feature_tensor_bytes(tensors: dict[str, torch.Tensor]) -> int:
    return sum(int(t.numel()) * int(t.element_size()) for t in tensors.values())
