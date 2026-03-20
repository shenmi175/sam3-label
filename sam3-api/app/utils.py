import base64
from io import BytesIO

import numpy as np
from PIL import Image


def load_image_from_bytes(raw: bytes) -> Image.Image:
    with Image.open(BytesIO(raw)) as image:
        return image.convert("RGB")


def mask_to_png_base64(mask: np.ndarray) -> str:
    # mask is expected to be uint8 array with values {0,1}
    mask_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    buf = BytesIO()
    mask_img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def mask_to_polygon(mask: np.ndarray) -> list[list[float]]:
    """
    Convert a binary mask to a simplified polygon.
    Returns an empty list when contour extraction is unavailable or unstable.
    """
    if mask is None:
        return []

    try:
        import cv2
    except Exception:
        return []

    work = (mask.astype(np.uint8) * 255)
    if work.ndim != 2:
        return []

    contours, _ = cv2.findContours(work, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    contour = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(contour))
    if area < 9.0:
        return []

    peri = cv2.arcLength(contour, True)
    epsilon = max(1.0, 0.003 * peri)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    if approx is None or len(approx) < 3:
        return []

    return [[float(pt[0]), float(pt[1])] for pt in approx.reshape(-1, 2)]
