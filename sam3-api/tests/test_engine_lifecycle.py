"""Engine-level lifecycle tests for Sam3InferenceEngine (state machine, OOM, unload).

Uses the fake torch installed by conftest.py; tests that depend on fake CUDA
counters are skipped automatically when a real torch is present.
"""

from __future__ import annotations

import types
from pathlib import Path

import numpy as np
import pytest

import app.sam3_compat as sam3_compat
import app.engine as engine_module
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


def test_single_image_feature_reuses_set_image_backbone_outside_infer_lock(
    monkeypatch, tmp_path
) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    monkeypatch.setattr(engine, "_ensure_model", lambda: None)
    monkeypatch.setattr(engine, "_split_text_prompt", lambda _prompt: ["chair"])
    monkeypatch.setattr(engine, "_extract_detections_from_state", lambda **_kwargs: [])
    monkeypatch.setattr(
        engine,
        "_feature_plan",
        lambda **_kwargs: {
            "feature_key": "key-1",
            "_path": Path(tmp_path) / "feature" / "key-1.safetensors",
            "_metadata": {},
        },
    )

    calls: dict[str, object] = {"set_image": 0}

    class FakeTensor:
        def to(self, *_args, **_kwargs):
            return self

    sam2_out = object()

    class Processor:
        def set_confidence_threshold(self, _value):
            return None

        def set_image(self, _image, *, state):
            calls["set_image"] = int(calls["set_image"]) + 1
            state["backbone_out"] = {"sam2_backbone_out": sam2_out}
            return state

        def set_text_prompt(self, _prompt, *, state):
            return state

    monkeypatch.setattr(engine, "_get_processor_for_size", lambda _size: Processor())

    def extract(raw, *, already_projected):
        calls["sam2_out"] = raw
        calls["already_projected"] = already_projected
        return {
            "high_res_0": FakeTensor(),
            "high_res_1": FakeTensor(),
            "image_embed": FakeTensor(),
        }

    monkeypatch.setattr(engine, "_interactive_features_from_sam2", extract)

    class TrackingLock:
        held = False

        def __enter__(self):
            self.held = True

        def __exit__(self, *_args):
            self.held = False

    tracking_lock = TrackingLock()
    engine._infer_lock = tracking_lock

    def queue(plan, _tensors):
        assert tracking_lock.held is False
        return {"feature_status": "queued", "feature_write_id": "write-1", **plan}

    monkeypatch.setattr(engine, "_queue_feature_write", queue)
    result = engine.infer(
        image=engine_module.Image.new("RGB", (8, 8)),
        prompt="chair",
        threshold=0.5,
        include_mask_png=False,
        max_detections=10,
        save_ai_features=True,
        feature_root=str(tmp_path / "feature"),
        image_digest="digest-1",
    )

    assert calls == {
        "set_image": 1,
        "sam2_out": sam2_out,
        "already_projected": True,
    }
    assert result["_feature"]["feature_status"] == "queued"


def test_single_image_feature_cache_hit_skips_conversion_and_write(monkeypatch, tmp_path) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    monkeypatch.setattr(engine, "_ensure_model", lambda: None)
    monkeypatch.setattr(engine, "_split_text_prompt", lambda _prompt: ["chair"])
    monkeypatch.setattr(engine, "_extract_detections_from_state", lambda **_kwargs: [])
    monkeypatch.setattr(
        engine,
        "_feature_plan",
        lambda **_kwargs: {"feature_status": "reused", "feature_key": "cached", "feature_bytes": 12},
    )

    class Processor:
        def set_confidence_threshold(self, _value):
            return None

        def set_image(self, _image, *, state):
            state["backbone_out"] = {"sam2_backbone_out": object()}
            return state

        def set_text_prompt(self, _prompt, *, state):
            return state

    monkeypatch.setattr(engine, "_get_processor_for_size", lambda _size: Processor())
    monkeypatch.setattr(
        engine,
        "_interactive_features_from_sam2",
        lambda *_args, **_kwargs: pytest.fail("cache hit must not convert features"),
    )
    monkeypatch.setattr(
        engine,
        "_queue_feature_write",
        lambda *_args, **_kwargs: pytest.fail("cache hit must not queue a write"),
    )

    result = engine.infer(
        image=engine_module.Image.new("RGB", (8, 8)),
        prompt="chair",
        threshold=0.5,
        include_mask_png=False,
        max_detections=10,
        save_ai_features=True,
        feature_root=str(tmp_path / "feature"),
        image_digest="digest-1",
    )

    assert result["_feature"]["feature_status"] == "reused"


def test_queued_feature_write_waits_for_saved_result(monkeypatch, tmp_path) -> None:
    engine = Sam3InferenceEngine(make_settings(tmp_path))
    monkeypatch.setattr(engine_module, "save_feature_atomic", lambda *_args, **_kwargs: 456)
    plan = {
        "feature_key": "key-1",
        "feature_relative_path": "feature/key-1.safetensors",
        "_path": tmp_path / "feature" / "key-1.safetensors",
        "_metadata": {},
    }

    queued = engine._queue_feature_write(plan, {})
    waited = engine.wait_feature_writes([queued["feature_write_id"]])

    assert queued["feature_status"] == "queued"
    assert waited[0]["feature_status"] == "saved"
    assert waited[0]["feature_bytes"] == 456
    assert engine.wait_feature_writes([queued["feature_write_id"]])[0]["feature_status"] == "feature_failed"


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


def test_interactive_feature_lru_is_globally_bounded(tmp_path) -> None:
    class FakeTensor:
        def numel(self):
            return 10

        def element_size(self):
            return 2

    settings = make_settings(tmp_path)
    settings.feature_gpu_lru_size = 5
    engine = Sam3InferenceEngine(settings)
    engine._interactive_sessions['session-old'] = {'feature_key': 'key-0'}
    tensors = {
        'high_res_0': FakeTensor(),
        'high_res_1': FakeTensor(),
        'image_embed': FakeTensor(),
    }

    for index in range(6):
        engine._put_gpu_feature(
            f'key-{index}', tensors=tensors, width=100, height=100, project_id='p1'
        )

    assert len(engine._feature_lru) == 5
    assert 'key-0' not in engine._feature_lru
    assert 'session-old' not in engine._interactive_sessions
    assert engine.feature_cache_stats() == {'count': 5, 'bytes': 300}


def test_interactive_feature_generation_can_stay_memory_only(monkeypatch, tmp_path) -> None:
    class FakeTensor:
        def to(self, *_args, **_kwargs):
            return self

        def numel(self):
            return 10

        def element_size(self):
            return 2

    class Processor:
        def set_image(self, _image, *, state):
            state['backbone_out'] = {'sam2_backbone_out': object()}
            return state

    settings = make_settings(tmp_path)
    settings.feature_allowed_roots = [tmp_path]
    engine = Sam3InferenceEngine(settings)
    engine._model = types.SimpleNamespace(inst_interactive_predictor=object())
    engine._model_fingerprint = 'model-fingerprint'
    monkeypatch.setattr(engine, '_ensure_model', lambda: None)
    monkeypatch.setattr(engine, '_get_processor_for_size', lambda _size: Processor())
    monkeypatch.setattr(
        engine,
        '_interactive_features_from_sam2',
        lambda *_args, **_kwargs: {
            'high_res_0': FakeTensor(),
            'high_res_1': FakeTensor(),
            'image_embed': FakeTensor(),
        },
    )
    monkeypatch.setattr(
        engine_module,
        'save_feature_atomic',
        lambda *_args, **_kwargs: pytest.fail('memory-only assistance must not write a feature file'),
    )

    result = engine.ensure_interactive_session(
        image=engine_module.Image.new('RGB', (8, 8)),
        image_digest='digest-memory-only',
        feature_root=str(tmp_path / 'feature'),
        project_id='project-1',
        image_id='image-1',
        persist_feature=False,
    )

    assert result['feature_status'] == 'memory_only'
    assert result['feature_relative_path'] == ''
    assert result['feature_bytes'] == 0
    assert result['feature_persisted'] is False
    assert not (tmp_path / 'feature').exists()
    assert engine.feature_cache_stats() == {'count': 1, 'bytes': 60}


def test_interactive_click_uses_official_predict_inst(monkeypatch, tmp_path) -> None:
    called = {}

    class FakeFeatureTensor:
        device = 'cpu'
        dtype = 'bfloat16'

        def reshape(self, *_args):
            return self

        def view(self, *_args):
            return self

        def to(self, **_kwargs):
            return self

        def __sub__(self, _other):
            return self

    class FakeTracker:
        no_mem_embed = FakeFeatureTensor()
        sam_prompt_encoder = types.SimpleNamespace(mask_input_size=(4, 4))

    class FakeModel:
        inst_interactive_predictor = types.SimpleNamespace(model=FakeTracker())
        empty = False

        def predict_inst(self, inference_state, **kwargs):
            called['state'] = inference_state
            called['kwargs'] = kwargs
            if kwargs['multimask_output'] and kwargs['mask_input'] is not None:
                masks = np.zeros((3, 8, 8), dtype=np.uint8)
                masks[0, 2:6, 1:5] = 1
                masks[1, :, :] = 1
                masks[2, 6:8, :] = 1
                return (
                    masks,
                    np.asarray([0.99, 0.42, 0.8]),
                    np.zeros((3, 4, 4), dtype=np.float32),
                )
            mask = np.zeros((1, 8, 8), dtype=np.uint8)
            if not self.empty:
                mask[0, 2:6, 1:5] = 1
            return mask, np.asarray([0.92]), np.zeros((1, 4, 4), dtype=np.float32)

    engine = Sam3InferenceEngine(make_settings(tmp_path))
    engine._loaded = True
    engine._state = 'loaded'
    engine._model = FakeModel()
    engine._feature_lru['feature-1'] = {
        'tensors': {
            'high_res_0': FakeFeatureTensor(),
            'high_res_1': FakeFeatureTensor(),
            'image_embed': FakeFeatureTensor(),
        },
        'width': 8,
        'height': 8,
        'project_id': 'project-1',
        'gpu_bytes': 0,
    }
    engine._interactive_sessions['session-1'] = {
        'feature_key': 'feature-1',
        'points': [],
        'labels': [],
        'low_res_logits': None,
        'candidate': None,
        'prompt_history': [],
        'prompt_history_index': 0,
    }
    monkeypatch.setattr(
        'app.engine.split_mask_components',
        lambda mask: (
            [types.SimpleNamespace(
                area=int(mask.sum()),
                polygon=[[1, 2], [4, 2], [4, 5], [1, 5]],
                mask=(mask > 0).astype(np.uint8),
            )]
            if int(mask.sum()) > 0 else []
        ),
    )
    monkeypatch.setattr(engine_module.torch, 'zeros_like', lambda tensor: tensor, raising=False)

    result = engine.interactive_predict(session_id='session-1', x=3, y=4, label=1)

    assert result['candidate']['score'] == pytest.approx(0.92)
    assert called['state']['original_width'] == 8
    assert called['kwargs']['multimask_output'] is True

    initial_logits = np.full((1, 4, 4), 7.0, dtype=np.float32)
    engine._interactive_sessions['session-refine'] = {
        'feature_key': 'feature-1',
        'points': [],
        'labels': [],
        'low_res_logits': initial_logits.copy(),
        'initial_low_res_logits': initial_logits.copy(),
        'edited_mask': np.ones((8, 8), dtype=np.uint8),
        'initial_edited_mask': np.ones((8, 8), dtype=np.uint8),
        'candidate': None,
        'prompt_history': [],
        'prompt_history_index': 0,
    }
    refined = engine.interactive_predict(session_id='session-refine', x=3, y=4, label=1)
    np.testing.assert_array_equal(called['kwargs']['mask_input'], initial_logits)
    assert called['kwargs']['multimask_output'] is True
    assert refined['candidate']['score'] == pytest.approx(0.42)
    assert refined['candidate']['area'] == 64

    reduced = engine.interactive_predict(session_id='session-refine', x=3, y=4, label=0)
    assert reduced['candidate']['area'] == 16
    restored = engine.undo_interactive_prompt('session-refine')
    assert restored['candidate']['area'] == 64
    engine.reset_interactive_session('session-refine')
    assert engine._interactive_sessions['session-refine']['candidate'] is None
    assert int(engine._interactive_sessions['session-refine']['edited_mask'].sum()) == 64

    engine.interactive_predict(session_id='session-1', x=5, y=6, label=0)
    undone = engine.undo_interactive_prompt('session-1')
    assert undone['points'] == 1
    assert undone['can_redo'] is True
    redone = engine.redo_interactive_prompt('session-1')
    assert redone['points'] == 2
    assert redone['can_undo'] is True

    engine._model.empty = True
    empty = engine.interactive_predict(session_id='session-1', x=7, y=7, label=0)
    assert empty['state'] == 'empty'
    assert empty['candidate'] is None
    assert empty['can_undo'] is True
