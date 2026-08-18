from __future__ import annotations

import io
import os
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import locate_anything_runtime as runtime_mod
from app import lifecycle
from app.config import Settings
from app.engine import LocateAnythingEngine
from app.main import create_app


# -- fake torch (same sys.modules monkeypatch technique as test_engine_unload) --


class _FakeCuda:
    def __init__(self) -> None:
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return True

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


class _FakeTorchOOM(RuntimeError):
    """Stands in for torch.cuda.OutOfMemoryError."""


def _install_fake_torch(monkeypatch: pytest.MonkeyPatch) -> _FakeCuda:
    torch_mod = types.ModuleType("torch")
    cuda = _FakeCuda()
    cuda.OutOfMemoryError = _FakeTorchOOM  # type: ignore[attr-defined]
    torch_mod.cuda = cuda  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch_mod)
    return cuda


# -- fake worker ----------------------------------------------------------


class _StubWorker:
    def __init__(self, checkpoint_path=None, attn: str = "sdpa", detect_error=None) -> None:
        self.checkpoint_path = checkpoint_path
        self.detect_error = detect_error
        self.detect_calls = 0
        self.unloaded = False

    def detect(self, image, categories):
        self.detect_calls += 1
        if self.detect_error is not None:
            raise self.detect_error
        return {"answer": ""}

    def unload(self) -> None:
        self.unloaded = True


def _install_fake_worker(
    monkeypatch: pytest.MonkeyPatch,
    *,
    construct_error: Exception | None = None,
    detect_error: Exception | None = None,
) -> list[_StubWorker]:
    created: list[_StubWorker] = []

    class _Worker(_StubWorker):
        def __init__(self, checkpoint_path=None, attn: str = "sdpa") -> None:
            if construct_error is not None:
                raise construct_error
            super().__init__(checkpoint_path, attn=attn, detect_error=detect_error)
            created.append(self)

    monkeypatch.setattr(runtime_mod, "LocateAnythingWorker", _Worker)
    return created


def _png_bytes() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(buf, format="PNG")
    return buf.getvalue()


def _make_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, eager: bool = False, checkpoint: Path | None = None):
    monkeypatch.delenv("LOCATE_API_TOKEN", raising=False)
    settings = Settings(
        eager_load=eager,
        checkpoint_path=str(checkpoint if checkpoint is not None else tmp_path / "ckpt"),
    )
    return create_app(settings)


# -- is_oom_error / cleanup_after_oom -------------------------------------


def test_is_oom_error_torch_oom_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_torch(monkeypatch)
    assert lifecycle.is_oom_error(_FakeTorchOOM("tried to allocate 2.00 GiB")) is True


def test_is_oom_error_string_fallback() -> None:
    assert lifecycle.is_oom_error(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")) is True
    assert lifecycle.is_oom_error(RuntimeError("cuda OOM during forward pass")) is True


def test_is_oom_error_regular_exception() -> None:
    assert lifecycle.is_oom_error(RuntimeError("boom")) is False
    assert lifecycle.is_oom_error(ValueError("invalid shape")) is False


def test_cleanup_after_oom_empties_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    cuda = _install_fake_torch(monkeypatch)
    lifecycle.cleanup_after_oom()
    assert cuda.empty_cache_calls == 1


# -- classify_load_error ----------------------------------------------------


def test_classify_load_error_categories() -> None:
    assert lifecycle.classify_load_error(RuntimeError("CUDA out of memory"))[0] == "cuda_oom"
    assert lifecycle.classify_load_error(FileNotFoundError("/models/LocateAnything-3B"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(RuntimeError("config.json not found"))[0] == "checkpoint_missing"
    assert lifecycle.classify_load_error(ModuleNotFoundError("No module named 'peft'"))[0] == "import_error"
    assert lifecycle.classify_load_error(ImportError("cannot import name 'x'"))[0] == "import_error"
    category, guidance = lifecycle.classify_load_error(ValueError("totally unexpected"))
    assert category == "other"
    assert guidance


# -- eager_load ---------------------------------------------------------------


def test_eager_load_raises_eager_load_failed(tmp_path: Path) -> None:
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path / "missing")))
    with pytest.raises(lifecycle.EagerLoadFailed) as ei:
        lifecycle.eager_load(engine, name="locate-anything")
    assert isinstance(ei.value.__cause__, FileNotFoundError)


# -- engine state machine ------------------------------------------------------


def test_load_failure_sets_load_failed_and_is_retryable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path / "missing")))
    assert engine.state == "not_loaded"

    with pytest.raises(FileNotFoundError):
        engine._ensure_loaded()
    assert engine.state == "load_failed"
    assert engine.loaded is False
    assert "checkpoint_missing" in (engine.load_error or "")

    # Retry after fixing the checkpoint: load_failed is not terminal.
    engine.settings = Settings(checkpoint_path=str(tmp_path))
    created = _install_fake_worker(monkeypatch)
    engine._ensure_loaded()
    assert engine.state == "loaded"
    assert engine.load_error is None
    assert engine.loaded is True
    assert len(created) == 1


def test_load_oom_cleans_up_and_marks_load_failed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cuda = _install_fake_torch(monkeypatch)
    _install_fake_worker(monkeypatch, construct_error=RuntimeError("CUDA out of memory"))
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path)))

    with pytest.raises(RuntimeError):
        engine._ensure_loaded()
    assert engine.state == "load_failed"
    assert "cuda_oom" in (engine.load_error or "")
    assert cuda.empty_cache_calls == 1


def test_unload_resets_state_after_failure() -> None:
    engine = LocateAnythingEngine(Settings(checkpoint_path="/irrelevant"))
    engine._state = "load_failed"
    engine._load_error = "[other] x"
    engine.unload()
    assert engine.state == "not_loaded"
    assert engine.load_error is None


def test_unload_after_load_sets_not_loaded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _install_fake_torch(monkeypatch)
    created = _install_fake_worker(monkeypatch)
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path)))
    engine._ensure_loaded()
    engine.unload()
    assert engine.state == "not_loaded"
    assert engine.loaded is False
    assert created[0].unloaded is True
    engine.unload()  # idempotent no-op


def test_verify_inference_failure_marks_load_failed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _install_fake_worker(monkeypatch, detect_error=RuntimeError("vit exploded"))
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path)))

    with pytest.raises(RuntimeError):
        engine.warmup()
    assert engine.state == "load_failed"
    assert "verify_inference failed" in (engine.load_error or "")
    assert engine.loaded is False  # worker dropped so retry does a clean reload


def test_verify_inference_oom_cleans_up(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cuda = _install_fake_torch(monkeypatch)
    _install_fake_worker(monkeypatch, detect_error=RuntimeError("CUDA out of memory"))
    engine = LocateAnythingEngine(Settings(checkpoint_path=str(tmp_path)))

    with pytest.raises(RuntimeError):
        engine.warmup()
    assert engine.state == "load_failed"
    assert "cuda_oom" in (engine.load_error or "")
    assert cuda.empty_cache_calls >= 1


# -- config ---------------------------------------------------------------------


def test_settings_eager_load_defaults_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOCATE_EAGER_LOAD", raising=False)
    monkeypatch.delenv("LOCATE_WARMUP_ON_START", raising=False)
    assert Settings().eager_load is True


def test_settings_eager_load_env_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCATE_EAGER_LOAD", "0")
    monkeypatch.setenv("LOCATE_WARMUP_ON_START", "true")
    assert Settings().eager_load is False  # new var wins over legacy

    monkeypatch.delenv("LOCATE_EAGER_LOAD")
    assert Settings().eager_load is True  # legacy fallback honored

    monkeypatch.setenv("LOCATE_WARMUP_ON_START", "false")
    assert Settings().eager_load is False

    monkeypatch.setenv("LOCATE_EAGER_LOAD", "1")
    assert Settings().eager_load is True


# -- HTTP layer -------------------------------------------------------------------


def test_health_maps_engine_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    app = _make_app(monkeypatch, tmp_path)
    engine = app.state.engine
    with TestClient(app) as client:
        body = client.get("/health").json()
        assert body["status"] == "not_loaded"
        assert body["mode"] == "lazy"
        assert body["model_loaded"] is False
        assert body["last_load_error"] is None
        # all pre-existing fields retained (model_loaded is consumed by web-auto)
        for key in ("device", "checkpoint_path", "attn_backend", "gpu"):
            assert key in body

        engine._state = "load_failed"
        engine._load_error = "[cuda_oom] boom"
        body = client.get("/health").json()
        assert body["status"] == "load_failed"
        assert body["last_load_error"] == "[cuda_oom] boom"

        engine._worker = _StubWorker()
        engine._state = "loaded"
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["model_loaded"] is True


def test_health_reports_eager_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(lifecycle, "eager_load", lambda engine, *, name: None)
    app = _make_app(monkeypatch, tmp_path, eager=True)
    with TestClient(app) as client:
        assert client.get("/health").json()["mode"] == "eager"


def test_startup_fail_fast_on_eager_load_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    exits: list[int] = []
    monkeypatch.setattr(os, "_exit", lambda code: exits.append(code))
    app = _make_app(monkeypatch, tmp_path, eager=True)  # checkpoint path missing
    with TestClient(app) as client:
        client.get("/health")
    assert exits == [1]
    assert app.state.engine.state == "load_failed"


def test_infer_oom_returns_507_and_cleans_up(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cuda = _install_fake_torch(monkeypatch)
    app = _make_app(monkeypatch, tmp_path)
    engine = app.state.engine
    engine._worker = _StubWorker(detect_error=RuntimeError("CUDA out of memory"))
    engine._state = "loaded"
    with TestClient(app) as client:
        resp = client.post(
            "/v1/infer",
            files={"file": ("img.png", _png_bytes(), "image/png")},
            data={"prompt": "object"},
        )
    assert resp.status_code == 507
    assert "out of memory" in resp.json()["detail"].lower()
    assert cuda.empty_cache_calls >= 1


def test_infer_load_failure_returns_503(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    app = _make_app(monkeypatch, tmp_path)  # checkpoint path missing
    engine = app.state.engine
    assert not Path(engine.settings.checkpoint_path).exists()
    with TestClient(app) as client:
        resp = client.post(
            "/v1/infer",
            files={"file": ("img.png", _png_bytes(), "image/png")},
            data={"prompt": "object"},
        )
    assert resp.status_code == 503
    assert "does not exist" in resp.json()["detail"]
    assert engine.state == "load_failed"


def test_warmup_failure_returns_503_with_category(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    app = _make_app(monkeypatch, tmp_path)  # checkpoint path missing
    with TestClient(app) as client:
        resp = client.post("/v1/warmup")
    assert resp.status_code == 503
    assert "checkpoint_missing" in resp.json()["detail"]


def test_warmup_oom_returns_507(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _install_fake_torch(monkeypatch)
    ckpt = tmp_path / "ckpt"
    ckpt.mkdir()
    app = _make_app(monkeypatch, tmp_path)
    app.state.engine.settings = Settings(checkpoint_path=str(ckpt))
    _install_fake_worker(monkeypatch, construct_error=RuntimeError("CUDA out of memory"))
    with TestClient(app) as client:
        resp = client.post("/v1/warmup")
    assert resp.status_code == 507
    assert "cuda_oom" in resp.json()["detail"]


def test_warmup_success_then_health_ok(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _install_fake_worker(monkeypatch)
    app = _make_app(monkeypatch, tmp_path, checkpoint=tmp_path)
    with TestClient(app) as client:
        assert client.post("/v1/warmup").json() == {"ok": True, "model_loaded": True}
        assert client.get("/health").json()["status"] == "ok"


def test_unload_endpoint_reports_status(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    app = _make_app(monkeypatch, tmp_path)
    with TestClient(app) as client:
        resp = client.post("/v1/unload")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "model_loaded": False, "status": "not_loaded"}
