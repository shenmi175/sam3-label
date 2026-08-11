from __future__ import annotations

import gc
import io
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger("locate_anything.engine")

_BOX_TOKEN_RE = re.compile(r"<box><(\d+)><(\d+)><(\d+)><(\d+)></box>")


@dataclass
class _Image:
    """PIL.Image-like wrapper kept tiny so schemas/engine don't import PIL at module load."""

    pil: Any
    width: int
    height: int


def load_image_from_bytes(raw: bytes) -> _Image:
    from PIL import Image  # local import: optional dep at startup

    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    return _Image(pil=pil, width=pil.width, height=pil.height)


def gpu_status_snapshot() -> dict[str, Any] | None:
    """Best-effort NVIDIA GPU snapshot; returns None when unavailable."""

    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return None
        idx = torch.cuda.current_device()
        free, total = torch.cuda.mem_get_info(idx)
        snapshot = {
            "device_index": int(idx),
            "name": torch.cuda.get_device_name(idx),
            "total_mb": round(total / 1024 / 1024, 1),
            "free_mb": round(free / 1024 / 1024, 1),
            "used_mb": round((total - free) / 1024 / 1024, 1),
        }
        try:
            snapshot["allocated_mb"] = round(torch.cuda.memory_allocated(idx) / 1024 / 1024, 1)
            snapshot["reserved_mb"] = round(torch.cuda.memory_reserved(idx) / 1024 / 1024, 1)
        except Exception:  # noqa: BLE001
            pass
        return snapshot
    except Exception:
        return None


def _cuda_allocated_mb() -> float | None:
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return None
        return torch.cuda.memory_allocated(torch.cuda.current_device()) / 1024 / 1024
    except Exception:  # noqa: BLE001
        return None


def _cuda_empty_cache() -> None:
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


class LocateAnythingEngine:
    """Thin wrapper around ``LocateAnythingWorker`` (HF model card reference impl).

    The wrapper is intentionally lazy: importing the underlying model pulls
    in ``transformers >= 4.57``, ``peft``, ``decord`` and ``lmdb``. Services
    that only need the HTTP skeleton (health/warmup responses, schema
    validation) must not crash when those deps are absent.
    """

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self._worker: Any | None = None
        self._load_error: str | None = None
        self._infer_count = 0

    # -- lifecycle -----------------------------------------------------
    @property
    def loaded(self) -> bool:
        return self._worker is not None

    def warmup(self) -> None:
        self._ensure_loaded()

    def unload(self) -> None:
        if self._worker is None:
            return
        worker, self._worker = self._worker, None
        allocated_before = _cuda_allocated_mb()
        try:
            worker.unload()
        except Exception:  # noqa: BLE001
            logger.exception("locate runtime module unload failed; continuing cleanup")
        del worker
        gc.collect()
        _cuda_empty_cache()
        freed_mb = (allocated_before - _cuda_allocated_mb()) if allocated_before is not None else None
        if freed_mb is not None:
            logger.info("locate-anything unloaded; freed ~%.0f MiB of allocated VRAM", freed_mb)
        else:
            logger.info("locate-anything unloaded")

    def _ensure_loaded(self) -> Any:
        if self._worker is not None:
            return self._worker
        try:
            from locate_anything_runtime import LocateAnythingWorker  # type: ignore
        except Exception as exc:  # pragma: no cover - optional runtime
            self._load_error = f"LocateAnything runtime unavailable: {exc}"
            logger.warning("locate-anything runtime not loadable: %s", exc)
            raise RuntimeError(self._load_error) from exc

        logger.info(
            "loading LocateAnything checkpoint=%s attn=%s",
            self.settings.checkpoint_path,
            self.settings.attn_backend,
        )
        self._worker = LocateAnythingWorker(
            self.settings.checkpoint_path,
            attn=self.settings.attn_backend,
        )
        return self._worker

    # -- inference -----------------------------------------------------
    def infer(
        self,
        *,
        image: _Image,
        prompt: str,
        include_mask_png: bool,  # accepted, always ignored (no mask produced)
        max_detections: int,
    ) -> dict[str, Any]:
        del include_mask_png  # bbox-only backend; mask flag has no effect

        worker = self._ensure_loaded()
        categories = _split_categories(prompt)
        if not categories:
            raise ValueError("prompt must contain at least one category")

        started = time.perf_counter()
        try:
            raw = worker.detect(image.pil, categories)
        except Exception as exc:
            logger.exception("locate inference failed")
            # Traceback frames hold KV/vit tensors; drop refs before re-raising.
            gc.collect()
            _cuda_empty_cache()
            raise RuntimeError(f"locate inference failed: {exc}") from None
        answer = raw.get("answer", "") if isinstance(raw, dict) else str(raw)

        parsed = _parse_answer(answer, width=image.width, height=image.height)
        detections = _build_detections(
            parsed=parsed,
            categories=categories,
            max_detections=max_detections,
        )

        self._maintain_cuda_cache()

        return {
            "model": "locate-anything-3b",
            "device": str(self.settings.device),
            "mode": "text",
            "prompt": prompt,
            "image": {"width": image.width, "height": image.height},
            "num_detections": len(detections),
            "detections": detections,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 2),
        }

    def _maintain_cuda_cache(self) -> None:
        self._infer_count += 1
        self._reset_attention_plan_cache_if_due()
        self._empty_cache_if_under_pressure()

    def _empty_cache_if_under_pressure(self) -> None:
        """gc+empty_cache only when device usage reaches the threshold.

        Mirrors external/sam3 Sam3BasePredictor._should_empty_cache: a
        per-request full-stream sync would stall throughput, so the caching
        allocator reuses free blocks until the device is actually under pressure.
        """
        threshold = int(getattr(self.settings, "clear_cache_threshold", 80))
        if threshold <= 0:
            return
        try:
            import torch  # type: ignore

            if not torch.cuda.is_available():
                return
            free, total = torch.cuda.mem_get_info(torch.cuda.current_device())
        except Exception:  # noqa: BLE001
            return
        if total <= 0:
            return
        used_pct = (total - free) / total * 100.0
        if used_pct < threshold:
            return
        logger.info("device VRAM usage %.1f%% >= %d%%; clearing CUDA cache", used_pct, threshold)
        gc.collect()
        _cuda_empty_cache()

    def _reset_attention_plan_cache_if_due(self) -> None:
        """Drop the unbounded causal_plan_cache closures in hybrid_runtime.

        Nulling the cached attention classes forces _set_llm_mode to rebuild
        them on the next inference, discarding the per-shape plan caches
        (CUDA tensors keyed by kv_seq_len) they close over.
        """
        every = int(getattr(self.settings, "attn_cache_reset_every", 0))
        if every <= 0 or self._infer_count % every:
            return
        try:
            import sys

            runtime = sys.modules.get("batch_utils.hybrid_runtime")
            if runtime is None:
                return
            for attr in ("_LaFlashCls", "_MagiCls"):
                if hasattr(runtime, attr):
                    setattr(runtime, attr, None)
        except Exception:  # noqa: BLE001
            pass


# -- answer parsing ----------------------------------------------------
_SEP = "</c>"


def _split_categories(prompt: str) -> list[str]:
    """Accept both comma-separated (web-auto convention) and ``</c>``-separated
    (LocateAnything model convention) prompts."""

    if not prompt:
        return []
    if _SEP in prompt:
        parts = prompt.split(_SEP)
    else:
        parts = prompt.split(",")
    return [p.strip() for p in parts if p and p.strip()]


_BOX_TOKEN_RE = __import__("re").compile(
    r"<box><(\d+)><(\d+)><(\d+)><(\d+)></box>"
)


def _parse_answer(answer: str, *, width: int, height: int) -> list[dict[str, Any]]:
    """Parse LocateAnything answer text into pixel-coordinate bboxes.

    The model outputs ``<ref>CATEGORY</ref><box>…</box>`` blocks (some
    versions use ``<c>CATEGORY</c>``).  We match both tag styles and
    assign each box to the most recent preceding category tag.
    """

    import re

    out: list[dict[str, Any]] = []
    cat_re = re.compile(r"<(?:c|ref)>([^<]*)</(?:c|ref)>")
    matches = list(cat_re.finditer(answer))

    for i, match in enumerate(matches):
        current_category = match.group(1).strip()
        seg_start = match.end()
        seg_end = matches[i + 1].start() if i + 1 < len(matches) else len(answer)
        segment = answer[seg_start:seg_end]
        for bm in _BOX_TOKEN_RE.finditer(segment):
            x1, y1, x2, y2 = (int(g) for g in bm.groups())
            out.append(
                {
                    "category": current_category,
                    "xyxy": (
                        x1 / 1000.0 * width,
                        y1 / 1000.0 * height,
                        x2 / 1000.0 * width,
                        y2 / 1000.0 * height,
                    ),
                }
            )

    # Boxes before the first category tag (shouldn't happen normally).
    if matches:
        leading = answer[: matches[0].start()]
        default_label = ""
        for bm in _BOX_TOKEN_RE.finditer(leading):
            x1, y1, x2, y2 = (int(g) for g in bm.groups())
            out.insert(
                0,
                {
                    "category": default_label,
                    "xyxy": (
                        x1 / 1000.0 * width,
                        y1 / 1000.0 * height,
                        x2 / 1000.0 * width,
                        y2 / 1000.0 * height,
                    ),
                },
            )
    else:
        for bm in _BOX_TOKEN_RE.finditer(answer):
            x1, y1, x2, y2 = (int(g) for g in bm.groups())
            out.append(
                {
                    "category": "",
                    "xyxy": (
                        x1 / 1000.0 * width,
                        y1 / 1000.0 * height,
                        x2 / 1000.0 * width,
                        y2 / 1000.0 * height,
                    ),
                }
            )
    return out


def _build_detections(
    *,
    parsed: list[dict[str, Any]],
    categories: list[str],
    max_detections: int,
) -> list[dict[str, Any]]:
    """Emit DetectionOut-compatible dicts. Label is forced to the user's first
    requested category when the model did not emit one — this matches the
    web-auto convention (decision D2)."""

    default_label = categories[0] if categories else "object"
    out: list[dict[str, Any]] = []
    for i, item in enumerate(parsed, start=1):
        x1, y1, x2, y2 = item["xyxy"]
        if x2 <= x1 or y2 <= y1:
            continue
        label = item.get("category") or default_label
        xyxy = [float(x1), float(y1), float(x2), float(y2)]
        out.append(
            {
                "id": f"la_{i:04d}",
                "label": label,
                "bbox_xyxy": xyxy,
                "bbox_xywh": [xyxy[0], xyxy[1], xyxy[2] - xyxy[0], xyxy[3] - xyxy[1]],
                "polygon": None,
                "area": int((xyxy[2] - xyxy[0]) * (xyxy[3] - xyxy[1])),
                "mask_png_base64": None,
                "model_det_id": f"la_{i:04d}",
            }
        )
        if len(out) >= max_detections:
            break
    return out
