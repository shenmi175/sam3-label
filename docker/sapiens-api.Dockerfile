ARG SAPIENS_API_BASE_IMAGE=pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime
FROM ${SAPIENS_API_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    SAPIENS_REPO_DIR=/app/external/sapiens2 \
    SAPIENS_CHECKPOINT_ROOT=/models/sapiens2 \
    PYTHONPATH=/app/sapiens-api:/app/external/sapiens2
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libglib2.0-0 libsm6 libxext6 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY external/sapiens2 /app/external/sapiens2
COPY sapiens-api/requirements.txt /tmp/sapiens-api-requirements.txt
RUN python -m venv --system-site-packages "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/python" -m pip install --upgrade pip setuptools wheel \
    && "$VIRTUAL_ENV/bin/python" -m pip install -r /tmp/sapiens-api-requirements.txt

COPY sapiens-api /app/sapiens-api
RUN python -c "from app.engine import SapiensSegmentationEngine; from app.pose_engine import SapiensPoseEngine; print('sapiens-api imports ok')"

WORKDIR /app/sapiens-api
EXPOSE 8010

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8010"]
