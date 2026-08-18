# LocateAnything-3B inference service

Bbox-only detection backend that mirrors the **HTTP contract** of
`sam3-api` so the web-auto frontend can talk to either backend without
code changes.

## Differences from sam3-api

| Aspect              | sam3-api                           | locate-anything-api                   |
| ------------------- | ---------------------------------- | ------------------------------------- |
| Model               | SAM3 (Grounded-SAM family)         | `nvidia/LocateAnything-3B` (VLM)      |
| Supported `mode`    | `text`, `points`, `boxes`          | `text` only                           |
| Output              | bbox + polygon + mask              | **bbox only** (`polygon=null`)        |
| `include_mask_png`  | honored                            | accepted & ignored (wire compat)      |
| Default `score`     | model-produced                     | `score_default` form field (default 0.5) |

## Endpoints

- `GET  /health`           — readiness + GPU snapshot
- `POST /v1/warmup`        — force-load the model
- `POST /v1/unload`        — release VRAM (useful when sam3-api shares the GPU)
- `POST /v1/infer`         — single-image text grounding

## Environment

| Var                           | Default                         | Notes                                |
| ----------------------------- | ------------------------------- | ------------------------------------ |
| `LOCATE_CHECKPOINT_PATH`      | `nvidia/LocateAnything-3B`      | local dir or HF repo id              |
| `LOCATE_DEVICE`               | `cuda`                          |                                      |
| `LOCATE_ATTN_BACKEND`         | `la_flash`                      | `la_flash` (~12 GB) or `sdpa` (~35 GB) |
| `LOCATE_MAX_NEW_TOKENS`       | `8192`                          |                                      |
| `LOCATE_DEFAULT_SCORE`        | `0.5`                           | fallback when client omits           |
| `LOCATE_API_TOKEN`            | `""`                            | set to enable Bearer auth            |
| `LOCATE_EAGER_LOAD`           | `true`                          | load + verify on startup (fail-fast); set `0` for lazy load. Legacy `LOCATE_WARMUP_ON_START` still honored |

## Run locally

```bash
cd locate-anything-api
pip install -r requirements.txt
python run.py           # listens on 0.0.0.0:8004
```

## Wire-format example

```
POST /v1/infer  multipart/form-data
  file=@photo.jpg
  mode=text
  prompt=person,car
  threshold=0.5
  max_detections=200
  score_default=0.5
```

Response shape is `InferResultOut` — same JSON layout as sam3-api.
`detections[*].polygon` is always `null`; downstream consumers (web-auto,
COCO/YOLO exporters) treat it as a bbox-only annotation.
