import copy
import sys
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Optional

import numpy as np
import torch
from PIL import Image
import logging
from torchvision.transforms import functional as TF

from app.config import Settings
from app.utils import mask_to_png_base64, mask_to_polygon

logger = logging.getLogger("sam3_api")


class Sam3InferenceEngine:
    """Thread-safe SAM3 inference engine with lazy model loading."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._loaded = False
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

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def default_input_size(self) -> int:
        return int(self._default_processor_resolution)

    def warmup(self) -> None:
        self._ensure_model()

    def _ensure_model(self) -> None:
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return
            self._load_model()
            self._loaded = True

    def _load_model(self) -> None:
        checkpoint = self.settings.checkpoint_path
        if not checkpoint.exists() and not self.settings.load_from_hf:
            raise RuntimeError(
                "SAM3 checkpoint not found. "
                f"Current path: {checkpoint}. "
                "Place sam3.pt at this path or set SAM3_API_LOAD_FROM_HF=1."
            )

        project_root_str = str(self.settings.project_root)
        if project_root_str not in sys.path:
            sys.path.insert(0, project_root_str)

        try:
            from sam3.model.sam3_image_processor import Sam3Processor
            from sam3.model_builder import build_sam3_image_model
            from sam3.eval.postprocessors import PostProcessImage
            from sam3.model.data_misc import (
                BatchedDatapoint,
                BatchedFindTarget,
                BatchedInferenceMetadata,
                FindStage,
                convert_my_tensors,
            )
            from sam3.model.utils.misc import copy_data_to_device
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "Failed to import SAM3 runtime dependencies. "
                "Please install torch/torchvision/timm/huggingface_hub/iopath/einops/etc. "
                f"Original error: {type(exc).__name__}: {exc}"
            ) from exc

        checkpoint_path = str(checkpoint) if checkpoint.exists() else None
        self._model = build_sam3_image_model(
            checkpoint_path=checkpoint_path,
            load_from_HF=self.settings.load_from_hf,
            device=self.settings.device,
            eval_mode=True,
            compile=self.settings.compile_model,
        )
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

            mask = masks_np[source_idx] if (masks_np is not None and source_idx < len(masks_np)) else None
            area = int(mask.sum()) if mask is not None else None
            polygon = mask_to_polygon(mask) if mask is not None else []

            payload: dict[str, Any] = {
                "id": f"det_{det_idx:04d}",
                "label": label,
                "score": round(float(scores_np[source_idx]), 6),
                "bbox_xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "area": area,
            }
            if class_id is not None:
                payload["class_id"] = int(class_id)
            if polygon:
                payload["polygon"] = polygon
            if include_mask_png and mask is not None:
                payload["mask_png_base64"] = mask_to_png_base64(mask)
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
        with self._infer_lock:
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

            with torch.inference_mode():
                outputs = self._model(batch)
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
                )
                per_image_detections[img_idx].extend(class_dets)

            results: list[dict[str, Any]] = []
            total_latency_ms = round((time.perf_counter() - start) * 1000.0, 3)
            for img_idx, image in enumerate(images):
                detections_all = per_image_detections[img_idx]
                detections_all.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
                if max_detections > 0:
                    detections_all = detections_all[:max_detections]
                for det_idx, det in enumerate(detections_all, start=1):
                    det["id"] = f"det_{det_idx:04d}"
                results.append(
                    {
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
                )
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
    ) -> dict[str, Any]:
        self._ensure_model()

        mode_norm = str(mode or "text").strip().lower()
        prompt_norm = str(prompt or "").strip()

        start = time.perf_counter()

        with self._infer_lock:
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
                    )
                    detections_all.extend(class_dets)

                detections_all.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
                if max_detections > 0:
                    detections_all = detections_all[:max_detections]

                for idx, det in enumerate(detections_all, start=1):
                    det["id"] = f"det_{idx:04d}"
                detections = detections_all
                output_label = ", ".join(class_prompts)
            elif mode_norm in {"points", "point", "boxes", "box"}:
                if prompt_norm:
                    # Optional text hint. If empty, processor uses "visual".
                    state = self._processor.set_text_prompt(prompt_norm, state=state)

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
                )
            else:
                raise ValueError("mode must be one of: text, points, boxes")

        latency_ms = round((time.perf_counter() - start) * 1000.0, 3)
        return {
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

        project_root_str = str(self.settings.project_root)
        if project_root_str not in sys.path:
            sys.path.insert(0, project_root_str)

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

        try:
            from sam3.model.sam3_video_predictor import Sam3VideoPredictor
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "Failed to import SAM3 video runtime dependencies. "
                f"Original error: {type(exc).__name__}: {exc}"
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
            polygon: list[list[float]] = []
            area: Optional[int] = None
            mask_b64: Optional[str] = None

            if masks_arr is not None and source_idx < len(masks_arr):
                mask = masks_arr[source_idx].astype(np.uint8)
                area = int(mask.sum())
                polygon = mask_to_polygon(mask)
                if include_mask_png:
                    mask_b64 = mask_to_png_base64(mask)

            payload: dict[str, Any] = {
                "id": f"det_{det_idx:04d}",
                "obj_id": obj_id,
                "label": f"obj_{obj_id}",
                "score": round(score, 6),
                "bbox_xyxy": [round(x, 2), round(y, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
                "area": area,
                "polygon": polygon if polygon else None,
            }
            if mask_b64:
                payload["mask_png_base64"] = mask_b64
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
