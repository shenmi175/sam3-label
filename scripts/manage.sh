#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DOCKER_CMD=()

info() {
  printf '\033[1;34m==>\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./deploy.sh <command> [options]

Commands:
  install            Guided first-time setup, image pull, build, and start.
  update             Pull latest git changes, rebuild, and restart.
  restart [service]  Restart all services or one service.
  start              Start the stack without rebuilding.
  stop               Stop and remove containers, preserving data.
  status             Show container status.
  logs [service]     Follow logs for all services or one service.
  mirror [url]       Configure a Docker Hub registry mirror.
  config             Render the effective Docker Compose config.
  uninstall          Run scripts/uninstall.sh.
  help               Show this help.

Options for install/update/start:
  --gpu              Use GPU profile. This is the default.
  --cpu              Use CPU profile for functional testing.
  --mirror URL       Configure Docker Hub mirror before pulling images.
  --skip-pull        Skip pre-pulling base images.
  --skip-git         update only: skip git pull.

Examples:
  ./deploy.sh install
  ./deploy.sh install --mirror https://your-mirror.example
  ./deploy.sh update
  ./deploy.sh restart web-auto
  ./deploy.sh logs sam3-api
EOF
}

is_interactive() {
  [[ -t 0 && -t 1 ]]
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local value=""
  if is_interactive; then
    read -r -p "$prompt [$default_value]: " value
  fi
  printf '%s' "${value:-$default_value}"
}

prompt_yes_no() {
  local prompt="$1"
  local default_value="${2:-n}"
  local suffix="[y/N]"
  [[ "$default_value" == "y" ]] && suffix="[Y/n]"
  local answer=""
  if is_interactive; then
    read -r -p "$prompt $suffix: " answer
  fi
  answer="${answer:-$default_value}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

select_docker() {
  require_command docker
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif command -v sudo >/dev/null 2>&1; then
    warn "Current user cannot access Docker directly; trying sudo docker."
    if is_interactive; then
      sudo docker info >/dev/null
    else
      sudo -n docker info >/dev/null
    fi
    DOCKER_CMD=(sudo docker)
  else
    die "Cannot access Docker daemon. Add this user to the docker group or run with sudo."
  fi

  "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1 || die "Docker Compose plugin is not available."
}

get_env_var() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" '
    BEGIN { FS = "=" }
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$ENV_FILE"
}

set_env_var() {
  local key="$1"
  local value="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
out = []
found = False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        found = True
    else:
        out.append(line)
if not found:
    if out and out[-1].strip():
        out.append("")
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
    return
  fi

  local tmp
  tmp="$(mktemp)"
  local found=0
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$key="* ]]; then
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
        found=1
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$ENV_FILE"
  fi
  if [[ "$found" -eq 0 ]]; then
    printf '\n%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  else
    die "Cannot generate SAM3_API_TOKEN; install openssl or python3."
  fi
}

project_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s' "$value"
  else
    printf '%s/%s' "$ROOT_DIR" "$value"
  fi
}

ensure_env() {
  local profile_override="${1:-}"
  cd "$ROOT_DIR"

  if [[ ! -f "$ENV_FILE" ]]; then
    info "Creating .env from .env.example"
    cp .env.example .env
  fi

  local token
  token="$(get_env_var SAM3_API_TOKEN || true)"
  if [[ -z "${token//[[:space:]]/}" ]]; then
    token="$(generate_token)"
    set_env_var SAM3_API_TOKEN "$token"
    info "Generated SAM3_API_TOKEN in .env"
  fi

  local profile
  profile="$(get_env_var SAM3_DEPLOY_PROFILE || true)"
  if [[ -n "$profile_override" ]]; then
    profile="$profile_override"
  fi
  if [[ -z "$profile" ]]; then
    profile="gpu"
    if is_interactive; then
      if prompt_yes_no "Use CPU mode instead of GPU mode" "n"; then
        profile="cpu"
      fi
    fi
  fi
  case "$profile" in
    gpu)
      set_env_var SAM3_DEPLOY_PROFILE "gpu"
      set_env_var SAM3_API_DEVICE "cuda"
      ;;
    cpu)
      set_env_var SAM3_DEPLOY_PROFILE "cpu"
      set_env_var SAM3_API_DEVICE "cpu"
      ;;
    *)
      die "Invalid SAM3_DEPLOY_PROFILE: $profile. Use gpu or cpu."
      ;;
  esac

  local host_root
  host_root="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
  if [[ -z "$host_root" || ( "$host_root" == "/home/zmb" && ! -d /home/zmb ) ]]; then
    host_root="$(prompt_value "Host data root mounted into web-auto" "${HOME:-$ROOT_DIR}")"
    set_env_var WEB_AUTO_HOST_DATA_ROOT "$host_root"
  fi

  local web_data sam_data ckpt_dir
  web_data="$(get_env_var WEB_AUTO_DATA_DIR || true)"
  sam_data="$(get_env_var SAM3_API_DATA_DIR || true)"
  ckpt_dir="$(get_env_var SAM3_CHECKPOINT_DIR || true)"
  mkdir -p \
    "$(project_path "${web_data:-./web-auto/data}")" \
    "$(project_path "${sam_data:-./sam3-api/data}")" \
    "$(project_path "${ckpt_dir:-./sam3_checkpoints}")"
}

effective_profile() {
  local profile
  profile="$(get_env_var SAM3_DEPLOY_PROFILE || true)"
  printf '%s' "${profile:-gpu}"
}

compose_args() {
  printf '%s\0' -f docker-compose.yml
  if [[ "$(effective_profile)" == "gpu" ]]; then
    printf '%s\0' -f docker-compose.gpu.yml
  fi
}

compose() {
  local args=()
  while IFS= read -r -d '' item; do
    args+=("$item")
  done < <(compose_args)
  (cd "$ROOT_DIR" && "${DOCKER_CMD[@]}" compose "${args[@]}" "$@")
}

configure_mirror() {
  local mirror="${1:-}"
  if [[ -z "$mirror" ]]; then
    mirror="$(prompt_value "Docker Hub registry mirror URL" "")"
  fi
  [[ -n "$mirror" ]] || die "Mirror URL is required."
  [[ "$mirror" =~ ^https?:// ]] || die "Mirror URL must start with http:// or https://"
  command -v sudo >/dev/null 2>&1 || die "sudo is required to write /etc/docker/daemon.json"
  command -v python3 >/dev/null 2>&1 || die "python3 is required to merge /etc/docker/daemon.json"

  info "Configuring Docker registry mirror: $mirror"
  sudo mkdir -p /etc/docker
  if [[ -f /etc/docker/daemon.json ]]; then
    sudo cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%F-%H%M%S)"
  fi
  sudo env MIRROR="$mirror" python3 - <<'PY'
from pathlib import Path
import json
import os

path = Path("/etc/docker/daemon.json")
mirror = os.environ["MIRROR"].strip()
data = {}
if path.exists() and path.read_text(encoding="utf-8").strip():
    data = json.loads(path.read_text(encoding="utf-8"))
mirrors = data.get("registry-mirrors", [])
if not isinstance(mirrors, list):
    mirrors = []
if mirror not in mirrors:
    mirrors.insert(0, mirror)
data["registry-mirrors"] = mirrors
path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

  info "Restarting Docker daemon"
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl daemon-reload || true
    sudo systemctl restart docker
  else
    sudo service docker restart
  fi
  DOCKER_CMD=()
  select_docker
}

required_images() {
  local npm_tag base_image
  npm_tag="$(get_env_var NPM_IMAGE_TAG || true)"
  base_image="$(get_env_var SAM3_API_BASE_IMAGE || true)"
  printf '%s\n' "jc21/nginx-proxy-manager:${npm_tag:-latest}"
  printf '%s\n' "python:3.11-slim"
  printf '%s\n' "${base_image:-pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime}"
}

pull_required_images() {
  local failed=0
  while IFS= read -r image; do
    [[ -n "$image" ]] || continue
    info "Pulling image: $image"
    if ! "${DOCKER_CMD[@]}" pull "$image"; then
      failed=1
      break
    fi
  done < <(required_images)
  return "$failed"
}

print_next_steps() {
  local admin_port
  admin_port="$(get_env_var NPM_ADMIN_PORT || true)"
  cat <<EOF

Deployment is running.

Nginx Proxy Manager admin:
  http://SERVER_IP:${admin_port:-81}

Create a Proxy Host in NPM:
  Domain Names: your domain
  Scheme: http
  Forward Hostname / IP: web-auto
  Forward Port: 8000
  Websockets Support: on
  SSL: Request a new SSL Certificate
  Force SSL: on

Then open your domain. web-auto will redirect to /setup for the first admin account.
EOF
}

parse_common_options() {
  PROFILE_OVERRIDE=""
  MIRROR_URL=""
  SKIP_PULL=0
  SKIP_GIT=0
  POSITIONAL=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --gpu)
        PROFILE_OVERRIDE="gpu"
        shift
        ;;
      --cpu)
        PROFILE_OVERRIDE="cpu"
        shift
        ;;
      --mirror)
        [[ $# -ge 2 ]] || die "--mirror requires a URL"
        MIRROR_URL="$2"
        shift 2
        ;;
      --skip-pull)
        SKIP_PULL=1
        shift
        ;;
      --skip-git)
        SKIP_GIT=1
        shift
        ;;
      *)
        POSITIONAL+=("$1")
        shift
        ;;
    esac
  done
}

cmd_install() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown install option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  select_docker
  [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"

  if [[ "$SKIP_PULL" -eq 0 ]]; then
    if ! pull_required_images; then
      warn "Image pull failed. This is usually Docker Hub connectivity."
      if is_interactive && prompt_yes_no "Configure a Docker Hub mirror now" "y"; then
        configure_mirror ""
        pull_required_images || die "Image pull still failed after configuring mirror."
      else
        die "Image pull failed. Run './deploy.sh mirror <url>' and retry './deploy.sh install'."
      fi
    fi
  fi

  info "Building and starting stack"
  compose up -d --build
  compose ps
  print_next_steps
}

cmd_update() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown update option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  select_docker
  [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"

  if [[ "$SKIP_GIT" -eq 0 && -d "$ROOT_DIR/.git" ]]; then
    info "Pulling latest git changes"
    (cd "$ROOT_DIR" && git pull --ff-only)
  fi

  if [[ "$SKIP_PULL" -eq 0 ]]; then
    pull_required_images || warn "Pre-pull failed; continuing with compose build so Docker can retry."
  fi

  info "Rebuilding and restarting stack"
  compose up -d --build
  compose ps
}

cmd_start() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown start option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  select_docker
  compose up -d
  compose ps
}

cmd_restart() {
  ensure_env ""
  select_docker
  compose restart "$@"
  compose ps
}

cmd_stop() {
  ensure_env ""
  select_docker
  compose down --remove-orphans
}

cmd_status() {
  ensure_env ""
  select_docker
  compose ps
}

cmd_logs() {
  ensure_env ""
  select_docker
  compose logs -f --tail=200 "$@"
}

cmd_config() {
  ensure_env ""
  select_docker
  compose config
}

cmd_mirror() {
  select_docker
  configure_mirror "${1:-}"
  "${DOCKER_CMD[@]}" info | sed -n '/Registry Mirrors/,+8p'
}

cmd_uninstall() {
  "$ROOT_DIR/scripts/uninstall.sh" "$@"
}

main() {
  local command="${1:-help}"
  [[ $# -gt 0 ]] && shift || true
  case "$command" in
    install) cmd_install "$@" ;;
    update) cmd_update "$@" ;;
    start|up) cmd_start "$@" ;;
    restart) cmd_restart "$@" ;;
    stop|down) cmd_stop "$@" ;;
    status|ps) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    mirror) cmd_mirror "$@" ;;
    config) cmd_config "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    help|-h|--help) usage ;;
    *) usage; die "Unknown command: $command" ;;
  esac
}

main "$@"
