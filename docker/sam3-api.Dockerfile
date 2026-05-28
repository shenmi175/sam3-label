ARG SAM3_API_BASE_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${SAM3_API_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    PYTHONPATH=/app/sam3-api:/app

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

COPY sam3-api/requirements.txt /tmp/sam3-api-requirements.txt
RUN python -m pip install --upgrade pip \
    && grep -v -E '^(torch|torchvision)($|[=<>])' /tmp/sam3-api-requirements.txt > /tmp/sam3-api-runtime-requirements.txt \
    && python -m pip install -r /tmp/sam3-api-runtime-requirements.txt

COPY sam3-api /app/sam3-api
COPY sam3 /app/sam3

RUN python -c "import sam3; from app.engine import Sam3InferenceEngine; print('sam3-api runtime imports ok')"

WORKDIR /app/sam3-api
EXPOSE 8001

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8001"]
