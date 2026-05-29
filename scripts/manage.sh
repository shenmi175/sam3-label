#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
MOUNTS_COMPOSE_FILE="$ROOT_DIR/docker-compose.mounts.yml"
DOCKER_CMD=()
FORCE_PROFILE_PROMPT=0
FORCE_CONFIG_PROMPT=0
ACCESS_MODE_OVERRIDE=""

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
Usage: ./deploy.sh [command] [options]

Running ./deploy.sh without a command starts the interactive install wizard.

Commands:
  install            Guided setup, image pull, build, and start.
  update             Pull latest git changes, rebuild, and restart.
  restart [service]  Restart all services or one service.
  start              Start the stack without rebuilding.
  stop               Stop and remove containers, preserving data.
  status             Show container status.
  logs [service]     Follow logs for all services or one service.
  services           Manage model/runtime containers with Docker Compose.
  sapiens            Enable, disable, or inspect optional sapiens-api.
  doctor             Run DNS, port, HTTPS, and Caddy diagnostics.
  reset-admin [pass] Reset web-auto admin password and recreate web-auto.
  data-root          Manage extra host data roots mounted into web-auto.
  mirror [url]       Configure a Docker Hub registry mirror.
  gpu-check          Check host NVIDIA driver and Docker GPU runtime.
  gpu-install        Install/configure NVIDIA Container Toolkit for Docker.
  config             Render the effective Docker Compose config.
  uninstall          Run scripts/uninstall.sh.
  help               Show this help.

Options for install/update/start:
  --gpu              Use GPU profile. This is the default.
  --cpu              Use CPU profile for functional testing.
  --direct           Expose web-auto directly on IP:port. This is the default.
  --proxy            Enable optional Caddy HTTPS reverse proxy.
  --mirror URL       Configure Docker Hub mirror before pulling images.
  --skip-pull        Skip pre-pulling base images.
  --skip-gpu-check   Skip Docker GPU runtime preflight.
  --skip-git         update only: skip git pull.

Examples:
  ./deploy.sh
  ./deploy.sh install
  ./deploy.sh install --direct
  ./deploy.sh install --proxy
  ./deploy.sh install --mirror https://your-mirror.example
  ./deploy.sh update
  ./deploy.sh gpu-check
  ./deploy.sh gpu-install
  ./deploy.sh restart web-auto
  ./deploy.sh reset-admin
  ./deploy.sh data-root list
  ./deploy.sh data-root doctor /media/enabot/disk/zmb_datas/openimg
  ./deploy.sh data-root add /media/enabot/disk/zmb_datas --default
  ./deploy.sh data-root remove /media/enabot/disk/zmb_datas
  ./deploy.sh logs caddy
  ./deploy.sh services status
  ./deploy.sh services restart sam3-api
  ./deploy.sh sapiens enable
  ./deploy.sh sapiens status
  ./deploy.sh doctor
EOF
}

trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

is_interactive() {
  [[ -t 0 ]]
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local value=""
  if is_interactive; then
    read -r -p "$prompt [$default_value]: " value
  fi
  printf '%s' "$(trim "${value:-$default_value}")"
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
  answer="$(trim "${answer:-$default_value}")"
  [[ "$answer" =~ ^[Yy]$ ]]
}

prompt_choice() {
  local prompt="$1"
  local default_value="$2"
  local choices="$3"
  local answer=""
  if ! is_interactive; then
    printf '%s' "$default_value"
    return
  fi
  while true; do
    read -r -p "$prompt ($choices) [$default_value]: " answer
    answer="$(trim "${answer:-$default_value}")"
    for choice in $choices; do
      if [[ "$answer" == "$choice" ]]; then
        printf '%s' "$answer"
        return
      fi
    done
    warn "Invalid choice: $answer"
  done
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

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n' | tr '/+' 'Aa' | cut -c1-20
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
import string
alphabet = string.ascii_letters + string.digits
print("".join(secrets.choice(alphabet) for _ in range(20)))
PY
  else
    die "Cannot generate WEB_AUTO_ADMIN_PASSWORD; install openssl or python3."
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

default_host_data_root() {
  printf '%s/project-data' "$ROOT_DIR"
}

default_upload_target_dir() {
  local host_root="$1"
  printf '%s/uploads' "$host_root"
}

default_sam3_api_base_image() {
  printf '%s' "pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime"
}

default_sapiens_api_base_image() {
  printf '%s' "pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime"
}

canonical_dir() {
  local value="$1"
  value="$(project_path "$value")"
  mkdir -p "$value"
  (cd "$value" && pwd -P)
}

path_inside_dir() {
  local child="$1"
  local parent="$2"
  [[ "$child/" == "$parent/"* ]]
}

split_roots() {
  local raw="${1:-}"
  local item
  local -a _ROOT_PARTS=()
  IFS=':' read -r -a _ROOT_PARTS <<<"$raw"
  for item in "${_ROOT_PARTS[@]}"; do
    item="$(trim "$item")"
    [[ -n "$item" ]] && printf '%s\n' "$item"
  done
}

join_roots() {
  local first=1
  local item
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    if [[ "$first" -eq 1 ]]; then
      printf '%s' "$item"
      first=0
    else
      printf ':%s' "$item"
    fi
  done
}

normalize_data_roots() {
  local primary="$1"
  local raw="${2:-}"
  local roots=()
  local item resolved existing

  primary="$(canonical_dir "$primary")"
  roots+=("$primary")

  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    [[ "$item" != "/home/zmb" ]] || continue
    item="$(repair_data_root_path "$item")"
    resolved="$(canonical_dir "$item")"
    existing=0
    for item in "${roots[@]}"; do
      if [[ "$item" == "$resolved" ]]; then
        existing=1
        break
      fi
    done
    [[ "$existing" -eq 1 ]] || roots+=("$resolved")
  done < <(split_roots "$raw")

  join_roots "${roots[@]}"
}

repair_data_root_path() {
  local item="$1"
  local prefix="$ROOT_DIR/media/"
  if [[ "$item" == "$prefix"* ]]; then
    printf '/media/%s' "${item#"$prefix"}"
    return
  fi
  printf '%s' "$item"
}

write_mounts_compose_file() {
  local primary="$1"
  local allowed="$2"
  command -v python3 >/dev/null 2>&1 || die "python3 is required to generate docker-compose.mounts.yml"
  python3 - "$MOUNTS_COMPOSE_FILE" "$primary" "$allowed" <<'PY'
from pathlib import Path
import sys

out = Path(sys.argv[1])
primary = str(Path(sys.argv[2]).resolve())
raw = sys.argv[3]

roots = []
for item in raw.split(":"):
    item = item.strip()
    if not item:
        continue
    resolved = str(Path(item).resolve())
    if resolved not in roots:
        roots.append(resolved)

extra = [root for root in roots if root != primary]
if not extra:
    if out.exists():
        out.unlink()
    raise SystemExit(0)

def dq(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

lines = [
    "# Generated by deploy.sh data-root. Do not edit by hand.",
    "services:",
    "  web-auto:",
    "    volumes:",
]
for root in extra:
    lines.append(f"      - {dq(root + ':' + root + ':rw')}")
lines.extend([
    "  sapiens-api:",
    "    volumes:",
])
for root in extra:
    lines.append(f"      - {dq(root + ':' + root + ':rw')}")
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

refresh_data_roots_env() {
  local primary="$1"
  local upload_target="$2"
  local allowed
  allowed="$(get_env_var WEB_AUTO_ALLOWED_DATA_ROOTS || true)"
  allowed="$(normalize_data_roots "$primary" "$allowed")"
  set_env_var WEB_AUTO_ALLOWED_DATA_ROOTS "$allowed"
  set_env_var WEB_AUTO_HOST_DATA_ROOT "$primary"
  set_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR "$upload_target"
  write_mounts_compose_file "$primary" "$allowed"
}

write_global_upload_target_config() {
  local upload_target="$1"
  local web_data config_file
  web_data="$(get_env_var WEB_AUTO_DATA_DIR || true)"
  config_file="$(project_path "${web_data:-./web-auto/data}")/global_config.json"
  command -v python3 >/dev/null 2>&1 || return 0
  mkdir -p "$(dirname "$config_file")"
  python3 - "$config_file" "$upload_target" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
upload = str(Path(sys.argv[2]).resolve())
try:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
data["upload_target_dir"] = upload
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(path)
PY
}

auth_file_path() {
  local web_data
  web_data="$(get_env_var WEB_AUTO_DATA_DIR || true)"
  printf '%s/auth.json' "$(project_path "${web_data:-./web-auto/data}")"
}

is_real_email() {
  local email="${1,,}"
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || return 1
  local domain="${email##*@}"
  case "$domain" in
    example.com|example.org|example.net|localhost) return 1 ;;
  esac
  return 0
}

is_valid_domain() {
  local domain="${1,,}"
  domain="$(trim "$domain")"
  [[ -n "$domain" ]] || return 1
  [[ "$domain" != *"://"* && "$domain" != *"/"* && "$domain" != *"@"* ]] || return 1
  [[ "$domain" != *"*"* && "$domain" != *":"* ]] || return 1
  [[ "${#domain}" -le 253 ]] || return 1
  [[ "$domain" == *.* ]] || return 1

  local label
  IFS='.' read -r -a labels <<<"$domain"
  [[ "${#labels[@]}" -ge 2 ]] || return 1
  for label in "${labels[@]}"; do
    [[ "${#label}" -ge 1 && "${#label}" -le 63 ]] || return 1
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  done
  return 0
}

prompt_required_domain() {
  local prompt="$1"
  local current_value="${2:-}"
  local value=""
  is_interactive || die "$prompt is required."
  while true; do
    if is_valid_domain "$current_value"; then
      read -r -p "$prompt [$current_value]: " value
      value="${value:-$current_value}"
    else
      read -r -p "$prompt: " value
    fi
    value="${value,,}"
    value="$(trim "$value")"
    if is_valid_domain "$value"; then
      printf '%s' "$value"
      return
    fi
    warn "Enter a real domain such as sam3.example.com. Do not include http://, paths, ports, or wildcard domains."
  done
}

prompt_required_email() {
  local prompt="$1"
  local current_value="${2:-}"
  local value=""
  is_interactive || die "$prompt is required."
  while true; do
    if is_real_email "$current_value"; then
      read -r -p "$prompt [$current_value]: " value
      value="${value:-$current_value}"
    else
      read -r -p "$prompt: " value
    fi
    value="$(trim "$value")"
    if is_real_email "$value"; then
      printf '%s' "$value"
      return
    fi
    warn "Enter a real email address. Placeholder domains such as example.com are not allowed."
  done
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

  local sapiens_token ops_token
  sapiens_token="$(get_env_var SAPIENS_API_TOKEN || true)"
  if [[ -z "${sapiens_token//[[:space:]]/}" ]]; then
    sapiens_token="$(generate_token)"
    set_env_var SAPIENS_API_TOKEN "$sapiens_token"
    info "Generated SAPIENS_API_TOKEN in .env"
  fi
  ops_token="$(get_env_var OPS_API_TOKEN || true)"
  if [[ -z "${ops_token//[[:space:]]/}" ]]; then
    ops_token="$(generate_token)"
    set_env_var OPS_API_TOKEN "$ops_token"
    info "Generated OPS_API_TOKEN in .env"
  fi
  [[ -n "$(get_env_var OPS_ALLOWED_SERVICES || true)" ]] || set_env_var OPS_ALLOWED_SERVICES "sam3-api,sapiens-api,caddy"
  set_env_var OPS_HOST_PROJECT_ROOT "$ROOT_DIR"

  local admin_user admin_password
  admin_user="$(get_env_var WEB_AUTO_ADMIN_USERNAME || true)"
  admin_password="$(get_env_var WEB_AUTO_ADMIN_PASSWORD || true)"
  if [[ -z "${admin_user//[[:space:]]/}" ]]; then
    set_env_var WEB_AUTO_ADMIN_USERNAME "admin"
  fi
  if [[ -z "${admin_password//[[:space:]]/}" ]]; then
    admin_password="$(generate_password)"
    set_env_var WEB_AUTO_ADMIN_PASSWORD "$admin_password"
    info "Generated WEB_AUTO_ADMIN_PASSWORD in .env"
  fi

  local profile
  profile="$(get_env_var SAM3_DEPLOY_PROFILE || true)"
  if [[ -n "$profile_override" ]]; then
    profile="$profile_override"
  fi
  if [[ "$FORCE_PROFILE_PROMPT" -eq 1 && -z "$profile_override" && is_interactive ]]; then
    profile="$(prompt_choice "Deployment mode" "${profile:-gpu}" "gpu cpu")"
  elif [[ -z "$profile" ]]; then
    profile="gpu"
  fi
  case "$profile" in
    gpu)
      set_env_var SAM3_DEPLOY_PROFILE "gpu"
      set_env_var SAM3_API_DEVICE "cuda"
      [[ -n "$(get_env_var SAPIENS_DEVICE || true)" ]] || set_env_var SAPIENS_DEVICE "cuda:0"
      ;;
    cpu)
      set_env_var SAM3_DEPLOY_PROFILE "cpu"
      set_env_var SAM3_API_DEVICE "cpu"
      set_env_var SAPIENS_DEVICE "cpu"
      ;;
    *)
      die "Invalid SAM3_DEPLOY_PROFILE: $profile. Use gpu or cpu."
      ;;
  esac

  local base_image
  base_image="$(get_env_var SAM3_API_BASE_IMAGE || true)"
  if [[ -z "$base_image" || "$base_image" == "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime" ]]; then
    set_env_var SAM3_API_BASE_IMAGE "$(default_sam3_api_base_image)"
  fi

  local sapiens_base_image sapiens_enabled sapiens_model
  sapiens_base_image="$(get_env_var SAPIENS_API_BASE_IMAGE || true)"
  if [[ -z "$sapiens_base_image" || "$sapiens_base_image" == "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime" ]]; then
    set_env_var SAPIENS_API_BASE_IMAGE "$(default_sapiens_api_base_image)"
  fi
  sapiens_enabled="$(get_env_var SAPIENS_ENABLED || true)"
  [[ -n "$sapiens_enabled" ]] || set_env_var SAPIENS_ENABLED "0"
  sapiens_model="$(get_env_var SAPIENS_MODEL_NAME || true)"
  if [[ "$sapiens_model" != "sapiens2_5b" ]]; then
    set_env_var SAPIENS_MODEL_NAME "sapiens2_5b"
  fi
  [[ -n "$(get_env_var SAPIENS_API_DATA_DIR || true)" ]] || set_env_var SAPIENS_API_DATA_DIR "./sapiens-api/data"
  [[ -n "$(get_env_var SAPIENS_CHECKPOINT_ROOT || true)" ]] || set_env_var SAPIENS_CHECKPOINT_ROOT "./sapiens_checkpoints"

  local access_mode
  access_mode="$(get_env_var SAM3_ACCESS_MODE || true)"
  if [[ -n "$ACCESS_MODE_OVERRIDE" ]]; then
    access_mode="$ACCESS_MODE_OVERRIDE"
  fi
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && -z "$ACCESS_MODE_OVERRIDE" && is_interactive ]]; then
    access_mode="$(prompt_choice "Access mode" "${access_mode:-direct}" "direct proxy")"
  elif [[ -z "$access_mode" ]]; then
    access_mode="direct"
  fi
  case "$access_mode" in
    direct|proxy) set_env_var SAM3_ACCESS_MODE "$access_mode" ;;
    *) die "Invalid SAM3_ACCESS_MODE: $access_mode. Use direct or proxy." ;;
  esac

  local web_http_port web_http_bind
  web_http_port="$(get_env_var WEB_AUTO_HTTP_PORT || true)"
  web_http_bind="$(get_env_var WEB_AUTO_HTTP_BIND || true)"
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && "$access_mode" == "direct" && is_interactive ]]; then
    web_http_bind="$(prompt_value "web-auto direct bind address" "${web_http_bind:-0.0.0.0}")"
    web_http_port="$(prompt_value "web-auto direct HTTP port" "${web_http_port:-8000}")"
  fi
  set_env_var WEB_AUTO_HTTP_BIND "${web_http_bind:-0.0.0.0}"
  set_env_var WEB_AUTO_HTTP_PORT "${web_http_port:-8000}"

  if [[ "$access_mode" == "proxy" ]]; then
    local public_domain
    public_domain="$(get_env_var PUBLIC_DOMAIN || true)"
    if ! is_valid_domain "$public_domain"; then
      if is_interactive; then
        public_domain="$(prompt_required_domain "Public domain for web-auto" "$public_domain")"
      else
        die "PUBLIC_DOMAIN must be set in .env to a real domain, for example sam3.example.com."
      fi
      set_env_var PUBLIC_DOMAIN "$public_domain"
    elif [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
      public_domain="$(prompt_required_domain "Public domain for web-auto" "$public_domain")"
      set_env_var PUBLIC_DOMAIN "$public_domain"
    fi

    local acme_email
    acme_email="$(get_env_var ACME_EMAIL || true)"
    if ! is_real_email "$acme_email"; then
      if is_interactive; then
        acme_email="$(prompt_required_email "Email for Let's Encrypt account" "$acme_email")"
      else
        die "ACME_EMAIL must be set in .env to a real email address."
      fi
      set_env_var ACME_EMAIL "$acme_email"
    elif [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
      acme_email="$(prompt_required_email "Email for Let's Encrypt account" "$acme_email")"
      set_env_var ACME_EMAIL "$acme_email"
    fi
  fi

  local caddy_http_port caddy_https_port caddy_http_bind caddy_https_bind caddy_image_tag
  caddy_http_port="$(get_env_var CADDY_HTTP_PORT || true)"
  caddy_https_port="$(get_env_var CADDY_HTTPS_PORT || true)"
  caddy_http_bind="$(get_env_var CADDY_HTTP_BIND || true)"
  caddy_https_bind="$(get_env_var CADDY_HTTPS_BIND || true)"
  caddy_image_tag="$(get_env_var CADDY_IMAGE_TAG || true)"
  [[ -n "$caddy_http_port" ]] || set_env_var CADDY_HTTP_PORT "80"
  [[ -n "$caddy_https_port" ]] || set_env_var CADDY_HTTPS_PORT "443"
  [[ -n "$caddy_http_bind" ]] || set_env_var CADDY_HTTP_BIND "0.0.0.0"
  [[ -n "$caddy_https_bind" ]] || set_env_var CADDY_HTTPS_BIND "0.0.0.0"
  [[ -n "$caddy_image_tag" ]] || set_env_var CADDY_IMAGE_TAG "2.11.2-alpine"

  local host_root default_data_root upload_target default_upload_target
  default_data_root="$(default_host_data_root)"
  host_root="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
    [[ -n "$host_root" && "$host_root" != "/home/zmb" ]] || host_root="$default_data_root"
    host_root="$(prompt_value "Server project data root mounted into web-auto" "$host_root")"
  elif [[ -z "$host_root" || "$host_root" == "/home/zmb" ]]; then
    host_root="$default_data_root"
  fi
  host_root="$(canonical_dir "$host_root")"
  upload_target="$(get_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR || true)"
  default_upload_target="$(default_upload_target_dir "$host_root")"
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
    if [[ -z "$upload_target" || "$upload_target" == "/home/zmb"* ]]; then
      upload_target="$default_upload_target"
    fi
    upload_target="$(prompt_value "Default dataset upload directory" "$upload_target")"
  elif [[ -z "$upload_target" || "$upload_target" == "/home/zmb"* ]]; then
    upload_target="$default_upload_target"
  fi
  upload_target="$(canonical_dir "$upload_target")"
  if ! path_inside_dir "$upload_target" "$host_root"; then
    warn "WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR must be inside the primary data root during setup; using $default_upload_target"
    upload_target="$(canonical_dir "$default_upload_target")"
  fi
  refresh_data_roots_env "$host_root" "$upload_target"

  if [[ "$host_root" == "$default_data_root" ]]; then
    info "Using project data root: $host_root"
  else
    info "Using external/project data root: $host_root"
  fi
  if [[ "$upload_target" == "$default_upload_target" ]]; then
    info "Using default upload directory: $upload_target"
  else
    info "Using configured upload directory: $upload_target"
  fi

  if [[ ! -w "$host_root" ]]; then
    warn "Current user cannot write to WEB_AUTO_HOST_DATA_ROOT: $host_root. Docker may still write as root, but uploads can fail if permissions are restrictive."
  fi
  if [[ ! -w "$upload_target" ]]; then
    warn "Current user cannot write to WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR: $upload_target. Check external disk permissions if uploads fail."
  fi

  # Reset stale UI-level upload defaults from previous Docker mount roots.
  local web_data config_file
  web_data="$(get_env_var WEB_AUTO_DATA_DIR || true)"
  config_file="$(project_path "${web_data:-./web-auto/data}")/global_config.json"
  if [[ -f "$config_file" ]] && command -v python3 >/dev/null 2>&1; then
    python3 - "$config_file" "$(get_env_var WEB_AUTO_ALLOWED_DATA_ROOTS || true)" "$upload_target" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
roots = [Path(item).resolve() for item in sys.argv[2].split(":") if item.strip()]
upload = str(Path(sys.argv[3]).resolve())
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
raw = str(data.get("upload_target_dir") or "").strip()
changed = False
if raw:
    resolved = Path(raw).expanduser().resolve()
    try:
        if not any(resolved == root or root in resolved.parents for root in roots):
            raise ValueError
    except Exception:
        data["upload_target_dir"] = upload
        changed = True
if changed:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
PY
  fi

  local web_data sam_data ckpt_dir sapiens_data sapiens_ckpt
  web_data="$(get_env_var WEB_AUTO_DATA_DIR || true)"
  sam_data="$(get_env_var SAM3_API_DATA_DIR || true)"
  ckpt_dir="$(get_env_var SAM3_CHECKPOINT_DIR || true)"
  sapiens_data="$(get_env_var SAPIENS_API_DATA_DIR || true)"
  sapiens_ckpt="$(get_env_var SAPIENS_CHECKPOINT_ROOT || true)"
  mkdir -p \
    "$(project_path "${web_data:-./web-auto/data}")" \
    "$(project_path "${sam_data:-./sam3-api/data}")" \
    "$(project_path "${ckpt_dir:-./sam3_checkpoints}")" \
    "$(project_path "${sapiens_data:-./sapiens-api/data}")" \
    "$(project_path "${sapiens_ckpt:-./sapiens_checkpoints}")" \
    "$host_root" \
    "$upload_target"
}

effective_profile() {
  local profile
  profile="$(get_env_var SAM3_DEPLOY_PROFILE || true)"
  printf '%s' "${profile:-gpu}"
}

effective_access_mode() {
  local mode
  mode="$(get_env_var SAM3_ACCESS_MODE || true)"
  printf '%s' "${mode:-direct}"
}

using_proxy_mode() {
  [[ "$(effective_access_mode)" == "proxy" ]]
}

sapiens_enabled() {
  local enabled
  enabled="$(get_env_var SAPIENS_ENABLED || true)"
  [[ "${enabled,,}" =~ ^(1|true|yes|on)$ ]]
}

compose_args() {
  printf '%s\0' -f docker-compose.yml
  if [[ -f "$MOUNTS_COMPOSE_FILE" ]]; then
    printf '%s\0' -f "$(basename "$MOUNTS_COMPOSE_FILE")"
  fi
  if using_proxy_mode; then
    printf '%s\0' --profile proxy
  fi
  if sapiens_enabled; then
    printf '%s\0' --profile sapiens
  fi
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

compose_env_defaults() {
  local value
  value="$(get_env_var PUBLIC_DOMAIN || true)"
  export PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-${value:-status.local}}"
  value="$(get_env_var ACME_EMAIL || true)"
  export ACME_EMAIL="${ACME_EMAIL:-${value:-status@example.org}}"
  value="$(get_env_var SAM3_API_TOKEN || true)"
  export SAM3_API_TOKEN="${SAM3_API_TOKEN:-${value:-status-token}}"
  value="$(get_env_var SAPIENS_API_TOKEN || true)"
  export SAPIENS_API_TOKEN="${SAPIENS_API_TOKEN:-${value:-status-sapiens-token}}"
  value="$(get_env_var OPS_API_TOKEN || true)"
  export OPS_API_TOKEN="${OPS_API_TOKEN:-${value:-status-ops-token}}"
  value="$(get_env_var WEB_AUTO_ADMIN_PASSWORD || true)"
  export WEB_AUTO_ADMIN_PASSWORD="${WEB_AUTO_ADMIN_PASSWORD:-${value:-status-password}}"
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
  local caddy_tag base_image sapiens_base_image
  caddy_tag="$(get_env_var CADDY_IMAGE_TAG || true)"
  base_image="$(get_env_var SAM3_API_BASE_IMAGE || true)"
  sapiens_base_image="$(get_env_var SAPIENS_API_BASE_IMAGE || true)"
  if using_proxy_mode; then
    printf '%s\n' "caddy:${caddy_tag:-2.11.2-alpine}"
  fi
  printf '%s\n' "python:3.11-slim"
  printf '%s\n' "${base_image:-$(default_sam3_api_base_image)}"
  if sapiens_enabled; then
    printf '%s\n' "${sapiens_base_image:-$(default_sapiens_api_base_image)}"
  fi
}

docker_has_nvidia_runtime() {
  "${DOCKER_CMD[@]}" info 2>/dev/null | awk '
    BEGIN { in_runtimes = 0 }
    /^ Runtimes:/ { in_runtimes = 1; if ($0 ~ /(^|[[:space:]])nvidia([[:space:]]|$)/) found = 1; next }
    in_runtimes && /^[^[:space:]]/ { in_runtimes = 0 }
    in_runtimes && /(^|[[:space:]])nvidia([[:space:]]|$)/ { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

ensure_sapiens_submodule() {
  if [[ ! -d "$ROOT_DIR/.git" ]]; then
    return 0
  fi
  if [[ -f "$ROOT_DIR/external/sapiens2/pyproject.toml" ]]; then
    return 0
  fi
  require_command git
  info "Initializing Sapiens2 submodule"
  (cd "$ROOT_DIR" && git submodule update --init --recursive external/sapiens2)
}

gpu_preflight() {
  [[ "$(effective_profile)" == "gpu" ]] || return 0
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    if is_interactive && prompt_yes_no "nvidia-smi was not found. Switch this deployment to CPU mode" "y"; then
      set_env_var SAM3_DEPLOY_PROFILE "cpu"
      set_env_var SAM3_API_DEVICE "cpu"
      return 0
    fi
    die "GPU mode selected but nvidia-smi is not available on the host. Install the NVIDIA driver or run './deploy.sh install --cpu'."
  fi
  if ! docker_has_nvidia_runtime; then
    if is_interactive; then
      warn "Docker NVIDIA runtime is missing."
      if prompt_yes_no "Install/configure NVIDIA Container Toolkit now" "y"; then
        install_nvidia_container_toolkit
        return 0
      fi
      if prompt_yes_no "Switch this deployment to CPU mode for now" "n"; then
        set_env_var SAM3_DEPLOY_PROFILE "cpu"
        set_env_var SAM3_API_DEVICE "cpu"
        return 0
      fi
    fi
    cat >&2 <<'EOF'
Docker cannot allocate GPUs because the NVIDIA Container Toolkit runtime is not configured.

Fix:
  ./deploy.sh gpu-install
  ./deploy.sh start --gpu

Temporary CPU mode:
  ./deploy.sh start --cpu
EOF
    exit 1
  fi
}

gpu_status_report() {
  select_docker
  echo "Host NVIDIA driver:"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,name,driver_version,memory.total --format=csv,noheader || nvidia-smi
  else
    echo "  nvidia-smi: not found"
  fi
  echo
  echo "Docker runtimes:"
  "${DOCKER_CMD[@]}" info | sed -n '/Runtimes:/,/Default Runtime:/p'
  echo
  if docker_has_nvidia_runtime; then
    echo "Docker NVIDIA runtime: configured"
  else
    echo "Docker NVIDIA runtime: missing"
    echo "Run: ./deploy.sh gpu-install"
  fi
}

install_nvidia_container_toolkit() {
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install NVIDIA Container Toolkit."
  command -v curl >/dev/null 2>&1 || die "curl is required. Install curl first or configure your package source."
  command -v gpg >/dev/null 2>&1 || die "gpg is required. Install gnupg first."

  info "Installing NVIDIA Container Toolkit for Docker"
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg2
  sudo rm -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart docker
  else
    sudo service docker restart
  fi
  DOCKER_CMD=()
  select_docker
  docker_has_nvidia_runtime || die "nvidia-container-toolkit installed, but Docker still does not list the nvidia runtime."
  info "NVIDIA Container Toolkit is configured."
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

get_public_ipv4() {
  command -v curl >/dev/null 2>&1 || die "curl is required for DNS preflight."
  local url value
  for url in https://api.ipify.org https://ifconfig.me/ip; do
    value="$(curl --noproxy '*' -fsS --max-time 8 "$url" 2>/dev/null || true)"
    value="$(trim "$value")"
    if [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

resolve_domain_records() {
  local domain="$1"
  require_command python3
  PUBLIC_DOMAIN="$domain" python3 - <<'PY'
import socket
import os

domain = os.environ["PUBLIC_DOMAIN"]
records = []
for family, label in ((socket.AF_INET, "A"), (socket.AF_INET6, "AAAA")):
    try:
        infos = socket.getaddrinfo(domain, 80, family, socket.SOCK_STREAM)
    except socket.gaierror:
        continue
    for item in infos:
        address = item[4][0]
        row = (label, address)
        if row not in records:
            records.append(row)
for label, address in records:
    print(label, address)
PY
}

array_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

validate_domain_dns() {
  local domain public_ipv4
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  is_valid_domain "$domain" || die "PUBLIC_DOMAIN is invalid: ${domain:-empty}"

  info "Checking DNS for $domain"
  if env | grep -qiE '^(http|https|all)_proxy='; then
    warn "Proxy environment variables are set; DNS preflight bypasses them with curl --noproxy '*'."
  fi
  public_ipv4="$(get_public_ipv4)" || die "Cannot determine this server's public IPv4. Check outbound network access, then rerun."

  local dns_lines=()
  mapfile -t dns_lines < <(resolve_domain_records "$domain")

  local a_records=()
  local aaaa_records=()
  local line record_type address
  for line in "${dns_lines[@]}"; do
    read -r record_type address <<<"$line"
    case "$record_type" in
      A) a_records+=("$address") ;;
      AAAA) aaaa_records+=("$address") ;;
    esac
  done

  [[ "${#a_records[@]}" -gt 0 ]] || die "DNS preflight failed: $domain has no A record. Add an A record pointing to $public_ipv4."
  if ! array_contains "$public_ipv4" "${a_records[@]}"; then
    die "DNS preflight failed: $domain A record is ${a_records[*]}, but this server's public IPv4 is $public_ipv4. Fix DNS first."
  fi

  if [[ "${#aaaa_records[@]}" -gt 0 ]]; then
    die "DNS preflight failed: $domain has AAAA record(s) ${aaaa_records[*]}. Remove AAAA records for this deployment and use an A record to $public_ipv4."
  fi
}

check_caddy_ports() {
  local http_port https_port http_bind https_bind port matches udp_matches
  http_bind="$(get_env_var CADDY_HTTP_BIND || true)"
  https_bind="$(get_env_var CADDY_HTTPS_BIND || true)"
  http_port="$(get_env_var CADDY_HTTP_PORT || true)"
  https_port="$(get_env_var CADDY_HTTPS_PORT || true)"
  http_bind="${http_bind:-0.0.0.0}"
  https_bind="${https_bind:-0.0.0.0}"
  http_port="${http_port:-80}"
  https_port="${https_port:-443}"
  [[ "$http_bind" == "0.0.0.0" ]] || die "CADDY_HTTP_BIND must be 0.0.0.0 for public ACME validation, current value: $http_bind"
  [[ "$https_bind" == "0.0.0.0" ]] || die "CADDY_HTTPS_BIND must be 0.0.0.0 for public HTTPS access, current value: $https_bind"
  [[ "$http_port" == "80" ]] || die "CADDY_HTTP_PORT must be 80 for Let's Encrypt HTTP-01 validation."
  [[ "$https_port" == "443" ]] || die "CADDY_HTTPS_PORT must be 443 for automatic HTTPS."

  if ! command -v ss >/dev/null 2>&1; then
    warn "ss command not found; skipping local port occupancy check."
    return 0
  fi
  for port in "$http_port" "$https_port"; do
    matches="$(ss -ltnp 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" {print}' || true)"
    if [[ -n "$matches" ]]; then
      printf '%s\n' "$matches" >&2
      die "Port $port is already in use after stopping this Compose stack. Stop the process using it, then rerun."
    fi
  done
  udp_matches="$(ss -lunp 2>/dev/null | awk -v suffix=":$https_port" '$4 ~ suffix "$" {print}' || true)"
  if [[ -n "$udp_matches" ]]; then
    printf '%s\n' "$udp_matches" >&2
    die "UDP port $https_port is already in use after stopping this Compose stack. Stop the process using it, then rerun."
  fi
}

check_direct_port() {
  local bind port matches
  bind="$(get_env_var WEB_AUTO_HTTP_BIND || true)"
  port="$(get_env_var WEB_AUTO_HTTP_PORT || true)"
  bind="${bind:-0.0.0.0}"
  port="${port:-8000}"
  if ! command -v ss >/dev/null 2>&1; then
    warn "ss command not found; skipping local port occupancy check."
    return 0
  fi
  matches="$(ss -ltnp 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" {print}' || true)"
  if [[ -n "$matches" ]]; then
    printf '%s\n' "$matches" >&2
    die "Port $port is already in use after stopping this Compose stack. Change WEB_AUTO_HTTP_PORT or stop the process using it."
  fi
}

stop_stack_for_recreate() {
  info "Stopping old Compose services and removing orphans"
  compose down --remove-orphans
}

show_caddy_logs() {
  warn "Last Caddy log lines:"
  compose logs --tail=160 caddy >&2 || true
}

wait_for_https() {
  local domain url last_error attempt
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  is_valid_domain "$domain" || die "PUBLIC_DOMAIN is invalid: ${domain:-empty}"
  command -v curl >/dev/null 2>&1 || die "curl is required for HTTPS validation."

  url="https://${domain}/api/health"
  info "Waiting for Caddy HTTPS certificate and web-auto health: $url"
  last_error=""
  for attempt in $(seq 1 60); do
    if curl --noproxy '*' -fsS --max-time 8 --resolve "${domain}:443:127.0.0.1" "$url" >/dev/null 2>&1; then
      info "HTTPS validation passed: $url"
      return 0
    fi
    last_error="$(curl --noproxy '*' -fsS --max-time 8 --resolve "${domain}:443:127.0.0.1" "$url" 2>&1 >/dev/null || true)"
    sleep 3
  done

  warn "HTTPS validation failed after waiting. Last curl error: ${last_error:-unknown}"
  show_caddy_logs
  die "Caddy did not serve a valid HTTPS response for $url. Run './deploy.sh doctor' for the full diagnostic report."
}

wait_for_direct_http() {
  local port url last_error
  port="$(get_env_var WEB_AUTO_HTTP_PORT || true)"
  port="${port:-8000}"
  url="http://127.0.0.1:${port}/api/health"
  command -v curl >/dev/null 2>&1 || die "curl is required for direct HTTP validation."
  info "Waiting for web-auto direct health: $url"
  last_error=""
  for _ in $(seq 1 40); do
    if curl --noproxy '*' -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      info "Direct HTTP validation passed: $url"
      return 0
    fi
    last_error="$(curl --noproxy '*' -fsS --max-time 5 "$url" 2>&1 >/dev/null || true)"
    sleep 2
  done
  die "web-auto did not become reachable on $url. Last curl error: ${last_error:-unknown}"
}

print_next_steps() {
  local domain web_user web_password port host_ip
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  web_user="$(get_env_var WEB_AUTO_ADMIN_USERNAME || true)"
  web_password="$(get_env_var WEB_AUTO_ADMIN_PASSWORD || true)"
  port="$(get_env_var WEB_AUTO_HTTP_PORT || true)"
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-SERVER_IP}"
  cat <<EOF

Deployment is running.

web-auto:
EOF
  if using_proxy_mode; then
    cat <<EOF
  https://${domain}
EOF
  else
    cat <<EOF
  http://${host_ip}:${port:-8000}
EOF
  fi
  cat <<EOF

web-auto login:
  Username: ${web_user:-admin}
  Password: ${web_password:-see .env WEB_AUTO_ADMIN_PASSWORD}

sam3-api is internal only:
  http://sam3-api:8001

sapiens-api:
  Optional, internal only. Enable with: ./deploy.sh sapiens enable

Useful commands:
  ./deploy.sh status
  ./deploy.sh logs web-auto
  ./deploy.sh services status
EOF
  if using_proxy_mode; then
    cat <<EOF
  ./deploy.sh logs caddy
EOF
  fi
}

parse_common_options() {
  PROFILE_OVERRIDE=""
  MIRROR_URL=""
  SKIP_PULL=0
  SKIP_GIT=0
  SKIP_GPU_CHECK=0
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
      --direct)
        ACCESS_MODE_OVERRIDE="direct"
        shift
        ;;
      --proxy)
        ACCESS_MODE_OVERRIDE="proxy"
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
      --skip-gpu-check)
        SKIP_GPU_CHECK=1
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

prepare_runtime() {
  select_docker
  [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight

  if [[ "$SKIP_PULL" -eq 0 ]]; then
    if ! pull_required_images; then
      warn "Image pull failed. This is usually Docker Hub connectivity."
      if is_interactive && prompt_yes_no "Configure a Docker Hub mirror now" "y"; then
        configure_mirror ""
        pull_required_images || die "Image pull still failed after configuring mirror."
      else
        die "Image pull failed. Run './deploy.sh mirror <url>' and retry."
      fi
    fi
  fi
}

cmd_install() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown install option: ${POSITIONAL[*]}"
  if is_interactive; then
    info "Starting interactive SAM3 deployment wizard. Direct IP:port access is the default."
    [[ -z "$PROFILE_OVERRIDE" ]] && FORCE_PROFILE_PROMPT=1
    FORCE_CONFIG_PROMPT=1
  fi
  ensure_env "$PROFILE_OVERRIDE"
  sapiens_enabled && ensure_sapiens_submodule
  if [[ -z "$MIRROR_URL" && is_interactive ]]; then
    if prompt_yes_no "Configure a Docker Hub registry mirror now" "n"; then
      MIRROR_URL="$(prompt_value "Docker Hub registry mirror URL" "")"
    fi
  fi
  if using_proxy_mode; then
    validate_domain_dns
  fi
  prepare_runtime
  stop_stack_for_recreate
  if using_proxy_mode; then
    check_caddy_ports
  else
    check_direct_port
  fi

  info "Building and starting stack"
  compose up -d --build --remove-orphans
  compose ps
  if using_proxy_mode; then
    wait_for_https
  else
    wait_for_direct_http
  fi
  print_next_steps
}

cmd_update() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown update option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  sapiens_enabled && ensure_sapiens_submodule
  if using_proxy_mode; then
    validate_domain_dns
  fi
  select_docker
  [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight

  if [[ "$SKIP_GIT" -eq 0 && -d "$ROOT_DIR/.git" ]]; then
    info "Pulling latest git changes"
    (cd "$ROOT_DIR" && git pull --ff-only)
  fi

  if [[ "$SKIP_PULL" -eq 0 ]]; then
    pull_required_images || warn "Pre-pull failed; continuing with compose build so Docker can retry."
  fi

  stop_stack_for_recreate
  if using_proxy_mode; then
    check_caddy_ports
  else
    check_direct_port
  fi
  info "Rebuilding and restarting stack"
  compose up -d --build --remove-orphans
  compose ps
  if using_proxy_mode; then
    wait_for_https
  else
    wait_for_direct_http
  fi
  print_next_steps
}

cmd_start() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown start option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  sapiens_enabled && ensure_sapiens_submodule
  if using_proxy_mode; then
    validate_domain_dns
  fi
  select_docker
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight
  stop_stack_for_recreate
  if using_proxy_mode; then
    check_caddy_ports
  else
    check_direct_port
  fi
  compose up -d --remove-orphans
  compose ps
  if using_proxy_mode; then
    wait_for_https
  else
    wait_for_direct_http
  fi
  print_next_steps
}

cmd_restart() {
  compose_env_defaults
  select_docker
  compose restart "$@"
  compose ps
}

cmd_stop() {
  compose_env_defaults
  select_docker
  compose down --remove-orphans
}

cmd_status() {
  compose_env_defaults
  select_docker
  compose ps
}

cmd_logs() {
  compose_env_defaults
  select_docker
  compose logs -f --tail=200 "$@"
}

cmd_doctor() {
  compose_env_defaults
  local domain public_ipv4 port
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  port="$(get_env_var WEB_AUTO_HTTP_PORT || true)"

  select_docker
  echo "== SAM3 deployment doctor =="
  echo "Access mode: $(effective_access_mode)"
  if using_proxy_mode; then
    is_valid_domain "$domain" || die "PUBLIC_DOMAIN is invalid or missing in .env."
    echo "Domain: $domain"
  else
    echo "Direct URL: http://127.0.0.1:${port:-8000}"
  fi
  public_ipv4="$(get_public_ipv4 || true)"
  echo "Server public IPv4: ${public_ipv4:-unknown}"
  echo

  if using_proxy_mode; then
    echo "DNS records:"
    resolve_domain_records "$domain" || true
    echo
  fi

  echo "Compose status:"
  compose ps || true
  echo

  if command -v ss >/dev/null 2>&1; then
    if using_proxy_mode; then
      echo "TCP listeners on 80/443:"
      ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print}' || true
      echo
      echo "UDP listeners on 443:"
      ss -lunp 2>/dev/null | awk '$4 ~ /:443$/ {print}' || true
    else
      echo "TCP listeners on web-auto port ${port:-8000}:"
      ss -ltnp 2>/dev/null | awk -v suffix=":${port:-8000}" '$4 ~ suffix "$" {print}' || true
    fi
    echo
  fi

  if command -v curl >/dev/null 2>&1; then
    if using_proxy_mode; then
      echo "Local Caddy HTTP probe:"
      curl --noproxy '*' -sS -I --max-time 8 --resolve "${domain}:80:127.0.0.1" "http://${domain}/" || true
      echo
      echo "Local Caddy HTTPS probe:"
      curl --noproxy '*' -v --max-time 10 --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/health" -o /dev/null || true
      echo
      echo "Public DNS HTTP probe:"
      curl --noproxy '*' -sS -I --max-time 10 "http://${domain}/.well-known/acme-challenge/deploy-doctor" || true
      echo
      echo "Public DNS HTTPS probe:"
      curl --noproxy '*' -v --max-time 10 "https://${domain}/api/health" -o /dev/null || true
      echo
    else
      echo "Direct web-auto health probe:"
      curl --noproxy '*' -sS -i --max-time 8 "http://127.0.0.1:${port:-8000}/api/health" || true
      echo
    fi
  fi

  if using_proxy_mode; then
    if command -v openssl >/dev/null 2>&1; then
      echo "TLS handshake probe:"
      printf '' | openssl s_client -servername "$domain" -connect "127.0.0.1:443" -brief 2>&1 || true
      echo
    fi

    echo "Caddy logs:"
    compose logs --tail=200 caddy || true
  fi
}

cmd_reset_admin() {
  [[ "$#" -le 1 ]] || die "Usage: ./deploy.sh reset-admin [new-password]"
  local new_password auth_file backup_file admin_user
  ensure_env ""
  new_password="${1:-}"
  if [[ -z "$new_password" ]]; then
    new_password="$(generate_password)"
  fi
  if [[ "${#new_password}" -lt 8 ]]; then
    die "Admin password must be at least 8 characters."
  fi

  set_env_var WEB_AUTO_ADMIN_PASSWORD "$new_password"
  admin_user="$(get_env_var WEB_AUTO_ADMIN_USERNAME || true)"
  admin_user="${admin_user:-admin}"
  auth_file="$(auth_file_path)"
  if [[ -f "$auth_file" ]]; then
    backup_file="${auth_file}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$auth_file" "$backup_file"
    info "Backed up old admin auth file: $backup_file"
  else
    info "No existing auth.json found; web-auto will initialize admin from .env."
  fi

  select_docker
  info "Recreating web-auto so the new admin password takes effect"
  compose up -d --force-recreate web-auto
  wait_for_direct_http
  cat <<EOF

web-auto admin reset complete.

Username: ${admin_user}
Password: ${new_password}
EOF
}

data_root_usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh data-root list
  ./deploy.sh data-root doctor [path]
  ./deploy.sh data-root add <host-path> [--default] [--upload-target <dir>] [--no-recreate]
  ./deploy.sh data-root remove <host-path> [--no-recreate]

Examples:
  ./deploy.sh data-root doctor /media/enabot/disk/zmb_datas/openimg
  ./deploy.sh data-root add /media/enabot/disk/zmb_datas --default
  ./deploy.sh data-root add /media/enabot/disk/zmb_datas --upload-target /media/enabot/disk/zmb_datas/uploads

Notes:
  - Added paths are mounted into web-auto at the same absolute path.
  - Upload targets must be inside one of the listed data roots.
  - add/remove recreates web-auto by default so Docker picks up mount changes.
EOF
}

current_allowed_roots() {
  local host_root allowed
  host_root="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
  [[ -n "$host_root" && "$host_root" != "/home/zmb" ]] || host_root="$(default_host_data_root)"
  host_root="$(canonical_dir "$host_root")"
  allowed="$(get_env_var WEB_AUTO_ALLOWED_DATA_ROOTS || true)"
  normalize_data_roots "$host_root" "$allowed"
}

rewrite_allowed_roots() {
  local primary="$1"
  local allowed="$2"
  local upload_target root valid_upload
  upload_target="$(get_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR || true)"
  if [[ -z "$upload_target" ]]; then
    upload_target="$(default_upload_target_dir "$primary")"
  fi
  upload_target="$(canonical_dir "$upload_target")"
  valid_upload=0
  while IFS= read -r root; do
    if path_inside_dir "$upload_target" "$root"; then
      valid_upload=1
      break
    fi
  done < <(split_roots "$allowed")
  if [[ "$valid_upload" -eq 0 ]]; then
    upload_target="$(canonical_dir "$(default_upload_target_dir "$primary")")"
  fi
  set_env_var WEB_AUTO_ALLOWED_DATA_ROOTS "$allowed"
  set_env_var WEB_AUTO_HOST_DATA_ROOT "$primary"
  set_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR "$upload_target"
  write_mounts_compose_file "$primary" "$allowed"
}

recreate_web_auto_after_mount_change() {
  compose_env_defaults
  select_docker
  local services=(web-auto)
  if sapiens_enabled; then
    services+=(sapiens-api)
  fi
  info "Recreating ${services[*]} so Docker picks up data-root mounts"
  compose up -d --force-recreate "${services[@]}"
  wait_for_direct_http || true
}

cmd_data_root() {
  local subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    list)
      ensure_env ""
      local allowed item idx
      allowed="$(current_allowed_roots)"
      echo "web-auto mounted data roots:"
      idx=1
      while IFS= read -r item; do
        printf '  %s. %s\n' "$idx" "$item"
        idx=$((idx + 1))
      done < <(split_roots "$allowed")
      echo
      echo "Default upload directory:"
      echo "  $(get_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR || true)"
      [[ -f "$MOUNTS_COMPOSE_FILE" ]] && echo "Compose override: $MOUNTS_COMPOSE_FILE"
      ;;
    doctor)
      local path="${1:-}"
      ensure_env ""
      compose_env_defaults
      select_docker
      if [[ -z "$path" ]]; then
        path="$(get_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR || true)"
      fi
      path="$(repair_data_root_path "$path")"
      echo "Host-side path:"
      echo "  $path"
      if [[ -e "$path" ]]; then
        ls -ld "$path"
      else
        warn "Host path does not exist: $path"
      fi
      echo
      echo "web-auto container view:"
      compose exec -T web-auto sh -lc '
target="${1:-}"
echo "WEB_AUTO_HOST_DATA_ROOT=${WEB_AUTO_HOST_DATA_ROOT:-}"
echo "WEB_AUTO_ALLOWED_DATA_ROOTS=${WEB_AUTO_ALLOWED_DATA_ROOTS:-}"
echo "WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR=${WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR:-}"
echo
if [ -z "$target" ]; then
  echo "No target path provided."
  exit 0
fi
echo "Target: $target"
if [ -e "$target" ]; then
  ls -ld "$target"
else
  echo "MISSING: $target"
fi
parent="$(dirname "$target")"
echo
echo "Parent: $parent"
if [ -d "$parent" ]; then
  ls -la "$parent" | sed -n "1,80p"
else
  echo "MISSING PARENT: $parent"
fi
echo
echo "Project directories under target/parent:"
if [ -d "$target" ]; then
  find "$target" -maxdepth 4 -type d -name "prj_*" -print | sed -n "1,120p"
elif [ -d "$parent" ]; then
  find "$parent" -maxdepth 4 -type d -name "prj_*" -print | sed -n "1,120p"
fi
' sh "$path"
      ;;
    add)
      local path="" upload_target_override="" set_default=0 no_recreate=0 arg
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --default)
            set_default=1
            shift
            ;;
          --upload-target|--target)
            [[ $# -ge 2 ]] || die "$1 requires a directory"
            upload_target_override="$2"
            set_default=1
            shift 2
            ;;
          --no-recreate)
            no_recreate=1
            shift
            ;;
          --help|-h)
            data_root_usage
            return 0
            ;;
          *)
            [[ -z "$path" ]] || die "Only one data root path can be added at a time."
            path="$1"
            shift
            ;;
        esac
      done
      [[ -n "$path" ]] || die "data-root add requires a host path."
      path="$(repair_data_root_path "$path")"
      ensure_env ""
      local primary allowed new_root root exists roots=()
      primary="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
      [[ -n "$primary" && "$primary" != "/home/zmb" ]] || primary="$(default_host_data_root)"
      primary="$(canonical_dir "$primary")"
      allowed="$(current_allowed_roots)"
      new_root="$(canonical_dir "$path")"
      exists=0
      while IFS= read -r root; do
        [[ -n "$root" ]] || continue
        roots+=("$root")
        [[ "$root" == "$new_root" ]] && exists=1
      done < <(split_roots "$allowed")
      if [[ "$exists" -eq 0 ]]; then
        roots+=("$new_root")
      fi
      allowed="$(join_roots "${roots[@]}")"
      set_env_var WEB_AUTO_ALLOWED_DATA_ROOTS "$allowed"
      write_mounts_compose_file "$primary" "$allowed"
      local use_as_default=0
      if [[ "$set_default" -eq 1 ]]; then
        use_as_default=1
      elif is_interactive && [[ "$no_recreate" -eq 0 ]] && prompt_yes_no "Use this data root as the default upload directory" "y"; then
        use_as_default=1
      fi
      if [[ "$use_as_default" -eq 1 ]]; then
        local new_upload_target
        if [[ -n "$upload_target_override" ]]; then
          upload_target_override="$(repair_data_root_path "$upload_target_override")"
          new_upload_target="$(canonical_dir "$upload_target_override")"
          if ! path_inside_dir "$new_upload_target" "$new_root"; then
            die "--upload-target must be inside the added data root: $new_root"
          fi
        else
          new_upload_target="$(canonical_dir "$(default_upload_target_dir "$new_root")")"
        fi
        set_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR "$new_upload_target"
        write_global_upload_target_config "$new_upload_target"
      fi
      info "Added data root: $new_root"
      [[ "$no_recreate" -eq 1 ]] || recreate_web_auto_after_mount_change
      ;;
    remove)
      local path="" no_recreate=0 root remove_root primary allowed new_allowed roots=()
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --no-recreate)
            no_recreate=1
            shift
            ;;
          --help|-h)
            data_root_usage
            return 0
            ;;
          *)
            [[ -z "$path" ]] || die "Only one data root path can be removed at a time."
            path="$1"
            shift
            ;;
        esac
      done
      [[ -n "$path" ]] || die "data-root remove requires a host path."
      path="$(repair_data_root_path "$path")"
      ensure_env ""
      remove_root="$(canonical_dir "$path")"
      primary="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
      [[ -n "$primary" && "$primary" != "/home/zmb" ]] || primary="$(default_host_data_root)"
      primary="$(canonical_dir "$primary")"
      if [[ "$remove_root" == "$primary" ]]; then
        die "Cannot remove the primary WEB_AUTO_HOST_DATA_ROOT. Change it in .env or rerun './deploy.sh install --direct'."
      fi
      allowed="$(current_allowed_roots)"
      while IFS= read -r root; do
        [[ -n "$root" ]] || continue
        [[ "$root" == "$remove_root" ]] && continue
        roots+=("$root")
      done < <(split_roots "$allowed")
      new_allowed="$(join_roots "${roots[@]}")"
      rewrite_allowed_roots "$primary" "$new_allowed"
      local current_upload
      current_upload="$(get_env_var WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR || true)"
      write_global_upload_target_config "$current_upload"
      info "Removed data root: $remove_root"
      [[ "$no_recreate" -eq 1 ]] || recreate_web_auto_after_mount_change
      ;;
    help|-h|--help|"")
      data_root_usage
      ;;
    *)
      data_root_usage
      die "Unknown data-root command: $subcommand"
      ;;
  esac
}

cmd_config() {
  compose_env_defaults
  select_docker
  compose config
}

cmd_mirror() {
  select_docker
  configure_mirror "${1:-}"
  "${DOCKER_CMD[@]}" info | sed -n '/Registry Mirrors/,+8p'
}

cmd_gpu_check() {
  gpu_status_report
}

cmd_gpu_install() {
  install_nvidia_container_toolkit
  gpu_status_report
}

services_usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh services status
  ./deploy.sh services start <sam3-api|sapiens-api|caddy>
  ./deploy.sh services stop <sam3-api|sapiens-api|caddy>
  ./deploy.sh services restart <sam3-api|sapiens-api|caddy>
  ./deploy.sh services logs <sam3-api|sapiens-api|caddy>

Notes:
  - web-auto is intentionally not managed here to avoid killing the UI from the UI.
  - Enable sapiens-api before starting it:
      ./deploy.sh sapiens enable
EOF
}

cmd_services() {
  local subcommand="${1:-status}"
  shift || true
  case "$subcommand" in
    status|ps)
      ensure_env ""
      compose_env_defaults
      select_docker
      compose ps
      ;;
    start|stop|restart)
      local service="${1:-}"
      [[ -n "$service" ]] || die "services $subcommand requires a service name."
      case "$service" in
        sam3-api|sapiens-api|caddy) ;;
        web-auto) die "web-auto is not controlled by services; use './deploy.sh restart web-auto' from the server." ;;
        *) die "Unsupported service: $service" ;;
      esac
      ensure_env ""
      if [[ "$service" == "sapiens-api" && "$subcommand" == "start" ]] && ! sapiens_enabled; then
        die "sapiens-api is not enabled. Run './deploy.sh sapiens enable' first."
      fi
      compose_env_defaults
      select_docker
      compose "$subcommand" "$service"
      compose ps
      ;;
    logs)
      local service="${1:-}"
      [[ -n "$service" ]] || die "services logs requires a service name."
      case "$service" in
        sam3-api|sapiens-api|caddy) ;;
        *) die "Unsupported service: $service" ;;
      esac
      ensure_env ""
      compose_env_defaults
      select_docker
      compose logs -f --tail=200 "$service"
      ;;
    help|-h|--help|"")
      services_usage
      ;;
    *)
      services_usage
      die "Unknown services command: $subcommand"
      ;;
  esac
}

sapiens_usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh sapiens enable [--gpu|--cpu] [--skip-pull] [--skip-gpu-check]
  ./deploy.sh sapiens disable
  ./deploy.sh sapiens status
  ./deploy.sh sapiens logs

Checkpoint layout:
  SAPIENS_CHECKPOINT_ROOT/seg/sapiens2_5b_seg.safetensors

The default model is sapiens2_5b. web-auto can start the official checkpoint
download and show progress after sapiens-api is enabled.
EOF
}

cmd_sapiens() {
  local subcommand="${1:-status}"
  shift || true
  case "$subcommand" in
    enable)
      parse_common_options "$@"
      [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown sapiens enable option: ${POSITIONAL[*]}"
      ensure_env "$PROFILE_OVERRIDE"
      set_env_var SAPIENS_ENABLED "1"
      if [[ "$(effective_profile)" == "gpu" ]]; then
        set_env_var SAPIENS_DEVICE "cuda:0"
      else
        set_env_var SAPIENS_DEVICE "cpu"
      fi
      ensure_sapiens_submodule
      select_docker
      [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"
      [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight
      if [[ "$SKIP_PULL" -eq 0 ]]; then
        pull_required_images || warn "Pre-pull failed; continuing with compose build so Docker can retry."
      fi
      info "Building and starting sapiens-api"
      compose up -d --build ops-api sapiens-api
      compose ps sapiens-api
      local ckpt_root model_name ckpt_file
      ckpt_root="$(project_path "$(get_env_var SAPIENS_CHECKPOINT_ROOT || true)")"
      ckpt_root="${ckpt_root%/}"
      if [[ "$ckpt_root" == "$ROOT_DIR" ]]; then
        ckpt_root="$(project_path ./sapiens_checkpoints)"
      fi
      model_name="$(get_env_var SAPIENS_MODEL_NAME || true)"
      model_name="${model_name:-sapiens2_5b}"
      ckpt_file="$ckpt_root/seg/${model_name}_seg.safetensors"
      if [[ ! -f "$ckpt_file" ]]; then
        warn "Sapiens2 checkpoint is not present yet: $ckpt_file"
        warn "Open the web-auto project page; it will start the official Sapiens2-5B download and show progress."
      fi
      ;;
    disable)
      ensure_env ""
      compose_env_defaults
      select_docker
      compose stop sapiens-api || true
      set_env_var SAPIENS_ENABLED "0"
      info "sapiens-api disabled in .env. Existing container is stopped, data is preserved."
      compose ps || true
      ;;
    status|ps)
      ensure_env ""
      compose_env_defaults
      select_docker
      compose ps sapiens-api || true
      ;;
    logs)
      ensure_env ""
      compose_env_defaults
      select_docker
      compose logs -f --tail=200 sapiens-api
      ;;
    help|-h|--help|"")
      sapiens_usage
      ;;
    *)
      sapiens_usage
      die "Unknown sapiens command: $subcommand"
      ;;
  esac
}

cmd_uninstall() {
  "$ROOT_DIR/scripts/uninstall.sh" "$@"
}

main() {
  local command="install"
  if [[ $# -gt 0 ]]; then
    case "$1" in
      --*)
        command="install"
        ;;
      *)
        command="$1"
        shift
        ;;
    esac
  fi
  case "$command" in
    install) cmd_install "$@" ;;
    update) cmd_update "$@" ;;
    start|up) cmd_start "$@" ;;
    restart) cmd_restart "$@" ;;
    stop|down) cmd_stop "$@" ;;
    status|ps) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    services) cmd_services "$@" ;;
    sapiens) cmd_sapiens "$@" ;;
    doctor) cmd_doctor "$@" ;;
    reset-admin) cmd_reset_admin "$@" ;;
    data-root) cmd_data_root "$@" ;;
    mirror) cmd_mirror "$@" ;;
    gpu-check) cmd_gpu_check "$@" ;;
    gpu-install) cmd_gpu_install "$@" ;;
    config) cmd_config "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    help|-h|--help) usage ;;
    *) usage; die "Unknown command: $command" ;;
  esac
}

main "$@"
