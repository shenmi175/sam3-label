import copy
import gc
import hashlib
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Optional

import numpy as np
import torch
from PIL import Image
import logging
from torchvision.transforms import functional as TF

from app import lifecycle
from app.config import Settings
from app.feature_cache import (
    feature_key,
    feature_tensor_bytes,
    load_feature,
    metadata_matches,
    resolve_feature_root,
    save_feature_atomic,
    sha256_file,
)
from app.utils import mask_to_png_base64, split_mask_components

logger = logging.getLogger("sam3_api")


def _format_load_error(exc: BaseException) -> str:
    text = str(exc or "").strip()
    return text or type(exc).__name__


class Sam3InferenceEngine:
    """Thread-safe SAM3 inference engine with lazy model loading."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._loaded = False
        self._state = "not_loaded"  # not_loaded | loading | loaded | load_failed
        self._load_error: Optional[str] = None
        self._model = None
        self._processor = None
        self._processor_cls = None
        self._default_processor_resolution = 1008
        self._processor_resolution = 1008
        self._find_stage_template = None
        self._api_copy_to_device = None
        self._api_postprocessor_cls = None
        self._api_batched_datapoint_cls = None
        self._api_find_stage_cls = None
        self._api_find_target_cls = None
        self._api_batched_meta_cls = None
        self._api_convert_my_tensors = None
        self._cuda_autocast_dtype = torch.bfloat16
        self._cuda_autocast_context = None
        self._cuda_autocast_context_entered = False
        self._model_fingerprint = ""
        self._feature_lru: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._interactive_sessions: dict[str, dict[str, Any]] = {}
        self._feature_write_executor = ThreadPoolExecutor(
            max_workers=int(self.settings.feature_write_workers),
            thread_name_prefix="sam3-feature-write",
        )
        self._feature_write_slots = threading.BoundedSemaphore(
            int(self.settings.feature_write_max_pending)
        )
        self._feature_write_lock = threading.Lock()
        self._feature_writes: dict[str, Future[dict[str, Any]]] = {}

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def state(self) -> str:
        return self._state

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    @property
    def default_input_size(self) -> int:
        return int(self._default_processor_resolution)

    def warmup(self) -> None:
        self._ensure_model()
        self.verify_inference()

    def _ensure_model(self) -> None:
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            self._state = "loading"
            try:
                self._load_model()
            except Exception as exc:
                category, _guidance = lifecycle.classify_load_error(exc)
                self._load_error = f"{category}: {_format_load_error(exc)}"
                self._state = "load_failed"
                self._clear_load_artifacts()
                if lifecycle.is_oom_error(exc):
                    lifecycle.cleanup_after_oom()
                raise
            self._loaded = True
            self._state = "loaded"
            self._load_error = None

    def _clear_load_artifacts(self) -> None:
        """Drop half-initialized references after a failed load."""
        self._model = None
        self._processor = None
        self._processor_cls = None
        self._find_stage_template = None
        self._api_copy_to_device = None
        self._api_postprocessor_cls = None
        self._api_batched_datapoint_cls = None
        self._api_find_stage_cls = None
        self._api_find_target_cls = None
        self._api_batched_meta_cls = None
        self._api_convert_my_tensors = None

    def verify_inference(self) -> None:
        """Run a dummy forward pass through the full inference chain to validate the load.

        A failure here is treated like a load failure: state becomes load_failed with a
        classified error so /health and lazy-mode endpoints can report it.
        """
        try:
            image = Image.new("RGB", (64, 64), color=(128, 128, 128))
            # SAM3 ViTDet precomputes RoPE frequencies for the model's native grid,
            # so the probe must run at the default resolution (not a smaller one).
            self.infer(
                image,
                prompt="object",
                threshold=0.5,
                include_mask_png=False,
                max_detections=1,
            )
        except Exception as exc:
            category, _guidance = lifecycle.classify_load_error(exc)
            self._load_error = f"{category}: {_format_load_error(exc)}"
            self._state = "load_failed"
            if lifecycle.is_oom_error(exc):
                lifecycle.cleanup_after_oom()
            raise
        self._state = "loaded"
        self._load_error = None

    def unload(self) -> None:
        """Idempotently unload the model and release VRAM."""
        with self._load_lock, self._infer_lock:
            if not self._loaded and self._model is None and not self._cuda_autocast_context_entered:
                self._state = "not_loaded"
                return
            allocated_before: Optional[int] = None
            if self._uses_cuda():
                try:
                    allocated_before = int(torch.cuda.memory_allocated())
                except Exception:  # noqa: BLE001
                    allocated_before = None

            self._loaded = False
            self._state = "not_loaded"
            self._load_error = None
            self._clear_load_artifacts()
            self._feature_lru.clear()
            self._interactive_sessions.clear()

            # The autocast context entered at load time is never exited otherwise;
            # pair it with an explicit __exit__ on unload.
            if self._cuda_autocast_context_entered and self._cuda_autocast_context is not None:
                try:
                    self._cuda_autocast_context.__exit__(None, None, None)
                except Exception:  # noqa: BLE001
                    logger.warning("failed to exit CUDA autocast context during unload", exc_info=True)
            self._cuda_autocast_context = None
            self._cuda_autocast_context_entered = False

            gc.collect()
            if self._uses_cuda():
                try:
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
            if allocated_before is not None:
                try:
                    freed_mb = (allocated_before - int(torch.cuda.memory_allocated())) / 1024.0 / 1024.0
                    logger.info("sam3 image model unloaded; freed ~%.0f MiB of allocated VRAM", freed_mb)
                except Exception:  # noqa: BLE001
                    logger.info("sam3 image model unloaded")
            else:
                logger.info("sam3 image model unloaded")

    def _load_model(self) -> None:
        checkpoint = self.settings.checkpoint_path
        if not checkpoint.exists() and not self.settings.load_from_hf:
            raise RuntimeError(
                "SAM3 checkpoint not found. "
                f"Current path: {checkpoint}. "
                "Place sam3.pt at this path or set SAM3_API_LOAD_FROM_HF=1."
            )

        from app.sam3_compat import SAM3_PIN_SHA

        logger.info(
            "sam3 image model load: ckpt_generation=%s ckpt_path=%s exists=%s sam3_pin_sha=%s",
            self.settings.expected_ckpt_generation,
            checkpoint,
            checkpoint.exists(),
            SAM3_PIN_SHA,
        )

        self._enter_official_cuda_precision_context()

        from app.sam3_compat import Sam3CompatError, load_image_surface

        try:
            surface = load_image_surface()
        except Sam3CompatError as exc:
            raise RuntimeError(
                "Failed to import SAM3 runtime dependencies. "
                "Please install torch/torchvision/timm/huggingface_hub/iopath/einops/etc. "
                f"Original error: {exc}"
            ) from exc
        Sam3Processor = surface["Sam3Processor"]
        build_sam3_image_model = surface["build_sam3_image_model"]
        PostProcessImage = surface["PostProcessImage"]
        BatchedDatapoint = surface["BatchedDatapoint"]
        BatchedFindTarget = surface["BatchedFindTarget"]
        BatchedInferenceMetadata = surface["BatchedInferenceMetadata"]
        FindStage = surface["FindStage"]
        convert_my_tensors = surface["convert_my_tensors"]
        copy_data_to_device = surface["copy_data_to_device"]

        checkpoint_path = str(checkpoint) if checkpoint.exists() else None
        self._model = build_sam3_image_model(
            checkpoint_path=checkpoint_path,
            load_from_HF=self.settings.load_from_hf,
            device=self.settings.device,
            eval_mode=True,
            compile=self.settings.compile_model,
            enable_inst_interactivity=self.settings.instance_interactivity_enabled,
        )
        checkpoint_digest = sha256_file(checkpoint) if checkpoint.exists() else "huggingface"
        self._model_fingerprint = hashlib.sha256(
            f"{checkpoint_digest}:{SAM3_PIN_SHA}".encode("utf-8")
        ).hexdigest()
        self._processor_cls = Sam3Processor
        self._api_copy_to_device = copy_data_to_device
        self._api_postprocessor_cls = PostProcessImage
        self._api_batched_datapoint_cls = BatchedDatapoint
        self._api_find_stage_cls = FindStage
        self._api_find_target_cls = BatchedFindTarget
        self._api_batched_meta_cls = BatchedInferenceMetadata
        self._api_convert_my_tensors = convert_my_tensors
        self._rebuild_processor(self._processor_resolution)

    @staticmethod
    def _normalize_input_size(input_size: int | None, default: int = 1008) -> int:
        try:
            value = int(input_size or 0)
        except Exception:
            value = 0
        if value <= 0:
            return int(default)
        return max(128, value)

    @staticmethod
    def _renumber_detection_ids(detections: list[dict[str, Any]]) -> None:
        group_ids: dict[str, str] = {}
        for det_idx, det in enumerate(detections, start=1):
            contour_index = det.get("contour_index")
            model_key = str(det.pop("_model_det_key", "") or "")
            if contour_index is None:
                det["id"] = f"det_{det_idx:04d}"
                if det.get("model_det_id") is not None:
                    det["model_det_id"] = det["id"]
                continue

            if not model_key:
                model_key = str(det.get("model_det_id") or det.get("id") or det_idx)
            model_det_id = group_ids.get(model_key)
            if model_det_id is None:
                model_det_id = f"det_{det_idx:04d}"
                group_ids[model_key] = model_det_id
            det["model_det_id"] = model_det_id
            det["id"] = f"{model_det_id}_c{int(contour_index):03d}"

    def _rebuild_processor(self, resolution: int) -> None:
        if self._processor_cls is None or self._model is None:
            raise RuntimeError("SAM3 processor class is not initialized")
        self._processor_resolution = int(resolution)
        self._processor = self._processor_cls(
            self._model,
            resolution=self._processor_resolution,
            device=self.settings.device,
            confidence_threshold=self.settings.default_threshold,
        )
        self._find_stage_template = copy.deepcopy(self._processor.find_stage)

    def _get_processor_for_size(self, input_size: int | None):
        use_size = self._normalize_input_size(input_size, default=self._default_processor_resolution)
        if self._processor is None or int(self._processor_resolution) != int(use_size):
            self._rebuild_processor(use_size)
        return self._processor

    def _uses_cuda(self) -> bool:
        return str(self.settings.device).startswith("cuda") and torch.cuda.is_available()

    def _select_official_cuda_autocast_dtype(self):
        if not self._uses_cuda():
            return torch.bfloat16
        try:
            if not torch.cuda.is_bf16_supported():
                return torch.float16
        except Exception:  # noqa: BLE001
            pass
        return torch.bfloat16

    def _enter_official_cuda_precision_context(self) -> None:
        if not self._uses_cuda() or self._cuda_autocast_context_entered:
            return

        self._cuda_autocast_dtype = self._select_official_cuda_autocast_dtype()
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        # Official SAM3 image examples enter a CUDA autocast context before model build.
        self._cuda_autocast_context = torch.autocast(
            device_type="cuda",
            dtype=self._cuda_autocast_dtype,
        )
        self._cuda_autocast_context.__enter__()
        self._cuda_autocast_context_entered = True
        logger.info(
            "enabled SAM3 official CUDA autocast context: dtype=%s",
            self._cuda_autocast_dtype,
        )

    def _precision_context(self):
        if self._uses_cuda():
            # Autocast is thread-local; request worker threads need the same official mode.
            return torch.autocast(device_type="cuda", dtype=self._cuda_autocast_dtype)
        return nullcontext()

    @property
    def instance_interactivity_enabled(self) -> bool:
        return bool(
            self.settings.instance_interactivity_enabled
            and self._model is not None
            and getattr(self._model, "inst_interactive_predictor", None) is not None
        )

    def feature_cache_stats(self) -> dict[str, int]:
        return {
            "count": len(self._feature_lru),
            "bytes": sum(int(item.get("gpu_bytes") or 0) for item in self._feature_lru.values()),
        }

    def _interactive_features_from_sam2(
        self,
        sam2_backbone_out: dict[str, Any],
        *,
        already_projected: bool,
    ) -> dict[str, torch.Tensor]:
        if not self.instance_interactivity_enabled:
            raise RuntimeError("SAM3 instance interactivity is not enabled")
        predictor = self._model.inst_interactive_predictor
        tracker = predictor.model
        fpn = list(sam2_backbone_out.get("backbone_fpn") or [])
        if len(fpn) != 3:
            raise RuntimeError("SAM3 interactive backbone did not return three FPN levels")
        if not already_projected:
            fpn[0] = tracker.sam_mask_decoder.conv_s0(fpn[0])
            fpn[1] = tracker.sam_mask_decoder.conv_s1(fpn[1])
        prepared = dict(sam2_backbone_out)
        prepared["backbone_fpn"] = fpn
        _, vision_feats, _, _ = tracker._prepare_backbone_features(prepared)
        vision_feats[-1] = vision_feats[-1] + tracker.no_mem_embed
        batch_size = int(vision_feats[-1].shape[1])
        feats = [
            feat.permute(1, 2, 0).view(batch_size, -1, *feat_size)
            for feat, feat_size in zip(vision_feats[::-1], predictor._bb_feat_sizes[::-1])
        ][::-1]
        return {
            "high_res_0": feats[0],
            "high_res_1": feats[1],
            "image_embed": feats[-1],
        }

    def _feature_metadata(
        self,
        *,
        key: str,
        image_digest: str,
        width: int,
        height: int,
    ) -> dict[str, str]:
        return {
            "feature_key": key,
            "format_version": self.settings.feature_format_version,
            "model_fingerprint": self._model_fingerprint,
            "image_digest": image_digest,
            "input_size": str(self._default_processor_resolution),
            "width": str(int(width)),
            "height": str(int(height)),
            "dtype": "bfloat16",
        }

    def _feature_identity(
        self,
        *,
        image_digest: str,
        width: int,
        height: int,
    ) -> tuple[str, dict[str, str]]:
        key = feature_key(
            image_digest=image_digest,
            model_fingerprint=self._model_fingerprint,
            input_size=self._default_processor_resolution,
            format_version=self.settings.feature_format_version,
            width=width,
            height=height,
        )
        return key, self._feature_metadata(
            key=key,
            image_digest=image_digest,
            width=width,
            height=height,
        )

    def _feature_plan(
        self,
        *,
        image: Image.Image,
        image_digest: str,
        feature_root: str,
    ) -> dict[str, Any]:
        root = resolve_feature_root(feature_root, self.settings.feature_allowed_roots)
        key, metadata = self._feature_identity(
            image_digest=image_digest,
            width=image.width,
            height=image.height,
        )
        path = root / f"{key}.safetensors"
        public = {
            "feature_key": key,
            "feature_relative_path": f"feature/{path.name}",
            "image_digest": image_digest,
            "model_fingerprint": self._model_fingerprint,
            "feature_input_size": self._default_processor_resolution,
            "feature_dtype": "bfloat16",
            "feature_format_version": self.settings.feature_format_version,
        }
        if metadata_matches(path, metadata):
            return {
                **public,
                "feature_status": "reused",
                "feature_bytes": int(path.stat().st_size),
            }
        return {**public, "_path": path, "_metadata": metadata}

    @staticmethod
    def _feature_failed(plan: dict[str, Any], exc: BaseException) -> dict[str, Any]:
        return {
            **{k: v for k, v in plan.items() if not str(k).startswith("_")},
            "feature_status": "feature_failed",
            "feature_bytes": 0,
            "feature_error": str(exc),
        }

    def _queue_feature_write(
        self,
        plan: dict[str, Any],
        tensors: dict[str, torch.Tensor],
    ) -> dict[str, Any]:
        self._feature_write_slots.acquire()
        write_id = uuid.uuid4().hex
        public = {k: v for k, v in plan.items() if not str(k).startswith("_")}

        def write() -> dict[str, Any]:
            try:
                size = save_feature_atomic(
                    Path(plan["_path"]),
                    tensors=tensors,
                    metadata=dict(plan["_metadata"]),
                )
                return {**public, "feature_status": "saved", "feature_bytes": size}
            except Exception as exc:  # feature failure must not fail annotations
                return self._feature_failed(plan, exc)
            finally:
                self._feature_write_slots.release()

        try:
            future = self._feature_write_executor.submit(write)
        except Exception:
            self._feature_write_slots.release()
            raise
        with self._feature_write_lock:
            self._feature_writes[write_id] = future
        return {
            **public,
            "feature_status": "queued",
            "feature_write_id": write_id,
            "feature_bytes": 0,
        }

    def wait_feature_writes(self, write_ids: list[str]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for raw_id in write_ids:
            write_id = str(raw_id or "").strip()
            if not write_id:
                continue
            with self._feature_write_lock:
                future = self._feature_writes.get(write_id)
            if future is None:
                results.append({
                    "feature_write_id": write_id,
                    "feature_status": "feature_failed",
                    "feature_bytes": 0,
                    "feature_error": "feature write result is unavailable",
                })
                continue
            result = future.result()
            with self._feature_write_lock:
                self._feature_writes.pop(write_id, None)
            results.append({"feature_write_id": write_id, **result})
        return results

    def _put_gpu_feature(
        self,
        key: str,
        *,
        tensors: dict[str, torch.Tensor],
        width: int,
        height: int,
        project_id: str,
    ) -> None:
        self._feature_lru.pop(key, None)
        self._feature_lru[key] = {
            "tensors": tensors,
            "width": int(width),
            "height": int(height),
            "project_id": project_id,
            "gpu_bytes": feature_tensor_bytes(tensors),
        }
        while len(self._feature_lru) > int(self.settings.feature_gpu_lru_size):
            evicted_key, _ = self._feature_lru.popitem(last=False)
            for session_id, session in list(self._interactive_sessions.items()):
                if session.get("feature_key") == evicted_key:
                    self._interactive_sessions.pop(session_id, None)

    def ensure_interactive_session(
        self,
        *,
        image: Image.Image,
        image_digest: str,
        feature_root: str,
        project_id: str,
        image_id: str,
        session_id: str = "",
        initial_polygons: list[list[list[float]]] | None = None,
        persist_feature: bool = False,
    ) -> dict[str, Any]:
        self._ensure_model()
        if not self.instance_interactivity_enabled:
            raise RuntimeError("SAM3 instance interactivity is unavailable")
        root = resolve_feature_root(feature_root, self.settings.feature_allowed_roots)
        key, metadata = self._feature_identity(
            image_digest=image_digest,
            width=image.width,
            height=image.height,
        )
        path = root / f"{key}.safetensors"
        status = "gpu_cached"
        with self._infer_lock, self._precision_context():
            entry = self._feature_lru.pop(key, None)
            if entry is not None:
                self._feature_lru[key] = entry
            else:
                if metadata_matches(path, metadata):
                    tensors, _ = load_feature(path, device=self.settings.device)
                    status = "loaded"
                else:
                    processor = self._get_processor_for_size(self._default_processor_resolution)
                    state = processor.set_image(image, state={})
                    tensors = self._interactive_features_from_sam2(
                        state["backbone_out"]["sam2_backbone_out"],
                        already_projected=True,
                    )
                    tensors = {name: value.to(torch.bfloat16) for name, value in tensors.items()}
                    if persist_feature:
                        save_feature_atomic(path, tensors=tensors, metadata=metadata)
                        status = "generated"
                    else:
                        status = "memory_only"
                self._put_gpu_feature(
                    key,
                    tensors=tensors,
                    width=image.width,
                    height=image.height,
                    project_id=project_id,
                )
        sid = str(session_id or uuid.uuid4().hex)
        initial_binary_mask = self._polygons_to_binary_mask(
            initial_polygons or [], width=image.width, height=image.height
        )
        initial_mask = self._binary_mask_to_input(initial_binary_mask)
        self._interactive_sessions[sid] = {
            "session_id": sid,
            "project_id": project_id,
            "image_id": image_id,
            "feature_key": key,
            "points": [],
            "labels": [],
            "low_res_logits": initial_mask,
            "initial_low_res_logits": initial_mask.copy() if initial_mask is not None else None,
            "edited_mask": initial_binary_mask.copy() if initial_binary_mask is not None else None,
            "initial_edited_mask": initial_binary_mask.copy() if initial_binary_mask is not None else None,
            "candidate": None,
            "prompt_history": [],
            "prompt_history_index": 0,
        }
        session = self._interactive_sessions[sid]
        session["prompt_history"] = [self._interactive_prompt_snapshot(session)]
        feature_on_disk = path.is_file()
        return {
            "session_id": sid,
            "project_id": project_id,
            "image_id": image_id,
            "feature_status": status,
            "feature_key": key,
            "feature_relative_path": f"feature/{path.name}" if feature_on_disk else "",
            "feature_bytes": int(path.stat().st_size) if feature_on_disk else 0,
            "feature_persisted": feature_on_disk,
            "image_digest": image_digest,
            "model_fingerprint": self._model_fingerprint,
            "feature_input_size": self._default_processor_resolution,
            "feature_dtype": "bfloat16",
            "feature_format_version": self.settings.feature_format_version,
            "state": "ready",
        }

    @staticmethod
    def _polygons_to_binary_mask(
        polygons: list[list[list[float]]], *, width: int, height: int
    ) -> np.ndarray | None:
        valid = [poly for poly in polygons if isinstance(poly, list) and len(poly) >= 3]
        if not valid:
            return None
        import cv2

        mask = np.zeros((int(height), int(width)), dtype=np.uint8)
        contours = [np.asarray(poly, dtype=np.float32).round().astype(np.int32) for poly in valid]
        cv2.fillPoly(mask, contours, 1)
        return mask

    def _binary_mask_to_input(self, mask: np.ndarray | None) -> np.ndarray | None:
        if mask is None:
            return None
        import cv2

        predictor = self._model.inst_interactive_predictor
        target_h, target_w = predictor.model.sam_prompt_encoder.mask_input_size
        low = cv2.resize(mask, (int(target_w), int(target_h)), interpolation=cv2.INTER_NEAREST)
        return (low.astype(np.float32) * 20.0 - 10.0)[None, :, :]

    @staticmethod
    def _select_refinement_candidate(
        masks: np.ndarray, scores: np.ndarray, reference_mask: np.ndarray | None
    ) -> int:
        default = int(np.argmax(scores))
        if reference_mask is None or len(masks) <= 1:
            return default
        reference = np.asarray(reference_mask) > 0
        if reference.ndim != 2 or not np.any(reference):
            return default
        overlaps: list[float] = []
        for candidate in masks:
            binary = np.asarray(candidate) > 0
            if binary.shape != reference.shape:
                overlaps.append(-1.0)
                continue
            union = int(np.logical_or(binary, reference).sum())
            intersection = int(np.logical_and(binary, reference).sum())
            overlaps.append(float(intersection) / float(union) if union else 0.0)
        return max(range(len(overlaps)), key=lambda index: (overlaps[index], float(scores[index])))

    @staticmethod
    def _foreground_component_mask(
        raw_mask: np.ndarray,
        *,
        x: float,
        y: float,
        reference_mask: np.ndarray,
    ) -> np.ndarray:
        components = split_mask_components(raw_mask)
        if not components:
            return np.zeros_like(reference_mask, dtype=np.uint8)
        px = max(0, min(int(reference_mask.shape[1]) - 1, int(round(x))))
        py = max(0, min(int(reference_mask.shape[0]) - 1, int(round(y))))
        pointed = [component for component in components if component.mask[py, px] > 0]
        if pointed:
            selected = pointed
        else:
            # Numerical edge effects can leave the click one pixel outside the
            # returned component. Fall back to the component most connected to
            # the existing instance, never to an unrelated high-score fragment.
            selected = [max(
                components,
                key=lambda component: int(np.logical_and(component.mask > 0, reference_mask > 0).sum()),
            )]
        merged = np.zeros_like(reference_mask, dtype=np.uint8)
        for component in selected:
            merged |= (component.mask > 0).astype(np.uint8)
        return merged

    def interactive_predict(self, *, session_id: str, x: float, y: float, label: int) -> dict[str, Any]:
        session = self._interactive_sessions.get(str(session_id))
        if not session:
            raise KeyError("interactive session not found or evicted")
        key = str(session["feature_key"])
        entry = self._feature_lru.pop(key, None)
        if entry is None:
            self._interactive_sessions.pop(str(session_id), None)
            raise KeyError("interactive feature was evicted; reopen the session")
        self._feature_lru[key] = entry
        before = self._interactive_prompt_snapshot(session)
        session["points"].append([float(x), float(y)])
        session["labels"].append(1 if int(label) != 0 else 0)
        predictor = self._model.inst_interactive_predictor
        tensors = entry["tensors"]
        # Rebuild the official inference-state shape from the persisted decoder
        # features. ``predict_inst`` prepares these spatial features and adds
        # ``no_mem_embed`` itself, so remove that term from the cached image
        # embedding before handing the state back to the public SAM3 method.
        tracker = predictor.model
        no_mem_spatial = tracker.no_mem_embed.reshape(-1).view(1, -1, 1, 1).to(
            device=tensors["image_embed"].device,
            dtype=tensors["image_embed"].dtype,
        )
        backbone_fpn = [
            tensors["high_res_0"],
            tensors["high_res_1"],
            tensors["image_embed"] - no_mem_spatial,
        ]
        inference_state = {
            "original_height": int(entry["height"]),
            "original_width": int(entry["width"]),
            "backbone_out": {
                "sam2_backbone_out": {
                    "backbone_fpn": backbone_fpn,
                    # The tracker uses positional tensors here to obtain the
                    # spatial sizes; predict_inst does not consume their values.
                    "vision_pos_enc": [torch.zeros_like(feat) for feat in backbone_fpn],
                }
            },
        }
        reference_mask = session.get("edited_mask")
        with self._infer_lock, self._precision_context():
            try:
                masks, scores, logits = self._model.predict_inst(
                    inference_state,
                    point_coords=np.asarray(session["points"], dtype=np.float32),
                    point_labels=np.asarray(session["labels"], dtype=np.int32),
                    mask_input=session.get("low_res_logits"),
                    multimask_output=len(session["points"]) == 1,
                    return_logits=False,
                    normalize_coords=True,
                )
            except Exception:
                self._restore_interactive_prompt_snapshot(session, before)
                raise
            finally:
                # The official method clears _features/_is_image_set on the
                # success path; also normalize state when its decoder raises.
                predictor._features = None
                predictor._is_image_set = False
                predictor._orig_hw = None
        best = self._select_refinement_candidate(masks, scores, reference_mask)
        raw_mask = (masks[best] > 0).astype(np.uint8)
        if reference_mask is not None:
            reference = (np.asarray(reference_mask) > 0).astype(np.uint8)
            if int(label) != 0:
                addition = self._foreground_component_mask(
                    raw_mask, x=float(x), y=float(y), reference_mask=reference
                )
                mask = np.logical_or(reference > 0, addition > 0).astype(np.uint8)
            else:
                mask = np.logical_and(reference > 0, raw_mask > 0).astype(np.uint8)
            session["edited_mask"] = mask.copy()
            session["low_res_logits"] = self._binary_mask_to_input(mask)
        else:
            mask = raw_mask
            session["low_res_logits"] = logits[best : best + 1]
        components = split_mask_components(mask)
        polygons = [component.polygon for component in components]
        if not polygons:
            # Negative prompts can legitimately suppress every pixel. Keep the
            # prompt/logit state so the user can undo it or add a foreground
            # point, but do not turn this normal decoder result into HTTP 500.
            session["candidate"] = None
            history = list(session.get("prompt_history") or [])
            index = int(session.get("prompt_history_index") or 0)
            history = history[: index + 1]
            history.append(self._interactive_prompt_snapshot(session))
            if len(history) > 51:
                history = history[-51:]
            session["prompt_history"] = history
            session["prompt_history_index"] = len(history) - 1
            return {
                "session_id": str(session_id),
                "state": "empty",
                "points": len(session["points"]),
                "candidate": None,
                "can_undo": len(history) > 1,
                "can_redo": False,
            }
        ys, xs = np.where(mask > 0)
        candidate = {
            "bbox": [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())],
            "polygon": max(components, key=lambda component: component.area).polygon,
            "polygons": polygons,
            "area": int(mask.sum()),
            "score": float(scores[best]),
        }
        session["candidate"] = candidate
        history = list(session.get("prompt_history") or [])
        index = int(session.get("prompt_history_index") or 0)
        history = history[: index + 1]
        history.append(self._interactive_prompt_snapshot(session))
        if len(history) > 51:
            history = history[-51:]
        session["prompt_history"] = history
        session["prompt_history_index"] = len(history) - 1
        return {
            "session_id": str(session_id),
            "state": "candidate",
            "points": len(session["points"]),
            "candidate": candidate,
            "can_undo": len(history) > 1,
            "can_redo": False,
        }

    @staticmethod
    def _interactive_prompt_snapshot(session: dict[str, Any]) -> dict[str, Any]:
        logits = session.get("low_res_logits")
        edited = session.get("edited_mask")
        return {
            "points": copy.deepcopy(list(session.get("points") or [])),
            "labels": list(session.get("labels") or []),
            "low_res_logits": logits.copy() if logits is not None else None,
            "edited_mask_packed": np.packbits(edited.reshape(-1)) if edited is not None else None,
            "edited_mask_shape": tuple(edited.shape) if edited is not None else None,
            "candidate": copy.deepcopy(session.get("candidate")),
        }

    @staticmethod
    def _restore_interactive_prompt_snapshot(session: dict[str, Any], snapshot: dict[str, Any]) -> None:
        logits = snapshot.get("low_res_logits")
        packed = snapshot.get("edited_mask_packed")
        shape = snapshot.get("edited_mask_shape")
        edited = None
        if packed is not None and isinstance(shape, tuple) and len(shape) == 2:
            size = int(shape[0]) * int(shape[1])
            edited = np.unpackbits(packed, count=size).reshape(shape).astype(np.uint8)
        session.update(
            points=copy.deepcopy(list(snapshot.get("points") or [])),
            labels=list(snapshot.get("labels") or []),
            low_res_logits=logits.copy() if logits is not None else None,
            edited_mask=edited,
            candidate=copy.deepcopy(snapshot.get("candidate")),
        )

    def _interactive_history_move(self, session_id: str, delta: int) -> dict[str, Any]:
        session = self._interactive_sessions.get(str(session_id))
        if not session:
            raise KeyError("interactive session not found")
        history = list(session.get("prompt_history") or [])
        if not history:
            history = [self._interactive_prompt_snapshot(session)]
        current = int(session.get("prompt_history_index") or 0)
        target = max(0, min(len(history) - 1, current + int(delta)))
        self._restore_interactive_prompt_snapshot(session, history[target])
        session["prompt_history"] = history
        session["prompt_history_index"] = target
        candidate = copy.deepcopy(session.get("candidate"))
        return {
            "session_id": str(session_id),
            "state": "candidate" if candidate else "ready",
            "points": len(session.get("points") or []),
            "candidate": candidate,
            "can_undo": target > 0,
            "can_redo": target < len(history) - 1,
        }

    def undo_interactive_prompt(self, session_id: str) -> dict[str, Any]:
        return self._interactive_history_move(session_id, -1)

    def redo_interactive_prompt(self, session_id: str) -> dict[str, Any]:
        return self._interactive_history_move(session_id, 1)

    def reset_interactive_session(self, session_id: str) -> dict[str, Any]:
        session = self._interactive_sessions.get(str(session_id))
        if not session:
            raise KeyError("interactive session not found")
        initial = session.get("initial_low_res_logits")
        initial_edited = session.get("initial_edited_mask")
        session.update(
            points=[],
            labels=[],
            low_res_logits=initial.copy() if initial is not None else None,
            edited_mask=initial_edited.copy() if initial_edited is not None else None,
            candidate=None,
        )
        session["prompt_history"] = [self._interactive_prompt_snapshot(session)]
        session["prompt_history_index"] = 0
        return {
            "session_id": str(session_id),
            "state": "ready",
            "points": 0,
            "candidate": None,
            "can_undo": False,
            "can_redo": False,
        }

    def close_interactive_session(self, session_id: str) -> bool:
        return self._interactive_sessions.pop(str(session_id), None) is not None

    def clear_project_features(self, project_id: str) -> dict[str, int]:
        closed = 0
        for session_id, session in list(self._interactive_sessions.items()):
            if str(session.get("project_id") or "") == str(project_id):
                self._interactive_sessions.pop(session_id, None)
                closed += 1
        removed = 0
        for key, entry in list(self._feature_lru.items()):
            if str(entry.get("project_id") or "") == str(project_id):
                self._feature_lru.pop(key, None)
                removed += 1
        if removed:
            gc.collect()
            if self._uses_cuda():
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
        return {"sessions_closed": closed, "gpu_entries_removed": removed}

    @staticmethod
    def _xyxy_to_cxcywh_norm(
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        image_w: int,
        image_h: int,
    ) -> list[float] | None:
        x1 = max(0.0, min(float(image_w), float(x1)))
        x2 = max(0.0, min(float(image_w), float(x2)))
        y1 = max(0.0, min(float(image_h), float(y1)))
        y2 = max(0.0, min(float(image_h), float(y2)))
        if x2 <= x1 or y2 <= y1 or image_w <= 0 or image_h <= 0:
            return None

        cx = (x1 + x2) / 2.0 / float(image_w)
        cy = (y1 + y2) / 2.0 / float(image_h)
        w = (x2 - x1) / float(image_w)
        h = (y2 - y1) / float(image_h)
        return [cx, cy, w, h]

    @staticmethod
    def _point_to_xyxy(
        x: float,
        y: float,
        image_w: int,
        image_h: int,
        point_box_size: float,
    ) -> tuple[float, float, float, float]:
        size = float(point_box_size)
        if size <= 0.0:
            size = 16.0
        # If value in (0, 1], treat it as ratio of min(image_w, image_h).
        if 0.0 < size <= 1.0:
            size = size * float(min(image_w, image_h))

        half = max(1.0, size / 2.0)
        x = float(x)
        y = float(y)
        return (x - half, y - half, x + half, y + half)

    @staticmethod
    def _extract_detections_from_state(
        state: dict[str, Any],
        image: Image.Image,
        label: str,
        class_id: int | None,
        include_mask_png: bool,
        max_detections: int,
        contour_mode: str = "split",
    ) -> list[dict[str, Any]]:
        boxes_tensor = state.get("boxes")
        scores_tensor = state.get("scores")
        masks_tensor = state.get("masks")

        detections: list[dict[str, Any]] = []
        if boxes_tensor is None or scores_tensor is None or len(boxes_tensor) == 0:
            return detections

        # Some runtimes return BF16 tensors; cast to float32 before numpy conversion
        # to avoid: "Got unsupported ScalarType BFloat16".
        boxes_np = boxes_tensor.detach().to(dtype=torch.float32).cpu().numpy()
        scores_np = scores_tensor.detach().to(dtype=torch.float32).cpu().numpy()
        masks_np: np.ndarray | None = None
        if masks_tensor is not None:
            masks_np = masks_tensor.detach().to(dtype=torch.float32).cpu().numpy()
            masks_np = (masks_np > 0).astype(np.uint8)
            if masks_np.ndim == 4:
                masks_np = masks_np[:, 0]

        order = np.argsort(-scores_np)
        if max_detections > 0:
            order = order[:max_detections]

        for det_idx, source_idx in enumerate(order, start=1):
            box = boxes_np[source_idx]
            x1, y1, x2, y2 = [float(v) for v in box.tolist()]
            x1 = max(0.0, min(float(image.width), x1))
            x2 = max(0.0, min(float(image.width), x2))
            y1 = max(0.0, min(float(image.height), y1))
            y2 = max(0.0, min(float(image.height), y2))
            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)

            base_id = f"det_{det_idx:04d}"
            mask = masks_np[source_idx] if (masks_np is not None and source_idx < len(masks_np)) else None
            base_payload: dict[str, Any] = {
                "id": base_id,
                "label": label,
                "score": round(float(scores_np[source_idx]), 6),
                "bbox_xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "area": None,
            }
            if class_id is not None:
                base_payload["class_id"] = int(class_id)

            if mask is None:
                detections.append(base_payload)
                continue

            components = split_mask_components(mask)
            contour_count = len(components)
            model_key = f"{label}:{int(class_id)}:{int(source_idx)}" if class_id is not None else ""

            if contour_mode == "merged":
                if not components:
                    detections.append(base_payload)
                    continue
                largest = max(components, key=lambda component: component.area)
                payload = dict(base_payload)
                payload.update(
                    {
                        "area": int(mask.sum()),
                        "polygon": largest.polygon,
                        "polygons": [component.polygon for component in components],
                        "model_det_id": base_id,
                        "contour_index": None,
                        "contour_count": contour_count,
                    }
                )
                if include_mask_png:
                    payload["mask_png_base64"] = mask_to_png_base64(mask)
                detections.append(payload)
                continue

            for contour_idx, component in enumerate(components, start=1):
                payload = dict(base_payload)
                payload.update(
                    {
                        "id": f"{base_id}_c{contour_idx:03d}",
                        "area": component.area,
                        "polygon": component.polygon,
                        "model_det_id": base_id,
                        "contour_index": contour_idx,
                        "contour_count": contour_count,
                    }
                )
                if model_key:
                    payload["_model_det_key"] = model_key
                if include_mask_png:
                    payload["mask_png_base64"] = mask_to_png_base64(component.mask)
                detections.append(payload)

        return detections

    @staticmethod
    def _split_text_prompt(prompt: str) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in str(prompt or "").split(","):
            name = raw.strip()
            if not name:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(name)
        return out

    def _build_batch_find_stage(self, batch_size: int):
        if self._find_stage_template is None:
            raise RuntimeError("SAM3 batch find stage template is not initialized")
        stage = copy.deepcopy(self._find_stage_template)
        device = self.settings.device
        stage.img_ids = torch.arange(batch_size, device=device, dtype=torch.long)
        stage.text_ids = torch.zeros(batch_size, device=device, dtype=torch.long)
        return stage

    def _build_official_postprocessor(self, threshold: float):
        if self._api_postprocessor_cls is None:
            raise RuntimeError("SAM3 official batch postprocessor is not initialized")
        return self._api_postprocessor_cls(
            max_dets_per_img=-1,
            iou_type="segm",
            use_original_sizes_box=True,
            use_original_sizes_mask=True,
            convert_mask_to_rle=False,
            detection_threshold=float(threshold),
            to_cpu=False,
        )

    @staticmethod
    def _transform_image_for_official_batch(image: Image.Image, input_size: int) -> torch.Tensor:
        tensor = TF.to_tensor(image.convert("RGB") if image.mode != "RGB" else image)
        tensor = TF.resize(
            tensor,
            [int(input_size), int(input_size)],
            antialias=True,
        )
        tensor = TF.normalize(tensor, mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5])
        return tensor

    @staticmethod
    def _pad_tensor_list_to_longest(
        tensors: list[torch.Tensor],
        *,
        dim: int = 0,
        pad_val: float | int = 0,
    ) -> list[torch.Tensor]:
        if not tensors:
            return tensors
        pad_len = max(t.shape[dim] for t in tensors)
        for idx, item in enumerate(tensors):
            n_dims = len(item.shape)
            n_right_dims = (n_dims - 1) - (n_dims + dim) % n_dims
            n_pad = pad_len - item.shape[dim]
            pad_tuple = tuple([0] * 2 * n_right_dims + [0, n_pad])
            tensors[idx] = torch.nn.functional.pad(item, pad_tuple, value=pad_val)
        return tensors

    @staticmethod
    def _packed_to_padded_naive(
        boxes_packed: torch.Tensor,
        num_boxes: torch.Tensor,
        *,
        fill_value: float | int = 0,
    ) -> torch.Tensor:
        batch_size = num_boxes.shape[0]
        counts = num_boxes.tolist()
        padded = boxes_packed.new_zeros(batch_size, max(counts), *boxes_packed.shape[1:])
        if fill_value != 0:
            padded[...] = fill_value
        prev_idx = 0
        for idx in range(batch_size):
            next_idx = prev_idx + counts[idx]
            padded[idx, : counts[idx]] = boxes_packed[prev_idx:next_idx]
            prev_idx = next_idx
        return padded

    def _build_official_text_batch(
        self,
        *,
        images: list[Image.Image],
        class_prompts: list[str],
        input_size: int,
    ) -> tuple[Any, dict[int, tuple[int, int, str]]]:
        if (
            self._api_batched_datapoint_cls is None
            or self._api_find_stage_cls is None
            or self._api_find_target_cls is None
            or self._api_batched_meta_cls is None
            or self._api_convert_my_tensors is None
        ):
            raise RuntimeError("SAM3 official batch data helpers are not initialized")

        img_batch = [
            self._transform_image_for_official_batch(image, input_size)
            for image in images
        ]
        stage = self._api_find_stage_cls(
            img_ids=[],
            text_ids=[],
            input_boxes=[],
            input_boxes_label=[],
            input_boxes_mask=[],
            input_points=[],
            input_points_mask=[],
            object_ids=[],
        )
        target = self._api_find_target_cls(
            num_boxes=[],
            boxes=[],
            boxes_padded=[],
            repeated_boxes=[],
            segments=None,
            semantic_segments=[],
            is_valid_segment=None,
            is_exhaustive=[],
            object_ids=[],
            object_ids_padded=[],
        )
        metadata = self._api_batched_meta_cls(
            coco_image_id=[],
            original_image_id=[],
            original_category_id=[],
            original_size=[],
            object_id=[],
            frame_index=[],
            is_conditioning_only=[],
        )

        text_batch: list[str] = []
        query_map: dict[int, tuple[int, int, str]] = {}
        query_id = 0
        for img_idx, image in enumerate(images):
            for class_idx, class_name in enumerate(class_prompts):
                query_id += 1
                query_map[query_id] = (img_idx, class_idx, class_name)
                if class_name not in text_batch:
                    text_batch.append(class_name)
                stage.img_ids.append(img_idx)
                stage.text_ids.append(text_batch.index(class_name))
                stage.input_boxes.append(torch.zeros(0, 4, dtype=torch.float32))
                stage.input_boxes_label.append(torch.zeros(0, dtype=torch.bool))
                stage.input_boxes_mask.append(torch.ones(0, dtype=torch.bool))
                stage.input_points.append(torch.empty(0, 257, dtype=torch.float32))
                stage.input_points_mask.append(torch.empty(0, dtype=torch.float32))
                stage.object_ids.append([])

                target.num_boxes.append(0)
                target.is_exhaustive.append(True)

                metadata.coco_image_id.append(query_id)
                metadata.original_image_id.append(query_id)
                metadata.original_category_id.append(class_idx + 1)
                metadata.original_size.append((int(image.height), int(image.width)))
                metadata.object_id.append(0)
                metadata.frame_index.append(0)
                metadata.is_conditioning_only.append(False)

        stage.input_points = self._pad_tensor_list_to_longest(
            stage.input_points,
            dim=0,
            pad_val=0,
        )
        stage.input_points_mask = self._pad_tensor_list_to_longest(
            stage.input_points_mask,
            dim=0,
            pad_val=1,
        )
        stage.input_boxes = self._pad_tensor_list_to_longest(
            stage.input_boxes,
            dim=0,
            pad_val=0,
        )
        stage.input_boxes_label = self._pad_tensor_list_to_longest(
            stage.input_boxes_label,
            dim=0,
            pad_val=0,
        )
        stage.input_boxes_mask = self._pad_tensor_list_to_longest(
            stage.input_boxes_mask,
            dim=0,
            pad_val=1,
        )

        stage = self._api_convert_my_tensors(stage)
        target = self._api_convert_my_tensors(target)
        metadata = self._api_convert_my_tensors(metadata)
        target.boxes_padded = self._packed_to_padded_naive(
            target.boxes.view(-1, 4),
            target.num_boxes,
        )
        target.object_ids_padded = self._packed_to_padded_naive(
            target.object_ids,
            target.num_boxes,
            fill_value=-1,
        )

        batch = self._api_batched_datapoint_cls(
            img_batch=torch.stack(img_batch, dim=0),
            find_text_batch=text_batch,
            find_inputs=[stage],
            find_targets=[target],
            find_metadatas=[metadata],
            raw_images=None,
        )
        return batch, query_map

    def infer_text_batch(
        self,
        images: list[Image.Image],
        prompt: str,
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        input_size: int | None = None,
        contour_mode: str = "split",
        save_ai_features: bool = False,
        feature_root: str = "",
        image_digests: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        self._ensure_model()
        if not images:
            raise ValueError("images must not be empty in text batch mode")

        class_prompts = self._split_text_prompt(prompt)
        if not class_prompts:
            raise ValueError("prompt must not be empty in text mode")

        start = time.perf_counter()
        use_size = self._normalize_input_size(
            input_size,
            default=self._default_processor_resolution,
        )
        feature_plans: list[dict[str, Any]] = []
        if save_ai_features:
            if use_size != self._default_processor_resolution:
                feature_plans = [{
                    "feature_status": "feature_failed",
                    "feature_error": "interactive features require the official 1008 input size",
                } for _ in images]
            elif len(image_digests or []) != len(images):
                feature_plans = [{
                    "feature_status": "feature_failed",
                    "feature_error": "image digest count does not match image count",
                } for _ in images]
            else:
                for image, digest in zip(images, image_digests or []):
                    try:
                        feature_plans.append(self._feature_plan(
                            image=image,
                            image_digest=str(digest),
                            feature_root=feature_root,
                        ))
                    except Exception as exc:
                        feature_plans.append(self._feature_failed({}, exc))

        prepared_feature_tensors: list[dict[str, torch.Tensor] | None] = [None] * len(images)
        with self._infer_lock, self._precision_context():
            if self._model is None or self._api_copy_to_device is None:
                raise RuntimeError("SAM3 official batch inference helpers are not initialized")

            postprocessor = self._build_official_postprocessor(float(threshold))
            batch, query_map = self._build_official_text_batch(
                images=images,
                class_prompts=class_prompts,
                input_size=use_size,
            )
            batch = self._api_copy_to_device(
                batch,
                torch.device(self.settings.device),
                non_blocking=True,
            )

            # Keep feature projection in the same inference context as the
            # backbone forward. PyTorch inference tensors cannot be consumed
            # by the decoder projection layers while autograd is enabled.
            with torch.inference_mode():
                outputs = self._model(batch)
                missing_indices = [
                    idx for idx, plan in enumerate(feature_plans)
                    if plan.get("feature_status") not in {"reused", "feature_failed"}
                ]
                if missing_indices:
                    try:
                        stage = outputs.output[0][-1]
                        sam2_out = stage["prev_encoder_out"]["backbone_out"]["sam2_backbone_out"]
                        all_features = self._interactive_features_from_sam2(
                            sam2_out, already_projected=False
                        )
                        for idx in missing_indices:
                            prepared_feature_tensors[idx] = {
                                name: tensor[idx:idx + 1].to(torch.bfloat16)
                                for name, tensor in all_features.items()
                            }
                    except Exception as exc:
                        for idx in missing_indices:
                            feature_plans[idx] = self._feature_failed(feature_plans[idx], exc)
                processed = postprocessor.process_results(outputs, batch.find_metadatas)

            per_image_detections: list[list[dict[str, Any]]] = [[] for _ in range(len(images))]
            for query_key, result in processed.items():
                img_idx, class_idx, class_name = query_map.get(int(query_key), (-1, -1, ""))
                if img_idx < 0 or img_idx >= len(images):
                    continue
                state_local = {
                    "boxes": result.get("boxes"),
                    "scores": result.get("scores"),
                    "masks": result.get("masks"),
                }
                class_dets = self._extract_detections_from_state(
                    state=state_local,
                    image=images[img_idx],
                    label=class_name,
                    class_id=class_idx,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    contour_mode=contour_mode,
                )
                per_image_detections[img_idx].extend(class_dets)

        feature_items: list[dict[str, Any]] = []
        for idx, plan in enumerate(feature_plans):
            tensors = prepared_feature_tensors[idx]
            if tensors is None:
                feature_items.append(plan)
                continue
            try:
                feature_items.append(self._queue_feature_write(plan, tensors))
            except Exception as exc:
                feature_items.append(self._feature_failed(plan, exc))

        results: list[dict[str, Any]] = []
        total_latency_ms = round((time.perf_counter() - start) * 1000.0, 3)
        for img_idx, image in enumerate(images):
            detections_all = per_image_detections[img_idx]
            detections_all.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
            if max_detections > 0:
                detections_all = detections_all[:max_detections]
            self._renumber_detection_ids(detections_all)
            item_result = {
                "model": "sam3",
                "device": self.settings.device,
                "mode": "text",
                "prompt": ", ".join(class_prompts),
                "threshold": float(threshold),
                "image": {
                    "width": int(image.width),
                    "height": int(image.height),
                    "input_size": int(use_size),
                },
                "num_detections": len(detections_all),
                "detections": detections_all,
                "latency_ms": total_latency_ms,
            }
            if feature_items:
                item_result["_feature"] = feature_items[img_idx]
            results.append(item_result)
        return results

    def infer(
        self,
        image: Image.Image,
        prompt: str,
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        mode: str = "text",
        points: list[tuple[float, float, bool]] | None = None,
        boxes: list[tuple[float, float, float, float, bool]] | None = None,
        point_box_size: float = 16.0,
        input_size: int | None = None,
        contour_mode: str = "split",
        save_ai_features: bool = False,
        feature_root: str = "",
        image_digest: str = "",
    ) -> dict[str, Any]:
        self._ensure_model()

        mode_norm = str(mode or "text").strip().lower()
        prompt_norm = str(prompt or "").strip()

        start = time.perf_counter()
        use_size = self._normalize_input_size(
            input_size, default=self._default_processor_resolution
        )
        feature_plan: dict[str, Any] = {}
        if save_ai_features:
            if use_size != self._default_processor_resolution:
                feature_plan = {
                    "feature_status": "feature_failed",
                    "feature_error": "interactive features require the official 1008 input size",
                }
            else:
                try:
                    feature_plan = self._feature_plan(
                        image=image,
                        image_digest=image_digest,
                        feature_root=feature_root,
                    )
                except Exception as exc:
                    feature_plan = self._feature_failed({}, exc)

        feature_tensors: dict[str, torch.Tensor] | None = None
        with self._infer_lock, self._precision_context():
            state: dict[str, Any] = {}
            processor = self._get_processor_for_size(input_size)
            processor.set_confidence_threshold(float(threshold))
            state = processor.set_image(image, state=state)

            if mode_norm == "text":
                class_prompts = self._split_text_prompt(prompt_norm)
                if not class_prompts:
                    raise ValueError("prompt must not be empty in text mode")

                detections_all: list[dict[str, Any]] = []
                for class_idx, class_name in enumerate(class_prompts):
                    state = processor.set_text_prompt(class_name, state=state)
                    class_dets = self._extract_detections_from_state(
                        state=state,
                        image=image,
                        label=class_name,
                        class_id=class_idx,
                        include_mask_png=include_mask_png,
                        max_detections=max_detections,
                        contour_mode=contour_mode,
                    )
                    detections_all.extend(class_dets)

                detections_all.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
                if max_detections > 0:
                    detections_all = detections_all[:max_detections]

                self._renumber_detection_ids(detections_all)
                detections = detections_all
                output_label = ", ".join(class_prompts)
            elif mode_norm in {"points", "point", "boxes", "box"}:
                if prompt_norm:
                    # Optional text hint. If empty, processor uses "visual".
                    state = processor.set_text_prompt(prompt_norm, state=state)

                if mode_norm in {"points", "point"}:
                    if not points:
                        raise ValueError("points must not be empty in points mode")
                    for x, y, label in points:
                        x1, y1, x2, y2 = self._point_to_xyxy(
                            x=x,
                            y=y,
                            image_w=image.width,
                            image_h=image.height,
                            point_box_size=point_box_size,
                        )
                        box_norm = self._xyxy_to_cxcywh_norm(
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                            image_w=image.width,
                            image_h=image.height,
                        )
                        if box_norm is None:
                            continue
                        state = processor.add_geometric_prompt(
                            box=box_norm,
                            label=bool(label),
                            state=state,
                        )
                else:
                    if not boxes:
                        raise ValueError("boxes must not be empty in boxes mode")
                    for x1, y1, x2, y2, label in boxes:
                        box_norm = self._xyxy_to_cxcywh_norm(
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                            image_w=image.width,
                            image_h=image.height,
                        )
                        if box_norm is None:
                            continue
                        state = processor.add_geometric_prompt(
                            box=box_norm,
                            label=bool(label),
                            state=state,
                        )
                output_label = prompt_norm or "visual"
                detections = self._extract_detections_from_state(
                    state=state,
                    image=image,
                    label=output_label,
                    class_id=None,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    contour_mode=contour_mode,
                )
            else:
                raise ValueError("mode must be one of: text, points, boxes")

            if feature_plan and feature_plan.get("feature_status") not in {"reused", "feature_failed"}:
                try:
                    sam2_out = state["backbone_out"]["sam2_backbone_out"]
                    feature_tensors = self._interactive_features_from_sam2(
                        sam2_out, already_projected=True
                    )
                    feature_tensors = {
                        name: tensor.to(torch.bfloat16)
                        for name, tensor in feature_tensors.items()
                    }
                except Exception as exc:
                    feature_plan = self._feature_failed(feature_plan, exc)

        latency_ms = round((time.perf_counter() - start) * 1000.0, 3)
        result = {
            "model": "sam3",
            "device": self.settings.device,
            "mode": "text" if mode_norm == "text" else ("points" if mode_norm in {"points", "point"} else "boxes"),
            "prompt": output_label,
            "threshold": float(threshold),
            "image": {
                "width": int(image.width),
                "height": int(image.height),
                "input_size": int(self._processor_resolution),
            },
            "num_detections": len(detections),
            "detections": detections,
            "latency_ms": latency_ms,
        }
        if feature_plan:
            if feature_tensors is not None:
                try:
                    result["_feature"] = self._queue_feature_write(feature_plan, feature_tensors)
                except Exception as exc:
                    result["_feature"] = self._feature_failed(feature_plan, exc)
            else:
                result["_feature"] = feature_plan
        return result


class Sam3VideoSessionEngine:
    """Thread-safe SAM3 video session engine."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._load_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._loaded = False
        self._predictor = None
        self._session_cleanup_paths: dict[str, Path] = {}
        self._dtype_patch_handles: list[Any] = []
        self._video_force_fp32_inputs = bool(getattr(settings, "video_force_fp32_inputs", True))
        self._video_disable_bf16_context = bool(getattr(settings, "video_disable_bf16_context", True))

    @property
    def loaded(self) -> bool:
        return self._loaded

    def warmup(self) -> None:
        self._ensure_predictor()

    def _ensure_predictor(self) -> None:
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            self._load_predictor()
            self._loaded = True

    def _load_predictor(self) -> None:
        checkpoint = self.settings.checkpoint_path
        if not checkpoint.exists() and not self.settings.load_from_hf:
            raise RuntimeError(
                "SAM3 checkpoint not found. "
                f"Current path: {checkpoint}. "
                "Place sam3.pt at this path or set SAM3_API_LOAD_FROM_HF=1."
            )

        logger.warning(
            "video runtime adapter config: conv_input_dtype_cast=%s, disable_bf16_context=%s, force_fp32_inputs=%s, request_bf16_autocast=%s, temporal_disambiguation=%s",
            bool(getattr(self.settings, "video_force_backbone_fpn_fp32", False)),
            self._video_disable_bf16_context,
            self._video_force_fp32_inputs,
            bool(getattr(self.settings, "video_enable_tracker_bf16_autocast", True)),
            bool(getattr(self.settings, "video_apply_temporal_disambiguation", False)),
        )
        try:
            bf16_ok = bool(torch.cuda.is_available() and torch.cuda.is_bf16_supported())
        except Exception:
            bf16_ok = False
        logger.warning(
            "video precision environment: device=%s cuda=%s bf16_supported=%s",
            str(self.settings.device),
            bool(torch.cuda.is_available()),
            bf16_ok,
        )

        from app.sam3_compat import Sam3CompatError, load_video_surface

        try:
            Sam3VideoPredictor = load_video_surface()["Sam3VideoPredictor"]
        except Sam3CompatError as exc:
            raise RuntimeError(
                "Failed to import SAM3 video runtime dependencies. "
                f"Original error: {exc}"
            ) from exc

        ckpt_path = str(checkpoint) if checkpoint.exists() else None
        try:
            self._predictor = Sam3VideoPredictor(
                checkpoint_path=ckpt_path,
                apply_temporal_disambiguation=bool(
                    getattr(self.settings, "video_apply_temporal_disambiguation", False)
                ),
            )
            if bool(getattr(self.settings, "video_force_backbone_fpn_fp32", False)):
                self._patch_video_model_runtime()
            self._maybe_disable_bf16_context()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"failed to load SAM3 video predictor: {exc}") from exc

    def _patch_module_input_dtype(self, module: Any, layer_name: str) -> bool:
        if module is None:
            return False
        if bool(getattr(module, "_sam3_api_input_cast_patched", False)):
            return False
        if not isinstance(
            module,
            (
                torch.nn.Conv1d,
                torch.nn.Conv2d,
                torch.nn.Conv3d,
                torch.nn.Linear,
            ),
        ):
            return False

        def _pre_hook(mod, args):
            # Runtime adapter only: align module input dtype to module weight dtype.
            # Keeps upstream SAM3 sources unchanged while avoiding BF16/FP32 mismatch.
            if not args:
                return None
            try:
                x = args[0]
                weight = getattr(mod, "weight", None)
                if torch.is_tensor(x) and torch.is_tensor(weight) and x.dtype != weight.dtype:
                    if len(args) == 1:
                        return (x.to(dtype=weight.dtype),)
                    return (x.to(dtype=weight.dtype), *args[1:])
            except Exception:
                return None
            return None

        handle = module.register_forward_pre_hook(_pre_hook)
        self._dtype_patch_handles.append(handle)
        setattr(module, "_sam3_api_input_cast_patched", True)
        return True

    def _patch_video_model_runtime(self) -> None:
        if self._predictor is None:
            return
        model = getattr(self._predictor, "model", None)
        if model is None:
            return
        patched = 0
        sample_names: list[str] = []
        for name, module in model.named_modules():
            if self._patch_module_input_dtype(module, name):
                patched += 1
                if len(sample_names) < 8:
                    sample_names.append(name)
        logger.warning(
            "patched video runtime dtype adapters: modules=%d sample=%s",
            patched,
            ",".join(sample_names),
        )

    def _maybe_disable_bf16_context(self) -> None:
        if not self._video_disable_bf16_context:
            return
        if self._predictor is None:
            return
        targets: list[Any] = [self._predictor]
        model = getattr(self._predictor, "model", None)
        if model is not None:
            targets.append(model)
            tracker = getattr(model, "tracker", None)
            detector = getattr(model, "detector", None)
            if tracker is not None:
                targets.append(tracker)
            if detector is not None:
                targets.append(detector)

        for obj in targets:
            ctx = getattr(obj, "bf16_context", None)
            if ctx is None:
                continue
            if bool(getattr(obj, "_sam3_api_bf16_disabled", False)):
                continue
            try:
                # Some SAM3 modules enable a process-wide BF16 autocast context in __init__.
                # Disable it here to avoid BF16/FP32 dtype mismatch in some CUDA environments.
                ctx.__exit__(None, None, None)
                setattr(obj, "_sam3_api_bf16_disabled", True)
            except Exception:
                # Best-effort only; continue with default behavior if context exit fails.
                pass

    def _autocast_guard(self):
        # IMPORTANT: autocast is thread-local. In API servers, request handlers usually run
        # in worker threads, so we must set autocast explicitly per request.
        if not torch.cuda.is_available():
            return nullcontext()
        # Compatibility mode: force-disable autocast and rely on FP32 path.
        if self._video_disable_bf16_context:
            return torch.autocast(device_type="cuda", enabled=False)
        # Official-aligned mode: explicit BF16 autocast on request thread.
        if bool(getattr(self.settings, "video_enable_tracker_bf16_autocast", True)):
            return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
        return nullcontext()

    def _get_session_state(self, session_id: str) -> dict[str, Any]:
        if not self._predictor:
            raise RuntimeError("video predictor is not loaded")
        session = self._predictor._ALL_INFERENCE_STATES.get(session_id)  # noqa: SLF001
        if not session or "state" not in session:
            raise RuntimeError(f"session not found: {session_id}")
        return session["state"]

    def _maybe_force_state_input_fp32(self, state: dict[str, Any]) -> None:
        if not self._video_force_fp32_inputs:
            return
        if not isinstance(state, dict):
            return
        input_batch = state.get("input_batch")
        if input_batch is None:
            return
        img_batch = getattr(input_batch, "img_batch", None)
        if img_batch is None:
            return
        if torch.is_tensor(img_batch):
            if img_batch.dtype != torch.float32:
                input_batch.img_batch = img_batch.to(dtype=torch.float32)
            return
        if isinstance(img_batch, (list, tuple)):
            changed = False
            converted: list[Any] = []
            for item in img_batch:
                if torch.is_tensor(item) and item.dtype != torch.float32:
                    converted.append(item.to(dtype=torch.float32))
                    changed = True
                else:
                    converted.append(item)
            if changed:
                input_batch.img_batch = tuple(converted) if isinstance(img_batch, tuple) else converted

    @staticmethod
    def _is_dtype_mismatch_error(exc: BaseException) -> bool:
        text = str(exc or "").lower()
        return (
            "input type (c10::bfloat16) and bias type (float) should be the same" in text
            or "input type (c10::half) and bias type (float) should be the same" in text
            or ("input type" in text and "bias type (float)" in text and "should be the same" in text)
        )

    def _force_state_fp32(self, state: dict[str, Any]) -> int:
        """Best-effort in-place cast of FP16/BF16 session tensors to FP32."""
        seen: set[int] = set()

        def _convert(obj: Any) -> tuple[Any, int]:
            obj_id = id(obj)
            if obj_id in seen:
                return obj, 0
            seen.add(obj_id)

            if torch.is_tensor(obj):
                if obj.dtype in (torch.float16, torch.bfloat16):
                    return obj.to(dtype=torch.float32), 1
                return obj, 0

            if isinstance(obj, dict):
                total = 0
                for k, v in list(obj.items()):
                    nv, n = _convert(v)
                    total += n
                    if nv is not v:
                        obj[k] = nv
                return obj, total

            if isinstance(obj, list):
                total = 0
                for i, v in enumerate(list(obj)):
                    nv, n = _convert(v)
                    total += n
                    if nv is not v:
                        obj[i] = nv
                return obj, total

            if isinstance(obj, tuple):
                total = 0
                changed = False
                out = []
                for v in obj:
                    nv, n = _convert(v)
                    total += n
                    changed = changed or (nv is not v)
                    out.append(nv)
                return (tuple(out) if changed else obj), total

            attrs = getattr(obj, "__dict__", None)
            if isinstance(attrs, dict):
                total = 0
                for name, v in list(attrs.items()):
                    nv, n = _convert(v)
                    total += n
                    if nv is not v:
                        try:
                            setattr(obj, name, nv)
                        except Exception:
                            pass
                return obj, total

            return obj, 0

        _, converted = _convert(state)
        return int(converted)

    @staticmethod
    def _to_norm_points(
        points: list[list[float | int]],
        image_w: int,
        image_h: int,
        normalized: bool,
    ) -> tuple[list[list[float]], list[int]]:
        pts: list[list[float]] = []
        labels: list[int] = []
        for item in points or []:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            x = float(item[0])
            y = float(item[1])
            label = int(item[2]) if len(item) > 2 else 1
            if not normalized:
                if image_w <= 0 or image_h <= 0:
                    continue
                x = x / float(image_w)
                y = y / float(image_h)
            x = max(0.0, min(1.0, x))
            y = max(0.0, min(1.0, y))
            pts.append([x, y])
            labels.append(1 if label > 0 else 0)
        return pts, labels

    @staticmethod
    def _to_norm_boxes_xywh(
        boxes: list[list[float | int]],
        image_w: int,
        image_h: int,
        normalized: bool,
    ) -> tuple[list[list[float]], list[int]]:
        out_boxes: list[list[float]] = []
        out_labels: list[int] = []
        for item in boxes or []:
            if not isinstance(item, (list, tuple)) or len(item) < 4:
                continue
            x1 = float(item[0])
            y1 = float(item[1])
            x2 = float(item[2])
            y2 = float(item[3])
            label = int(item[4]) if len(item) > 4 else 1

            if normalized:
                nx1, ny1, nx2, ny2 = x1, y1, x2, y2
            else:
                if image_w <= 0 or image_h <= 0:
                    continue
                nx1 = x1 / float(image_w)
                ny1 = y1 / float(image_h)
                nx2 = x2 / float(image_w)
                ny2 = y2 / float(image_h)

            nx1 = max(0.0, min(1.0, nx1))
            ny1 = max(0.0, min(1.0, ny1))
            nx2 = max(0.0, min(1.0, nx2))
            ny2 = max(0.0, min(1.0, ny2))
            if nx2 <= nx1 or ny2 <= ny1:
                continue

            out_boxes.append([nx1, ny1, nx2 - nx1, ny2 - ny1])
            out_labels.append(1 if label > 0 else 0)
        return out_boxes, out_labels

    @staticmethod
    def _outputs_to_detections(
        outputs: dict[str, Any],
        image_w: int,
        image_h: int,
        include_mask_png: bool,
        max_detections: int,
    ) -> list[dict[str, Any]]:
        obj_ids = outputs.get("out_obj_ids")
        probs = outputs.get("out_probs")
        boxes_xywh = outputs.get("out_boxes_xywh")
        binary_masks = outputs.get("out_binary_masks")
        if obj_ids is None or probs is None or boxes_xywh is None:
            return []

        obj_ids_arr = np.asarray(obj_ids)
        probs_arr = np.asarray(probs)
        boxes_arr = np.asarray(boxes_xywh)
        masks_arr = np.asarray(binary_masks) if binary_masks is not None else None
        if obj_ids_arr.size == 0:
            return []

        order = np.argsort(-probs_arr.astype(np.float32))
        if max_detections > 0:
            order = order[:max_detections]

        detections: list[dict[str, Any]] = []
        for det_idx, source_idx in enumerate(order, start=1):
            obj_id = int(obj_ids_arr[source_idx])
            score = float(probs_arr[source_idx])
            bx = boxes_arr[source_idx].tolist()
            x = float(bx[0]) * float(image_w)
            y = float(bx[1]) * float(image_h)
            w = float(bx[2]) * float(image_w)
            h = float(bx[3]) * float(image_h)
            x2 = x + w
            y2 = y + h
            base_id = f"det_{det_idx:04d}"
            base_payload: dict[str, Any] = {
                "id": base_id,
                "obj_id": obj_id,
                "label": f"obj_{obj_id}",
                "score": round(score, 6),
                "bbox_xyxy": [round(x, 2), round(y, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
                "area": None,
            }

            if masks_arr is None or source_idx >= len(masks_arr):
                detections.append(base_payload)
                continue

            mask = masks_arr[source_idx].astype(np.uint8)
            components = split_mask_components(mask)
            contour_count = len(components)
            for contour_idx, component in enumerate(components, start=1):
                payload = dict(base_payload)
                payload.update(
                    {
                        "id": f"{base_id}_c{contour_idx:03d}",
                        "area": component.area,
                        "polygon": component.polygon,
                        "model_det_id": base_id,
                        "contour_index": contour_idx,
                        "contour_count": contour_count,
                    }
                )
                if include_mask_png:
                    payload["mask_png_base64"] = mask_to_png_base64(component.mask)
                detections.append(payload)
        return detections

    def start_session(
        self,
        resource_path: str,
        session_id: Optional[str] = None,
        cleanup_resource_on_close: bool = False,
    ) -> dict[str, Any]:
        self._ensure_predictor()
        path = Path(str(resource_path or "")).expanduser().resolve()
        if not path.exists():
            raise ValueError(f"resource_path does not exist: {path}")

        request: dict[str, Any] = {"type": "start_session", "resource_path": str(path)}
        if session_id:
            request["session_id"] = str(session_id)

        with self._request_lock:
            with self._autocast_guard():
                resp = self._predictor.handle_request(request)
            sid = str(resp["session_id"])
            if cleanup_resource_on_close:
                self._session_cleanup_paths[sid] = path
            state = self._get_session_state(sid)
            self._maybe_force_state_input_fp32(state)
            return {
                "session_id": sid,
                "resource_path": str(path),
                "num_frames": int(state.get("num_frames", 0)),
                "width": int(state.get("orig_width", 0)),
                "height": int(state.get("orig_height", 0)),
            }

    def get_session_info(self, session_id: str) -> dict[str, Any]:
        self._ensure_predictor()
        with self._request_lock:
            state = self._get_session_state(session_id)
            return {
                "session_id": session_id,
                "num_frames": int(state.get("num_frames", 0)),
                "width": int(state.get("orig_width", 0)),
                "height": int(state.get("orig_height", 0)),
                "has_text_prompt": bool(state.get("text_prompt")),
            }

    def add_prompt(
        self,
        *,
        session_id: str,
        frame_index: int,
        text: Optional[str],
        points: list[list[float | int]],
        boxes: list[list[float | int]],
        obj_id: Optional[int],
        normalized: bool,
        include_mask_png: bool,
        max_detections: int,
    ) -> dict[str, Any]:
        self._ensure_predictor()
        with self._request_lock:
            state = self._get_session_state(session_id)
            self._maybe_force_state_input_fp32(state)
            image_w = int(state.get("orig_width", 0))
            image_h = int(state.get("orig_height", 0))

            req: dict[str, Any] = {
                "type": "add_prompt",
                "session_id": session_id,
                "frame_index": int(frame_index),
            }
            text_norm = str(text or "").strip()
            if text_norm:
                req["text"] = text_norm

            if points:
                pts, point_labels = self._to_norm_points(points, image_w, image_h, normalized)
                if not pts:
                    raise ValueError("invalid points payload")
                req["points"] = pts
                req["point_labels"] = point_labels

            if boxes:
                bxs, box_labels = self._to_norm_boxes_xywh(boxes, image_w, image_h, normalized)
                if not bxs:
                    raise ValueError("invalid boxes payload")
                req["bounding_boxes"] = bxs
                req["bounding_box_labels"] = box_labels

            # Keep object identity stable for visual prompts in video mode.
            # Without obj_id, some runtimes only return prompt-frame outputs and
            # fail to propagate meaningful tracking across subsequent frames.
            if ("points" in req) or ("bounding_boxes" in req):
                # Do not mix placeholder text with visual prompts.
                # web-auto used to pass text='visual', which can route to an
                # unintended path in some predictor builds.
                if str(req.get("text", "")).strip().lower() in {"visual"}:
                    req.pop("text", None)
                req["obj_id"] = int(obj_id) if obj_id is not None else 1

            if "points" not in req and "bounding_boxes" not in req and "text" not in req:
                raise ValueError("add_prompt requires at least one of text/points/boxes")

            try:
                with self._autocast_guard():
                    resp = self._predictor.handle_request(req)
            except RuntimeError as exc:
                if not self._is_dtype_mismatch_error(exc):
                    raise
                # In official BF16 mode, do not silently switch precision path.
                # Only apply FP32 retry in explicit compatibility mode.
                compat_mode = (
                    self._video_force_fp32_inputs
                    or self._video_disable_bf16_context
                    or bool(getattr(self.settings, "video_force_backbone_fpn_fp32", False))
                )
                if not compat_mode:
                    raise
                converted = self._force_state_fp32(state)
                self._maybe_disable_bf16_context()
                logger.warning(
                    "video add_prompt dtype mismatch; forced FP32 tensors=%d and retry once",
                    converted,
                )
                with self._autocast_guard():
                    resp = self._predictor.handle_request(req)
            frame_idx = int(resp.get("frame_index", frame_index))
            outputs = resp.get("outputs", {}) if isinstance(resp, dict) else {}
            detections = self._outputs_to_detections(
                outputs=outputs,
                image_w=image_w,
                image_h=image_h,
                include_mask_png=include_mask_png,
                max_detections=max(0, int(max_detections)),
            )
            return {
                "session_id": session_id,
                "frame_index": frame_idx,
                "num_detections": len(detections),
                "detections": detections,
            }

    def propagate(
        self,
        *,
        session_id: str,
        propagation_direction: str,
        start_frame_index: Optional[int],
        max_frame_num_to_track: Optional[int],
        include_mask_png: bool,
        max_detections: int,
        max_frames: int,
    ) -> dict[str, Any]:
        self._ensure_predictor()
        direction = str(propagation_direction or "forward").strip().lower()
        if direction not in {"both", "forward", "backward"}:
            raise ValueError("propagation_direction must be one of: both, forward, backward")

        with self._request_lock:
            state = self._get_session_state(session_id)
            self._maybe_force_state_input_fp32(state)
            image_w = int(state.get("orig_width", 0))
            image_h = int(state.get("orig_height", 0))

            req: dict[str, Any] = {
                "type": "propagate_in_video",
                "session_id": session_id,
                "propagation_direction": direction,
            }
            if start_frame_index is not None:
                req["start_frame_index"] = int(start_frame_index)
            if max_frame_num_to_track is not None:
                req["max_frame_num_to_track"] = int(max_frame_num_to_track)

            t0 = time.perf_counter()
            frames: list[dict[str, Any]] = []
            truncated = False
            with self._autocast_guard():
                for item in self._predictor.handle_stream_request(req):
                    frame_idx = int(item.get("frame_index"))
                    outputs = item.get("outputs", {}) if isinstance(item, dict) else {}
                    detections = self._outputs_to_detections(
                        outputs=outputs,
                        image_w=image_w,
                        image_h=image_h,
                        include_mask_png=include_mask_png,
                        max_detections=max(0, int(max_detections)),
                    )
                    frames.append(
                        {
                            "frame_index": frame_idx,
                            "num_detections": len(detections),
                            "detections": detections,
                        }
                    )
                    if max_frames and max_frames > 0 and len(frames) >= int(max_frames):
                        truncated = True
                        break
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 3)
            return {
                "session_id": session_id,
                "num_frames": len(frames),
                "frames": frames,
                "truncated": truncated,
                "latency_ms": latency_ms,
            }

    def remove_object(self, session_id: str, obj_id: int, is_user_action: bool = True) -> dict[str, Any]:
        self._ensure_predictor()
        with self._request_lock:
            with self._autocast_guard():
                return self._predictor.handle_request(
                    {
                        "type": "remove_object",
                        "session_id": session_id,
                        "obj_id": int(obj_id),
                        "is_user_action": bool(is_user_action),
                    }
                )

    def reset_session(self, session_id: str) -> dict[str, Any]:
        self._ensure_predictor()
        with self._request_lock:
            with self._autocast_guard():
                return self._predictor.handle_request({"type": "reset_session", "session_id": session_id})

    def close_session(self, session_id: str) -> dict[str, Any]:
        self._ensure_predictor()
        with self._request_lock:
            with self._autocast_guard():
                resp = self._predictor.handle_request({"type": "close_session", "session_id": session_id})
            cleanup_path = self._session_cleanup_paths.pop(str(session_id), None)
            if cleanup_path is not None:
                try:
                    cleanup_path.unlink(missing_ok=True)
                except Exception:
                    pass
            return resp
