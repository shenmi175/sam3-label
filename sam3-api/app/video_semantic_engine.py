from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from ultralytics.models.sam import SAM3VideoSemanticPredictor
from ultralytics.models.sam.amg import batched_mask_to_box

from app.config import Settings
from app.utils import mask_to_png_base64, mask_to_polygon


class Sam3VideoSemanticSessionEngine:
    """Ultralytics SAM3 semantic video session engine."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._load_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._loaded = False
        self._predictor: SAM3VideoSemanticPredictor | None = None
        self._default_imgsz: int = 0
        self._sessions: dict[str, dict[str, Any]] = {}
        self._session_cleanup_paths: dict[str, Path] = {}
        self._active_source_key: str = ""

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
                "SAM3 semantic video checkpoint not found. "
                f"Current path: {checkpoint}. "
                "Place sam3.pt at this path or set SAM3_API_LOAD_FROM_HF=1."
            )

        predictor = SAM3VideoSemanticPredictor(
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
    def _normalize_threshold(threshold: float | None, default: float) -> float:
        value = float(default if threshold is None else threshold)
        if value < 0.0 or value > 1.0:
            raise ValueError("threshold must be in [0, 1]")
        return value

    def _normalize_imgsz(self, imgsz: int | None) -> int:
        try:
            value = int(imgsz or 0)
        except Exception:
            value = 0
        if value <= 0:
            value = int(self._default_imgsz or 640)
        return max(128, value)

    @staticmethod
    def _split_text_prompt(prompt: str | list[str] | None) -> list[str]:
        if isinstance(prompt, list):
            raw_items = prompt
        else:
            raw_items = str(prompt or "").split(",")
        seen: set[str] = set()
        out: list[str] = []
        for raw in raw_items:
            item = str(raw or "").strip()
            if not item:
                continue
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out

    @staticmethod
    def _current_imgsz(predictor: SAM3VideoSemanticPredictor) -> list[int]:
        raw = getattr(predictor, "imgsz", None)
        if isinstance(raw, int):
            return [int(raw), int(raw)]
        if isinstance(raw, (list, tuple)):
            values = [int(v) for v in raw if int(v) > 0]
            if len(values) == 1:
                return [values[0], values[0]]
            if len(values) >= 2:
                return [values[0], values[1]]
        arg_raw = getattr(getattr(predictor, "args", None), "imgsz", None)
        if isinstance(arg_raw, int):
            return [int(arg_raw), int(arg_raw)]
        return [640, 640]

    @staticmethod
    def _probe_video(resource_path: Path) -> tuple[int, int, int]:
        cap = cv2.VideoCapture(str(resource_path))
        if not cap.isOpened():
            raise RuntimeError(f"failed to open video: {resource_path}")
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        num_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        cap.release()
        if width <= 0 or height <= 0 or num_frames <= 0:
            raise RuntimeError(f"invalid video metadata: {resource_path}")
        return num_frames, width, height

    @staticmethod
    def _read_video_frame_bgr(resource_path: str, frame_index: int) -> np.ndarray:
        cap = cv2.VideoCapture(str(resource_path))
        if not cap.isOpened():
            raise RuntimeError(f"failed to open video: {resource_path}")
        idx = max(0, int(frame_index))
        ok_seek = cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        if not ok_seek:
            cap.release()
            raise RuntimeError(f"failed to seek frame index: {idx}")
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            raise RuntimeError(f"failed to read frame index: {idx}")
        return frame

    @staticmethod
    def _normalize_boxes_xyxy(
        boxes: list[list[float | int]],
        *,
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
                x1 *= float(image_w)
                y1 *= float(image_h)
                x2 *= float(image_w)
                y2 *= float(image_h)
            x1 = max(0.0, min(float(image_w), x1))
            y1 = max(0.0, min(float(image_h), y1))
            x2 = max(0.0, min(float(image_w), x2))
            y2 = max(0.0, min(float(image_h), y2))
            if x2 <= x1 or y2 <= y1:
                continue
            out_boxes.append([x1, y1, x2, y2])
            out_labels.append(1 if label > 0 else 0)
        return out_boxes, out_labels

    def _prepare_source(self, resource_path: Path, imgsz: int) -> tuple[dict[str, Any], list[int]]:
        assert self._predictor is not None
        self._predictor.args.imgsz = int(imgsz)
        self._predictor.inference_state = {}
        self._predictor.setup_source(str(resource_path))
        self._predictor.init_state(self._predictor)
        self._active_source_key = f"{resource_path}::{self._current_imgsz(self._predictor)}"
        return self._predictor.inference_state, self._current_imgsz(self._predictor)

    def _activate_session(self, session: dict[str, Any], *, force_reload: bool = False) -> None:
        assert self._predictor is not None
        source_key = f"{session['resource_path']}::{session['imgsz']}"
        if force_reload or self._active_source_key != source_key:
            self._predictor.args.imgsz = int(session["imgsz_request"])
            self._predictor.setup_source(session["resource_path"])
            session["imgsz"] = self._current_imgsz(self._predictor)
            self._active_source_key = f"{session['resource_path']}::{session['imgsz']}"
        self._predictor.args.conf = float(session["threshold"])
        self._predictor.inference_state = session["inference_state"]

    def _prepare_frame(self, session: dict[str, Any], frame_index: int) -> np.ndarray:
        assert self._predictor is not None
        im0 = self._read_video_frame_bgr(session["resource_path"], frame_index)
        self._predictor.batch = (
            [session["resource_path"]],
            [im0],
            [f"video 1/1 (frame {frame_index + 1}/{session['num_frames']}) {session['resource_path']}: "],
        )
        if getattr(self._predictor, "dataset", None) is not None:
            try:
                self._predictor.dataset.frame = int(frame_index) + 1
            except Exception:
                pass
        im = self._predictor.preprocess([im0])
        session["inference_state"]["im"] = im
        return im0

    @staticmethod
    def _label_for_detection(
        *,
        obj_id: int,
        class_id: int,
        text_prompts: list[str],
    ) -> tuple[str, Optional[int]]:
        if 0 <= int(class_id) < len(text_prompts):
            return text_prompts[int(class_id)], int(class_id)
        if len(text_prompts) == 1:
            return text_prompts[0], 0
        return f"obj_{obj_id}", None

    def _outputs_to_detections(
        self,
        *,
        outputs: dict[str, Any],
        image_w: int,
        image_h: int,
        threshold: float,
        text_prompts: list[str],
        include_mask_png: bool,
        max_detections: int,
    ) -> list[dict[str, Any]]:
        obj_id_to_mask = outputs.get("obj_id_to_mask", {})
        obj_id_to_score = outputs.get("obj_id_to_score", {})
        obj_id_to_cls = outputs.get("obj_id_to_cls", {})
        if not isinstance(obj_id_to_mask, dict) or not obj_id_to_mask:
            return []

        curr_obj_ids = sorted(int(obj_id) for obj_id in obj_id_to_mask.keys())
        pred_masks = torch.cat([obj_id_to_mask[obj_id] for obj_id in curr_obj_ids], dim=0)
        pred_masks = F.interpolate(pred_masks.float()[None], size=(image_h, image_w), mode="bilinear")[0] > 0.5
        pred_scores = torch.tensor(
            [float(obj_id_to_score.get(obj_id, 0.0)) for obj_id in curr_obj_ids],
            dtype=torch.float32,
            device=pred_masks.device,
        )
        pred_cls = torch.tensor(
            [int(obj_id_to_cls.get(obj_id, 0)) for obj_id in curr_obj_ids],
            dtype=torch.int64,
            device=pred_masks.device,
        )
        pred_ids = torch.tensor(curr_obj_ids, dtype=torch.int64, device=pred_masks.device)

        keep = (pred_scores >= float(threshold)) & pred_masks.any(dim=(1, 2))
        if not bool(keep.any()):
            return []

        pred_masks = pred_masks[keep]
        pred_scores = pred_scores[keep]
        pred_cls = pred_cls[keep]
        pred_ids = pred_ids[keep]
        pred_boxes = batched_mask_to_box(pred_masks)

        order = torch.argsort(pred_scores, descending=True)
        if max_detections > 0:
            order = order[: int(max_detections)]

        detections: list[dict[str, Any]] = []
        for det_idx, source_idx in enumerate(order.tolist(), start=1):
            obj_id = int(pred_ids[source_idx].item())
            class_id = int(pred_cls[source_idx].item())
            label, safe_class_id = self._label_for_detection(
                obj_id=obj_id,
                class_id=class_id,
                text_prompts=text_prompts,
            )
            box = pred_boxes[source_idx].detach().to(dtype=torch.float32, device="cpu").numpy().tolist()
            x1, y1, x2, y2 = [float(v) for v in box]
            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)
            mask = pred_masks[source_idx].detach().to(device="cpu").numpy().astype(np.uint8)
            polygon = mask_to_polygon(mask)
            payload: dict[str, Any] = {
                "id": f"det_{det_idx:04d}",
                "obj_id": obj_id,
                "label": label,
                "score": round(float(pred_scores[source_idx].item()), 6),
                "bbox_xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                "bbox_xywh": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "area": int(mask.sum()),
            }
            if safe_class_id is not None:
                payload["class_id"] = safe_class_id
            if polygon:
                payload["polygon"] = polygon
            if include_mask_png:
                payload["mask_png_base64"] = mask_to_png_base64(mask)
            detections.append(payload)
        return detections

    def _get_session(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(str(session_id or "").strip())
        if not isinstance(session, dict):
            raise RuntimeError(f"session not found: {session_id}")
        return session

    def start_session(
        self,
        resource_path: str,
        session_id: Optional[str] = None,
        cleanup_resource_on_close: bool = False,
        threshold: float | None = None,
        imgsz: int | None = None,
    ) -> dict[str, Any]:
        self._ensure_model()
        path = Path(str(resource_path or "")).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise ValueError(f"resource_path does not exist: {path}")

        use_threshold = self._normalize_threshold(threshold, float(self.settings.default_threshold))
        use_imgsz = self._normalize_imgsz(imgsz)
        use_session_id = str(session_id or uuid.uuid4().hex).strip()
        if not use_session_id:
            raise ValueError("session_id must not be empty")

        with self._request_lock:
            inference_state, resolved_imgsz = self._prepare_source(path, use_imgsz)
            num_frames, width, height = self._probe_video(path)
            session = {
                "session_id": use_session_id,
                "resource_path": str(path),
                "num_frames": int(num_frames),
                "width": int(width),
                "height": int(height),
                "threshold": float(use_threshold),
                "imgsz_request": int(use_imgsz),
                "imgsz": resolved_imgsz,
                "inference_state": inference_state,
                "text_prompts": [],
            }
            self._sessions[use_session_id] = session
            if cleanup_resource_on_close:
                self._session_cleanup_paths[use_session_id] = path
            return {
                "session_id": use_session_id,
                "resource_path": str(path),
                "num_frames": int(num_frames),
                "width": int(width),
                "height": int(height),
                "threshold": float(use_threshold),
                "imgsz": resolved_imgsz,
            }

    def get_session_info(self, session_id: str) -> dict[str, Any]:
        self._ensure_model()
        with self._request_lock:
            session = self._get_session(session_id)
            return {
                "session_id": session["session_id"],
                "resource_path": session["resource_path"],
                "num_frames": int(session["num_frames"]),
                "width": int(session["width"]),
                "height": int(session["height"]),
                "threshold": float(session["threshold"]),
                "imgsz": list(session["imgsz"]),
                "has_text_prompt": bool(session["text_prompts"]),
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
        del obj_id
        self._ensure_model()
        if points:
            raise ValueError("semantic video add_prompt does not support points; use text and/or boxes")

        with self._request_lock:
            session = self._get_session(session_id)
            if int(frame_index) < 0 or int(frame_index) >= int(session["num_frames"]):
                raise ValueError("frame_index out of range")
            assert self._predictor is not None
            self._activate_session(session)
            self._prepare_frame(session, int(frame_index))
            prompt_texts = self._split_text_prompt(text)
            prompt_boxes, prompt_labels = self._normalize_boxes_xyxy(
                boxes,
                image_w=int(session["width"]),
                image_h=int(session["height"]),
                normalized=bool(normalized),
            )
            if not prompt_texts and not prompt_boxes:
                raise ValueError("add_prompt requires text and/or boxes")

            text_payload: str | list[str] | None = None
            if prompt_texts:
                text_payload = prompt_texts[0] if len(prompt_texts) == 1 else prompt_texts

            _, outputs = self._predictor.add_prompt(
                frame_idx=int(frame_index),
                text=text_payload,
                bboxes=prompt_boxes or None,
                labels=prompt_labels or None,
                inference_state=session["inference_state"],
            )
            session["text_prompts"] = prompt_texts
            detections = self._outputs_to_detections(
                outputs=outputs,
                image_w=int(session["width"]),
                image_h=int(session["height"]),
                threshold=float(session["threshold"]),
                text_prompts=prompt_texts,
                include_mask_png=bool(include_mask_png),
                max_detections=max(0, int(max_detections)),
            )
            return {
                "session_id": session_id,
                "frame_index": int(frame_index),
                "num_detections": len(detections),
                "detections": detections,
            }

    @staticmethod
    def _frame_sequence(
        *,
        direction: str,
        start_frame_index: int,
        num_frames: int,
        max_frame_num_to_track: int | None,
    ) -> list[int]:
        if direction == "backward":
            frames = list(range(int(start_frame_index), -1, -1))
        else:
            frames = list(range(int(start_frame_index), int(num_frames)))
        if max_frame_num_to_track is not None and int(max_frame_num_to_track) > 0:
            frames = frames[: int(max_frame_num_to_track)]
        return frames

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
        self._ensure_model()
        direction = str(propagation_direction or "forward").strip().lower()
        if direction not in {"both", "forward", "backward"}:
            raise ValueError("propagation_direction must be one of: both, forward, backward")

        with self._request_lock:
            session = self._get_session(session_id)
            assert self._predictor is not None
            self._activate_session(session)

            if start_frame_index is None:
                start_idx = 0 if direction == "forward" else max(0, int(session["num_frames"]) - 1)
            else:
                start_idx = int(start_frame_index)
            if start_idx < 0 or start_idx >= int(session["num_frames"]):
                raise ValueError("start_frame_index out of range")

            directions = [direction] if direction != "both" else ["forward", "backward"]
            frames: list[dict[str, Any]] = []
            seen_frames: set[int] = set()
            truncated = False
            t0 = time.perf_counter()

            for direction_local in directions:
                frame_indices = self._frame_sequence(
                    direction=direction_local,
                    start_frame_index=start_idx,
                    num_frames=int(session["num_frames"]),
                    max_frame_num_to_track=max_frame_num_to_track,
                )
                for frame_idx in frame_indices:
                    if frame_idx in seen_frames:
                        continue
                    self._prepare_frame(session, frame_idx)
                    outputs = self._predictor._run_single_frame_inference(  # noqa: SLF001
                        frame_idx=frame_idx,
                        reverse=(direction_local == "backward"),
                        inference_state=session["inference_state"],
                    )
                    detections = self._outputs_to_detections(
                        outputs=outputs,
                        image_w=int(session["width"]),
                        image_h=int(session["height"]),
                        threshold=float(session["threshold"]),
                        text_prompts=list(session.get("text_prompts") or []),
                        include_mask_png=bool(include_mask_png),
                        max_detections=max(0, int(max_detections)),
                    )
                    frames.append(
                        {
                            "frame_index": int(frame_idx),
                            "num_detections": len(detections),
                            "detections": detections,
                        }
                    )
                    seen_frames.add(int(frame_idx))
                    if max_frames and max_frames > 0 and len(frames) >= int(max_frames):
                        truncated = True
                        break
                if truncated:
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
        del session_id, obj_id, is_user_action
        raise ValueError("remove_object is not supported in semantic video sessions")

    def reset_session(self, session_id: str) -> dict[str, Any]:
        self._ensure_model()
        with self._request_lock:
            session = self._get_session(session_id)
            inference_state, resolved_imgsz = self._prepare_source(
                Path(session["resource_path"]),
                int(session["imgsz_request"]),
            )
            session["inference_state"] = inference_state
            session["imgsz"] = resolved_imgsz
            session["text_prompts"] = []
            return {"session_id": session_id, "ok": True}

    def close_session(self, session_id: str) -> dict[str, Any]:
        self._ensure_model()
        with self._request_lock:
            session = self._sessions.pop(str(session_id or "").strip(), None)
            if not isinstance(session, dict):
                raise RuntimeError(f"session not found: {session_id}")
            if self._active_source_key.startswith(f"{session['resource_path']}::"):
                self._active_source_key = ""
            cleanup_path = self._session_cleanup_paths.pop(str(session_id), None)
            if cleanup_path is not None:
                try:
                    cleanup_path.unlink(missing_ok=True)
                except Exception:
                    pass
            return {"session_id": session_id, "ok": True}
