from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from model_registry import MODELS, get_model, status  # noqa: E402
from model_registry.status import resolve_host_dir  # noqa: E402

_CLEAN_ENV = mock.patch.dict(
    os.environ,
    {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("SAM3_", "SAPIENS_", "LOCATE_"))
    },
    clear=True,
)


class RegistryConsistencyTest(unittest.TestCase):
    def test_registry_ids_ports_services_unique(self) -> None:
        ids = [m.id for m in MODELS]
        self.assertEqual(len(ids), len(set(ids)))
        ports = [m.api_port for m in MODELS]
        self.assertEqual(len(ports), len(set(ports)))
        services = [m.api_service for m in MODELS]
        self.assertEqual(len(services), len(set(services)))

    def test_get_model(self) -> None:
        self.assertEqual(get_model("sam3").api_service, "sam3-api")
        with self.assertRaises(KeyError):
            get_model("nope")

    def test_hf_downloads_have_repo_id(self) -> None:
        for spec in MODELS:
            if spec.download.kind == "hf":
                self.assertTrue(spec.download.hf_repo_id, spec.id)
            else:
                self.assertIn(spec.download.kind, {"manual"})
                self.assertTrue(spec.download.instructions, spec.id)

    def test_registry_matches_docker_compose(self) -> None:
        compose_text = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        services = set(re.findall(r"^  ([a-z0-9-]+):\s*$", compose_text, re.M))
        for spec in MODELS:
            with self.subTest(model=spec.id):
                self.assertIn(spec.api_service, services)
                self.assertIn(f"{spec.api_port_env}: {spec.api_port}", compose_text)
                self.assertIn(
                    f"{spec.container_path_env}: {spec.container_mount}", compose_text
                )
                self.assertIn(
                    f"${{{spec.host_dir_env}:-./{spec.default_host_dir}}}", compose_text
                )

    def test_container_mount_covers_expected_files(self) -> None:
        for spec in MODELS:
            with self.subTest(model=spec.id):
                if spec.id == "sam3":
                    # Container env points at the weight file itself.
                    self.assertTrue(spec.container_mount.endswith(spec.expected_files[0]))
                else:
                    # Container env points at the checkpoint root directory.
                    self.assertFalse(spec.container_mount.endswith("/"))


class StatusResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        _CLEAN_ENV.start()
        self.addCleanup(_CLEAN_ENV.stop)

    def test_default_dir_relative_to_root(self) -> None:
        spec = get_model("sam3")
        resolved = resolve_host_dir(spec, root=ROOT, env_file={})
        self.assertEqual(resolved, ROOT / "sam3_checkpoints")

    def test_env_file_override(self) -> None:
        spec = get_model("sapiens2")
        resolved = resolve_host_dir(
            spec, root=ROOT, env_file={"SAPIENS_CHECKPOINT_ROOT": "/data/weights"}
        )
        self.assertEqual(resolved, Path("/data/weights"))

    def test_os_environ_wins_over_env_file(self) -> None:
        spec = get_model("locate-anything")
        os.environ["LOCATE_CHECKPOINT_DIR"] = "/tmp/la"
        try:
            resolved = resolve_host_dir(
                spec, root=ROOT, env_file={"LOCATE_CHECKPOINT_DIR": "/other"}
            )
            self.assertEqual(resolved, Path("/tmp/la"))
        finally:
            del os.environ["LOCATE_CHECKPOINT_DIR"]

    def test_status_states(self) -> None:
        spec = get_model("sam3")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            st = status(spec, root=root, env_file={})
            self.assertEqual(st.state, "missing")

            ckpt_dir = root / spec.default_host_dir
            ckpt_dir.mkdir(parents=True)
            st = status(spec, root=root, env_file={})
            self.assertEqual(st.state, "incomplete")

            (ckpt_dir / "sam3.pt").write_bytes(b"x" * 10)
            st = status(spec, root=root, env_file={})
            self.assertEqual(st.state, "ready")
            self.assertEqual(st.total_bytes, 10)

    def test_optional_files_do_not_block_ready(self) -> None:
        spec = get_model("sapiens2")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / spec.default_host_dir
            (base / "seg").mkdir(parents=True)
            (base / "pose").mkdir()
            (base / "seg" / "sapiens2_5b_seg.safetensors").write_bytes(b"a")
            (base / "pose" / "sapiens2_5b_pose.safetensors").write_bytes(b"b")
            st = status(spec, root=root, env_file={})
            self.assertEqual(st.state, "ready")
            optional = [f for f in st.files if f.optional]
            self.assertTrue(optional)
            self.assertFalse(any(f.exists for f in optional))


if __name__ == "__main__":
    unittest.main()
