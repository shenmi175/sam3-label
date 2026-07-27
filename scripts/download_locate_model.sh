#!/usr/bin/env bash
# Download the nvidia/LocateAnything-3B checkpoint to the host checkpoint directory.
# Usage:
#   ./scripts/download_locate_model.sh            # use huggingface.co
#   ./scripts/download_locate_model.sh --mirror   # use hf-mirror.com

set -euo pipefail
cd "$(dirname "$0")/.."

MIRROR=0
if [[ "${1:-}" == "--mirror" ]]; then
  MIRROR=1
fi

# Read LOCATE_CHECKPOINT_DIR from .env (fall back to ./locate_checkpoints).
CHECKPOINT_DIR="./locate_checkpoints"
if [[ -f .env ]]; then
  val="$(grep -E '^LOCATE_CHECKPOINT_DIR=' .env | cut -d= -f2- | tr -d '[:space:]')"
  [[ -n "$val" ]] && CHECKPOINT_DIR="$val"
fi

TARGET="${CHECKPOINT_DIR}/LocateAnything-3B"
mkdir -p "$TARGET"

info() { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-0}"

if [[ "$MIRROR" -eq 1 ]]; then
  export HF_ENDPOINT="https://hf-mirror.com"
  info "Using HuggingFace mirror: $HF_ENDPOINT"
fi

# Prefer huggingface-cli if installed; fall back to Python one-liner.
if command -v huggingface-cli &>/dev/null; then
  info "Downloading nvidia/LocateAnything-3B -> $TARGET"
  huggingface-cli download \
    nvidia/LocateAnything-3B \
    --local-dir "$TARGET" \
    --local-dir-use-symlinks False
elif python3 -c "import huggingface_hub" 2>/dev/null; then
  info "Downloading via huggingface_hub Python API -> $TARGET"
  python3 - <<'PY'
import os, sys
from huggingface_hub import snapshot_download

target = os.environ.get("TARGET", "./locate_checkpoints/LocateAnything-3B")
endpoint = os.environ.get("HF_ENDPOINT", "")
kwargs = {"local_dir": target, "local_dir_use_symlinks": False}
if endpoint:
    kwargs["endpoint"] = endpoint
try:
    snapshot_download("nvidia/LocateAnything-3B", **kwargs)
    print(f"Download complete: {target}")
except Exception as exc:
    print(f"Download failed: {exc}", file=sys.stderr)
    if "401" in str(exc) or "gated" in str(exc).lower():
        print("This model may require `huggingface-cli login` first.", file=sys.stderr)
    sys.exit(1)
PY
else
  warn "Neither huggingface-cli nor huggingface_hub found."
  warn "Install with: pip install -U 'huggingface_hub[cli]'"
  exit 1
fi

info "Done. Files in $TARGET:"
ls -lh "$TARGET" | head -20
