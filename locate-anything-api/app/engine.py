from __future__ import annotations

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
        return {
            "device_index": int(idx),
            "name": torch.cuda.get_device_name(idx),
            "total_mb": round(total / 1024 / 1024, 1),
            "free_mb": round(free / 1024 / 1024, 1),
            "used_mb": round((total - free) / 1024 / 1024, 1),
        }
    except Exception:
        return None


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

    # -- lifecycle -----------------------------------------------------
    @property
    def loaded(self) -> bool:
        return self._worker is not None

    def warmup(self) -> None:
        self._ensure_loaded()

    def unload(self) -> None:
        if self._worker is None:
            return
        try:
            import torch  # type: ignore

            del self._worker
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        self._worker = None

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
        threshold: float,
        include_mask_png: bool,  # accepted, always ignored (no mask produced)
        max_detections: int,
        score_default: float,
    ) -> dict[str, Any]:
        del include_mask_png  # bbox-only backend; mask flag has no effect

        worker = self._ensure_loaded()
        categories = _split_categories(prompt)
        if not categories:
            raise ValueError("prompt must contain at least one category")

        started = time.perf_counter()
        raw = worker.detect(image.pil, categories)
        answer = raw.get("answer", "") if isinstance(raw, dict) else str(raw)

        parsed = _parse_answer(answer, width=image.width, height=image.height)
        detections = _build_detections(
            parsed=parsed,
            categories=categories,
            max_detections=max_detections,
            score_default=float(score_default),
        )

        return {
            "model": "locate-anything-3b",
            "device": str(self.settings.device),
            "mode": "text",
            "prompt": prompt,
            "threshold": float(threshold),
            "image": {"width": image.width, "height": image.height},
            "num_detections": len(detections),
            "detections": detections,
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 2),
        }


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

    The worker groups outputs in fixed-length blocks whose first token is
    ``<c>CATEGORY</c>``. We extract per-box categories when present;
    otherwise the caller assigns the first requested category.
    """

    import re

    out: list[dict[str, Any]] = []
    # Split into <c>…</c> blocks. The text between two <c> tags is the
    # category for all boxes that follow until the next <c> tag.
    cat_re = re.compile(r"<c>([^<]*)</c>")
    cursor = 0
    current_category = ""
    for match in cat_re.finditer(answer):
        # Consume boxes between the previous cursor and this <c> tag and
        # assign them to the previous category.
        segment = answer[cursor : match.start()]
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
        current_category = match.group(1).strip()
        cursor = match.end()

    # Trailing boxes after the last </c>.
    tail = answer[cursor:]
    for bm in _BOX_TOKEN_RE.finditer(tail):
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
    return out


def _build_detections(
    *,
    parsed: list[dict[str, Any]],
    categories: list[str],
    max_detections: int,
    score_default: float,
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
                "score": float(score_default),
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
