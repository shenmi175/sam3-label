"""Test bootstrap for sam3-api.

Mirrors locate-anything-api/tests/conftest.py: insert the service root into
sys.path, and (only when real torch is absent) install a fake torch/torchvision
into sys.modules so app.engine can be imported on machines without the CUDA
runtime. Engine tests that rely on the fake counters is skipped when a real
torch is installed.
"""

from __future__ import annotations

import sys
import types
from contextlib import nullcontext
from pathlib import Path

import pytest

SAM3_API_ROOT = Path(__file__).resolve().parents[1]
if str(SAM3_API_ROOT) not in sys.path:
    sys.path.insert(0, str(SAM3_API_ROOT))


class FakeOutOfMemoryError(RuntimeError):
    """Stand-in for torch.cuda.OutOfMemoryError."""


class FakeCuda:
    def __init__(self) -> None:
        self.available = False
        self.bf16_supported = True
        self.empty_cache_calls = 0
        self.allocated = 256 * 1024 * 1024

    def is_available(self) -> bool:
        return self.available

    def is_bf16_supported(self) -> bool:
        return self.bf16_supported

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1

    def memory_allocated(self, idx: int | None = None) -> int:
        return self.allocated


class FakeAutocast:
    """Records enter/exit pairing; engine enters one at load and must exit on unload."""

    instances: list["FakeAutocast"] = []

    def __init__(self, *args, **kwargs) -> None:
        self.kwargs = kwargs
        self.enter_count = 0
        self.exit_count = 0
        FakeAutocast.instances.append(self)

    def __enter__(self) -> "FakeAutocast":
        self.enter_count += 1
        return self

    def __exit__(self, *exc_info) -> bool:
        self.exit_count += 1
        return False


class FakeDevice:
    def __init__(self, spec: str | None = None) -> None:
        self.spec = spec

    def __str__(self) -> str:
        return str(self.spec)


def _build_fake_torch() -> types.ModuleType:
    mod = types.ModuleType("torch")
    for name in ("float16", "float32", "bfloat16", "int64", "long", "bool", "uint8"):
        setattr(mod, name, f"<fake dtype {name}>")
    cuda = FakeCuda()
    cuda.OutOfMemoryError = FakeOutOfMemoryError  # type: ignore[attr-defined]
    mod.cuda = cuda  # type: ignore[attr-defined]
    mod.autocast = FakeAutocast  # type: ignore[attr-defined]
    mod.device = FakeDevice  # type: ignore[attr-defined]
    mod.Tensor = type("Tensor", (), {})  # annotation evaluation in app.engine  # type: ignore[attr-defined]
    mod.backends = types.SimpleNamespace(
        cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=False)),
        cudnn=types.SimpleNamespace(allow_tf32=False),
    )

    def _inference_mode():
        return nullcontext()

    def _unsupported(*args, **kwargs):
        raise NotImplementedError("fake torch tensor factories are not supported in tests")

    mod.inference_mode = _inference_mode  # type: ignore[attr-defined]
    mod.is_tensor = lambda obj: False  # type: ignore[attr-defined]
    mod.nn = types.SimpleNamespace(functional=types.SimpleNamespace(pad=lambda *a, **k: a[0]))
    for fn in ("arange", "zeros", "ones", "empty", "stack", "cat", "tensor"):
        setattr(mod, fn, _unsupported)
    return mod


def _install_fake_torchvision() -> None:
    tv = types.ModuleType("torchvision")
    transforms = types.ModuleType("torchvision.transforms")
    functional = types.ModuleType("torchvision.transforms.functional")
    functional.to_tensor = lambda img: img  # type: ignore[attr-defined]
    functional.resize = lambda tensor, size, antialias=True: tensor  # type: ignore[attr-defined]
    functional.normalize = lambda tensor, mean, std: tensor  # type: ignore[attr-defined]
    transforms.functional = functional  # type: ignore[attr-defined]
    tv.transforms = transforms  # type: ignore[attr-defined]
    sys.modules["torchvision"] = tv
    sys.modules["torchvision.transforms"] = transforms
    sys.modules["torchvision.transforms.functional"] = functional


try:  # pragma: no cover - depends on environment
    import torch  # type: ignore  # noqa: F401

    HAVE_REAL_TORCH = True
    FAKE_TORCH: types.ModuleType | None = None
except ImportError:
    HAVE_REAL_TORCH = False
    FAKE_TORCH = _build_fake_torch()
    sys.modules["torch"] = FAKE_TORCH

try:  # pragma: no cover - depends on environment
    import torchvision  # type: ignore  # noqa: F401
except ImportError:
    _install_fake_torchvision()


@pytest.fixture
def fake_torch():
    """The fake torch module with freshly reset counters.

    Skips when a real torch is installed (module-level `import torch` in
    app.engine then holds the real module and fake counters are meaningless).
    """
    if FAKE_TORCH is None:
        pytest.skip("real torch installed; fake-torch counters unavailable")
    cuda = FAKE_TORCH.cuda
    cuda.available = False
    cuda.empty_cache_calls = 0
    cuda.allocated = 256 * 1024 * 1024
    FakeAutocast.instances.clear()
    return FAKE_TORCH
