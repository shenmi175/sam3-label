"""Unified model-lifecycle helpers.

This module is intentionally duplicated verbatim in sam3-api, locate-anything-api
and sapiens-api (no shared packaging exists between the images). The contract
must stay identical across the three copies:

- ``is_oom_error(exc)``           -> bool
- ``cleanup_after_oom()``         -> gc.collect() + torch.cuda.empty_cache()
- ``classify_load_error(exc)``    -> (category, guidance) with categories
                                     cuda_oom | checkpoint_missing | import_error | other
- ``EagerLoadFailed``             -> raised by ``eager_load`` on startup failure
- ``eager_load(engine, name=...)``-> engine.warmup() or raise EagerLoadFailed
"""

from __future__ import annotations

import gc
import logging

logger = logging.getLogger(__name__)

_OOM_TEXT_MARKERS = ("out of memory", "cuda oom", "cuda out of memory")


class EagerLoadFailed(RuntimeError):
    """Startup eager load (load + verification) failed; the process should exit."""


def is_oom_error(exc: BaseException) -> bool:
    try:
        import torch

        oom_cls = getattr(torch.cuda, "OutOfMemoryError", None)
        if oom_cls is not None and isinstance(exc, oom_cls):
            return True
    except Exception:
        pass
    text = str(exc).lower()
    return any(marker in text for marker in _OOM_TEXT_MARKERS)


def cleanup_after_oom() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        logger.debug("torch.cuda.empty_cache unavailable; skipped", exc_info=True)


def classify_load_error(exc: BaseException) -> tuple[str, str]:
    """Return (category, operational guidance) for a load/verify failure."""
    if is_oom_error(exc):
        return (
            "cuda_oom",
            "显存不足：检查 docker-compose.gpu.yml 的 device_ids 分配；"
            "若多服务共用同一张卡，请保留一个服务 *_EAGER_LOAD=0，"
            "用 /v1/warmup + /v1/unload 轮换加载",
        )
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return "import_error", "依赖或导入失败：检查服务镜像与 external 子模块是否完整"
    text = str(exc).lower()
    if (
        isinstance(exc, FileNotFoundError)
        or "not found" in text
        or "no such file" in text
        or "does not exist" in text
    ):
        return "checkpoint_missing", "模型权重缺失：检查挂载卷与权重路径，或先触发权重下载"
    return "other", "请查看上方堆栈日志定位具体原因"


def eager_load(engine, *, name: str) -> None:
    """Run ``engine.warmup()`` (load + verification); raise EagerLoadFailed on failure."""
    try:
        engine.warmup()
    except Exception as exc:
        category, guidance = classify_load_error(exc)
        detail = str(exc) or f"{type(exc).__name__} (no message)"
        logger.error(
            "FATAL: %s eager load failed (%s): %s — %s", name, category, detail, guidance
        )
        raise EagerLoadFailed(f"{name} eager load failed ({category}): {detail}") from exc
