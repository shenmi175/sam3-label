FROM pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LOCATE_API_HOST=0.0.0.0 \
    LOCATE_API_PORT=8004 \
    LOCATE_CHECKPOINT_PATH=/models/LocateAnything-3B \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    HF_ENDPOINT= \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/locate-anything-api
COPY locate-anything-api/requirements.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

COPY locate-anything-api/ ./

EXPOSE 8004

HEALTHCHECK --interval=30s --timeout=8s --start-period=300s --retries=3 \
  CMD python -c "import urllib.request,json,sys;d=json.load(urllib.request.urlopen('http://localhost:8004/health',timeout=5));sys.exit(0 if d.get('status') in ('ok','not_loaded','loading') else 1)"

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8004"]
