from __future__ import annotations

import copy
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from app.locate_anything_client import LocateAnythingClient
from app.sam3_client import Sam3Client
from app.services.integration_clients import OpsClient, SapiensClient


SUPPORTED_SERVICES = {'sam3-api', 'locate-anything-api', 'sapiens-api'}
ACTIVE_STATUSES = {'queued', 'running'}


class ModelLoadRejected(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int = 409,
        code: str = 'model_load_rejected',
    ):
        self.status_code = int(status_code)
        self.code = str(code)
        super().__init__(message)


def normalize_model_load_error(exc: BaseException) -> dict[str, str]:
    raw = str(exc or '').strip() or exc.__class__.__name__
    text = raw.lower()
    status_code = getattr(exc, 'status_code', None)
    auth_tokens = (
        'http 401',
        'http 403',
        'http error 401',
        'http error 403',
        'unauthorized',
        'forbidden',
        'authentication',
        'invalid token',
        'api token',
    )
    if status_code in {401, 403} or any(token in text for token in auth_tokens):
        code = 'authentication_failed'
        prefix = '模型服务认证失败'
    elif status_code == 507 or any(
        token in text
        for token in (
            'cuda out of memory',
            'gpu out of memory',
            'cuda oom',
            'cublas_status_alloc_failed',
        )
    ):
        code = 'cuda_oom'
        prefix = 'CUDA 显存不足'
    elif any(
        token in text
        for token in (
            'weights missing',
            'weight missing',
            'checkpoint missing',
            'checkpoint not found',
            'no such file',
            'does not exist',
        )
    ):
        code = 'weights_missing'
        prefix = '模型权重缺失'
    elif any(token in text for token in ('timed out', 'timeout')):
        code = 'timeout'
        prefix = '模型加载或预热超时'
    elif any(
        token in text
        for token in (
            'connection refused',
            'connection error',
            'name or service not known',
            'failed to establish',
            'service unavailable',
            'request failed',
        )
    ):
        code = 'service_unavailable'
        prefix = '模型服务不可用'
    elif isinstance(exc, ValueError) and 'response' in text:
        code = 'invalid_response'
        prefix = '模型服务响应无效'
    else:
        code = 'inference_failed'
        prefix = '模型加载或预热失败'
    return {'code': code, 'message': f'{prefix}：{raw}'}


class ModelLoadJobManager:
    """In-memory real-inference warmup jobs with atomic physical-GPU reservation."""

    def __init__(
        self,
        *,
        sam3: Sam3Client,
        locate: LocateAnythingClient,
        sapiens: SapiensClient,
        ops: OpsClient,
        example_image: Path,
        sam3_api_base_url: Callable[[], str],
        locate_api_base_url: Callable[[], str],
        gpu_deployment: bool = False,
        gpu_devices: dict[str, str] | None = None,
    ) -> None:
        self._sam3 = sam3
        self._locate = locate
        self._sapiens = sapiens
        self._ops = ops
        self._example_image = Path(example_image)
        self._sam3_api_base_url = sam3_api_base_url
        self._locate_api_base_url = locate_api_base_url
        self._gpu_deployment = bool(gpu_deployment)
        self._gpu_devices = {
            service: str((gpu_devices or {}).get(service, '')).strip()
            for service in SUPPORTED_SERVICES
        }
        self._lock = threading.RLock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._latest_by_service: dict[str, str] = {}
        self._gpu_reservations: dict[str, str] = {}

    @staticmethod
    def _clean_service(service: str) -> str:
        clean = str(service or '').strip()
        if clean not in SUPPORTED_SERVICES:
            raise ModelLoadRejected(
                f'不支持的模型服务：{clean or "(empty)"}',
                status_code=400,
                code='unsupported_service',
            )
        return clean

    def _snapshot(self, job: dict[str, Any] | None) -> dict[str, Any] | None:
        return copy.deepcopy(job) if job else None

    def latest(self, service: str) -> dict[str, Any] | None:
        clean = self._clean_service(service)
        with self._lock:
            return self._snapshot(self._jobs.get(self._latest_by_service.get(clean, '')))

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._snapshot(self._jobs.get(str(job_id or '').strip()))

    def _service_states(self) -> dict[str, str]:
        try:
            payload = self._ops.request('GET', '/v1/services', timeout=8.0)
        except Exception as exc:  # noqa: BLE001
            raise ModelLoadRejected(
                f'无法确认容器状态：{exc}',
                status_code=503,
                code='service_management_unavailable',
            ) from exc
        services = payload.get('services') if isinstance(payload, dict) else None
        if not isinstance(services, list):
            raise ModelLoadRejected(
                '无法确认容器状态：ops-api 返回结构无效',
                status_code=503,
                code='service_management_unavailable',
            )
        return {
            str(item.get('service') or ''): str(item.get('status') or 'unknown')
            for item in services
            if isinstance(item, dict)
        }

    def _model_state(self, service: str) -> tuple[bool, bool, dict[str, Any]]:
        if service == 'sam3-api':
            data = self._sam3.health(self._sam3_api_base_url())
            state = str(data.get('model_state') or data.get('status') or '').lower()
            return bool(data.get('model_loaded')), state == 'loading', data
        if service == 'locate-anything-api':
            data = self._locate.health(self._locate_api_base_url())
            state = str(data.get('model_state') or data.get('status') or '').lower()
            return bool(data.get('model_loaded')), state == 'loading', data
        data = self._sapiens.request('GET', '/v1/pose/status', timeout=8.0)
        state = str(data.get('state') or '').lower()
        return bool(data.get('model_loaded')), state == 'loading', data

    @staticmethod
    def _explicit_load_error(data: dict[str, Any]) -> BaseException | None:
        last_error = str(data.get('last_load_error') or '').strip()
        if data.get('checkpoint_available') is False:
            checkpoint_path = str(data.get('checkpoint_path') or 'model checkpoint')
            return RuntimeError(f'checkpoint not found: {checkpoint_path}')
        checkpoint = data.get('checkpoint')
        if isinstance(checkpoint, dict):
            checkpoint_missing = checkpoint.get('checkpoint_exists') is False
            detector_missing = checkpoint.get('detector_exists') is False
            if checkpoint_missing or detector_missing:
                missing: list[str] = []
                if checkpoint_missing:
                    missing.append(str(checkpoint.get('checkpoint_path') or 'pose checkpoint'))
                if detector_missing:
                    missing.append(str(checkpoint.get('detector_path') or 'pose detector'))
                return RuntimeError(f'checkpoint not found: {", ".join(missing)}')
        if data.get('weights_missing'):
            return RuntimeError(last_error or 'weights missing')
        if str(data.get('status') or '').lower() == 'load_failed' and last_error:
            return RuntimeError(last_error)
        return None

    def _assert_target_ready(self, service: str) -> None:
        try:
            _loaded, _loading, data = self._model_state(service)
        except Exception as exc:  # noqa: BLE001
            normalized = normalize_model_load_error(exc)
            raise ModelLoadRejected(
                normalized['message'],
                status_code=503,
                code=normalized['code'],
            ) from exc
        error = self._explicit_load_error(data)
        if error is not None:
            normalized = normalize_model_load_error(error)
            raise ModelLoadRejected(normalized['message'], code=normalized['code'])

    def _assert_no_gpu_conflict(self, service: str, service_states: dict[str, str]) -> None:
        if not self._gpu_deployment:
            return
        gpu_id = self._gpu_devices.get(service, '')
        if not gpu_id:
            return
        reserved_by = self._gpu_reservations.get(gpu_id)
        if reserved_by and reserved_by != service:
            raise ModelLoadRejected(
                f'GPU {gpu_id} 正在由 {reserved_by} 加载模型，请先停止 {reserved_by} 服务',
                code='gpu_conflict',
            )
        for other in sorted(SUPPORTED_SERVICES):
            if other == service or self._gpu_devices.get(other, '') != gpu_id:
                continue
            if service_states.get(other) != 'running':
                continue
            try:
                loaded, loading, _data = self._model_state(other)
            except Exception:
                continue
            if loaded or loading:
                phase = '已加载' if loaded else '正在加载'
                raise ModelLoadRejected(
                    f'GPU {gpu_id} 上的 {other} 模型{phase}，请先停止 {other} 服务',
                    code='gpu_conflict',
                )

    def start(self, service: str) -> tuple[dict[str, Any], bool]:
        clean = self._clean_service(service)
        with self._lock:
            active = self._jobs.get(self._latest_by_service.get(clean, ''))
            if active and active.get('status') in ACTIVE_STATUSES:
                return self._snapshot(active) or {}, False
            if not self._example_image.is_file():
                raise ModelLoadRejected(
                    f'预热示例图不存在：{self._example_image}',
                    status_code=500,
                    code='example_image_missing',
                )
            service_states = self._service_states()
            if service_states.get(clean) != 'running':
                raise ModelLoadRejected(
                    f'{clean} 容器未运行，请先启动服务',
                    code='service_not_running',
                )
            self._assert_target_ready(clean)
            self._assert_no_gpu_conflict(clean, service_states)

            job_id = f'model_load_{uuid.uuid4().hex[:16]}'
            now = time.time()
            job = {
                'job_id': job_id,
                'service': clean,
                'status': 'queued',
                'created_at': now,
                'updated_at': now,
                'started_at': None,
                'finished_at': None,
                'summary': None,
                'error': None,
            }
            self._jobs[job_id] = job
            self._latest_by_service[clean] = job_id
            gpu_id = self._gpu_devices.get(clean, '') if self._gpu_deployment else ''
            if gpu_id:
                self._gpu_reservations[gpu_id] = clean
            try:
                thread = threading.Thread(
                    target=self._run,
                    args=(job_id, gpu_id),
                    daemon=True,
                    name=f'model-load-{clean}',
                )
                thread.start()
            except Exception:
                self._jobs.pop(job_id, None)
                self._latest_by_service.pop(clean, None)
                if gpu_id and self._gpu_reservations.get(gpu_id) == clean:
                    self._gpu_reservations.pop(gpu_id, None)
                raise
            return self._snapshot(job) or {}, True

    def _run_inference(self, service: str) -> int:
        image_path = str(self._example_image)
        if service == 'sam3-api':
            result = self._sam3.infer(
                api_base_url=self._sam3_api_base_url(),
                image_path=image_path,
                mode='text',
                prompt='person',
                threshold=0.25,
                include_mask_png=False,
                max_detections=50,
            )
            if not isinstance(result, dict) or not isinstance(result.get('detections'), list):
                raise ValueError('SAM3 inference response is missing detections')
            return int(result.get('num_detections', len(result['detections'])))
        if service == 'locate-anything-api':
            result = self._locate.infer(
                api_base_url=self._locate_api_base_url(),
                image_path=image_path,
                mode='text',
                prompt='person',
                include_mask_png=False,
                max_detections=50,
            )
            if not isinstance(result, dict) or not isinstance(result.get('detections'), list):
                raise ValueError('LocateAnything inference response is missing detections')
            return int(result.get('num_detections', len(result['detections'])))
        result = self._sapiens.file_request(
            '/v1/pose/infer',
            file_path=self._example_image,
            fields={
                'bbox_threshold': 0.3,
                'nms_threshold': 0.3,
                'keypoint_threshold': 0.3,
            },
            timeout=600.0,
        )
        if not isinstance(result, dict) or not isinstance(result.get('instances'), list):
            raise ValueError('Sapiens pose inference response is missing instances')
        return len(result['instances'])

    def _run(self, job_id: str, gpu_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            started = time.time()
            job.update(status='running', started_at=started, updated_at=started)
            service = str(job['service'])
        try:
            count = self._run_inference(service)
            finished = time.time()
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    job.update(
                        status='completed',
                        finished_at=finished,
                        updated_at=finished,
                        summary={
                            'duration_ms': round((finished - started) * 1000.0, 2),
                            'detection_count': int(count),
                        },
                    )
        except Exception as exc:  # noqa: BLE001
            finished = time.time()
            with self._lock:
                job = self._jobs.get(job_id)
                if job:
                    job.update(
                        status='failed',
                        finished_at=finished,
                        updated_at=finished,
                        error=normalize_model_load_error(exc),
                    )
        finally:
            with self._lock:
                if gpu_id and self._gpu_reservations.get(gpu_id) == service:
                    self._gpu_reservations.pop(gpu_id, None)
