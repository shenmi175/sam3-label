"""Unified model registry for the sam3-auto-label platform.

Single source of truth describing each model: its API service, ports,
host checkpoint directory, container mount layout, expected weight files,
and how to obtain the weights. Used by the host CLI
(`python -m model_registry`) and by ops-api's /v1/models endpoints.
"""

from model_registry.registry import MODELS, DownloadSpec, ModelSpec, get_model
from model_registry.status import ModelStatus, repo_root, resolve_host_dir, status

__all__ = [
    "MODELS",
    "DownloadSpec",
    "ModelSpec",
    "ModelStatus",
    "get_model",
    "repo_root",
    "resolve_host_dir",
    "status",
]
