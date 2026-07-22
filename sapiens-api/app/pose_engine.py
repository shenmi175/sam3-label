from __future__ import annotations

import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
from PIL import Image


POSE_MODEL_NAME = "sapiens2_5b"
POSE_CHECKPOINT_FILENAME = "sapiens2_5b_pose.safetensors"
POSE_MODEL_DOWNLOAD_URL = (
    "https://huggingface.co/facebook/sapiens2-pose-5b/resolve/main/"
    "sapiens2_5b_pose.safetensors"
)
POSE_DETECTOR_REPO_ID = "facebook/detr-resnet-101-dc5"


@dataclass(frozen=True)
class SapiensPoseConfig:
    repo_dir: Path
    checkpoint_root: Path
    model_name: str
    device: str

    @property
    def pose_dir(self) -> Path:
        return self.repo_dir / "sapiens" / "pose"

    @property
    def config_path(self) -> Path:
        return (
            self.pose_dir
            / "configs"
            / "keypoints308"
            / "shutterstock_goliath_3po"
            / f"{self.model_name}_keypoints308_shutterstock_goliath_3po-1024x768.py"
        )

    @property
    def metainfo_path(self) -> Path:
        return self.pose_dir / "configs" / "_base_" / "keypoints308.py"

    @property
    def checkpoint_path(self) -> Path:
        return self.checkpoint_root / "pose" / POSE_CHECKPOINT_FILENAME

    @property
    def detector_dir(self) -> Path:
        return self.checkpoint_root / "detector" / "detr-resnet-101-dc5"


class SapiensPoseEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model: Any | None = None
        self._detector_processor: Any | None = None
        self._detector_model: Any | None = None
        self._config: SapiensPoseConfig | None = None
        self._load_error = ""

    @staticmethod
    def _repo_dir() -> Path:
        return Path(os.getenv("SAPIENS_REPO_DIR", "/app/external/sapiens2")).expanduser().resolve()

    @staticmethod
    def _checkpoint_root() -> Path:
        return Path(os.getenv("SAPIENS_CHECKPOINT_ROOT", "/models/sapiens2")).expanduser().resolve()

    @staticmethod
    def default_model_name() -> str:
        return POSE_MODEL_NAME

    @staticmethod
    def default_device() -> str:
        return os.getenv("SAPIENS_DEVICE", "cuda:0").strip() or "cuda:0"

    def _build_config(self) -> SapiensPoseConfig:
        return SapiensPoseConfig(
            repo_dir=self._repo_dir(),
            checkpoint_root=self._checkpoint_root(),
            model_name=self.default_model_name(),
            device=self.default_device(),
        )

    @staticmethod
    def _detector_exists(detector_dir: Path) -> bool:
        if not detector_dir.exists() or not detector_dir.is_dir():
            return False
        has_config = (detector_dir / "config.json").exists()
        has_processor = (detector_dir / "preprocessor_config.json").exists()
        has_weights = (detector_dir / "model.safetensors").exists() or (detector_dir / "pytorch_model.bin").exists()
        return has_config and has_processor and has_weights

    def checkpoint_status(self) -> dict[str, Any]:
        cfg = self._config or self._build_config()
        checkpoint = cfg.checkpoint_path
        part = checkpoint.with_suffix(checkpoint.suffix + ".part")
        return {
            "task": "pose",
            "model_name": cfg.model_name,
            "checkpoint_path": str(checkpoint),
            "checkpoint_exists": checkpoint.exists(),
            "checkpoint_size_bytes": checkpoint.stat().st_size if checkpoint.exists() else 0,
            "partial_path": str(part),
            "partial_size_bytes": part.stat().st_size if part.exists() else 0,
            "download_url": POSE_MODEL_DOWNLOAD_URL,
            "detector_repo_id": POSE_DETECTOR_REPO_ID,
            "detector_path": str(cfg.detector_dir),
            "detector_exists": self._detector_exists(cfg.detector_dir),
        }

    def status(self) -> dict[str, Any]:
        cfg = self._config or self._build_config()
        checkpoint = self.checkpoint_status()
        return {
            "service": "sapiens-api",
            "task": "pose",
            "status": "ok" if cfg.repo_dir.exists() else "missing_repo",
            "model_loaded": self._model is not None,
            "detector_loaded": self._detector_model is not None,
            "model_name": cfg.model_name,
            "device": cfg.device,
            "repo_dir": str(cfg.repo_dir),
            "repo_exists": cfg.repo_dir.exists(),
            "config_path": str(cfg.config_path),
            "config_exists": cfg.config_path.exists(),
            "metainfo_path": str(cfg.metainfo_path),
            "metainfo_exists": cfg.metainfo_path.exists(),
            "checkpoint_root": str(cfg.checkpoint_root),
            "checkpoint": checkpoint,
            "last_load_error": self._load_error,
        }

    def _prepare_imports(self, repo_dir: Path) -> None:
        for item in (repo_dir, repo_dir / "sapiens" / "pose"):
            text = str(item)
            if text not in sys.path:
                sys.path.insert(0, text)

    def load(self) -> tuple[Any, Any, Any]:
        cfg = self._build_config()
        with self._lock:
            if (
                self._model is not None
                and self._detector_model is not None
                and self._detector_processor is not None
                and self._config == cfg
            ):
                return self._model, self._detector_processor, self._detector_model
            if not cfg.repo_dir.exists():
                raise RuntimeError(f"Sapiens2 repo not found: {cfg.repo_dir}")
            if not cfg.config_path.exists():
                raise RuntimeError(f"Sapiens2 pose config not found: {cfg.config_path}")
            if not cfg.metainfo_path.exists():
                raise RuntimeError(f"Sapiens2 pose metainfo not found: {cfg.metainfo_path}")
            if not cfg.checkpoint_path.exists():
                raise RuntimeError(
                    "Sapiens2 pose checkpoint not found: "
                    f"{cfg.checkpoint_path}. Use /v1/pose/checkpoints/download first."
                )
            if not self._detector_exists(cfg.detector_dir):
                raise RuntimeError(
                    "Sapiens2 pose detector not found: "
                    f"{cfg.detector_dir}. Use /v1/pose/checkpoints/download first."
                )

            self._prepare_imports(cfg.repo_dir)
            try:
                from sapiens.pose.datasets import UDPHeatmap, parse_pose_metainfo
                from sapiens.pose.models import init_model
                from transformers import DetrForObjectDetection, DetrImageProcessor

                model = init_model(str(cfg.config_path), str(cfg.checkpoint_path), device=cfg.device)
                model.eval()
                if int(getattr(model.cfg, "num_keypoints", 0) or 0) == 308:
                    model.pose_metainfo = parse_pose_metainfo(dict(from_file=str(cfg.metainfo_path)))
                codec_cfg = dict(model.cfg.codec)
                codec_type = codec_cfg.pop("type", "")
                if codec_type != "UDPHeatmap":
                    raise RuntimeError(f"unsupported Sapiens2 pose codec: {codec_type}")
                model.codec = UDPHeatmap(**codec_cfg)

                processor = DetrImageProcessor.from_pretrained(str(cfg.detector_dir), local_files_only=True)
                detector = DetrForObjectDetection.from_pretrained(str(cfg.detector_dir), local_files_only=True)
                detector.eval().to(cfg.device)
            except Exception as exc:  # noqa: BLE001
                self._load_error = str(exc)
                raise RuntimeError(f"failed to load Sapiens2 pose runtime: {exc}") from exc

            self._model = model
            self._detector_processor = processor
            self._detector_model = detector
            self._config = cfg
            self._load_error = ""
            return model, processor, detector

    @staticmethod
    def _decode_image(image_bytes: bytes) -> np.ndarray:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("image decode failed")
        return image

    def _detect_persons(
        self,
        image_bgr: np.ndarray,
        processor: Any,
        detector: Any,
        *,
        bbox_threshold: float,
        nms_threshold: float,
    ) -> tuple[np.ndarray, np.ndarray]:
        from sapiens.pose.evaluators import nms

        cfg = self._config or self._build_config()
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(image_rgb)
        inputs = processor(images=pil_img, return_tensors="pt").to(cfg.device)
        with torch.inference_mode():
            outputs = detector(**inputs)
        target_sizes = torch.tensor([image_rgb.shape[:2]], device=cfg.device)
        results = processor.post_process_object_detection(
            outputs,
            target_sizes=target_sizes,
            threshold=float(bbox_threshold),
        )[0]
        person_mask = results["labels"] == 1
        boxes = results["boxes"][person_mask].detach().cpu().numpy()
        scores = results["scores"][person_mask].detach().cpu().numpy().reshape(-1, 1)
        if len(boxes) == 0:
            h, w = image_rgb.shape[:2]
            return np.array([[0, 0, w - 1, h - 1]], dtype=np.float32), np.array([1.0], dtype=np.float32)
        bboxes_scores = np.concatenate([boxes, scores], axis=1)
        keep = nms(bboxes_scores, float(nms_threshold))
        kept = bboxes_scores[keep]
        return kept[:, :4].astype(np.float32), kept[:, 4].astype(np.float32)

    @staticmethod
    def _to_jsonable_keypoints(points: np.ndarray, scores: np.ndarray, threshold: float) -> list[list[float]]:
        out: list[list[float]] = []
        for idx in range(points.shape[0]):
            score = float(scores[idx]) if idx < len(scores) else 0.0
            visible = 1.0 if score >= threshold else 0.0
            out.append([float(points[idx, 0]), float(points[idx, 1]), score, visible])
        return out

    @staticmethod
    def _skeleton_links(model: Any) -> list[list[int]]:
        metainfo = getattr(model, "pose_metainfo", {}) or {}
        links = metainfo.get("skeleton_links") or metainfo.get("skeleton") or []
        out: list[list[int]] = []
        for raw in links:
            if isinstance(raw, dict):
                pair = raw.get("link") or raw.get("keypoints") or []
            else:
                pair = raw
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                try:
                    a, b = int(pair[0]), int(pair[1])
                except Exception:
                    continue
                out.append([a, b])
        return out

    def infer_image(
        self,
        image_bytes: bytes,
        *,
        bbox_threshold: float = 0.3,
        nms_threshold: float = 0.3,
        keypoint_threshold: float = 0.3,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        image = self._decode_image(image_bytes)
        model, processor, detector = self.load()
        bboxes, bbox_scores = self._detect_persons(
            image,
            processor,
            detector,
            bbox_threshold=bbox_threshold,
            nms_threshold=nms_threshold,
        )

        inputs_list: list[Any] = []
        data_samples_list: list[Any] = []
        for bbox in bboxes:
            data_info = {"img": image, "bbox": bbox[None], "bbox_score": np.ones(1, dtype=np.float32)}
            data = model.pipeline(data_info)
            data = model.data_preprocessor(data)
            inputs_list.append(data["inputs"])
            data_samples_list.append(data["data_samples"])

        inputs = torch.cat(inputs_list, dim=0)
        model_param = next(model.parameters(), None)
        if model_param is not None:
            inputs = inputs.to(device=model_param.device, dtype=model_param.dtype)
        with torch.inference_mode():
            autocast_enabled = inputs.is_cuda and inputs.dtype in {torch.float16, torch.bfloat16}
            with torch.autocast(device_type="cuda", dtype=inputs.dtype, enabled=autocast_enabled):
                pred = model(inputs)
                if model.cfg.val_cfg is not None and model.cfg.val_cfg.get("flip_test", False):
                    pred_flipped = model(inputs.flip(-1)).flip(-1)
                    flip_indices = model.pose_metainfo["flip_indices"]
                    pred_flipped = pred_flipped[:, flip_indices]
                    pred = (pred + pred_flipped) / 2.0

        pred_np = pred.detach().float().cpu().numpy()
        links = self._skeleton_links(model)
        instances: list[dict[str, Any]] = []
        for idx, data_samples in enumerate(data_samples_list):
            keypoints_i, keypoint_scores_i = model.codec.decode(pred_np[idx])
            input_size = data_samples["meta"]["input_size"]
            bbox_center = data_samples["meta"]["bbox_center"]
            bbox_scale = data_samples["meta"]["bbox_scale"]
            keypoints_i = keypoints_i / input_size * bbox_scale + bbox_center - 0.5 * bbox_scale
            points = keypoints_i[0]
            scores = keypoint_scores_i[0]
            visible_scores = [float(s) for s in scores if float(s) >= float(keypoint_threshold)]
            avg_score = float(sum(visible_scores) / len(visible_scores)) if visible_scores else float(np.mean(scores))
            bbox = [float(x) for x in bboxes[idx].tolist()]
            instances.append(
                {
                    "id": f"pose_{idx + 1:04d}",
                    "label": "person_pose",
                    "class_name": "person_pose",
                    "type": "pose",
                    "source": "sapiens2_pose",
                    "model": POSE_MODEL_NAME,
                    "bbox": bbox,
                    "bbox_score": float(bbox_scores[idx]) if idx < len(bbox_scores) else 1.0,
                    "score": avg_score,
                    "keypoints": self._to_jsonable_keypoints(points, scores, float(keypoint_threshold)),
                    "keypoint_threshold": float(keypoint_threshold),
                    "skeleton_links": links,
                }
            )

        return {
            "task": "pose",
            "model": POSE_MODEL_NAME,
            "image_shape": [int(image.shape[0]), int(image.shape[1])],
            "num_keypoints": int(len(instances[0]["keypoints"])) if instances else 0,
            "skeleton_links": links,
            "instances": instances,
            "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 2),
        }


pose_engine = SapiensPoseEngine()
