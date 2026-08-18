"""Endpoint-level tests for the unified lifecycle API.

Gated on ultralytics (required to import app.video_semantic_engine / app.main);
skipped on machines without it, which is not treated as a failure.
"""

from __future__ import annotations

import os

import pytest

pytest.importorskip("ultralytics")

os.environ["SAM3_API_EAGER_LOAD"] = "0"  # lazy mode: TestClient startup must not load models
os.environ.setdefault("SAM3_API_DEVICE", "cpu")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


@pytest.fixture()
def client():
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def test_health_reports_lazy_not_loaded(client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "not_loaded"
    assert body["mode"] == "lazy"
    assert body["model_loaded"] is False
    assert body["semantic_model_loaded"] is False
    assert body["video_model_loaded"] is False
    assert body["last_load_error"] is None
    assert body["video_last_load_error"] is None
    # Existing web-auto-facing fields stay present.
    assert body["sam3_pin_sha"]
    assert "device" in body and "checkpoint_path" in body


def test_health_reports_load_failed_status(client) -> None:
    engine = client.app.state.engine
    engine._state = "load_failed"
    engine._load_error = "cuda_oom: fake failure"
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "load_failed"
    assert body["last_load_error"] == "cuda_oom: fake failure"


def test_unload_endpoint_reports_both_engines(client) -> None:
    resp = client.post("/v1/unload")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "model_loaded": False, "video_model_loaded": False}


def test_unload_resets_loaded_engine(client) -> None:
    engine = client.app.state.engine
    video_engine = client.app.state.video_engine
    engine._loaded = True
    engine._state = "loaded"
    engine._model = object()
    video_engine._loaded = True
    video_engine._state = "loaded"
    video_engine._predictor = object()

    resp = client.post("/v1/unload")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "model_loaded": False, "video_model_loaded": False}
    assert engine.state == "not_loaded"
    assert engine._model is None
    assert video_engine.state == "not_loaded"
    assert video_engine._predictor is None

    # /health back to not_loaded but still HTTP 200.
    body = client.get("/health").json()
    assert body["status"] == "not_loaded"
