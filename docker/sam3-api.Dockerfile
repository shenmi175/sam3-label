ARG SAM3_API_BASE_IMAGE=pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime
FROM ${SAM3_API_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    PYTHONPATH=/app/sam3-api
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libsm6 libxext6 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# sam3 is vendored as a pinned git submodule (external/sam3). It is installed as a
# normal (non-editable) package into site-packages; PYTHONPATH must NOT point at the
# source tree. Run `scripts/check_submodules.sh` before building to make sure the
# submodule is checked out.
COPY external/sam3 /app/external/sam3
COPY LICENSES/SAM-LICENSE /app/licenses/SAM-LICENSE
COPY sam3-api/requirements.txt /tmp/sam3-api-requirements.txt
RUN python -m venv --system-site-packages "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/python" -m pip install --upgrade pip setuptools wheel \
    && "$VIRTUAL_ENV/bin/python" -m pip install /app/external/sam3 \
    && grep -v -E '^(torch|torchvision)($|[=<>])' /tmp/sam3-api-requirements.txt > /tmp/sam3-api-runtime-requirements.txt \
    && "$VIRTUAL_ENV/bin/python" -m pip install -r /tmp/sam3-api-runtime-requirements.txt

COPY sam3-api /app/sam3-api

# Build-time verification: sam3 must be importable from site-packages (not the source
# tree), its distribution version must be resolvable, and the SAM license must ship
# inside the image.
RUN python - <<'EOF'
import importlib.metadata
import os

import sam3

from app.engine import Sam3InferenceEngine  # noqa: F401

dist_version = importlib.metadata.version("sam3")
print("sam3 distribution version:", dist_version)
print("sam3 module version:", getattr(sam3, "__version__", None))
print("sam3 module file:", sam3.__file__)
assert "/app/external/sam3" not in str(sam3.__file__), (
    "sam3 must resolve from site-packages, not the vendored source tree"
)
assert os.path.isfile("/app/licenses/SAM-LICENSE"), "SAM license file missing from image"
print("sam3-api runtime imports ok")
EOF

WORKDIR /app/sam3-api
EXPOSE 8001

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8001"]
