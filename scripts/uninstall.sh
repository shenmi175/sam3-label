#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PURGE=0
WITH_IMAGES=0
DOCKER_CMD=()

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

select_docker() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif command -v sudo >/dev/null 2>&1; then
    echo "WARN: Current user cannot access Docker directly; trying sudo docker." >&2
    sudo docker info >/dev/null
    DOCKER_CMD=(sudo docker)
  else
    echo "ERROR: Cannot access Docker daemon. Add this user to the docker group or run with sudo." >&2
    exit 1
  fi
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
select_docker

export PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-uninstall.local}"
export ACME_EMAIL="${ACME_EMAIL:-uninstall@example.org}"
export SAM3_API_TOKEN="${SAM3_API_TOKEN:-uninstall-token}"
export WEB_AUTO_ADMIN_PASSWORD="${WEB_AUTO_ADMIN_PASSWORD:-uninstall-password}"

COMPOSE=("${DOCKER_CMD[@]}" compose -f docker-compose.yml -f docker-compose.gpu.yml)
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
  "${DOCKER_CMD[@]}" image rm sam3-api:local web-auto:local 2>/dev/null || true
fi

echo "Uninstall complete."
if [[ "$PURGE" -eq 0 ]]; then
  echo "Project data, models, and Docker volumes were preserved."
else
  echo "Compose volumes and default app data were removed. sam3_checkpoints and host datasets were preserved."
fi
