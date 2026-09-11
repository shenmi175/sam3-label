"""Pluggable, preview-first data-cleaning engine."""

from .config import normalize_config
from .engine import analyze_project, apply_change_sets

__all__ = ['normalize_config', 'analyze_project', 'apply_change_sets']
