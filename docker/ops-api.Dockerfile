FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    PYTHONPATH=/app/ops-api
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN python -m venv "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/python" -m pip install --upgrade pip setuptools wheel

COPY ops-api/requirements.txt /tmp/ops-api-requirements.txt
RUN "$VIRTUAL_ENV/bin/python" -m pip install -r /tmp/ops-api-requirements.txt

COPY ops-api /app/ops-api
RUN python -c "from app.main import app; print('ops-api imports ok')"

WORKDIR /app/ops-api
EXPOSE 8020

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8020"]
