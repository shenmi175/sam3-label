from __future__ import annotations

import sys
import types

import pytest

import locate_anything_runtime as runtime_mod
from app.config import Settings
from app.engine import LocateAnythingEngine, _Image


class _FakeCuda:
    def __init__(self, free: int, total: int) -> None:
        self.free = free
        self.total = total
        self.allocated = 100 * 1024 * 1024
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return True

    def current_device(self) -> int:
        return 0

    def mem_get_info(self, idx: int | None = None) -> tuple[int, int]:
        return self.free, self.total

    def memory_allocated(self, idx: int | None = None) -> int:
        return self.allocated

    def memory_reserved(self, idx: int | None = None) -> int:
        return self.allocated * 2

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


def _install_fake_torch(monkeypatch: pytest.MonkeyPatch, free: int, total: int) -> _FakeCuda:
    torch_mod = types.ModuleType("torch")
    cuda = _FakeCuda(free, total)
    torch_mod.cuda = cuda  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch_mod)
    return cuda


class _FakeWorker:
    def __init__(self, answer: str = "", error: Exception | None = None) -> None:
        self._answer = answer
        self._error = error
        self.unloaded = False

    def unload(self) -> None:
        self.unloaded = True
        runtime_mod.unload_runtime_modules()

    def detect(self, image, categories: list[str]) -> dict:
        if self._error is not None:
            raise self._error
        return {"answer": self._answer}


def _engine(**overrides) -> LocateAnythingEngine:
    return LocateAnythingEngine(Settings(**overrides))


def _image() -> _Image:
    return _Image(pil=None, width=10, height=10)


def test_unload_runtime_modules_evicts_batch_utils(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "batch_utils", types.ModuleType("batch_utils"))
    monkeypatch.setitem(
        sys.modules, "batch_utils.hybrid_runtime", types.ModuleType("batch_utils.hybrid_runtime")
    )
    runtime_mod.unload_runtime_modules()
    assert "batch_utils" not in sys.modules
    assert "batch_utils.hybrid_runtime" not in sys.modules


def test_engine_unload_clears_worker_and_modules(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_torch(monkeypatch, free=10 << 30, total=24 << 30)
    monkeypatch.setitem(sys.modules, "batch_utils", types.ModuleType("batch_utils"))

    worker = _FakeWorker()
    engine = _engine()
    engine._worker = worker

    engine.unload()

    assert engine.loaded is False
    assert worker.unloaded is True
    assert "batch_utils" not in sys.modules
    engine.unload()  # idempotent no-op


def test_infer_error_path_cleans_up_and_cuts_traceback(monkeypatch: pytest.MonkeyPatch) -> None:
    cuda = _install_fake_torch(monkeypatch, free=10 << 30, total=24 << 30)
    engine = _engine()
    engine._worker = _FakeWorker(error=RuntimeError("CUDA out of memory"))

    with pytest.raises(RuntimeError) as ei:
        engine.infer(image=_image(), prompt="cat", include_mask_png=False, max_detections=10)

    assert ei.value.__cause__ is None
    assert "CUDA out of memory" in str(ei.value)
    assert cuda.empty_cache_calls == 1


def test_cache_clearing_is_threshold_gated(monkeypatch: pytest.MonkeyPatch) -> None:
    total = 1 << 40
    cuda = _install_fake_torch(monkeypatch, free=total // 2, total=total)  # 50% used
    engine = _engine(clear_cache_threshold=80, attn_cache_reset_every=0)

    engine._empty_cache_if_under_pressure()
    assert cuda.empty_cache_calls == 0

    cuda.free = total // 10  # 90% used
    engine._empty_cache_if_under_pressure()
    assert cuda.empty_cache_calls == 1


def test_attention_plan_cache_reset_nulls_classes(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = types.ModuleType("batch_utils.hybrid_runtime")
    runtime._LaFlashCls = object()  # type: ignore[attr-defined]
    runtime._MagiCls = object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "batch_utils.hybrid_runtime", runtime)

    engine = _engine(clear_cache_threshold=0, attn_cache_reset_every=2)
    engine._worker = _FakeWorker(answer="")

    engine.infer(image=_image(), prompt="cat", include_mask_png=False, max_detections=1)
    assert runtime._LaFlashCls is not None  # count=1, not due yet

    engine.infer(image=_image(), prompt="cat", include_mask_png=False, max_detections=1)
    assert runtime._LaFlashCls is None
    assert runtime._MagiCls is None
