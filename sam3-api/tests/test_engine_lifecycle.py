"""Engine-level lifecycle tests for Sam3InferenceEngine (state machine, OOM, unload).

Uses the fake torch installed by conftest.py; tests that depend on fake CUDA
counters are skipped automatically when a real torch is present.
"""

from __future__ import annotations

import types

import pytest

import app.sam3_compat as sam3_compat
from app.config import Settings
from app.engine import Sam3InferenceEngine


def make_settings(tmp_path, *, device: str = "cpu", checkpoint_exists: bool = True) -> Settings:
    checkpoint = tmp_path / "sam3_checkpoints" / "sam3.pt"
    if checkpoint_exists:
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.write_bytes(b"fake-checkpoint")
    return Settings(
        api_title="test",
        api_version="0.0.0",
        project_root=tmp_path,
        checkpoint_path=checkpoint,
        device=device,
        load_from_hf=False,
        compile_model=False,
        default_threshold=0.5,
        eager_load=False,
        cors_origins=["*"],
        max_batch_files=4,
        max_image_bytes=1024 * 1024,
        video_upload_dir=tmp_path / "uploads",
        max_video_bytes=1024 * 1024,
        video_force_fp32_inputs=False,
        video_disable_bf16_context=False,
        video_force_backbone_fpn_fp32=False,
        video_enable_tracker_bf16_autocast=False,
        video_force_tracker_state_fp32=False,
        video_apply_temporal_disambiguation=False,
        expected_ckpt_generation="v1",
    )


class FakeProcessor:
    def __init__(self, model, resolution=None, device=None, confidence_threshold=None):
        self.model = model
        self.resolution = resolution
        self.device = device
        self.confidence_threshold = confidence_threshold
        self.find_stage = types.SimpleNamespace()

    def set_confidence_threshold(self, value: float) -> None:
        self.confidence_threshold = float(value)


def fake_surface() -> dict:
    return {
        "Sam3Processor": FakeProcessor,
        "build_sam3_image_model": lambda **kwargs: types.SimpleNamespace(tag="fake-model"),
        "PostProcessImage": object,
        "BatchedDatapoint": object,
        "BatchedFindTarget": object,
        "BatchedInferenceMetadata": object,
        "FindStage": object,
        "convert_my_tensors": lambda obj: obj,
        "copy_data_to_device": lambda *args, **kwargs: args[0] if args else None,
    }


def test_initial_state_is_not_loaded(tmp_path) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    assert engine.state == "not_loaded"
    assert engine.loaded is False
    assert engine.load_error is None


def test_missing_checkpoint_marks_load_failed_with_classification(tmp_path) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path, checkpoint_exists=False))
    with pytest.raises(RuntimeError, match="checkpoint not found"):
        engine.warmup()
    assert engine.state == "load_failed"
    assert engine.loaded is False
    assert engine.load_error is not None
    assert engine.load_error.startswith("checkpoint_missing:")
    assert engine._model is None


def test_load_oom_classification_cleanup_and_retry(fake_torch, monkeypatch, tmp_path) -> None:
    fake_torch.cuda.available = True

    def _raise_oom():
        raise fake_torch.cuda.OutOfMemoryError("CUDA out of memory while building model")

    monkeypatch.setattr(sam3_compat, "load_image_surface", _raise_oom)
    engine = Sam3InferenceEngine(make_settings(tmp_path, device="cuda"))

    with pytest.raises(Exception):
        engine.warmup()

    assert engine.state == "load_failed"
    assert engine.load_error.startswith("cuda_oom:")
    assert engine._model is None
    assert engine._processor is None
    assert fake_torch.cuda.empty_cache_calls == 1  # cleanup_after_oom ran

    # Retry succeeds once the runtime surface becomes available again.
    monkeypatch.setattr(sam3_compat, "load_image_surface", fake_surface)
    engine._ensure_model()
    assert engine.state == "loaded"
    assert engine.loaded is True
    assert engine.load_error is None


def test_successful_load_then_unload_pairs_autocast_and_is_idempotent(
    fake_torch, monkeypatch, tmp_path
) -> None:
    fake_torch.cuda.available = True
    monkeypatch.setattr(sam3_compat, "load_image_surface", fake_surface)
    engine = Sam3InferenceEngine(make_settings(tmp_path, device="cuda"))

    engine._ensure_model()
    assert engine.state == "loaded"
    # The official CUDA precision context was entered exactly once at load time.
    contexts = fake_torch.autocast.instances
    assert len(contexts) == 1
    assert contexts[0].enter_count == 1
    assert contexts[0].exit_count == 0

    engine.unload()
    assert engine.state == "not_loaded"
    assert engine.loaded is False
    assert engine._model is None
    assert engine._processor is None
    assert contexts[0].exit_count == 1  # autocast __exit__ paired
    assert fake_torch.cuda.empty_cache_calls == 1

    engine.unload()  # idempotent no-op
    assert contexts[0].exit_count == 1
    assert fake_torch.cuda.empty_cache_calls == 1
    assert engine.state == "not_loaded"


def test_verify_inference_runs_full_chain_at_native_resolution(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(sam3_compat, "load_image_surface", fake_surface)
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    engine._ensure_model()

    calls: list[dict] = []

    def fake_infer(image, prompt, threshold, include_mask_png, max_detections, **kwargs):
        calls.append(
            {
                "size": (image.width, image.height),
                "prompt": prompt,
                "threshold": threshold,
                "include_mask_png": include_mask_png,
                "max_detections": max_detections,
                "kwargs": kwargs,
            }
        )
        return {"num_detections": 0}

    engine.infer = fake_infer  # type: ignore[assignment]

    engine.verify_inference()

    assert len(calls) == 1
    assert calls[0]["size"] == (64, 64)
    assert calls[0]["prompt"] == "object"
    assert calls[0]["threshold"] == 0.5
    assert calls[0]["include_mask_png"] is False
    assert calls[0]["max_detections"] == 1
    # RoPE frequencies are precomputed for the native grid: no resolution override.
    assert "input_size" not in calls[0]["kwargs"]
    assert engine.state == "loaded"


def test_verify_inference_failure_marks_load_failed(fake_torch, monkeypatch, tmp_path) -> None:
    fake_torch.cuda.available = True
    monkeypatch.setattr(sam3_compat, "load_image_surface", fake_surface)
    engine = Sam3InferenceEngine(make_settings(tmp_path, device="cuda"))
    engine._ensure_model()

    def fake_infer(*args, **kwargs):
        raise fake_torch.cuda.OutOfMemoryError("CUDA out of memory during forward")

    engine.infer = fake_infer  # type: ignore[assignment]

    with pytest.raises(Exception):
        engine.verify_inference()

    assert engine.state == "load_failed"
    assert engine.load_error.startswith("cuda_oom:")
    assert fake_torch.cuda.empty_cache_calls == 1


def test_warmup_is_load_plus_verify(monkeypatch, tmp_path) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    order: list[str] = []
    monkeypatch.setattr(engine, "_ensure_model", lambda: order.append("load"))
    monkeypatch.setattr(engine, "verify_inference", lambda: order.append("verify"))
    engine.warmup()
    assert order == ["load", "verify"]
