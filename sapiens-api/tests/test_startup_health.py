"""Startup branches, merged /health status and engine lifecycle-state tests.

Engine load/verify and weight presence are monkeypatched; no GPU or real
weights are required.
"""

from __future__ import annotations

import sys
import types

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.engine import SapiensSegmentationEngine
from app.engine import engine as seg_engine
from app.main import app
from app.pose_engine import SapiensPoseEngine
from app.pose_engine import pose_engine


class _ExitCalled(Exception):
    def __init__(self, code: int) -> None:
        super().__init__(f"os._exit({code})")
        self.code = code


@pytest.fixture(autouse=True)
def _lazy_env(monkeypatch: pytest.MonkeyPatch):
    # Keep TestClient-triggered startup events inert unless a test opts in.
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "0")
    monkeypatch.delenv("SAPIENS_STRICT_EAGER_LOAD", raising=False)
    monkeypatch.delenv("SAPIENS_API_TOKEN", raising=False)


@pytest.fixture(autouse=True)
def _reset_engines():
    yield
    for eng in (seg_engine, pose_engine):
        eng._model = None
        eng._config = None
        eng._load_error = ""
        eng._state = "not_loaded"
        eng.weights_missing = False


def _mark_ready(monkeypatch: pytest.MonkeyPatch, *engines) -> None:
    for eng in engines:
        monkeypatch.setattr(eng, "weights_ready", lambda *a, **k: True)
        monkeypatch.setattr(eng, "repo_exists", lambda *a, **k: True)


def _set_engine(eng, state: str, *, weights_missing: bool = False, load_error: str = "") -> None:
    eng._state = state
    eng._model = object() if state == "loaded" else None
    eng.weights_missing = weights_missing
    eng._load_error = load_error


def _patch_os_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_exit(code: int) -> None:
        raise _ExitCalled(code)

    monkeypatch.setattr(main_mod.os, "_exit", _fake_exit)


# ---------------------------------------------------------------- startup


def test_startup_eager_disabled_is_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "0")
    warmed: list[str] = []
    monkeypatch.setattr(seg_engine, "warmup", lambda: warmed.append("seg"))
    monkeypatch.setattr(pose_engine, "warmup", lambda: warmed.append("pose"))

    main_mod.startup_eager_load()

    assert warmed == []
    assert seg_engine.state == "not_loaded"
    assert pose_engine.state == "not_loaded"


def test_startup_normal_warms_up_both_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "1")
    _mark_ready(monkeypatch, seg_engine, pose_engine)
    warmed: list[str] = []
    monkeypatch.setattr(seg_engine, "warmup", lambda: warmed.append("seg"))
    monkeypatch.setattr(pose_engine, "warmup", lambda: warmed.append("pose"))

    main_mod.startup_eager_load()

    assert warmed == ["seg", "pose"]
    assert seg_engine.weights_missing is False
    assert pose_engine.weights_missing is False


def test_startup_missing_weights_degrades_but_survives(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "1")
    monkeypatch.setattr(seg_engine, "weights_ready", lambda *a, **k: False)
    _mark_ready(monkeypatch, pose_engine)
    warmed: list[str] = []
    monkeypatch.setattr(seg_engine, "warmup", lambda: warmed.append("seg"))
    monkeypatch.setattr(pose_engine, "warmup", lambda: warmed.append("pose"))

    main_mod.startup_eager_load()

    # seg degraded, pose still warmed up independently
    assert warmed == ["pose"]
    assert seg_engine.weights_missing is True
    assert seg_engine.state == "not_loaded"
    assert pose_engine.weights_missing is False


def test_startup_missing_weights_strict_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "1")
    monkeypatch.setenv("SAPIENS_STRICT_EAGER_LOAD", "1")
    monkeypatch.setattr(seg_engine, "weights_ready", lambda *a, **k: False)
    _mark_ready(monkeypatch, pose_engine)
    monkeypatch.setattr(pose_engine, "warmup", lambda: None)
    _patch_os_exit(monkeypatch)

    with pytest.raises(_ExitCalled) as excinfo:
        main_mod.startup_eager_load()
    assert excinfo.value.code == 1


def test_startup_warmup_failure_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "1")
    _mark_ready(monkeypatch, seg_engine, pose_engine)

    def _boom() -> None:
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(seg_engine, "warmup", _boom)
    warmed: list[str] = []
    monkeypatch.setattr(pose_engine, "warmup", lambda: warmed.append("pose"))
    _patch_os_exit(monkeypatch)

    with pytest.raises(_ExitCalled) as excinfo:
        main_mod.startup_eager_load()
    assert excinfo.value.code == 1
    # seg failure is fatal before pose is even attempted
    assert warmed == []


# ---------------------------------------------------------------- /health


def test_health_merged_status_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    _mark_ready(monkeypatch, seg_engine, pose_engine)

    _set_engine(seg_engine, "loaded")
    _set_engine(pose_engine, "loaded")
    assert main_mod.health()["status"] == "ok"

    _set_engine(pose_engine, "not_loaded", weights_missing=True)
    assert main_mod.health()["status"] == "weights_missing"

    _set_engine(seg_engine, "load_failed", load_error="[cuda_oom] boom")
    payload = main_mod.health()
    assert payload["status"] == "load_failed"  # load_failed beats weights_missing
    assert "[cuda_oom] boom" in payload["last_load_error"]

    _set_engine(seg_engine, "not_loaded")
    _set_engine(pose_engine, "not_loaded")
    assert main_mod.health()["status"] == "not_loaded"


def test_health_missing_repo_folds_into_load_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seg_engine, "repo_exists", lambda *a, **k: False)
    _mark_ready(monkeypatch, pose_engine)
    _set_engine(seg_engine, "not_loaded")
    _set_engine(pose_engine, "loaded")

    payload = main_mod.health()

    assert payload["status"] == "load_failed"
    assert payload["repo_exists"] is False  # detail preserved, nothing lost
    # nested pose structure intact
    assert payload["pose"]["state"] == "loaded"
    assert payload["pose"]["model_loaded"] is True
    assert "status" in payload["pose"]


def test_health_keeps_existing_fields_and_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "1")
    _mark_ready(monkeypatch, seg_engine, pose_engine)
    _set_engine(seg_engine, "loaded")
    _set_engine(pose_engine, "loaded")

    payload = main_mod.health()

    assert payload["mode"] == "eager"
    assert payload["last_load_error"] == ""
    assert payload["status"] == "ok"
    # legacy fields preserved
    assert payload["service"] == "sapiens-api"
    assert payload["model_loaded"] is True
    assert "repo_exists" in payload and "checkpoint_exists" in payload
    assert payload["pose"]["model_loaded"] is True
    assert payload["pose"]["state"] == "loaded"
    assert "token_required" in payload and "allowed_data_roots" in payload

    monkeypatch.setenv("SAPIENS_EAGER_LOAD", "0")
    assert main_mod.health()["mode"] == "lazy"


def test_health_merges_load_errors_from_both_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    _mark_ready(monkeypatch, seg_engine, pose_engine)
    _set_engine(seg_engine, "load_failed", load_error="[cuda_oom] seg boom")
    _set_engine(pose_engine, "load_failed", load_error="[other] pose boom")

    assert main_mod.health()["last_load_error"] == "[cuda_oom] seg boom | [other] pose boom"


# ------------------------------------------------------- warmup/unload API


def test_warmup_endpoint_reports_weights_missing_not_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seg_engine, "weights_ready", lambda *a, **k: False)
    _mark_ready(monkeypatch, pose_engine)
    monkeypatch.setattr(pose_engine, "warmup", lambda: setattr(pose_engine, "_state", "loaded"))

    with TestClient(app) as client:
        resp = client.post("/v1/warmup")

    assert resp.status_code == 200
    body = resp.json()
    assert body["engines"]["segmentation"]["state"] == "weights_missing"
    assert "/v1/checkpoints/download" in body["engines"]["segmentation"]["hint"]
    assert body["engines"]["pose"]["state"] == "loaded"
    assert seg_engine.weights_missing is True


def test_warmup_endpoint_oom_returns_507(monkeypatch: pytest.MonkeyPatch) -> None:
    _mark_ready(monkeypatch, seg_engine, pose_engine)

    def _boom() -> None:
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(seg_engine, "warmup", _boom)
    monkeypatch.setattr(pose_engine, "warmup", lambda: None)

    with TestClient(app) as client:
        resp = client.post("/v1/warmup")

    assert resp.status_code == 507
    detail = resp.json()["detail"]
    assert detail["engines"]["segmentation"]["error_category"] == "cuda_oom"
    assert detail["engines"]["pose"]["error"] == ""


def test_unload_endpoint_resets_both_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_engine(seg_engine, "loaded")
    _set_engine(pose_engine, "loaded")

    with TestClient(app) as client:
        resp = client.post("/v1/unload")

    assert resp.status_code == 200
    body = resp.json()
    assert body["engines"]["segmentation"] == {"state": "not_loaded", "model_loaded": False}
    assert body["engines"]["pose"] == {"state": "not_loaded", "model_loaded": False}
    assert seg_engine.state == "not_loaded"
    assert pose_engine.state == "not_loaded"


def test_warmup_and_unload_require_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAPIENS_API_TOKEN", "secret-token")

    with TestClient(app) as client:
        assert client.post("/v1/warmup").status_code == 401
        assert client.post("/v1/unload").status_code == 401

        resp = client.post("/v1/unload", headers={"Authorization": "Bearer secret-token"})
        assert resp.status_code == 200
        # /health stays public
        assert client.get("/health").status_code == 200


# ------------------------------------------------------- engine state machine


def _fake_seg_env(monkeypatch: pytest.MonkeyPatch, tmp_path, init_error: Exception | None = None):
    """Create an on-disk seg repo/checkpoint layout plus a fake init_model."""
    repo_dir = tmp_path / "repo"
    ckpt_root = tmp_path / "models"
    cfg_dir = repo_dir / "sapiens" / "dense" / "configs" / "seg" / "shutterstock_goliath"
    cfg_dir.mkdir(parents=True)
    seg_dir = ckpt_root / "seg"
    seg_dir.mkdir(parents=True)
    for name, filename in (
        ("sapiens2_0.4b", "sapiens2_0.4b_seg.safetensors"),
        ("sapiens2_1b", "sapiens2_1b_seg.safetensors"),
    ):
        (cfg_dir / f"{name}_seg_shutterstock_goliath-1024x768.py").write_text("# fake config")
        (seg_dir / filename).write_bytes(b"weights")

    monkeypatch.setenv("SAPIENS_REPO_DIR", str(repo_dir))
    monkeypatch.setenv("SAPIENS_CHECKPOINT_ROOT", str(ckpt_root))

    eng = SapiensSegmentationEngine()
    build_time_model_refs: list = []

    class _FakeModel:
        def eval(self):
            return self

    def fake_init_model(config, checkpoint, device=None):
        build_time_model_refs.append(eng._model)
        if init_error is not None:
            raise init_error
        return _FakeModel()

    fake_models_mod = types.ModuleType("sapiens.dense.models")
    fake_models_mod.init_model = fake_init_model  # type: ignore[attr-defined]
    fake_sapiens = types.ModuleType("sapiens")
    fake_dense = types.ModuleType("sapiens.dense")
    fake_sapiens.dense = fake_dense  # type: ignore[attr-defined]
    fake_dense.models = fake_models_mod  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sapiens", fake_sapiens)
    monkeypatch.setitem(sys.modules, "sapiens.dense", fake_dense)
    monkeypatch.setitem(sys.modules, "sapiens.dense.models", fake_models_mod)

    return eng, build_time_model_refs


def test_seg_load_success_state_and_weights_ready(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    eng, _refs = _fake_seg_env(monkeypatch, tmp_path)
    assert eng.weights_ready("sapiens2_0.4b") is True

    model = eng.load("sapiens2_0.4b")

    assert model is not None
    assert eng.state == "loaded"
    assert eng.load_error == ""
    # same config -> cached, no rebuild
    assert eng.load("sapiens2_0.4b") is model


def test_seg_model_switch_releases_old_model_before_build(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    eng, refs = _fake_seg_env(monkeypatch, tmp_path)

    model_a = eng.load("sapiens2_0.4b")
    model_b = eng.load("sapiens2_1b")

    assert model_b is not model_a
    assert eng._model is model_b
    assert eng._config is not None and eng._config.model_name == "sapiens2_1b"
    # old model was released before the new one was built (both saw _model=None)
    assert refs == [None, None]


def test_seg_load_failure_classification(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    eng, _refs = _fake_seg_env(monkeypatch, tmp_path, init_error=RuntimeError("CUDA out of memory"))

    with pytest.raises(RuntimeError):
        eng.load("sapiens2_0.4b")

    assert eng.state == "load_failed"
    assert eng.load_error.startswith("[cuda_oom]")


def test_seg_load_missing_repo_marks_checkpoint_missing(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("SAPIENS_REPO_DIR", str(tmp_path / "missing-repo"))
    eng = SapiensSegmentationEngine()

    with pytest.raises(RuntimeError):
        eng.load()

    assert eng.state == "load_failed"
    assert eng.load_error.startswith("[checkpoint_missing]")


def test_seg_unload_is_idempotent_and_resets_state(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    eng, _refs = _fake_seg_env(monkeypatch, tmp_path)
    eng.load("sapiens2_0.4b")

    eng.unload()

    assert eng.state == "not_loaded"
    assert eng._model is None
    assert eng._config is None
    assert eng.load_error == ""
    eng.unload()  # idempotent no-op
    assert eng.state == "not_loaded"


def test_seg_warmup_verify_failure_marks_load_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    eng = SapiensSegmentationEngine()
    monkeypatch.setattr(eng, "load", lambda model_name=None: object())

    def _bad_verify() -> None:
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(eng, "verify_inference", _bad_verify)

    with pytest.raises(RuntimeError):
        eng.warmup()

    assert eng.state == "load_failed"
    assert eng.load_error.startswith("[cuda_oom]")


def test_pose_unload_releases_model_and_detector() -> None:
    eng = SapiensPoseEngine()
    eng._model = object()
    eng._detector_model = object()
    eng._detector_processor = object()
    eng._state = "loaded"

    eng.unload()

    assert eng.state == "not_loaded"
    assert eng._model is None
    assert eng._detector_model is None
    assert eng._detector_processor is None
    assert eng._config is None
    eng.unload()  # idempotent no-op


def test_pose_load_missing_repo_marks_checkpoint_missing(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("SAPIENS_REPO_DIR", str(tmp_path / "missing-repo"))
    eng = SapiensPoseEngine()

    with pytest.raises(RuntimeError):
        eng.load()

    assert eng.state == "load_failed"
    assert eng.load_error.startswith("[checkpoint_missing]")
    assert eng.weights_ready() is False
