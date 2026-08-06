#!/usr/bin/env bash
# Download the nvidia/LocateAnything-3B checkpoint to the host checkpoint directory.
# Kept for backwards compatibility; delegates to the unified model CLI.
# Usage:
#   ./scripts/download_locate_model.sh            # use huggingface.co
#   ./scripts/download_locate_model.sh --mirror   # use hf-mirror.com

set -euo pipefail
cd "$(dirname "$0")/.."

exec python3 -m model_registry download locate-anything "$@"
