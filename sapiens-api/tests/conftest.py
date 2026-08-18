import sys
import types
from pathlib import Path

# Make the sapiens-api root importable (app.*).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _install_fake_torch() -> None:
    """Install a minimal fake torch so app.engine/app.pose_engine import without
    the real (GPU) dependency. Mirrors the locate-anything-api tests approach."""
    torch_mod = types.ModuleType("torch")

    class _FakeCuda:
        def is_available(self) -> bool:
            return False

        def empty_cache(self) -> None:
            pass

    torch_mod.cuda = _FakeCuda()  # type: ignore[attr-defined]
    nn_mod = types.ModuleType("torch.nn")
    functional_mod = types.ModuleType("torch.nn.functional")
    torch_mod.nn = nn_mod  # type: ignore[attr-defined]
    nn_mod.functional = functional_mod  # type: ignore[attr-defined]
    sys.modules["torch"] = torch_mod
    sys.modules["torch.nn"] = nn_mod
    sys.modules["torch.nn.functional"] = functional_mod


try:  # pragma: no cover - depends on host environment
    import torch  # noqa: F401
except ImportError:
    _install_fake_torch()
