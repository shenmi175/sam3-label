#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PURGE=0
WITH_IMAGES=0

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--purge] [--with-images]

Stops and removes the Docker Compose stack.

Options:
  --purge        Also remove Compose volumes and default app data directories.
  --with-images  Also remove local images built by this project.
  -h, --help     Show this help.

The script never deletes WEB_AUTO_HOST_DATA_ROOT datasets or sam3_checkpoints.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)
      PURGE=1
      shift
      ;;
    --with-images)
      WITH_IMAGES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

COMPOSE=(docker compose -f docker-compose.yml)
DOWN_ARGS=(down --remove-orphans)
if [[ "$PURGE" -eq 1 ]]; then
  DOWN_ARGS+=(--volumes)
fi

echo "Stopping Docker Compose stack..."
"${COMPOSE[@]}" "${DOWN_ARGS[@]}"

if [[ "$PURGE" -eq 1 ]]; then
  echo "Removing default app data directories..."
  rm -rf "$ROOT_DIR/web-auto/data" "$ROOT_DIR/sam3-api/data"
fi

if [[ "$WITH_IMAGES" -eq 1 ]]; then
  echo "Removing local project images..."
  docker image rm sam3-api:local web-auto:local 2>/dev/null || true
fi

echo "Uninstall complete."
if [[ "$PURGE" -eq 0 ]]; then
  echo "Project data, models, and Docker volumes were preserved."
else
  echo "Compose volumes and default app data were removed. sam3_checkpoints and host datasets were preserved."
fi
