from __future__ import annotations

from pydantic import BaseModel


class PoseInferIn(BaseModel):
    project_id: str
    image_id: str
    bbox_threshold: float = 0.3
    nms_threshold: float = 0.3
    keypoint_threshold: float = 0.3
