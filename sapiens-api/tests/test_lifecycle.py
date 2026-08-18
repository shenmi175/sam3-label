"""Tests for the pure lifecycle helpers (no GPU, no real torch)."""

from __future__ import annotations

import sys
import types

import pytest

from app import lifecycle


def test_is_oom_error_matches_text_markers() -> None:
    assert lifecycle.is_oom_error(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"))
    assert lifecycle.is_oom_error(RuntimeError("cuda OOM while allocating"))
    assert lifecycle.is_oom_error(RuntimeError("cuda out of memory"))
    assert not lifecycle.is_oom_error(RuntimeError("checkpoint not found"))
    assert not lifecycle.is_oom_error(ValueError("image decode failed"))


def test_is_oom_error_matches_torch_exception_class(monkeypatch: pytest.MonkeyPatch) -> None:
    class OutOfMemoryError(RuntimeError):
        pass

    fake = types.ModuleType("torch")
    fake.cuda = types.SimpleNamespace(OutOfMemoryError=OutOfMemoryError)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake)

    assert lifecycle.is_oom_error(OutOfMemoryError("boom"))
    assert not lifecycle.is_oom_error(RuntimeError("boom"))


def test_cleanup_after_oom_calls_empty_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"empty_cache": 0}

    class _Cuda:
        def is_available(self) -> bool:
            return True

        def empty_cache(self) -> None:
            calls["empty_cache"] += 1

    fake = types.ModuleType("torch")
    fake.cuda = _Cuda()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake)

    lifecycle.cleanup_after_oom()
    assert calls["empty_cache"] == 1


def test_cleanup_after_oom_without_cuda_does_not_raise() -> None:
    lifecycle.cleanup_after_oom()  # fake torch from conftest: is_available() is False


def test_classify_load_error_categories() -> None:
    assert lifecycle.classify_load_error(RuntimeError("CUDA out of memory"))[0] == "cuda_oom"
    assert lifecycle.classify_load_error(FileNotFoundError("/models/x.safetensors"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(RuntimeError("checkpoint not found: /x"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(RuntimeError("No such file or directory"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(RuntimeError("path does not exist"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(ImportError("No module named 'x'"))[0] == "import_error"
    assert lifecycle.classify_load_error(ModuleNotFoundError("No module named 'y'"))[0] == "import_error"
    assert lifecycle.classify_load_error(RuntimeError("weird failure"))[0] == "other"


def test_classify_load_error_always_returns_guidance() -> None:
    for exc in (
        RuntimeError("CUDA out of memory"),
        FileNotFoundError("x"),
        ImportError("x"),
        RuntimeError("x"),
    ):
        _category, guidance = lifecycle.classify_load_error(exc)
        assert guidance


def test_eager_load_success_calls_warmup() -> None:
    class _Engine:
        def __init__(self) -> None:
            self.calls = 0

        def warmup(self) -> None:
            self.calls += 1

    eng = _Engine()
    lifecycle.eager_load(eng, name="segmentation")
    assert eng.calls == 1


def test_eager_load_failure_raises_eager_load_failed() -> None:
    class _Engine:
        def warmup(self) -> None:
            raise RuntimeError("CUDA out of memory")

    with pytest.raises(lifecycle.EagerLoadFailed) as excinfo:
        lifecycle.eager_load(_Engine(), name="pose")
    assert "cuda_oom" in str(excinfo.value)
    assert isinstance(excinfo.value, RuntimeError)
