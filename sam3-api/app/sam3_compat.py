"""Compatibility adapter between sam3-api and the vendored sam3 package.

sam3 is a third-party submodule (external/sam3, pinned SHA below). This module is the
ONLY place in sam3-api that imports sam3 internals, so an upstream upgrade only ever
needs to be reconciled here. Tests in tests/test_sam3_compat.py snapshot the required
symbols and signatures.
"""

from __future__ import annotations

import importlib
from typing import Any

# Upstream commit pinned in the external/sam3 submodule (see docs/wiki/sam3-submodule.md).
SAM3_PIN_SHA = "66b74826020e1c5b54ee3782ed360fa0b85cbee7"

# symbol name -> (module path, attribute name)
REQUIRED_SYMBOLS: dict[str, tuple[str, str]] = {
    "Sam3Processor": ("sam3.model.sam3_image_processor", "Sam3Processor"),
    "build_sam3_image_model": ("sam3.model_builder", "build_sam3_image_model"),
    "PostProcessImage": ("sam3.eval.postprocessors", "PostProcessImage"),
    "BatchedDatapoint": ("sam3.model.data_misc", "BatchedDatapoint"),
    "BatchedFindTarget": ("sam3.model.data_misc", "BatchedFindTarget"),
    "BatchedInferenceMetadata": ("sam3.model.data_misc", "BatchedInferenceMetadata"),
    "FindStage": ("sam3.model.data_misc", "FindStage"),
    "convert_my_tensors": ("sam3.model.data_misc", "convert_my_tensors"),
    "copy_data_to_device": ("sam3.model.utils.misc", "copy_data_to_device"),
    "Sam3VideoPredictor": ("sam3.model.sam3_video_predictor", "Sam3VideoPredictor"),
    "load_video_frames": ("sam3.model.io_utils", "load_video_frames"),
}

IMAGE_SURFACE = (
    "Sam3Processor",
    "build_sam3_image_model",
    "PostProcessImage",
    "BatchedDatapoint",
    "BatchedFindTarget",
    "BatchedInferenceMetadata",
    "FindStage",
    "convert_my_tensors",
    "copy_data_to_device",
)

VIDEO_SURFACE = ("Sam3VideoPredictor",)


class Sam3CompatError(RuntimeError):
    """Raised when the pinned sam3 package does not provide a required symbol."""


_cache: dict[str, Any] = {}


def _load_symbol(name: str) -> Any:
    if name in _cache:
        return _cache[name]
    if name not in REQUIRED_SYMBOLS:
        raise Sam3CompatError(f"unknown sam3 compat symbol: {name}")
    module_path, attr = REQUIRED_SYMBOLS[name]
    try:
        module = importlib.import_module(module_path)
        symbol = getattr(module, attr)
    except Exception as exc:  # noqa: BLE001
        raise Sam3CompatError(
            f"sam3 symbol unavailable: {module_path}.{attr} (alias '{name}'). "
            f"The sam3 package installed here is incompatible with sam3-api; "
            f"expected the submodule pinned at {SAM3_PIN_SHA}. "
            f"Original error: {type(exc).__name__}: {exc}"
        ) from exc
    _cache[name] = symbol
    return symbol


def load_image_surface() -> dict[str, Any]:
    """Load all sam3 symbols required for image inference."""
    return {name: _load_symbol(name) for name in IMAGE_SURFACE}


def load_video_surface() -> dict[str, Any]:
    """Load all sam3 symbols required for video inference."""
    return {name: _load_symbol(name) for name in VIDEO_SURFACE}


def sam3_runtime_info() -> dict[str, Any]:
    """Best-effort description of the sam3 package actually importable at runtime."""
    info: dict[str, Any] = {"pin_sha": SAM3_PIN_SHA}
    try:
        import sam3

        info["module_file"] = getattr(sam3, "__file__", None)
        info["module_version"] = getattr(sam3, "__version__", None)
    except Exception as exc:  # noqa: BLE001
        info["import_error"] = f"{type(exc).__name__}: {exc}"
    try:
        from importlib.metadata import version

        info["distribution_version"] = version("sam3")
    except Exception:  # noqa: BLE001
        info["distribution_version"] = None
    try:
        import torch

        info["cuda_available"] = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        info["cuda_available"] = False
    return info
