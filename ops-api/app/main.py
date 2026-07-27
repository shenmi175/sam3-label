from __future__ import annotations

import hmac
import os
import threading
import time
from typing import Any

import docker
from docker.errors import DockerException, NotFound
from docker.types import DeviceRequest
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware


PROJECT_NAME = os.getenv("COMPOSE_PROJECT_NAME", "sam3-auto-label").strip() or "sam3-auto-label"
ALLOWED_SERVICES = {
    item.strip()
    for item in os.getenv("OPS_ALLOWED_SERVICES", "sam3-api,sapiens-api,caddy").split(",")
    if item.strip()
}
SERVICE_COMMANDS = {
    "sam3-api": "./deploy.sh start",
    "locate-anything-api": "./deploy.sh services start locate-anything-api",
    "sapiens-api": "./deploy.sh sapiens enable",
    "caddy": "./deploy.sh install --proxy",
}
OPS_PROJECT_ROOT = os.getenv("OPS_PROJECT_ROOT", "/workspace").strip() or "/workspace"
OPS_HOST_PROJECT_ROOT = os.getenv("OPS_HOST_PROJECT_ROOT", "").strip()
_OPS_LOCK = threading.Lock()
_OPERATIONS: dict[str, dict[str, Any]] = {}
_SERVICE_OPERATIONS: dict[str, str] = {}


def _configured_api_token() -> str:
    return os.getenv("OPS_API_TOKEN", "").strip()


def _request_api_token(request: Request) -> str:
    auth_header = str(request.headers.get("authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return str(request.headers.get("x-ops-api-key") or "").strip()


def _auth_public_path(path: str) -> bool:
    return path == "/health"


app = FastAPI(title="ops-api", version="1.0", description="Internal Docker service control API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_token(request: Request, call_next):
    token = _configured_api_token()
    if token and not _auth_public_path(request.url.path):
        supplied = _request_api_token(request)
        if not supplied or not hmac.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="invalid ops api token")
    return await call_next(request)


def _client():
    return docker.from_env()


def _assert_service_allowed(service: str) -> str:
    clean = str(service or "").strip()
    if clean not in ALLOWED_SERVICES:
        raise HTTPException(status_code=403, detail=f"service is not allowed: {clean}")
    return clean


def _containers_for_service(service: str) -> list[Any]:
    service = _assert_service_allowed(service)
    try:
        client = _client()
        return client.containers.list(
            all=True,
            filters={
                "label": [
                    f"com.docker.compose.project={PROJECT_NAME}",
                    f"com.docker.compose.service={service}",
                ],
            },
        )
    except DockerException as exc:
        raise HTTPException(status_code=503, detail=f"Docker API unavailable: {exc}") from exc


def _set_operation(operation_id: str, **values: Any) -> None:
    with _OPS_LOCK:
        op = _OPERATIONS.setdefault(operation_id, {})
        op.update(values)
        op["updated_at"] = time.time()


def _append_operation_log(operation_id: str, text: str, limit: int = 80) -> None:
    clean = str(text or "").rstrip()
    if not clean:
        return
    with _OPS_LOCK:
        op = _OPERATIONS.setdefault(operation_id, {})
        logs = list(op.get("logs") or [])
        logs.extend(clean.splitlines())
        op["logs"] = logs[-limit:]
        op["updated_at"] = time.time()


def _active_operation(service: str) -> dict[str, Any] | None:
    with _OPS_LOCK:
        op_id = _SERVICE_OPERATIONS.get(service)
        op = dict(_OPERATIONS.get(op_id or "") or {})
    if not op:
        return None
    if op.get("status") in {"queued", "running"}:
        return op
    if time.time() - float(op.get("updated_at") or 0.0) < 300:
        return op
    return None


def _container_status(container: Any) -> dict[str, Any]:
    container.reload()
    labels = container.attrs.get("Config", {}).get("Labels", {}) or {}
    state = container.attrs.get("State", {}) or {}
    health = state.get("Health", {}) or {}
    return {
        "id": container.short_id,
        "name": container.name,
        "service": labels.get("com.docker.compose.service", ""),
        "status": container.status,
        "health": health.get("Status", ""),
        "image": (container.image.tags or [container.image.short_id])[0],
        "created": container.attrs.get("Created", ""),
        "ports": container.attrs.get("NetworkSettings", {}).get("Ports", {}) or {},
    }


def _service_status(service: str) -> dict[str, Any]:
    operation = _active_operation(service)
    containers = _containers_for_service(service)
    if not containers:
        status = "creating" if operation and operation.get("status") in {"queued", "running"} else "not_created"
        return {
            "service": service,
            "status": status,
            "containers": [],
            "manage_command": SERVICE_COMMANDS.get(service, "./deploy.sh start"),
            "operation": operation,
        }
    statuses = [_container_status(container) for container in containers]
    running = any(item["status"] == "running" for item in statuses)
    return {
        "service": service,
        "status": "running" if running else statuses[0]["status"],
        "containers": statuses,
        "manage_command": SERVICE_COMMANDS.get(service, "./deploy.sh start"),
        "operation": operation,
    }


def _env_value(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip() or default


def _set_project_env_var(key: str, value: str, operation_id: str = "") -> None:
    env_path = os.path.join(OPS_PROJECT_ROOT, ".env")
    try:
        lines: list[str] = []
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        out: list[str] = []
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
        with open(env_path, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
    except Exception as exc:  # noqa: BLE001
        if operation_id:
            _append_operation_log(operation_id, f"Could not update .env {key}: {exc}")


def _host_path_env(key: str, default: str) -> str:
    value = _env_value(key, default)
    if value.startswith("./"):
        base = OPS_HOST_PROJECT_ROOT or OPS_PROJECT_ROOT
        return os.path.abspath(os.path.join(base, value[2:]))
    if value == ".":
        return os.path.abspath(OPS_HOST_PROJECT_ROOT or OPS_PROJECT_ROOT)
    return value


def _sapiens_volumes() -> dict[str, dict[str, str]]:
    checkpoint_root = _host_path_env("SAPIENS_CHECKPOINT_ROOT", "./sapiens_checkpoints")
    data_dir = _host_path_env("SAPIENS_API_DATA_DIR", "./sapiens-api/data")
    host_root = _host_path_env("WEB_AUTO_HOST_DATA_ROOT", "./project-data")
    volumes: dict[str, dict[str, str]] = {
        checkpoint_root: {"bind": "/models/sapiens2", "mode": "rw"},
        data_dir: {"bind": "/app/sapiens-api/data", "mode": "rw"},
        host_root: {"bind": host_root, "mode": "rw"},
        f"{PROJECT_NAME}_sapiens_hf_cache": {"bind": "/cache/huggingface", "mode": "rw"},
        f"{PROJECT_NAME}_sapiens_torch_cache": {"bind": "/cache/torch", "mode": "rw"},
    }
    for item in _env_value("WEB_AUTO_ALLOWED_DATA_ROOTS", "").split(os.pathsep):
        root = item.strip()
        if root and root not in volumes:
            volumes[root] = {"bind": root, "mode": "rw"}
    return volumes


def _sapiens_environment() -> dict[str, str]:
    allowed_roots = _env_value("WEB_AUTO_ALLOWED_DATA_ROOTS", "")
    host_root = _host_path_env("WEB_AUTO_HOST_DATA_ROOT", "./project-data")
    if host_root and host_root not in allowed_roots.split(os.pathsep):
        allowed_roots = host_root if not allowed_roots else f"{host_root}{os.pathsep}{allowed_roots}"
    env = {
        "SAPIENS_API_HOST": "0.0.0.0",
        "SAPIENS_API_PORT": "8010",
        "SAPIENS_DEVICE": _env_value("SAPIENS_DEVICE", "cuda:0"),
        "SAPIENS_MODEL_NAME": "sapiens2_5b",
        "SAPIENS_REPO_DIR": "/app/external/sapiens2",
        "SAPIENS_CHECKPOINT_ROOT": "/models/sapiens2",
        "SAPIENS_ALLOWED_DATA_ROOTS": allowed_roots,
        "SAPIENS_API_TOKEN": _env_value("SAPIENS_API_TOKEN", ""),
        "HF_HOME": "/cache/huggingface",
        "TORCH_HOME": "/cache/torch",
    }
    hf_token = _env_value("HF_TOKEN", "") or _env_value("HUGGINGFACE_HUB_TOKEN", "")
    if hf_token:
        env["HF_TOKEN"] = hf_token
    return env


def _ensure_network(client: Any) -> str:
    network_name = f"{PROJECT_NAME}_default"
    try:
        client.networks.get(network_name)
    except NotFound:
        client.networks.create(network_name, driver="bridge", labels={"com.docker.compose.project": PROJECT_NAME})
    return network_name


def _create_sapiens_container_job(operation_id: str) -> None:
    service = "sapiens-api"
    _set_operation(operation_id, status="running", phase="build", service=service)
    try:
        client = _client()
        project_root = os.path.abspath(OPS_PROJECT_ROOT)
        if not os.path.exists(os.path.join(project_root, "docker", "sapiens-api.Dockerfile")):
            raise RuntimeError(f"project root is not mounted correctly: {project_root}")
        _append_operation_log(operation_id, "Building sapiens-api image")
        buildargs = {
            "SAPIENS_API_BASE_IMAGE": _env_value(
                "SAPIENS_API_BASE_IMAGE",
                "pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime",
            )
        }
        for chunk in client.api.build(
            path=project_root,
            dockerfile="docker/sapiens-api.Dockerfile",
            tag="sapiens-api:local",
            buildargs=buildargs,
            rm=True,
            forcerm=True,
            decode=True,
        ):
            if "stream" in chunk:
                _append_operation_log(operation_id, str(chunk["stream"]))
            if "error" in chunk:
                raise RuntimeError(str(chunk["error"]))

        existing = _containers_for_service(service)
        if existing:
            _append_operation_log(operation_id, "Existing sapiens-api container found; starting it")
            for container in existing:
                container.start()
            _set_operation(operation_id, status="completed", phase="start", finished_at=time.time())
            return

        _set_operation(operation_id, phase="create")
        network_name = _ensure_network(client)
        container_name = f"{PROJECT_NAME}-sapiens-api-1"
        labels = {
            "com.docker.compose.project": PROJECT_NAME,
            "com.docker.compose.service": service,
            "com.docker.compose.container-number": "1",
            "com.docker.compose.oneoff": "False",
            "managed-by": "sam3-ops-api",
        }
        device_requests = []
        if _env_value("SAPIENS_DEVICE", "cuda:0").startswith("cuda"):
            device_requests = [DeviceRequest(count=-1, capabilities=[["gpu"]])]

        _append_operation_log(operation_id, "Creating sapiens-api container")
        container = client.containers.create(
            image="sapiens-api:local",
            name=container_name,
            detach=True,
            environment=_sapiens_environment(),
            labels=labels,
            network=network_name,
            volumes=_sapiens_volumes(),
            restart_policy={"Name": "unless-stopped"},
            shm_size=_env_value("SAPIENS_API_SHM_SIZE", "8gb"),
            device_requests=device_requests,
        )
        _append_operation_log(operation_id, "Starting sapiens-api container")
        container.start()
        _set_project_env_var("SAPIENS_ENABLED", "1", operation_id)
        _set_project_env_var("SAPIENS_MODEL_NAME", "sapiens2_5b", operation_id)
        _set_operation(operation_id, status="completed", phase="start", finished_at=time.time())
    except Exception as exc:  # noqa: BLE001
        _append_operation_log(operation_id, str(exc))
        _set_operation(operation_id, status="failed", error=str(exc), finished_at=time.time())


def _start_sapiens_create_operation() -> dict[str, Any]:
    service = "sapiens-api"
    active = _active_operation(service)
    if active and active.get("status") in {"queued", "running"}:
        return active
    operation_id = f"ops_{service.replace('-', '_')}_{int(time.time())}"
    with _OPS_LOCK:
        _SERVICE_OPERATIONS[service] = operation_id
        _OPERATIONS[operation_id] = {
            "operation_id": operation_id,
            "service": service,
            "action": "create_start",
            "status": "queued",
            "phase": "queued",
            "logs": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }
    thread = threading.Thread(target=_create_sapiens_container_job, args=(operation_id,), daemon=True)
    thread.start()
    return _OPERATIONS[operation_id]


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        client = _client()
        client.ping()
        docker_ok = True
        docker_error = ""
    except Exception as exc:  # noqa: BLE001
        docker_ok = False
        docker_error = str(exc)
    return {
        "status": "ok" if docker_ok else "docker_unavailable",
        "service": "ops-api",
        "project": PROJECT_NAME,
        "allowed_services": sorted(ALLOWED_SERVICES),
        "docker_ok": docker_ok,
        "docker_error": docker_error,
    }


@app.get("/v1/services")
def services() -> dict[str, Any]:
    return {
        "project": PROJECT_NAME,
        "services": [_service_status(service) for service in sorted(ALLOWED_SERVICES)],
    }


@app.post("/v1/services/{service}/{action}")
def control_service(service: str, action: str) -> dict[str, Any]:
    service = _assert_service_allowed(service)
    action = str(action or "").strip().lower()
    if action not in {"start", "stop", "restart"}:
        raise HTTPException(status_code=400, detail="action must be start, stop, or restart")
    containers = _containers_for_service(service)
    if not containers:
        if service == "sapiens-api" and action in {"start", "restart"}:
            operation = _start_sapiens_create_operation()
            return {"ok": True, "action": action, "service": service, "operation": operation, "status": _service_status(service)}
        raise HTTPException(status_code=404, detail=f"service has no created container: {service}")
    for container in containers:
        try:
            if action == "start":
                container.start()
            elif action == "stop":
                container.stop(timeout=20)
            else:
                container.restart(timeout=20)
        except NotFound as exc:
            raise HTTPException(status_code=404, detail=f"container not found: {container.name}") from exc
        except DockerException as exc:
            raise HTTPException(status_code=500, detail=f"Docker API error: {exc}") from exc
    return {"ok": True, "action": action, "service": service, "status": _service_status(service)}


@app.get("/v1/services/{service}/logs")
def service_logs(service: str, tail: int = 120) -> dict[str, Any]:
    service = _assert_service_allowed(service)
    containers = _containers_for_service(service)
    if not containers:
        raise HTTPException(status_code=404, detail=f"service has no created container: {service}")
    limit = max(1, min(1000, int(tail or 120)))
    logs = []
    for container in containers:
        try:
            text = container.logs(tail=limit).decode("utf-8", errors="replace")
        except DockerException as exc:
            raise HTTPException(status_code=500, detail=f"Docker API error: {exc}") from exc
        logs.append({"container": container.name, "logs": text})
    return {"service": service, "tail": limit, "containers": logs}
