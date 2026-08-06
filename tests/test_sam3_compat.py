"""Compatibility tests for the sam3 adapter layer (sam3-api/app/sam3_compat.py).

Two tiers:
1. Structural checks run without the sam3 package installed (CI-safe).
2. Symbol/signature snapshot checks run only when the pinned sam3 package is
   importable (e.g. inside the sam3-api image or a dev env with external/sam3 installed).
"""

import importlib.util
import inspect
import re
import sys
import unittest
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_compat():
    spec = importlib.util.spec_from_file_location(
        "sam3_compat_for_tests",
        ROOT / "sam3-api" / "app" / "sam3_compat.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


compat = _load_compat()

try:
    import sam3  # noqa: F401

    SAM3_AVAILABLE = True
except Exception:
    SAM3_AVAILABLE = False


class TestCompatDeclarations(unittest.TestCase):
    """Structural checks that never require the sam3 package."""

    def test_pin_sha_is_full_40_char_hex(self) -> None:
        assert re.fullmatch(r"[0-9a-f]{40}", compat.SAM3_PIN_SHA)

    def test_required_symbols_well_formed(self) -> None:
        self.assertGreater(len(compat.REQUIRED_SYMBOLS), 0)
        for name, target in compat.REQUIRED_SYMBOLS.items():
            self.assertIsInstance(name, str)
            self.assertEqual(len(target), 2, f"bad target for {name}")
            module_path, attr = target
            self.assertTrue(module_path.startswith("sam3."), module_path)
            self.assertTrue(attr, f"empty attribute for {name}")

    def test_surfaces_subset_of_required_symbols(self) -> None:
        for name in compat.IMAGE_SURFACE + compat.VIDEO_SURFACE:
            self.assertIn(name, compat.REQUIRED_SYMBOLS)

    def test_missing_symbol_raises_compat_error_with_pin_sha(self) -> None:
        compat.REQUIRED_SYMBOLS["__definitely_missing__"] = (
            "sam3.model.__no_such_module__",
            "Nope",
        )
        compat._cache.pop("__definitely_missing__", None)
        try:
            with self.assertRaises(compat.Sam3CompatError) as ctx:
                compat._load_symbol("__definitely_missing__")
            self.assertIn(compat.SAM3_PIN_SHA, str(ctx.exception))
            self.assertIn("__no_such_module__", str(ctx.exception))
        finally:
            compat.REQUIRED_SYMBOLS.pop("__definitely_missing__", None)
            compat._cache.pop("__definitely_missing__", None)

    def test_runtime_info_shape_without_sam3(self) -> None:
        info = compat.sam3_runtime_info()
        self.assertEqual(info["pin_sha"], compat.SAM3_PIN_SHA)
        self.assertIn("cuda_available", info)


@pytest.mark.skipif(not SAM3_AVAILABLE, reason="sam3 package not installed")
class TestSam3SymbolSnapshot(unittest.TestCase):
    """Requires the pinned sam3 package (run inside sam3-api image or dev env)."""

    def test_all_required_symbols_importable(self) -> None:
        surface = compat.load_image_surface()
        for name in compat.IMAGE_SURFACE:
            self.assertIn(name, surface)
        video = compat.load_video_surface()
        for name in compat.VIDEO_SURFACE:
            self.assertIn(name, video)
        self.assertIsNotNone(compat._load_symbol("load_video_frames"))

    def test_build_sam3_image_model_signature(self) -> None:
        fn = compat._load_symbol("build_sam3_image_model")
        params = set(inspect.signature(fn).parameters)
        for expected in ("checkpoint_path", "load_from_HF", "device", "eval_mode", "compile"):
            self.assertIn(expected, params)

    def test_video_predictor_signature(self) -> None:
        cls = compat._load_symbol("Sam3VideoPredictor")
        params = set(inspect.signature(cls.__init__).parameters)
        for expected in ("checkpoint_path", "apply_temporal_disambiguation"):
            self.assertIn(expected, params)

    def test_postprocessor_is_class(self) -> None:
        cls = compat._load_symbol("PostProcessImage")
        self.assertTrue(inspect.isclass(cls))

    def test_sam3_resolves_outside_repo_source_tree(self) -> None:
        info = compat.sam3_runtime_info()
        module_file = info.get("module_file") or ""
        self.assertNotIn(
            str(ROOT / "sam3" / "__init__.py"),
            module_file,
            "sam3 must not resolve from the legacy top-level sam3/ source tree",
        )
