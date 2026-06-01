FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/web-auto \
    WEB_AUTO_HOST=0.0.0.0 \
    WEB_AUTO_PORT=8000 \
    WEB_AUTO_DATA_DIR=/data/web-auto

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libvips-tools \
    && rm -rf /var/lib/apt/lists/*

COPY web-auto/requirements.txt /tmp/web-auto-requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /tmp/web-auto-requirements.txt

COPY web-auto /app/web-auto

RUN mkdir -p /data/web-auto

WORKDIR /app/web-auto
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
