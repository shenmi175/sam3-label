from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DownloadSpec:
    """How to obtain a model's weights.

    kind: "hf"   -> automated download from a HuggingFace repo id.
    kind: "manual" -> gated / manual acquisition; show `instructions`.
    """

    kind: str
    hf_repo_id: str = ""
    subdir: str = ""
    instructions: str = ""


@dataclass(frozen=True)
class ModelSpec:
    id: str
    display_name: str
    api_service: str
    api_port: int
    api_port_env: str
    # Host side: directory holding the weights. `host_dir_env` overrides
    # `default_host_dir` (relative to the repo root).
    host_dir_env: str
    default_host_dir: str
    # Container side: env var consumed by the API and the mount point
    # configured in docker-compose.yml.
    container_path_env: str
    container_mount: str
    # Paths relative to the host checkpoint directory. Entries marked
    # optional may be fetched on demand by the service itself.
    expected_files: tuple[str, ...]
    optional_files: tuple[str, ...] = ()
    approx_size_gb: float = 0.0
    download: DownloadSpec = DownloadSpec(kind="manual")


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="sam3",
        display_name="SAM3 (Segment Anything Model 3)",
        api_service="sam3-api",
        api_port=8001,
        api_port_env="SAM3_API_PORT",
        host_dir_env="SAM3_CHECKPOINT_DIR",
        default_host_dir="sam3_checkpoints",
        container_path_env="SAM3_API_CHECKPOINT",
        container_mount="/models/sam3.pt",
        expected_files=("sam3.pt",),
        approx_size_gb=3.2,
        download=DownloadSpec(
            kind="manual",
            instructions=(
                "SAM3 weights are distributed by Meta under the SAM License and "
                "are gated. Obtain sam3.pt from the official Meta SAM3 release "
                "channels (see external/sam3 README) and place it in the "
                "checkpoint directory. Alternatively set SAM3_API_LOAD_FROM_HF=1 "
                "to let sam3-api pull from HuggingFace at startup."
            ),
        ),
    ),
    ModelSpec(
        id="sapiens2",
        display_name="Sapiens 2 (segmentation / pose)",
        api_service="sapiens-api",
        api_port=8010,
        api_port_env="SAPIENS_API_PORT",
        host_dir_env="SAPIENS_CHECKPOINT_ROOT",
        default_host_dir="sapiens_checkpoints",
        container_path_env="SAPIENS_CHECKPOINT_ROOT",
        container_mount="/models/sapiens2",
        expected_files=(
            "seg/sapiens2_5b_seg.safetensors",
            "pose/sapiens2_5b_pose.safetensors",
        ),
        optional_files=("detector/detr-resnet-101-dc5",),
        approx_size_gb=13.0,
        download=DownloadSpec(
            kind="manual",
            instructions=(
                "Download the official Sapiens2 checkpoints from HuggingFace "
                "(facebook/sapiens2-seg-* and sapiens2 pose repos) into the "
                "expected layout: seg/<name>_seg.safetensors and "
                "pose/sapiens2_5b_pose.safetensors. The DETR detector "
                "(detector/detr-resnet-101-dc5) is fetched automatically by "
                "sapiens-api when pose downloads run."
            ),
        ),
    ),
    ModelSpec(
        id="locate-anything",
        display_name="LocateAnything-3B (NVIDIA)",
        api_service="locate-anything-api",
        api_port=8004,
        api_port_env="LOCATE_API_PORT",
        host_dir_env="LOCATE_CHECKPOINT_DIR",
        default_host_dir="locate_checkpoints",
        container_path_env="LOCATE_CHECKPOINT_PATH",
        container_mount="/models/LocateAnything-3B",
        expected_files=("LocateAnything-3B",),
        approx_size_gb=7.2,
        download=DownloadSpec(
            kind="hf",
            hf_repo_id="nvidia/LocateAnything-3B",
            subdir="LocateAnything-3B",
            instructions=(
                "Automated via `python -m model_registry download "
                "locate-anything` (add --mirror for hf-mirror.com)."
            ),
        ),
    ),
)


def get_model(model_id: str) -> ModelSpec:
    for spec in MODELS:
        if spec.id == model_id:
            return spec
    raise KeyError(f"unknown model id: {model_id!r} (known: {[m.id for m in MODELS]})")
