#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DOCKER_CMD=()
FORCE_PROFILE_PROMPT=0
FORCE_CONFIG_PROMPT=0

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
  install            Guided setup, DNS preflight, image pull, build, and start.
  update             Pull latest git changes, rebuild, and restart.
  restart [service]  Restart all services or one service.
  start              Start the stack without rebuilding.
  stop               Stop and remove containers, preserving data.
  status             Show container status.
  logs [service]     Follow logs for all services or one service.
  doctor             Run DNS, port, HTTPS, and Caddy diagnostics.
  mirror [url]       Configure a Docker Hub registry mirror.
  gpu-check          Check host NVIDIA driver and Docker GPU runtime.
  gpu-install        Install/configure NVIDIA Container Toolkit for Docker.
  config             Render the effective Docker Compose config.
  uninstall          Run scripts/uninstall.sh.
  help               Show this help.

Options for install/update/start:
  --gpu              Use GPU profile. This is the default.
  --cpu              Use CPU profile for functional testing.
  --mirror URL       Configure Docker Hub mirror before pulling images.
  --skip-pull        Skip pre-pulling base images.
  --skip-gpu-check   Skip Docker GPU runtime preflight.
  --skip-git         update only: skip git pull.

Examples:
  ./deploy.sh
  ./deploy.sh install
  ./deploy.sh install --mirror https://your-mirror.example
  ./deploy.sh update
  ./deploy.sh gpu-check
  ./deploy.sh gpu-install
  ./deploy.sh restart web-auto
  ./deploy.sh logs caddy
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
      ;;
    cpu)
      set_env_var SAM3_DEPLOY_PROFILE "cpu"
      set_env_var SAM3_API_DEVICE "cpu"
      ;;
    *)
      die "Invalid SAM3_DEPLOY_PROFILE: $profile. Use gpu or cpu."
      ;;
  esac

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

  local host_root
  host_root="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
    host_root="$(prompt_value "Host data root mounted into web-auto" "${host_root:-${HOME:-$ROOT_DIR}}")"
    set_env_var WEB_AUTO_HOST_DATA_ROOT "$host_root"
  elif [[ -z "$host_root" || ( "$host_root" == "/home/zmb" && ! -d /home/zmb ) ]]; then
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

compose_env_defaults() {
  local value
  value="$(get_env_var PUBLIC_DOMAIN || true)"
  export PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-${value:-status.local}}"
  value="$(get_env_var ACME_EMAIL || true)"
  export ACME_EMAIL="${ACME_EMAIL:-${value:-status@example.org}}"
  value="$(get_env_var SAM3_API_TOKEN || true)"
  export SAM3_API_TOKEN="${SAM3_API_TOKEN:-${value:-status-token}}"
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
  local caddy_tag base_image
  caddy_tag="$(get_env_var CADDY_IMAGE_TAG || true)"
  base_image="$(get_env_var SAM3_API_BASE_IMAGE || true)"
  printf '%s\n' "caddy:${caddy_tag:-2.11.2-alpine}"
  printf '%s\n' "python:3.11-slim"
  printf '%s\n' "${base_image:-pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime}"
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
    value="$(curl -fsS --max-time 8 "$url" 2>/dev/null || true)"
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
    if curl -fsS --max-time 8 --resolve "${domain}:443:127.0.0.1" "$url" >/dev/null 2>&1; then
      info "HTTPS validation passed: $url"
      return 0
    fi
    last_error="$(curl -fsS --max-time 8 --resolve "${domain}:443:127.0.0.1" "$url" 2>&1 >/dev/null || true)"
    sleep 3
  done

  warn "HTTPS validation failed after waiting. Last curl error: ${last_error:-unknown}"
  show_caddy_logs
  die "Caddy did not serve a valid HTTPS response for $url. Run './deploy.sh doctor' for the full diagnostic report."
}

print_next_steps() {
  local domain web_user web_password
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  web_user="$(get_env_var WEB_AUTO_ADMIN_USERNAME || true)"
  web_password="$(get_env_var WEB_AUTO_ADMIN_PASSWORD || true)"
  cat <<EOF

Deployment is running.

web-auto:
  https://${domain}

web-auto login:
  Username: ${web_user:-admin}
  Password: ${web_password:-see .env WEB_AUTO_ADMIN_PASSWORD}

sam3-api is internal only:
  http://sam3-api:8001

Useful commands:
  ./deploy.sh status
  ./deploy.sh logs caddy
  ./deploy.sh logs web-auto
EOF
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
    info "Starting interactive SAM3 deployment wizard. Domain and Let's Encrypt email are required."
    [[ -z "$PROFILE_OVERRIDE" ]] && FORCE_PROFILE_PROMPT=1
    FORCE_CONFIG_PROMPT=1
  fi
  ensure_env "$PROFILE_OVERRIDE"
  if [[ -z "$MIRROR_URL" && is_interactive ]]; then
    if prompt_yes_no "Configure a Docker Hub registry mirror now" "n"; then
      MIRROR_URL="$(prompt_value "Docker Hub registry mirror URL" "")"
    fi
  fi
  validate_domain_dns
  prepare_runtime
  stop_stack_for_recreate
  check_caddy_ports

  info "Building and starting stack"
  compose up -d --build --remove-orphans
  compose ps
  wait_for_https
  print_next_steps
}

cmd_update() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown update option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  validate_domain_dns
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
  check_caddy_ports
  info "Rebuilding and restarting stack"
  compose up -d --build --remove-orphans
  compose ps
  wait_for_https
  print_next_steps
}

cmd_start() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown start option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  validate_domain_dns
  select_docker
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight
  stop_stack_for_recreate
  check_caddy_ports
  compose up -d --remove-orphans
  compose ps
  wait_for_https
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
  local domain public_ipv4
  domain="$(get_env_var PUBLIC_DOMAIN || true)"
  is_valid_domain "$domain" || die "PUBLIC_DOMAIN is invalid or missing in .env."

  select_docker
  echo "== SAM3 deployment doctor =="
  echo "Domain: $domain"
  public_ipv4="$(get_public_ipv4 || true)"
  echo "Server public IPv4: ${public_ipv4:-unknown}"
  echo

  echo "DNS records:"
  resolve_domain_records "$domain" || true
  echo

  echo "Compose status:"
  compose ps || true
  echo

  if command -v ss >/dev/null 2>&1; then
    echo "TCP listeners on 80/443:"
    ss -ltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print}' || true
    echo
    echo "UDP listeners on 443:"
    ss -lunp 2>/dev/null | awk '$4 ~ /:443$/ {print}' || true
    echo
  fi

  if command -v curl >/dev/null 2>&1; then
    echo "Local Caddy HTTP probe:"
    curl -sS -I --max-time 8 --resolve "${domain}:80:127.0.0.1" "http://${domain}/" || true
    echo
    echo "Local Caddy HTTPS probe:"
    curl -v --max-time 10 --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/health" -o /dev/null || true
    echo
    echo "Public DNS HTTP probe:"
    curl -sS -I --max-time 10 "http://${domain}/.well-known/acme-challenge/deploy-doctor" || true
    echo
    echo "Public DNS HTTPS probe:"
    curl -v --max-time 10 "https://${domain}/api/health" -o /dev/null || true
    echo
  fi

  if command -v openssl >/dev/null 2>&1; then
    echo "TLS handshake probe:"
    printf '' | openssl s_client -servername "$domain" -connect "127.0.0.1:443" -brief 2>&1 || true
    echo
  fi

  echo "Caddy logs:"
  compose logs --tail=200 caddy || true
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
    doctor) cmd_doctor "$@" ;;
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
