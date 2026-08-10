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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web-auto'))

from app.services.annotation_masks import annotation_mask_path, normalize_annotation_masks  # noqa: E402
from app.services.image_previews import ImagePreviewService  # noqa: E402
from app.services.image_tiles import ImageTileService  # noqa: E402


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


if __name__ == '__main__':
    unittest.main()
