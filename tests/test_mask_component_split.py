import base64
import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

try:
    import cv2
except Exception:
    cv2 = None


ROOT = Path(__file__).resolve().parents[1]


def _load_sam3_utils():
    spec = importlib.util.spec_from_file_location(
        "sam3_api_utils_for_tests",
        ROOT / "sam3-api" / "app" / "utils.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _encode_mask(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", (mask.astype(np.uint8) * 255))
    assert ok
    return base64.b64encode(encoded.tobytes()).decode("utf-8")


def _decode_mask_area(mask_b64: str) -> int:
    raw = base64.b64decode(mask_b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    decoded = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    assert decoded is not None
    return int(np.count_nonzero(decoded))


def _load_web_auto_conversion():
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    sys.path.insert(0, str(ROOT / "web-auto"))
    try:
        from app.services.inference_results import _convert_detections
    finally:
        sys.path.pop(0)
    return _convert_detections


@unittest.skipIf(cv2 is None, "cv2 is not installed")
class TestMaskComponentSplit(unittest.TestCase):
    def test_split_mask_components_returns_all_disconnected_regions(self):
        utils = _load_sam3_utils()
        mask = np.zeros((20, 20), dtype=np.uint8)
        mask[2:6, 2:6] = 1
        mask[10:13, 12:17] = 1

        components = utils.split_mask_components(mask)

        self.assertEqual(len(components), 2)
        self.assertEqual([component.area for component in components], [16, 15])
        self.assertTrue(all(len(component.polygon) >= 3 for component in components))
        self.assertEqual([int(component.mask.sum()) for component in components], [16, 15])

    def test_split_mask_components_keeps_small_valid_region_and_drops_single_pixel_noise(self):
        utils = _load_sam3_utils()
        mask = np.zeros((20, 20), dtype=np.uint8)
        mask[1:8, 1:8] = 1
        mask[12:14, 12:14] = 1
        mask[18, 18] = 1

        components = utils.split_mask_components(mask)

        self.assertEqual(len(components), 2)
        self.assertEqual([component.area for component in components], [49, 4])

    def test_web_auto_fallback_splits_mask_only_remote_detection(self):
        convert_detections = _load_web_auto_conversion()
        mask = np.zeros((20, 20), dtype=np.uint8)
        mask[2:6, 2:6] = 1
        mask[10:13, 12:17] = 1

        annotations = convert_detections(
            detections=[
                {
                    "id": "det_0007",
                    "label": "chair",
                    "score": 0.9,
                    "bbox_xyxy": [0, 0, 20, 20],
                    "mask_png_base64": _encode_mask(mask),
                }
            ],
            classes=["chair"],
        )

        self.assertEqual([ann["id"] for ann in annotations], ["det_0007_c001", "det_0007_c002"])
        self.assertEqual([ann["model_det_id"] for ann in annotations], ["det_0007", "det_0007"])
        self.assertEqual([ann["contour_index"] for ann in annotations], [1, 2])
        self.assertEqual([ann["contour_count"] for ann in annotations], [2, 2])
        self.assertEqual(
            [ann["bbox"] for ann in annotations],
            [[0.0, 0.0, 20.0, 20.0], [0.0, 0.0, 20.0, 20.0]],
        )
        self.assertEqual([ann["area"] for ann in annotations], [16.0, 15.0])
        self.assertEqual([_decode_mask_area(ann["mask_png_base64"]) for ann in annotations], [16, 15])

    def test_web_auto_keeps_already_polygonized_remote_detections_without_resplitting(self):
        convert_detections = _load_web_auto_conversion()
        annotations = convert_detections(
            detections=[
                {
                    "id": "det_0001_c001",
                    "label": "chair",
                    "score": 0.8,
                    "bbox_xyxy": [0, 0, 20, 20],
                    "polygon": [[1, 1], [5, 1], [5, 5], [1, 5]],
                    "area": 16,
                    "mask_png_base64": "not-used-when-polygon-exists",
                    "model_det_id": "det_0001",
                    "contour_index": 1,
                    "contour_count": 2,
                },
                {
                    "id": "det_0001_c002",
                    "label": "chair",
                    "score": 0.8,
                    "bbox_xyxy": [0, 0, 20, 20],
                    "polygon": [[12, 10], [16, 10], [16, 12], [12, 12]],
                    "area": 15,
                    "model_det_id": "det_0001",
                    "contour_index": 2,
                    "contour_count": 2,
                },
            ],
            classes=["chair"],
        )

        self.assertEqual(len(annotations), 2)
        self.assertEqual([ann["id"] for ann in annotations], ["det_0001_c001", "det_0001_c002"])
        self.assertEqual([ann["model_det_id"] for ann in annotations], ["det_0001", "det_0001"])


if __name__ == "__main__":
    unittest.main()
