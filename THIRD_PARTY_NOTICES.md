# Third-Party Notices

This repository (sam3-auto-label platform) vendors and depends on third-party
components. Their licenses and acquisition sources are listed below.

## Vendored components (git submodules)

### external/sam3 — SAM3 (Segment Anything Model 3)

- Upstream: https://github.com/facebookresearch/sam3
- License: SAM License (Meta). Full text: `LICENSE` and `LICENSES/SAM-LICENSE`.
- Pinned submodule SHA: recorded in the gitlink; see `docs/wiki/sam3-submodule.md`
  for the current pin and the upgrade procedure.
- Used by: `sam3-api` (installed into the service image at build time).

### external/sapiens2 — Sapiens 2

- Upstream: https://github.com/facebookresearch/sapiens2
- License: see `external/sapiens2/LICENSE` in the checked-out submodule.
- Pinned submodule SHA: recorded in the gitlink.
- Used by: `sapiens-api` (sources are copied into the service image at build time).

## Model weights

- `sam3.pt` (SAM3 checkpoint): distributed by Meta under the SAM License; loaded by
  `sam3-api` from the path configured via `SAM3_API_CHECKPOINT`.
- LocateAnything-3B weights: distributed by NVIDIA; used by `locate-anything-api`.
  Obtain per the model card at https://huggingface.co/nvidia/LocateAnything-3B.

## Runtime dependencies (installed via each service's requirements.txt)

Key third-party packages and their licenses:

| Package | License | Source |
|---|---|---|
| PyTorch (`torch`) | BSD-3-Clause | https://github.com/pytorch/pytorch |
| torchvision | BSD-3-Clause | https://github.com/pytorch/vision |
| ultralytics (>=8.4.21) | AGPL-3.0 | https://github.com/ultralytics/ultralytics |
| FastAPI / Uvicorn | MIT / BSD-3-Clause | https://github.com/fastapi/fastapi |
| timm | Apache-2.0 | https://github.com/huggingface/pytorch-image-models |

Full dependency lists and their licenses are available via
`pip install <service>/requirements.txt && pip-licenses` inside each service image.

Note: ultralytics is AGPL-3.0. Review its terms before redistributing images
that bundle it (`sam3-api`, `sapiens-api`).
