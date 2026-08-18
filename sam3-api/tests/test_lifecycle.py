"""Pure-function tests for app/lifecycle.py (fake-torch + string fallback + classification)."""

from __future__ import annotations

import sys
import types

import pytest

from app import lifecycle


class _FakeTorchOOM(RuntimeError):
    pass


def _fake_torch_module(*, available: bool = True) -> types.ModuleType:
    mod = types.ModuleType("torch")
    calls: list[str] = []

    cuda = types.SimpleNamespace(
        OutOfMemoryError=_FakeTorchOOM,
        is_available=lambda: available,
        empty_cache=lambda: calls.append("empty_cache"),
    )
    mod.cuda = cuda  # type: ignore[attr-defined]
    mod._empty_cache_calls = calls  # type: ignore[attr-defined]
    return mod


def test_is_oom_by_exception_type(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _fake_torch_module()
    monkeypatch.setitem(sys.modules, "torch", fake)
    # No OOM marker text at all; the type alone must classify as OOM.
    assert lifecycle.is_oom_error(_FakeTorchOOM("some allocation failure")) is True


def test_is_oom_string_fallback() -> None:
    assert lifecycle.is_oom_error(RuntimeError("CUDA error: out of memory. Tried to allocate 2 GiB"))
    assert lifecycle.is_oom_error(RuntimeError("CUDA OOM while loading"))
    assert lifecycle.is_oom_error(RuntimeError("CUDA out of memory"))
    assert lifecycle.is_oom_error(RuntimeError("CUDA out of memory")) is True
    assert lifecycle.is_oom_error(RuntimeError("weight file corrupted")) is False


def test_is_oom_without_torch_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    # Even if `import torch` succeeds with a real module, the string fallback must hold.
    assert lifecycle.is_oom_error(RuntimeError("CUDA out of memory")) is True


def test_cleanup_after_oom_empties_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _fake_torch_module(available=True)
    monkeypatch.setitem(sys.modules, "torch", fake)
    lifecycle.cleanup_after_oom()
    assert fake._empty_cache_calls == ["empty_cache"]


def test_cleanup_after_oom_without_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch_module(available=False))
    lifecycle.cleanup_after_oom()  # must not raise


def test_classify_load_error_categories(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch_module())

    category, guidance = lifecycle.classify_load_error(RuntimeError("CUDA out of memory"))
    assert category == "cuda_oom"
    assert guidance

    category, guidance = lifecycle.classify_load_error(ModuleNotFoundError("No module named 'sam3'"))
    assert category == "import_error"
    assert guidance

    category, guidance = lifecycle.classify_load_error(FileNotFoundError("/models/sam3.pt"))
    assert category == "checkpoint_missing"
    assert guidance

    category, guidance = lifecycle.classify_load_error(RuntimeError("checkpoint not found at /x"))
    assert category == "checkpoint_missing"

    category, guidance = lifecycle.classify_load_error(RuntimeError("something unexpected"))
    assert category == "other"
    assert guidance


class _StubEngine:
    def __init__(self, error: Exception | None = None) -> None:
        self._error = error
        self.warmup_calls = 0

    def warmup(self) -> None:
        self.warmup_calls += 1
        if self._error is not None:
            raise self._error


def test_eager_load_success() -> None:
    engine = _StubEngine()
    lifecycle.eager_load(engine, name="test engine")
    assert engine.warmup_calls == 1


def test_eager_load_failure_raises_with_category(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch_module())
    engine = _StubEngine(RuntimeError("CUDA out of memory"))
    with pytest.raises(lifecycle.EagerLoadFailed) as exc_info:
        lifecycle.eager_load(engine, name="test engine")
    assert "cuda_oom" in str(exc_info.value)
    assert isinstance(exc_info.value.__cause__, RuntimeError)
