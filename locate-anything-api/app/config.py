from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    return float(raw) if raw else float(default)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else int(default)


@dataclass(frozen=True)
class Settings:
    api_title: str = "LocateAnything API"
    api_version: str = "0.1.0"

    checkpoint_path: str = field(
        default_factory=lambda: os.getenv(
            "LOCATE_CHECKPOINT_PATH", "nvidia/LocateAnything-3B"
        )
    )
    device: str = field(default_factory=lambda: os.getenv("LOCATE_DEVICE", "cuda"))
    attn_backend: str = field(
        default_factory=lambda: os.getenv("LOCATE_ATTN_BACKEND", "la_flash")
    )

    max_image_bytes: int = field(default_factory=lambda: _env_int("LOCATE_MAX_IMAGE_BYTES", 32 * 1024 * 1024))
    default_threshold: float = field(default_factory=lambda: _env_float("LOCATE_DEFAULT_THRESHOLD", 0.5))
    default_score: float = field(default_factory=lambda: _env_float("LOCATE_DEFAULT_SCORE", 0.5))

    max_new_tokens: int = field(default_factory=lambda: _env_int("LOCATE_MAX_NEW_TOKENS", 8192))
    temperature: float = field(default_factory=lambda: _env_float("LOCATE_TEMPERATURE", 0.7))
    top_p: float = field(default_factory=lambda: _env_float("LOCATE_TOP_P", 0.9))
    repetition_penalty: float = field(default_factory=lambda: _env_float("LOCATE_REPETITION_PENALTY", 1.1))
    generation_mode: str = field(default_factory=lambda: os.getenv("LOCATE_GEN_MODE", "hybrid"))

    warmup_on_start: bool = field(default_factory=lambda: _env_bool("LOCATE_WARMUP_ON_START", False))
    api_token: str = field(default_factory=lambda: os.getenv("LOCATE_API_TOKEN", ""))

    cors_origins: list[str] = field(
        default_factory=lambda: [
            s.strip()
            for s in os.getenv("LOCATE_CORS_ORIGINS", "*").split(",")
            if s.strip()
        ]
        or ["*"]
    )

    @property
    def checkpoint_display(self) -> str:
        p = Path(self.checkpoint_path)
        return str(p) if p.exists() else self.checkpoint_path


_SETTINGS: Settings | None = None


def get_settings() -> Settings:
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = Settings()
    return _SETTINGS
