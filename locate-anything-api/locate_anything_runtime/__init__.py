"""Thin runtime wrapper around the LocateAnything-3B model's batch_utils.

The model ships its own ``batch_utils/`` package inside the checkpoint directory.
This module adds that directory to sys.path, sets the required environment
variables, and exposes a ``LocateAnythingWorker`` class consumed by
``locate-anything-api/app/engine.py``.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

_PROMPT_TEMPLATE = "Locate all the instances that matches the following description: "


def unload_runtime_modules() -> None:
    """Drop ``batch_utils`` (and submodules) from ``sys.modules``.

    The model weights are held by module-level globals inside
    ``batch_utils.hybrid_runtime`` (``_tok/_proc/_model`` etc.), so deleting
    the worker wrapper alone never frees VRAM. Evicting the module graph lets
    those globals be collected; the next load re-imports a fresh copy.
    ``kernel_utils`` (flash_attn handle cache) and ``transformers_modules``
    are intentionally kept to speed up reload.
    """
    for name in list(sys.modules):
        if name == "batch_utils" or name.startswith("batch_utils."):
            try:
                del sys.modules[name]
            except KeyError:  # pragma: no cover - concurrent removal
                pass


class LocateAnythingWorker:
    """Single-image, multi-category detection worker.

    Parameters
    ----------
    checkpoint_path : str
        Local directory containing the downloaded model files (must include
        ``batch_utils/`` and ``config.json``).  Also accepted as an HF repo
        id when the model is cached via HuggingFace Hub.
    attn : str
        LLM attention backend: ``sdpa``, ``eager``, ``magi``, or ``la_flash``.
    """

    def __init__(self, checkpoint_path: str, attn: str = "sdpa") -> None:
        self._checkpoint_path = str(checkpoint_path)
        self._attn = attn

        os.environ["LA_FLASH_MODEL"] = self._checkpoint_path
        os.environ["LA_FLASH_ATTN"] = attn

        ckpt = Path(self._checkpoint_path)
        if ckpt.is_dir() and (ckpt / "batch_utils").is_dir():
            ckpt_str = str(ckpt)
            if ckpt_str not in sys.path:
                sys.path.insert(0, ckpt_str)

        from batch_utils import load  # type: ignore[import-untyped]

        load()

    def unload(self) -> None:
        """Evict the imported batch_utils module graph so model globals are freed."""
        unload_runtime_modules()

    def detect(self, image: Any, categories: list[str]) -> dict[str, Any]:
        """Run detection on a single PIL image for the given categories.

        Returns a dict with ``answer`` containing the raw model output text
        (box tokens in LocateAnything format).
        """
        from batch_utils import generate_batch_hybrid  # type: ignore[import-untyped]
        from batch_utils.hybrid_runtime import load as _load, MAX_DIM  # type: ignore[import-untyped]

        _load()

        w, h = image.size
        if max(w, h) > MAX_DIM:
            scale = MAX_DIM / max(w, h)
            image = image.resize(
                (max(1, round(w * scale)), max(1, round(h * scale))),
                image.resampling.LANCZOS if hasattr(image, 'resampling') else 1,
            )

        query = "</c>".join(categories)
        pairs = [(image, query)]
        texts = generate_batch_hybrid(
            pairs,
            temperature=0.7,
            top_p=0.9,
            top_k=0,
            repetition_penalty=1.1,
            max_new_tokens=2048,
        )
        answer = texts[0] if texts else ""
        return {"answer": answer}
