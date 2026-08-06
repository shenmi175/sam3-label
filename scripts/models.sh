#!/usr/bin/env bash
# Unified model management CLI. Thin wrapper over `python -m model_registry`.
# Usage:
#   ./scripts/models.sh list
#   ./scripts/models.sh status [model_id]
#   ./scripts/models.sh download <model_id> [--mirror]

set -euo pipefail
cd "$(dirname "$0")/.."

exec python3 -m model_registry "$@"
