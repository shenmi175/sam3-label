import base64
from dataclasses import dataclass
from io import BytesIO

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class MaskComponent:
    polygon: list[list[float]]
    area: int
    mask: np.ndarray


def load_image_from_bytes(raw: bytes) -> Image.Image:
    with Image.open(BytesIO(raw)) as image:
        return image.convert("RGB")


def mask_to_png_base64(mask: np.ndarray) -> str:
    # mask is expected to be uint8 array with values {0,1}
    mask_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    buf = BytesIO()
    mask_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def split_mask_components(mask: np.ndarray, min_contour_area: float = 1.0) -> list[MaskComponent]:
    """
    Split a binary mask into valid external-contour components.

    Each component keeps its own binary mask and pixel area. Very small contours
    and contours that cannot simplify to a valid polygon are treated as noise.
    """
    if mask is None:
        return []

    try:
        import cv2
    except Exception:
        return []

    work = (mask > 0).astype(np.uint8)
    if work.ndim != 2:
        return []

    contours, _ = cv2.findContours(work * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    contours = sorted(contours, key=lambda c: cv2.boundingRect(c)[:2][::-1])
    components: list[MaskComponent] = []
    for contour in contours:
        contour_area = float(cv2.contourArea(contour))
        if contour_area < float(min_contour_area):
            continue

        peri = cv2.arcLength(contour, True)
        epsilon = max(1.0, 0.003 * peri)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        if (approx is None or len(approx) < 3) and len(contour) >= 3:
            approx = contour
        if approx is None or len(approx) < 3:
            continue

        component_region = np.zeros_like(work, dtype=np.uint8)
        cv2.drawContours(component_region, [contour], -1, 1, thickness=cv2.FILLED)
        component_mask = ((component_region > 0) & (work > 0)).astype(np.uint8)
        area = int(component_mask.sum())
        if area <= 0:
            continue

        polygon = [[float(pt[0]), float(pt[1])] for pt in approx.reshape(-1, 2)]
        components.append(MaskComponent(polygon=polygon, area=area, mask=component_mask))

    return components


def mask_to_polygons(mask: np.ndarray, min_contour_area: float = 1.0) -> list[list[list[float]]]:
    return [component.polygon for component in split_mask_components(mask, min_contour_area)]


def mask_to_polygon(mask: np.ndarray) -> list[list[float]]:
    """
    Compatibility wrapper for callers that still expect one polygon.
    Detection output paths use split_mask_components() to preserve all contours.
    """
    components = split_mask_components(mask)
    if not components:
        return []
    return max(components, key=lambda component: component.area).polygon
