from __future__ import annotations

import base64
import sys
import tempfile
import threading
import time
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.services.annotation_masks import annotation_mask_path, normalize_annotation_masks  # noqa: E402
from app.services.image_previews import ImagePreviewService  # noqa: E402
from app.services.image_tiles import ImageTileService  # noqa: E402
from app.services.inference_service import InferenceService  # noqa: E402


def _write_image(path: Path, size: tuple[int, int] = (64, 48)) -> None:
    Image.new('RGB', size, (120, 80, 40)).save(path)


class WebAutoPerformanceServiceTests(unittest.TestCase):
    def test_tile_status_enqueue_is_nonblocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_path = tmp / 'image.jpg'
            _write_image(image_path)
            release = threading.Event()
            started = threading.Event()

            service = ImageTileService(get_current_data_dir=lambda: tmp, max_workers=1)

            def fake_generate(tile_dir: Path, source: Path):  # type: ignore[no-untyped-def]
                started.set()
                release.wait(timeout=2)
                tile_dir.mkdir(parents=True, exist_ok=True)
                (tile_dir / 'image.dzi').write_text(
                    '<Image TileSize="256" Overlap="1" Format="jpg" '
                    'xmlns="http://schemas.microsoft.com/deepzoom/2008">'
                    '<Size Width="64" Height="48"/></Image>',
                    encoding='utf-8',
                )
                return tile_dir, service.read_dzi_metadata(tile_dir)

            service.generate_image_tiles = fake_generate  # type: ignore[method-assign]
            t0 = time.perf_counter()
            status = service.tile_status('p1', 'img1', image_path, enqueue=True, priority='high')
            elapsed = time.perf_counter() - t0
            release.set()

            self.assertLess(elapsed, 0.2)
            self.assertIn(status['status'], {'queued', 'generating'})
            self.assertTrue(started.wait(timeout=2))

    def test_preview_cache_generates_bounded_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            image_path = tmp / 'large.jpg'
            _write_image(image_path, (2000, 1000))
            service = ImagePreviewService(get_current_data_dir=lambda: tmp, preview_max_edge=1280, thumbnail_max_edge=384)

            cache_dir, metadata = service.ensure_image_previews('p1', 'img1', image_path)

            self.assertEqual(metadata['source_width'], 2000)
            self.assertEqual(metadata['source_height'], 1000)
            self.assertLessEqual(max(metadata['preview_width'], metadata['preview_height']), 1280)
            self.assertLessEqual(max(metadata['thumbnail_width'], metadata['thumbnail_height']), 384)
            self.assertTrue((cache_dir / 'preview.jpg').is_file())
            self.assertTrue((cache_dir / 'thumbnail.jpg').is_file())

    def test_annotation_mask_base64_is_sidecar_and_stripped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            mask = Image.new('L', (16, 16), 0)
            for x in range(4, 12):
                for y in range(5, 13):
                    mask.putpixel((x, y), 255)
            buf = BytesIO()
            mask.save(buf, format='PNG')
            mask_b64 = base64.b64encode(buf.getvalue()).decode('ascii')

            anns = normalize_annotation_masks(
                base_dir=tmp,
                project_id='p1',
                image_id='img1',
                annotations=[{'id': 'ann1', 'class_name': 'door', 'mask_png_base64': mask_b64}],
            )

            self.assertEqual(len(anns), 1)
            self.assertNotIn('mask_png_base64', anns[0])
            self.assertIn('mask_url', anns[0])
            self.assertIn('overlay_url', anns[0])
            self.assertGreaterEqual(len(anns[0].get('polygon') or []), 3)
            self.assertTrue(annotation_mask_path(tmp, 'p1', 'img1', 'ann1').is_file())


class VisualExemplarInferenceTests(unittest.TestCase):
    class _Storage:
        @staticmethod
        def load_annotations(project_id: str, image_id: str):  # type: ignore[no-untyped-def]
            return [{'id': 'existing', 'class_name': 'door'}]

    class _Sam3:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def infer(self, **kwargs):  # type: ignore[no-untyped-def]
            self.calls.append(kwargs)
            return {
                'detections': [
                    {'id': 'det_1', 'label': 'visual', 'bbox_xyxy': [30, 30, 40, 40], 'score': 0.9}
                ]
            }

    def _service(self):  # type: ignore[no-untyped-def]
        sam3 = self._Sam3()
        storage = self._Storage()
        service = InferenceService(
            get_storage=lambda: storage,
            sam3=sam3,
            infer_jobs=object(),
            default_api_base_url='http://sam3-api:8001',
            max_batch_files=8,
            max_pending_image_ids=100,
        )
        return service, sam3

    def test_example_preview_uses_pure_visual_official_box_mode(self) -> None:
        service, sam3 = self._service()
        result = service.infer_example_preview(
            project={'id': 'p1'},
            image={'id': 'img1', 'abs_path': '/tmp/source.jpg'},
            active_class='door',
            boxes=[[1, 2, 10, 20], [12, 13, 18, 19, 0]],
            threshold=0.5,
            api_base_url='http://sam3-api:8001',
        )

        self.assertEqual(len(sam3.calls), 1)
        self.assertEqual(sam3.calls[0]['mode'], 'boxes')
        self.assertEqual(sam3.calls[0]['prompt'], '')
        self.assertEqual(sam3.calls[0]['boxes'], [[1.0, 2.0, 10.0, 20.0, 1.0], [12.0, 13.0, 18.0, 19.0, 0.0]])
        self.assertEqual(result['detections'][0]['class_name'], 'door')
        self.assertEqual(result['detections'][0]['bbox'], [30.0, 30.0, 40.0, 40.0])

    def test_example_preview_requires_positive_box(self) -> None:
        service, _ = self._service()
        with self.assertRaises(HTTPException) as ctx:
            service.infer_example_preview(
                project={'id': 'p1'},
                image={'id': 'img1', 'abs_path': '/tmp/source.jpg'},
                active_class='door',
                boxes=[[1, 2, 10, 20, 0]],
                threshold=0.5,
                api_base_url='http://sam3-api:8001',
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_cross_image_example_routes_and_schema_are_removed(self) -> None:
        from app.main import app

        openapi = app.openapi()
        paths = openapi['paths']
        self.assertIn('/api/infer/example_preview', paths)
        self.assertNotIn('/api/infer/batch_example', paths)
        self.assertNotIn('/api/infer/jobs/start_batch_example', paths)
        preview_schema = openapi['components']['schemas']['InferExamplePreviewIn']['properties']
        self.assertNotIn('pure_visual', preview_schema)


if __name__ == '__main__':
    unittest.main()
