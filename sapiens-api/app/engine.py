from __future__ import annotations

import gc
import logging
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
import torch.nn.functional as F

from app import lifecycle

logger = logging.getLogger(__name__)


DOME_CLASSES_29 = [
    "Background",
    "Apparel",
    "Eyeglass",
    "Face_Neck",
    "Hair",
    "Left_Foot",
    "Left_Hand",
    "Left_Lower_Arm",
    "Left_Lower_Leg",
    "Left_Shoe",
    "Left_Sock",
    "Left_Upper_Arm",
    "Left_Upper_Leg",
    "Lower_Clothing",
    "Right_Foot",
    "Right_Hand",
    "Right_Lower_Arm",
    "Right_Lower_Leg",
    "Right_Shoe",
    "Right_Sock",
    "Right_Upper_Arm",
    "Right_Upper_Leg",
    "Torso",
    "Upper_Clothing",
    "Lower_Lip",
    "Upper_Lip",
    "Lower_Teeth",
    "Upper_Teeth",
    "Tongue",
]


SUPPORTED_SEG_MODELS = {
    "sapiens2_0.4b": "sapiens2_0.4b_seg.safetensors",
    "sapiens2_0.8b": "sapiens2_0.8b_seg.safetensors",
    "sapiens2_1b": "sapiens2_1b_seg.safetensors",
    "sapiens2_5b": "sapiens2_5b_seg.safetensors",
}
DEFAULT_SEG_MODEL = "sapiens2_5b"
MODEL_DOWNLOAD_URLS = {
    "sapiens2_0.4b": "https://huggingface.co/facebook/sapiens2-seg-0.4b/resolve/main/sapiens2_0.4b_seg.safetensors",
    "sapiens2_0.8b": "https://huggingface.co/facebook/sapiens2-seg-0.8b/resolve/main/sapiens2_0.8b_seg.safetensors",
    "sapiens2_1b": "https://huggingface.co/facebook/sapiens2-seg-1b/resolve/main/sapiens2_1b_seg.safetensors",
    "sapiens2_5b": "https://huggingface.co/facebook/sapiens2-seg-5b/resolve/main/sapiens2_5b_seg.safetensors",
}


@dataclass(frozen=True)
class SapiensSegConfig:
    repo_dir: Path
    checkpoint_root: Path
    model_name: str
    device: str

    @property
    def dense_dir(self) -> Path:
        return self.repo_dir / "sapiens" / "dense"

    @property
    def config_path(self) -> Path:
        return (
            self.dense_dir
            / "configs"
            / "seg"
            / "shutterstock_goliath"
            / f"{self.model_name}_seg_shutterstock_goliath-1024x768.py"
        )

    @property
    def checkpoint_path(self) -> Path:
        filename = SUPPORTED_SEG_MODELS[self.model_name]
        return self.checkpoint_root / "seg" / filename


class SapiensSegmentationEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model: Any | None = None
        self._config: SapiensSegConfig | None = None
        self._load_error = ""
        self._state = "not_loaded"  # not_loaded | loading | loaded | load_failed
        # Set by startup when weights are absent on disk (degraded, non-fatal).
        self.weights_missing = False

    @property
    def state(self) -> str:
        return self._state

    @property
    def load_error(self) -> str:
        return self._load_error

    @staticmethod
    def _repo_dir() -> Path:
        return Path(os.getenv("SAPIENS_REPO_DIR", "/app/external/sapiens2")).expanduser().resolve()

    @staticmethod
    def _checkpoint_root() -> Path:
        return Path(os.getenv("SAPIENS_CHECKPOINT_ROOT", "/models/sapiens2")).expanduser().resolve()

    @staticmethod
    def default_model_name() -> str:
        model_name = os.getenv("SAPIENS_MODEL_NAME", DEFAULT_SEG_MODEL).strip() or DEFAULT_SEG_MODEL
        return model_name if model_name in SUPPORTED_SEG_MODELS else DEFAULT_SEG_MODEL

    @staticmethod
    def default_device() -> str:
        return os.getenv("SAPIENS_DEVICE", "cuda:0").strip() or "cuda:0"

    def _build_config(self, model_name: str | None = None) -> SapiensSegConfig:
        selected = (model_name or self.default_model_name()).strip()
        if selected not in SUPPORTED_SEG_MODELS:
            raise ValueError(f"unsupported model_name: {selected}")
        return SapiensSegConfig(
            repo_dir=self._repo_dir(),
            checkpoint_root=self._checkpoint_root(),
            model_name=selected,
            device=self.default_device(),
        )

    def weights_ready(self, model_name: str | None = None) -> bool:
        """True when every file required by load() is present on disk."""
        cfg = self._build_config(model_name)
        return (
            cfg.repo_dir.exists()
            and cfg.config_path.exists()
            and cfg.checkpoint_path.exists()
        )

    def expected_weight_paths(self, model_name: str | None = None) -> list[str]:
        """Paths that must exist for load() to succeed (for operator-facing hints)."""
        cfg = self._build_config(model_name)
        return [str(cfg.repo_dir), str(cfg.config_path), str(cfg.checkpoint_path)]

    def repo_exists(self, model_name: str | None = None) -> bool:
        return self._build_config(model_name).repo_dir.exists()

    def status(self) -> dict[str, Any]:
        cfg = self._config or self._build_config()
        return {
            "service": "sapiens-api",
            "status": "ok" if cfg.repo_dir.exists() else "missing_repo",
            "state": self._state,
            "weights_missing": self.weights_missing,
            "model_loaded": self._model is not None,
            "model_name": cfg.model_name,
            "device": cfg.device,
            "repo_dir": str(cfg.repo_dir),
            "repo_exists": cfg.repo_dir.exists(),
            "config_path": str(cfg.config_path),
            "config_exists": cfg.config_path.exists(),
            "checkpoint_path": str(cfg.checkpoint_path),
            "checkpoint_exists": cfg.checkpoint_path.exists(),
            "checkpoint_root": str(cfg.checkpoint_root),
            "last_load_error": self._load_error,
            "classes": DOME_CLASSES_29,
        }

    def models(self) -> list[dict[str, Any]]:
        root = self._checkpoint_root()
        return [
            {
                "name": name,
                "task": "segmentation",
                "download_url": MODEL_DOWNLOAD_URLS[name],
                "checkpoint": str(root / "seg" / filename),
                "checkpoint_exists": (root / "seg" / filename).exists(),
            }
            for name, filename in SUPPORTED_SEG_MODELS.items()
        ]

    def _prepare_imports(self, repo_dir: Path) -> None:
        for item in (repo_dir, repo_dir / "sapiens" / "dense"):
            text = str(item)
            if text not in sys.path:
                sys.path.insert(0, text)

    def load(self, model_name: str | None = None) -> Any:
        cfg = self._build_config(model_name)
        with self._lock:
            if self._model is not None and self._config == cfg:
                return self._model
            self._state = "loading"
            # Model switch: release the old model before allocating the new one
            # so both never occupy VRAM at the same time.
            if self._model is not None:
                self._release_locked()
            try:
                if not cfg.repo_dir.exists():
                    raise RuntimeError(f"Sapiens2 repo not found: {cfg.repo_dir}")
                if not cfg.config_path.exists():
                    raise RuntimeError(f"Sapiens2 config not found: {cfg.config_path}")
                if not cfg.checkpoint_path.exists():
                    raise RuntimeError(
                        "Sapiens2 segmentation checkpoint not found: "
                        f"{cfg.checkpoint_path}. Put official checkpoints under "
                        f"{cfg.checkpoint_root}/seg or set SAPIENS_CHECKPOINT_ROOT."
                    )

                self._prepare_imports(cfg.repo_dir)
                try:
                    from sapiens.dense.models import init_model

                    model = init_model(str(cfg.config_path), str(cfg.checkpoint_path), device=cfg.device)
                    model.eval()
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"failed to load Sapiens2 segmentation model: {exc}") from exc
            except Exception as exc:  # noqa: BLE001
                self._record_load_failure(exc)
                raise

            self._model = model
            self._config = cfg
            self._state = "loaded"
            self._load_error = ""
            self.weights_missing = False
            return model

    def _record_load_failure(self, exc: BaseException) -> None:
        category, guidance = lifecycle.classify_load_error(exc)
        self._state = "load_failed"
        self._load_error = f"[{category}] {exc}"
        logger.error(
            "sapiens seg engine load/verify failed (%s): %s — %s", category, exc, guidance
        )
        if lifecycle.is_oom_error(exc):
            lifecycle.cleanup_after_oom()

    def _release_locked(self) -> None:
        """Drop model references and free VRAM. Caller must hold ``_lock``."""
        self._model = None
        self._config = None
        gc.collect()
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            logger.debug("torch.cuda.empty_cache unavailable; skipped", exc_info=True)

    def unload(self) -> None:
        """Idempotently release the model and reset lifecycle state."""
        with self._lock:
            self._release_locked()
            self._state = "not_loaded"
            self._load_error = ""

    def verify_inference(self) -> None:
        """Run a synthetic 64x64 image through the full infer_image pipeline.

        Raises on any failure; success means the loaded model can actually infer.
        """
        image = np.zeros((64, 64, 3), dtype=np.uint8)
        image[:] = (40, 90, 160)  # BGR
        ok, encoded = cv2.imencode(".png", image)
        if not ok:
            raise RuntimeError("verify_inference: failed to encode synthetic test image")
        result = self.infer_image(encoded.tobytes())
        if not isinstance(result, dict):
            raise RuntimeError(f"verify_inference: unexpected result type: {type(result)!r}")

    def warmup(self) -> None:
        """load() + verify_inference(); a verification failure counts as load failure."""
        self.load()
        try:
            self.verify_inference()
        except Exception as exc:  # noqa: BLE001
            self._record_load_failure(exc)
            raise

    @staticmethod
    def _decode_image(image_bytes: bytes) -> np.ndarray:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("image decode failed")
        return image

    @staticmethod
    def _contour_to_polygon(contour: np.ndarray) -> list[list[float]]:
        perimeter = cv2.arcLength(contour, True)
        epsilon = max(1.0, 0.003 * perimeter)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        if approx is None or len(approx) < 3:
            return []
        return [[float(x), float(y)] for x, y in approx.reshape(-1, 2)]

    @staticmethod
    def _bbox_from_contour(contour: np.ndarray) -> list[float]:
        x, y, w, h = cv2.boundingRect(contour)
        return [float(x), float(y), float(x + w), float(y + h)]

    def _label_map_to_detections(
        self,
        label_map: np.ndarray,
        *,
        min_area: float,
        max_detections: int,
    ) -> list[dict[str, Any]]:
        detections: list[dict[str, Any]] = []
        h, w = label_map.shape[:2]
        for class_id, class_name in enumerate(DOME_CLASSES_29):
            if class_id == 0:
                continue
            binary = (label_map == class_id).astype(np.uint8) * 255
            if not np.any(binary):
                continue
            contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                area = float(cv2.contourArea(contour))
                if area < min_area:
                    continue
                polygon = self._contour_to_polygon(contour)
                if len(polygon) < 3:
                    continue
                detections.append(
                    {
                        "id": f"sapiens_{class_id}_{len(detections) + 1:04d}",
                        "label": class_name,
                        "class_id": class_id,
                        "score": 1.0,
                        "bbox": self._bbox_from_contour(contour),
                        "polygon": polygon,
                        "area": area,
                        "source": "sapiens2_seg",
                    }
                )
        detections.sort(key=lambda item: float(item.get("area") or 0.0), reverse=True)
        return detections[: max(1, int(max_detections))]

    def infer_image(
        self,
        image_bytes: bytes,
        *,
        model_name: str | None = None,
        min_area: float = 64.0,
        max_detections: int = 300,
        include_label_map: bool = False,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        image = self._decode_image(image_bytes)
        model = self.load(model_name)

        data = model.pipeline(dict(img=image))
        data = model.data_preprocessor(data)
        inputs = data["inputs"]

        with torch.inference_mode():
            seg_logits = model(inputs)
        seg_logits = F.interpolate(seg_logits, size=image.shape[:2], mode="bilinear")
        pred_labels = seg_logits.argmax(dim=1).detach().cpu().numpy().squeeze(0).astype(np.uint8)

        detections = self._label_map_to_detections(
            pred_labels,
            min_area=max(1.0, float(min_area)),
            max_detections=max_detections,
        )
        result: dict[str, Any] = {
            "model": self._config.model_name if self._config else self.default_model_name(),
            "task": "segmentation",
            "image_shape": [int(image.shape[0]), int(image.shape[1])],
            "label_map_shape": [int(pred_labels.shape[0]), int(pred_labels.shape[1])],
            "classes": DOME_CLASSES_29,
            "detections": detections,
            "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 2),
        }
        if include_label_map:
            result["label_map"] = pred_labels.tolist()
        return result

    def infer_path(self, image_path: Path, **kwargs: Any) -> dict[str, Any]:
        with image_path.open("rb") as f:
            return self.infer_image(f.read(), **kwargs)


engine = SapiensSegmentationEngine()
