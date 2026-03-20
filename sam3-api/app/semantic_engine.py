from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
import torchvision
from PIL import Image
from ultralytics.models.sam import SAM3SemanticPredictor
from ultralytics.models.sam.modules.sam import SAM2Model
from ultralytics.utils import ops

from app.config import Settings
from app.utils import mask_to_png_base64, mask_to_polygon


class Sam3SemanticEngine:
    """Official SAM3 semantic inference engine for current-image and exemplar propagation."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._loaded = False
        self._predictor: SAM3SemanticPredictor | None = None
        self._default_imgsz: int = 0

    @staticmethod
    def _normalize_input_size(input_size: int | None) -> int | None:
        try:
            value = int(input_size or 0)
        except Exception:
            value = 0
        if value <= 0:
            return None
        return max(128, value)

    def _apply_input_size(self, input_size: int | None) -> None:
        assert self._predictor is not None
        use_size = self._normalize_input_size(input_size)
        if use_size is None:
            use_size = int(self._default_imgsz or 0)
        if use_size > 0:
            self._predictor.args.imgsz = int(use_size)

    @property
    def loaded(self) -> bool:
        return self._loaded

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
                "SAM3 semantic checkpoint not found. "
                f"Current path: {checkpoint}. "
                "Place sam3.pt at this path or set SAM3_API_LOAD_FROM_HF=1."
            )
        predictor = SAM3SemanticPredictor(
            overrides={
                "model": str(checkpoint),
                "device": self.settings.device,
                "conf": float(self.settings.default_threshold),
                "iou": 0.45,
                "verbose": False,
            }
        )
        predictor.setup_model(verbose=False)
        self._predictor = predictor
        try:
            self._default_imgsz = int(getattr(predictor.args, "imgsz", 0) or 0)
        except Exception:
            self._default_imgsz = 0

    @staticmethod
    def _image_to_bgr(image: Image.Image) -> np.ndarray:
        rgb = image.convert("RGB")
        return np.asarray(rgb)[:, :, ::-1].copy()

    @staticmethod
    def _clone_tree(value: Any) -> Any:
        if isinstance(value, torch.Tensor):
            return value.detach().clone()
        if isinstance(value, list):
            return [Sam3SemanticEngine._clone_tree(item) for item in value]
        if isinstance(value, tuple):
            return tuple(Sam3SemanticEngine._clone_tree(item) for item in value)
        if isinstance(value, dict):
            return {k: Sam3SemanticEngine._clone_tree(v) for k, v in value.items()}
        return value

    @staticmethod
    def _boxes_to_xyxy_and_labels(
        boxes: list[tuple[float, float, float, float, bool]] | None,
    ) -> tuple[list[list[float]], list[int]]:
        out_boxes: list[list[float]] = []
        out_labels: list[int] = []
        for item in boxes or []:
            if len(item) < 5:
                continue
            x1, y1, x2, y2, label = item
            x1 = float(x1)
            y1 = float(y1)
            x2 = float(x2)
            y2 = float(y2)
            if x2 <= x1 or y2 <= y1:
                continue
            out_boxes.append([x1, y1, x2, y2])
            out_labels.append(1 if bool(label) else 0)
        return out_boxes, out_labels

    @staticmethod
    def _normalize_prompt_text(prompt: str | None) -> tuple[str, str, list[str] | None]:
        prompt_norm = str(prompt or "").strip()
        if prompt_norm:
            return prompt_norm, prompt_norm, [prompt_norm]
        return "", "visual", None

    @staticmethod
    def _image_hw_from_dataset(predictor: SAM3SemanticPredictor) -> tuple[int, int]:
        batch = next(iter(predictor.dataset))
        shape = batch[1][0].shape[:2]
        return int(shape[0]), int(shape[1])

    @staticmethod
    def _sort_limit(indices: list[int], scores: list[float], max_detections: int) -> list[int]:
        order = sorted(indices, key=lambda idx: scores[idx], reverse=True)
        if max_detections > 0:
            order = order[:max_detections]
        return order

    def _extract_detections(
        self,
        *,
        pred_masks: torch.Tensor | None,
        pred_boxes: torch.Tensor,
        label: str,
        include_mask_png: bool,
        max_detections: int,
    ) -> list[dict[str, Any]]:
        if pred_boxes is None or pred_boxes.numel() == 0:
            return []

        scores = [float(pred_boxes[idx][4].item()) for idx in range(int(pred_boxes.shape[0]))]
        order = self._sort_limit(list(range(len(scores))), scores, max_detections)
        detections: list[dict[str, Any]] = []
        for det_idx, source_idx in enumerate(order, start=1):
            box = pred_boxes[source_idx]
            x1 = float(box[0].item())
            y1 = float(box[1].item())
            x2 = float(box[2].item())
            y2 = float(box[3].item())
            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)

            mask_arr: np.ndarray | None = None
            if pred_masks is not None and source_idx < int(pred_masks.shape[0]):
                mask_arr = pred_masks[source_idx].detach().to(device="cpu").numpy().astype(np.uint8)
            polygon = mask_to_polygon(mask_arr) if mask_arr is not None else []
            area = int(mask_arr.sum()) if mask_arr is not None else None

            payload: dict[str, Any] = {
                "id": f"det_{det_idx:04d}",
                "label": label,
                "score": round(float(box[4].item()), 6),
                "bbox_xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "area": area,
            }
            if polygon:
                payload["polygon"] = polygon
            if include_mask_png and mask_arr is not None:
                payload["mask_png_base64"] = mask_to_png_base64(mask_arr)
            detections.append(payload)
        return detections

    def _current_semantic_impl(
        self,
        *,
        image: Image.Image,
        prompt: str,
        boxes: list[tuple[float, float, float, float, bool]],
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        input_size: int | None = None,
    ) -> dict[str, Any]:
        assert self._predictor is not None
        prompt_boxes, prompt_labels = self._boxes_to_xyxy_and_labels(boxes)
        if not prompt_boxes or not any(prompt_labels):
            raise ValueError("semantic inference requires at least one positive box")
        prompt_norm, result_prompt, text_batch = self._normalize_prompt_text(prompt)

        start = time.perf_counter()
        with torch.inference_mode():
            self._apply_input_size(input_size)
            self._predictor.args.conf = float(threshold)
            self._predictor.reset_prompts()
            self._predictor.set_image(self._image_to_bgr(image))
            src_shape = self._image_hw_from_dataset(self._predictor)
            backbone_out = self._clone_tree(self._predictor.features)
            pred_masks, pred_boxes = self._predictor.inference_features(
                features=backbone_out,
                src_shape=src_shape,
                bboxes=prompt_boxes,
                labels=prompt_labels,
                text=text_batch,
            )

            detections = self._extract_detections(
                pred_masks=pred_masks,
                pred_boxes=pred_boxes,
                label=result_prompt,
                include_mask_png=include_mask_png,
                max_detections=max_detections,
            )

        return {
            "model": "sam3-semantic",
            "device": self.settings.device,
            "mode": "semantic",
            "prompt": result_prompt,
            "threshold": float(threshold),
            "image": {"width": int(image.width), "height": int(image.height), "input_size": int(getattr(self._predictor.args, "imgsz", 0) or 0)},
            "num_detections": len(detections),
            "detections": detections,
            "latency_ms": round((time.perf_counter() - start) * 1000.0, 3),
        }

    def _build_example_prompt(
        self,
        *,
        source_image: Image.Image,
        boxes: list[tuple[float, float, float, float, bool]],
        input_size: int | None = None,
    ) -> dict[str, torch.Tensor]:
        assert self._predictor is not None
        prompt_boxes, prompt_labels = self._boxes_to_xyxy_and_labels(boxes)
        if not prompt_boxes or not any(prompt_labels):
            raise ValueError("example propagation requires at least one positive box")

        self._apply_input_size(input_size)
        self._predictor.reset_prompts()
        self._predictor.set_image(self._image_to_bgr(source_image))
        source_shape = self._image_hw_from_dataset(self._predictor)
        bboxes, labels = self._predictor._prepare_geometric_prompts(source_shape, prompt_boxes, prompt_labels)
        geometric_prompt = self._predictor._get_dummy_prompt(1)
        for idx in range(len(bboxes)):
            geometric_prompt.append_boxes(bboxes[[idx]], labels[[idx]])

        source_backbone = self._clone_tree(self._predictor.features)
        _, img_feats, img_pos_embeds, vis_feat_sizes = SAM2Model._prepare_backbone_features(
            self._predictor.model, source_backbone, batch=1
        )
        visual_prompt_embed, visual_prompt_mask = self._predictor.model._encode_prompt(
            img_feats,
            img_pos_embeds,
            vis_feat_sizes,
            geometric_prompt,
        )
        return {
            "visual_prompt_embed": visual_prompt_embed.detach().clone(),
            "visual_prompt_mask": visual_prompt_mask.detach().clone(),
        }

    def _infer_with_example_prompt(
        self,
        *,
        image: Image.Image,
        prompt: str,
        example_prompt: dict[str, torch.Tensor],
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        input_size: int | None = None,
    ) -> dict[str, Any]:
        assert self._predictor is not None
        prompt_norm, result_prompt, text_batch = self._normalize_prompt_text(prompt)
        visual_prompt_embed = example_prompt.get("visual_prompt_embed")
        visual_prompt_mask = example_prompt.get("visual_prompt_mask")
        if not isinstance(visual_prompt_embed, torch.Tensor) or not isinstance(visual_prompt_mask, torch.Tensor):
            raise ValueError("invalid example prompt payload")

        start = time.perf_counter()
        with torch.inference_mode():
            self._apply_input_size(input_size)
            self._predictor.args.conf = float(threshold)
            self._predictor.reset_prompts()
            self._predictor.set_image(self._image_to_bgr(image))
            src_shape = self._image_hw_from_dataset(self._predictor)
            backbone_out = self._clone_tree(self._predictor.features)

            self._predictor.model.set_classes(text=[result_prompt] if text_batch is None else text_batch)
            backbone_out, img_feats, img_pos_embeds, vis_feat_sizes = SAM2Model._prepare_backbone_features(
                self._predictor.model, backbone_out, batch=1
            )
            backbone_out.update({k: v for k, v in self._predictor.model.text_embeddings.items()})

            prompt_embed, prompt_mask = self._predictor.model._encode_prompt(
                img_feats,
                img_pos_embeds,
                vis_feat_sizes,
                self._predictor._get_dummy_prompt(1),
                visual_prompt_embed=visual_prompt_embed.to(device=self._predictor.device),
                visual_prompt_mask=visual_prompt_mask.to(device=self._predictor.device),
            )
            text_ids = torch.arange(1, device=self._predictor.device, dtype=torch.long)
            txt_feats = backbone_out["language_features"][:, text_ids]
            txt_masks = backbone_out["language_mask"][text_ids]
            prompt_embed = torch.cat([txt_feats, prompt_embed], dim=0)
            prompt_mask = torch.cat([txt_masks, prompt_mask], dim=1)

            encoder_out = self._predictor.model._run_encoder(
                img_feats, img_pos_embeds, vis_feat_sizes, prompt_embed, prompt_mask
            )
            out: dict[str, Any] = {"backbone_out": backbone_out}
            out, hs = self._predictor.model._run_decoder(
                memory=encoder_out["encoder_hidden_states"],
                pos_embed=encoder_out["pos_embed"],
                src_mask=encoder_out["padding_mask"],
                out=out,
                prompt=prompt_embed,
                prompt_mask=prompt_mask,
                encoder_out=encoder_out,
            )
            self._predictor.model._run_segmentation_heads(
                out=out,
                backbone_out=backbone_out,
                encoder_hidden_states=encoder_out["encoder_hidden_states"],
                prompt=prompt_embed,
                prompt_mask=prompt_mask,
                hs=hs,
            )

            pred_boxes = out["pred_boxes"].detach().to(dtype=torch.float32)
            pred_logits = out["pred_logits"].detach().to(dtype=torch.float32)
            pred_masks = out["pred_masks"]
            pred_scores = pred_logits.sigmoid()
            presence_score = out["presence_logit_dec"].detach().to(dtype=torch.float32).sigmoid().unsqueeze(1)
            pred_scores = (pred_scores * presence_score).squeeze(-1)
            pred_cls = torch.tensor(
                list(range(pred_scores.shape[0])),
                dtype=pred_scores.dtype,
                device=pred_scores.device,
            )[:, None].expand_as(pred_scores)
            pred_boxes = torch.cat([pred_boxes, pred_scores[..., None], pred_cls[..., None]], dim=-1)

            keep = pred_scores > self._predictor.args.conf
            pred_masks, pred_boxes = pred_masks[keep], pred_boxes[keep]
            if pred_boxes.numel() > 0:
                pred_boxes[:, :4] = ops.xywh2xyxy(pred_boxes[:, :4])
                c = pred_boxes[:, 5:6] * 7680
                keep = torchvision.ops.nms(pred_boxes[:, :4] + c, pred_boxes[:, 4], float(self._predictor.args.iou))
                pred_boxes, pred_masks = pred_boxes[keep], pred_masks[keep]
            if pred_masks is not None and pred_masks.shape[0] > 0:
                pred_masks = F.interpolate(pred_masks.float()[None], src_shape, mode="bilinear")[0] > 0.5
                pred_boxes[..., 0] *= src_shape[1]
                pred_boxes[..., 1] *= src_shape[0]
                pred_boxes[..., 2] *= src_shape[1]
                pred_boxes[..., 3] *= src_shape[0]

            detections = self._extract_detections(
                pred_masks=pred_masks,
                pred_boxes=pred_boxes,
                label=result_prompt,
                include_mask_png=include_mask_png,
                max_detections=max_detections,
            )

        return {
            "model": "sam3-semantic",
            "device": self.settings.device,
            "mode": "semantic_batch",
            "prompt": result_prompt,
            "threshold": float(threshold),
            "image": {"width": int(image.width), "height": int(image.height), "input_size": int(getattr(self._predictor.args, "imgsz", 0) or 0)},
            "num_detections": len(detections),
            "detections": detections,
            "latency_ms": round((time.perf_counter() - start) * 1000.0, 3),
        }

    def infer_current(
        self,
        *,
        image: Image.Image,
        prompt: str,
        boxes: list[tuple[float, float, float, float, bool]],
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        input_size: int | None = None,
    ) -> dict[str, Any]:
        self._ensure_model()
        with self._infer_lock:
            return self._current_semantic_impl(
                image=image,
                prompt=prompt,
                boxes=boxes,
                threshold=threshold,
                include_mask_png=include_mask_png,
                max_detections=max_detections,
                input_size=input_size,
            )

    def infer_batch(
        self,
        *,
        source_image: Image.Image,
        prompt: str,
        boxes: list[tuple[float, float, float, float, bool]],
        targets: list[tuple[str, Image.Image]],
        threshold: float,
        include_mask_png: bool,
        max_detections: int,
        input_size: int | None = None,
    ) -> list[dict[str, Any]]:
        self._ensure_model()
        with self._infer_lock:
            example_prompt = self._build_example_prompt(source_image=source_image, boxes=boxes, input_size=input_size)
            items: list[dict[str, Any]] = []
            for filename, image in targets:
                result = self._infer_with_example_prompt(
                    image=image,
                    prompt=prompt,
                    example_prompt=example_prompt,
                    threshold=threshold,
                    include_mask_png=include_mask_png,
                    max_detections=max_detections,
                    input_size=input_size,
                )
                items.append({"filename": filename, "result": result})
            return items
