from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from typing import Any


@dataclass
class ChangeSet:
    image_id: str
    rel_path: str
    delete_indices: list[int] = field(default_factory=list)
    delete_annotation_ids: list[str] = field(default_factory=list)
    delete_fingerprints: dict[str, str] = field(default_factory=dict)
    relabels: list[dict[str, Any]] = field(default_factory=list)
    geometry_updates: list[dict[str, Any]] = field(default_factory=list)
    removed_count: int = 0
    relabel_count: int = 0
    removed_components: int = 0
    removed_pixels: int = 0
    opening_removed_pixels: int = 0
    bridges_added: int = 0
    bridge_pixels: int = 0
    filled_holes: int = 0
    filled_pixels: int = 0
    collision_rejected_bridges: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            'image_id': self.image_id,
            'rel_path': self.rel_path,
            'delete_indices': self.delete_indices,
            'delete_annotation_ids': self.delete_annotation_ids,
            'delete_fingerprints': self.delete_fingerprints,
            'relabels': self.relabels,
            'geometry_updates': self.geometry_updates,
            'removed_count': self.removed_count,
            'relabel_count': self.relabel_count,
            'removed_components': self.removed_components,
            'removed_pixels': self.removed_pixels,
            'opening_removed_pixels': self.opening_removed_pixels,
            'bridges_added': self.bridges_added,
            'bridge_pixels': self.bridge_pixels,
            'filled_holes': self.filled_holes,
            'filled_pixels': self.filled_pixels,
            'collision_rejected_bridges': self.collision_rejected_bridges,
        }


def annotation_fingerprint(annotation: dict[str, Any]) -> str:
    """Stable identity/version check for an annotation in a preview plan."""
    raw = json.dumps(annotation, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()
