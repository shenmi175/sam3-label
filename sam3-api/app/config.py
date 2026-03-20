import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    api_title: str
    api_version: str
    project_root: Path
    checkpoint_path: Path
    device: str
    load_from_hf: bool
    compile_model: bool
    default_threshold: float
    warmup_on_start: bool
    cors_origins: list[str]
    max_batch_files: int
    max_image_bytes: int
    video_upload_dir: Path
    max_video_bytes: int
    video_force_fp32_inputs: bool
    video_disable_bf16_context: bool
    video_force_backbone_fpn_fp32: bool
    video_enable_tracker_bf16_autocast: bool
    video_force_tracker_state_fp32: bool
    video_apply_temporal_disambiguation: bool


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_device() -> str:
    env_device = os.getenv("SAM3_API_DEVICE", "").strip().lower()
    if env_device in {"cpu", "cuda"}:
        return env_device

    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _resolve_project_root() -> Path:
    app_file = Path(__file__).resolve()
    # sam3-api/app/config.py -> auto-label/
    return app_file.parents[2]


def _resolve_checkpoint(project_root: Path) -> Path:
    env_ckpt = os.getenv("SAM3_API_CHECKPOINT", "").strip()
    if env_ckpt:
        return Path(env_ckpt).expanduser().resolve()
    return (project_root / "sam3_checkpoints" / "sam3.pt").resolve()


def _parse_cors_origins() -> list[str]:
    raw = os.getenv("SAM3_API_CORS_ORIGINS", "*").strip()
    if not raw:
        return ["*"]
    values = [x.strip() for x in raw.split(",") if x.strip()]
    return values or ["*"]


def get_settings() -> Settings:
    project_root = _resolve_project_root()
    max_batch_files = int(os.getenv("SAM3_API_MAX_BATCH_FILES", "32"))
    max_image_mb = int(os.getenv("SAM3_API_MAX_IMAGE_MB", "50"))
    max_video_mb = int(os.getenv("SAM3_API_MAX_VIDEO_MB", "4096"))
    upload_dir = Path(
        os.getenv(
            "SAM3_API_VIDEO_UPLOAD_DIR",
            str((project_root / "sam3-api" / "data" / "uploads").resolve()),
        )
    ).expanduser().resolve()

    return Settings(
        api_title="SAM3 Inference API",
        api_version="0.1.0",
        project_root=project_root,
        checkpoint_path=_resolve_checkpoint(project_root),
        device=_resolve_device(),
        load_from_hf=_env_bool("SAM3_API_LOAD_FROM_HF", False),
        compile_model=_env_bool("SAM3_API_COMPILE", False),
        default_threshold=float(os.getenv("SAM3_API_DEFAULT_THRESHOLD", "0.5")),
        warmup_on_start=_env_bool("SAM3_API_WARMUP_ON_START", False),
        cors_origins=_parse_cors_origins(),
        max_batch_files=max(1, max_batch_files),
        max_image_bytes=max(1, max_image_mb) * 1024 * 1024,
        video_upload_dir=upload_dir,
        max_video_bytes=max(1, max_video_mb) * 1024 * 1024,
        # Official-aligned defaults: keep end-to-end CUDA + BF16 path.
        video_force_fp32_inputs=_env_bool("SAM3_API_VIDEO_FORCE_FP32_INPUTS", False),
        video_disable_bf16_context=_env_bool("SAM3_API_VIDEO_DISABLE_BF16_CONTEXT", False),
        # Runtime dtype adapter (Conv/Linear input cast) is OFF by default in official mode.
        video_force_backbone_fpn_fp32=_env_bool("SAM3_API_VIDEO_FORCE_BACKBONE_FPN_FP32", False),
        video_enable_tracker_bf16_autocast=_env_bool("SAM3_API_VIDEO_ENABLE_TRACKER_BF16_AUTOCAST", True),
        video_force_tracker_state_fp32=_env_bool("SAM3_API_VIDEO_FORCE_TRACKER_STATE_FP32", False),
        # For interactive labeling stability, default to False to reduce aggressive suppression.
        video_apply_temporal_disambiguation=_env_bool("SAM3_API_VIDEO_APPLY_TEMPORAL_DISAMBIGUATION", False),
    )
