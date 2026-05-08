#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DOCKER_CMD=()
FORCE_PROFILE_PROMPT=0
FORCE_CONFIG_PROMPT=0
NPM_PROXY_DOMAINS=""
NPM_PROXY_USE_SSL=0
NPM_PROXY_SSL_EMAIL=""
NPM_PROXY_FORCE_SSL=1

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
  install            Guided first-time setup, image pull, build, and start.
  update             Pull latest git changes, rebuild, and restart.
  restart [service]  Restart all services or one service.
  start              Start the stack without rebuilding.
  stop               Stop and remove containers, preserving data.
  status             Show container status.
  logs [service]     Follow logs for all services or one service.
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
    answer="${answer:-$default_value}"
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

  local host_root
  host_root="$(get_env_var WEB_AUTO_HOST_DATA_ROOT || true)"
  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
    host_root="$(prompt_value "Host data root mounted into web-auto" "${host_root:-${HOME:-$ROOT_DIR}}")"
    set_env_var WEB_AUTO_HOST_DATA_ROOT "$host_root"
  elif [[ -z "$host_root" || ( "$host_root" == "/home/zmb" && ! -d /home/zmb ) ]]; then
    host_root="$(prompt_value "Host data root mounted into web-auto" "${HOME:-$ROOT_DIR}")"
    set_env_var WEB_AUTO_HOST_DATA_ROOT "$host_root"
  fi

  if [[ "$FORCE_CONFIG_PROMPT" -eq 1 && is_interactive ]]; then
    local http_port https_port admin_port bootstrap_port bootstrap_bind
    http_port="$(prompt_value "Nginx Proxy Manager HTTP port" "$(get_env_var NPM_HTTP_PORT || true)")"
    https_port="$(prompt_value "Nginx Proxy Manager HTTPS port" "$(get_env_var NPM_HTTPS_PORT || true)")"
    admin_port="$(prompt_value "Nginx Proxy Manager admin port" "$(get_env_var NPM_ADMIN_PORT || true)")"
    bootstrap_bind="$(prompt_value "web-auto bootstrap bind address" "$(get_env_var WEB_AUTO_BOOTSTRAP_BIND || true)")"
    bootstrap_port="$(prompt_value "web-auto bootstrap port" "$(get_env_var WEB_AUTO_BOOTSTRAP_PORT || true)")"
    set_env_var NPM_HTTP_PORT "${http_port:-80}"
    set_env_var NPM_HTTPS_PORT "${https_port:-443}"
    set_env_var NPM_ADMIN_PORT "${admin_port:-81}"
    set_env_var WEB_AUTO_BOOTSTRAP_BIND "${bootstrap_bind:-0.0.0.0}"
    set_env_var WEB_AUTO_BOOTSTRAP_PORT "${bootstrap_port:-8000}"
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

prompt_proxy_config() {
  NPM_PROXY_DOMAINS=""
  NPM_PROXY_USE_SSL=0
  NPM_PROXY_SSL_EMAIL=""
  NPM_PROXY_FORCE_SSL=1
  is_interactive || return 0
  if ! prompt_yes_no "Configure Nginx Proxy Manager Proxy Host now" "n"; then
    return 0
  fi
  NPM_PROXY_DOMAINS="$(prompt_value "Domain name(s), comma-separated" "")"
  if [[ -z "${NPM_PROXY_DOMAINS//[[:space:]]/}" ]]; then
    warn "No domain entered; skipping NPM proxy configuration."
    NPM_PROXY_DOMAINS=""
    return 0
  fi
  if prompt_yes_no "Request Let's Encrypt certificate" "y"; then
    NPM_PROXY_USE_SSL=1
    local first_domain default_email
    first_domain="$(printf '%s' "$NPM_PROXY_DOMAINS" | cut -d',' -f1 | tr -d '[:space:]')"
    default_email="admin@${first_domain}"
    NPM_PROXY_SSL_EMAIL="$(prompt_value "Let's Encrypt email" "$default_email")"
    if prompt_yes_no "Force HTTPS" "y"; then
      NPM_PROXY_FORCE_SSL=1
    else
      NPM_PROXY_FORCE_SSL=0
    fi
  fi
}

configure_npm_proxy_host() {
  [[ -n "${NPM_PROXY_DOMAINS//[[:space:]]/}" ]] || return 0
  command -v python3 >/dev/null 2>&1 || {
    warn "python3 is required for automatic NPM proxy configuration; configure it manually in NPM."
    return 0
  }

  local admin_port admin_email admin_password
  admin_port="$(get_env_var NPM_ADMIN_PORT || true)"
  admin_email="$(get_env_var NPM_ADMIN_EMAIL || true)"
  admin_password="$(get_env_var NPM_ADMIN_PASSWORD || true)"
  admin_port="${admin_port:-81}"
  admin_email="${admin_email:-admin@example.com}"
  admin_password="${admin_password:-changeme}"

  info "Configuring NPM Proxy Host for: $NPM_PROXY_DOMAINS"
  if ! NPM_URL="http://127.0.0.1:${admin_port}" \
    NPM_EMAIL="$admin_email" \
    NPM_PASSWORD="$admin_password" \
    NPM_PROXY_DOMAINS="$NPM_PROXY_DOMAINS" \
    NPM_PROXY_USE_SSL="$NPM_PROXY_USE_SSL" \
    NPM_PROXY_SSL_EMAIL="$NPM_PROXY_SSL_EMAIL" \
    NPM_PROXY_FORCE_SSL="$NPM_PROXY_FORCE_SSL" \
    python3 - <<'PY'
import json
import os
import time
import urllib.error
import urllib.request

base_url = os.environ["NPM_URL"].rstrip("/")
email = os.environ["NPM_EMAIL"]
password = os.environ["NPM_PASSWORD"]
domains = [item.strip() for item in os.environ["NPM_PROXY_DOMAINS"].split(",") if item.strip()]
use_ssl = os.environ.get("NPM_PROXY_USE_SSL") == "1"
ssl_email = os.environ.get("NPM_PROXY_SSL_EMAIL", "").strip()
force_ssl = os.environ.get("NPM_PROXY_FORCE_SSL", "1") == "1"

def request(method, path, payload=None, token=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"NPM API HTTP {exc.code}: {detail[:240]}") from exc

def proxy_host_request(method, path, payload, token=None, retry_meta_schema=True):
    try:
        return request(method, path, payload, token=token)
    except Exception as exc:
        if not retry_meta_schema or "data/meta must NOT have additional properties" not in str(exc):
            raise
        retry_payload = dict(payload)
        retry_payload["meta"] = {}
        return request(method, path, retry_payload, token=token)

def letsencrypt_meta(email="", legacy=False):
    meta = {"dns_challenge": False}
    if legacy and email:
        meta["letsencrypt_email"] = email
        meta["letsencrypt_agree"] = True
    return meta

last_error = None
for _ in range(45):
    try:
        token_payload = request("POST", "/api/tokens", {"identity": email, "secret": password})
        token = token_payload["token"]
        break
    except Exception as exc:
        last_error = exc
        time.sleep(2)
else:
    raise SystemExit(f"failed to login to NPM API at {base_url}: {last_error}")

hosts = request("GET", "/api/nginx/proxy-hosts", token=token)
target = None
for host in hosts:
    existing = set(host.get("domain_names") or [])
    if existing.intersection(domains):
        target = host
        break

body = {
    "domain_names": domains,
    "forward_scheme": "http",
    "forward_host": "web-auto",
    "forward_port": 8000,
    "access_list_id": 0,
    "certificate_id": 0,
    "ssl_forced": False,
    "caching_enabled": False,
    "block_exploits": True,
    "advanced_config": "",
    "meta": {},
    "allow_websocket_upgrade": True,
    "http2_support": False,
    "hsts_enabled": False,
    "hsts_subdomains": False,
    "enabled": True,
    "locations": [],
}

if target:
    host_id = target["id"]
    proxy_host_request("PUT", f"/api/nginx/proxy-hosts/{host_id}", body, token=token)
else:
    created = proxy_host_request("POST", "/api/nginx/proxy-hosts", body, token=token)
    host_id = created["id"]

if use_ssl:
    cert_id = 0
    certs = request("GET", "/api/nginx/certificates", token=token)
    for cert in certs:
        if set(cert.get("domain_names") or []) == set(domains):
            cert_id = cert.get("id") or 0
            break
    if not cert_id:
        cert_body = {
            "provider": "letsencrypt",
            "nice_name": ",".join(domains),
            "domain_names": domains,
            "meta": letsencrypt_meta(),
        }
        cert_error = None
        try:
            cert = request("POST", "/api/nginx/certificates", cert_body, token=token)
            cert_id = cert["id"]
        except Exception as cert_exc:
            cert_error = cert_exc
            if ssl_email:
                legacy_cert_body = dict(cert_body)
                legacy_cert_body["meta"] = letsencrypt_meta(ssl_email, legacy=True)
                try:
                    cert = request("POST", "/api/nginx/certificates", legacy_cert_body, token=token)
                    cert_id = cert["id"]
                    cert_error = None
                except Exception as legacy_cert_exc:
                    cert_error = RuntimeError(f"new schema: {cert_exc}; legacy schema: {legacy_cert_exc}")
        if not cert_id:
            ssl_body = dict(body)
            ssl_body["certificate_id"] = "new"
            ssl_body["ssl_forced"] = bool(force_ssl)
            ssl_body["http2_support"] = True
            ssl_body["meta"] = letsencrypt_meta()
            proxy_error = None
            try:
                updated = proxy_host_request(
                    "PUT",
                    f"/api/nginx/proxy-hosts/{host_id}",
                    ssl_body,
                    token=token,
                    retry_meta_schema=False,
                )
            except Exception as proxy_exc:
                proxy_error = proxy_exc
                if ssl_email:
                    legacy_ssl_body = dict(ssl_body)
                    legacy_ssl_body["meta"] = letsencrypt_meta(ssl_email, legacy=True)
                    try:
                        updated = proxy_host_request(
                            "PUT",
                            f"/api/nginx/proxy-hosts/{host_id}",
                            legacy_ssl_body,
                            token=token,
                            retry_meta_schema=False,
                        )
                        ssl_body = legacy_ssl_body
                        proxy_error = None
                    except Exception as legacy_proxy_exc:
                        proxy_error = RuntimeError(f"new schema: {proxy_exc}; legacy schema: {legacy_proxy_exc}")
                if proxy_error is not None:
                    raise RuntimeError(f"NPM SSL certificate request failed: certificates API: {cert_error}; proxy-host API: {proxy_error}") from proxy_error
            host_id = updated.get("id") or host_id
            cert_id = updated.get("certificate_id") or 0
            body = ssl_body
    if cert_id:
        body["certificate_id"] = cert_id
        body["ssl_forced"] = bool(force_ssl)
        body["http2_support"] = True
        body["meta"] = {}
        proxy_host_request("PUT", f"/api/nginx/proxy-hosts/{host_id}", body, token=token)

print(f"configured proxy host id={host_id} domains={','.join(domains)} ssl={'yes' if use_ssl else 'no'}")
PY
  then
    warn "Automatic NPM proxy configuration failed. You can still configure it manually in the NPM UI."
  fi
}

required_images() {
  local npm_tag base_image
  npm_tag="$(get_env_var NPM_IMAGE_TAG || true)"
  base_image="$(get_env_var SAM3_API_BASE_IMAGE || true)"
  printf '%s\n' "jc21/nginx-proxy-manager:${npm_tag:-2.14.0}"
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

print_next_steps() {
  local admin_port bootstrap_port host_ip web_user web_password npm_email npm_password
  admin_port="$(get_env_var NPM_ADMIN_PORT || true)"
  bootstrap_port="$(get_env_var WEB_AUTO_BOOTSTRAP_PORT || true)"
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host_ip="${host_ip:-SERVER_IP}"
  web_user="$(get_env_var WEB_AUTO_ADMIN_USERNAME || true)"
  web_password="$(get_env_var WEB_AUTO_ADMIN_PASSWORD || true)"
  npm_email="$(get_env_var NPM_ADMIN_EMAIL || true)"
  npm_password="$(get_env_var NPM_ADMIN_PASSWORD || true)"
  cat <<EOF

Deployment is running.

Initial web-auto address:
  http://${host_ip}:${bootstrap_port:-8000}

web-auto login:
  Username: ${web_user:-admin}
  Password: ${web_password:-see .env WEB_AUTO_ADMIN_PASSWORD}

Configure domain:
  Open web-auto -> Global Settings -> Reverse Proxy.
  Fill domain name and certificate email, then click Configure Proxy.

Nginx Proxy Manager admin is only for troubleshooting:
  http://127.0.0.1:${admin_port:-81}
  Email: ${npm_email:-admin@example.com}
  Password: ${npm_password:-changeme}
EOF
  if [[ -n "${NPM_PROXY_DOMAINS//[[:space:]]/}" ]]; then
    local first_domain scheme
    first_domain="$(printf '%s' "$NPM_PROXY_DOMAINS" | cut -d',' -f1 | tr -d '[:space:]')"
    scheme="http"
    [[ "$NPM_PROXY_USE_SSL" -eq 1 ]] && scheme="https"
    cat <<EOF

Configured web-auto address:
  ${scheme}://${first_domain}
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

cmd_install() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown install option: ${POSITIONAL[*]}"
  if is_interactive; then
    info "Starting interactive SAM3 deployment wizard. Press Enter to accept defaults."
    [[ -z "$PROFILE_OVERRIDE" ]] && FORCE_PROFILE_PROMPT=1
    FORCE_CONFIG_PROMPT=1
  fi
  ensure_env "$PROFILE_OVERRIDE"
  select_docker
  if [[ -z "$MIRROR_URL" && is_interactive ]]; then
    if prompt_yes_no "Configure a Docker Hub registry mirror now" "n"; then
      MIRROR_URL="$(prompt_value "Docker Hub registry mirror URL" "")"
    fi
  fi
  prompt_proxy_config
  [[ -z "$MIRROR_URL" ]] || configure_mirror "$MIRROR_URL"
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight

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
  configure_npm_proxy_host
  compose ps
  print_next_steps
}

cmd_update() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown update option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
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

  info "Rebuilding and restarting stack"
  compose up -d --build
  compose ps
}

cmd_start() {
  parse_common_options "$@"
  [[ "${#POSITIONAL[@]}" -eq 0 ]] || die "Unknown start option: ${POSITIONAL[*]}"
  ensure_env "$PROFILE_OVERRIDE"
  select_docker
  [[ "$SKIP_GPU_CHECK" -eq 1 ]] || gpu_preflight
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
