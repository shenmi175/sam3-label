ARG SAM3_API_BASE_IMAGE=pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime
FROM ${SAM3_API_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    PYTHONPATH=/app/sam3-api:/app
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libsm6 libxext6 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md LICENSE MANIFEST.in /app/
COPY sam3 /app/sam3
COPY sam3-api/requirements.txt /tmp/sam3-api-requirements.txt
RUN python -m venv --system-site-packages "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/python" -m pip install --upgrade pip setuptools wheel \
    && "$VIRTUAL_ENV/bin/python" -m pip install -e /app \
    && grep -v -E '^(torch|torchvision)($|[=<>])' /tmp/sam3-api-requirements.txt > /tmp/sam3-api-runtime-requirements.txt \
    && "$VIRTUAL_ENV/bin/python" -m pip install -r /tmp/sam3-api-runtime-requirements.txt

COPY sam3-api /app/sam3-api

RUN python -c "import sam3; from app.engine import Sam3InferenceEngine; print('sam3-api runtime imports ok')"

WORKDIR /app/sam3-api
EXPOSE 8001

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8001"]
