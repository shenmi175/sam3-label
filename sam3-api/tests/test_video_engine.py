"""Lifecycle tests for Sam3VideoSemanticSessionEngine.

Gated on ultralytics (module-level import in app.video_semantic_engine);
skipped on machines without it, which is not treated as a failure.
"""

from __future__ import annotations

import pytest

pytest.importorskip("ultralytics")

from app.video_semantic_engine import Sam3VideoSemanticSessionEngine  # noqa: E402

from test_engine_lifecycle import make_settings  # noqa: E402


def test_initial_state_is_not_loaded(tmp_path) -> None:
    engine = Sam3VideoSemanticSessionEngine(make_settings(tmp_path))
    assert engine.state == "not_loaded"
    assert engine.loaded is False
    assert engine.load_error is None


def test_missing_checkpoint_marks_load_failed(tmp_path) -> None:
    engine = Sam3VideoSemanticSessionEngine(make_settings(tmp_path, checkpoint_exists=False))
    with pytest.raises(RuntimeError, match="checkpoint not found"):
        engine.warmup()
    assert engine.state == "load_failed"
    assert engine.load_error is not None
    assert engine.load_error.startswith("checkpoint_missing:")
    assert engine._predictor is None


def test_unload_is_idempotent_and_clears_sessions(tmp_path) -> None:
    engine = Sam3VideoSemanticSessionEngine(make_settings(tmp_path))
    engine._loaded = True
    engine._state = "loaded"
    engine._predictor = object()
    engine._sessions = {"s1": {"resource_path": "/tmp/x.mp4"}}
    engine._session_cleanup_paths = {"s1": tmp_path / "x.mp4"}

    engine.unload()
    assert engine.state == "not_loaded"
    assert engine.loaded is False
    assert engine._predictor is None
    assert engine._sessions == {}
    assert engine._session_cleanup_paths == {}

    engine.unload()  # idempotent no-op
    assert engine.state == "not_loaded"
