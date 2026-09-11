from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

from PIL import Image
from fastapi import FastAPI


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.services.model_load_jobs import ModelLoadJobManager, ModelLoadRejected  # noqa: E402
from app.routers.services import create_services_router  # noqa: E402


class FakeOps:
    def __init__(self) -> None:
        self.states = {
            'sam3-api': 'running',
            'locate-anything-api': 'running',
            'sapiens-api': 'running',
        }

    def request(self, method: str, path: str, timeout: float = 0) -> dict[str, Any]:
        del method, timeout
        if path != '/v1/services':
            raise AssertionError(path)
        return {'services': [
            {'service': service, 'status': status}
            for service, status in self.states.items()
        ]}


class FakeSam3:
    def __init__(self) -> None:
        self.health_data: dict[str, Any] = {
            'status': 'not_loaded',
            'model_state': 'not_loaded',
            'model_loaded': False,
        }
        self.infer_result: dict[str, Any] | BaseException = {
            'num_detections': 2,
            'detections': [{}, {}],
        }
        self.infer_kwargs: dict[str, Any] | None = None
        self.entered = threading.Event()
        self.release: threading.Event | None = None

    def health(self, base_url: str) -> dict[str, Any]:
        del base_url
        return dict(self.health_data)

    def infer(self, **kwargs: Any) -> dict[str, Any]:
        self.infer_kwargs = kwargs
        self.entered.set()
        if self.release:
            self.release.wait(timeout=3)
        if isinstance(self.infer_result, BaseException):
            raise self.infer_result
        return dict(self.infer_result)


class FakeLocate:
    def __init__(self) -> None:
        self.health_data: dict[str, Any] = {
            'status': 'not_loaded',
            'model_state': 'not_loaded',
            'model_loaded': False,
        }
        self.infer_kwargs: dict[str, Any] | None = None

    def health(self, base_url: str) -> dict[str, Any]:
        del base_url
        return dict(self.health_data)

    def infer(self, **kwargs: Any) -> dict[str, Any]:
        self.infer_kwargs = kwargs
        return {'num_detections': 1, 'detections': [{}]}


class FakeSapiens:
    def __init__(self) -> None:
        self.status_data: dict[str, Any] = {
            'state': 'not_loaded',
            'model_loaded': False,
            'weights_missing': False,
        }
        self.file_path: str = ''
        self.file_fields: dict[str, Any] | None = None

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 0,
    ) -> dict[str, Any]:
        del method, payload, timeout
        if path != '/v1/pose/status':
            raise AssertionError(path)
        return dict(self.status_data)

    def file_request(
        self,
        path: str,
        *,
        file_path: Path,
        fields: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        del timeout
        self.file_path = path
        self.file_fields = fields
        return {'instances': [{}, {}, {}]}


def wait_terminal(manager: ModelLoadJobManager, job_id: str) -> dict[str, Any]:
    deadline = time.time() + 3
    while time.time() < deadline:
        job = manager.get(job_id) or {}
        if job.get('status') in {'completed', 'failed'}:
            return job
        time.sleep(0.01)
    raise AssertionError(f'job did not finish: {manager.get(job_id)}')


class ModelLoadJobManagerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.image = Path(self.tmp.name) / 'warmup.jpg'
        Image.new('RGB', (32, 24), (30, 90, 140)).save(self.image)
        self.sam3 = FakeSam3()
        self.locate = FakeLocate()
        self.sapiens = FakeSapiens()
        self.ops = FakeOps()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def manager(
        self,
        *,
        image: Path | None = None,
        gpu: bool = False,
        devices: dict[str, str] | None = None,
    ) -> ModelLoadJobManager:
        return ModelLoadJobManager(
            sam3=self.sam3,  # type: ignore[arg-type]
            locate=self.locate,  # type: ignore[arg-type]
            sapiens=self.sapiens,  # type: ignore[arg-type]
            ops=self.ops,  # type: ignore[arg-type]
            example_image=image or self.image,
            sam3_api_base_url=lambda: 'http://sam3-api:8001',
            locate_api_base_url=lambda: 'http://locate-anything-api:8004',
            gpu_deployment=gpu,
            gpu_devices=devices,
        )

    def test_each_service_runs_the_required_real_inference(self) -> None:
        manager = self.manager()
        for service, expected_count in (
            ('sam3-api', 2),
            ('locate-anything-api', 1),
            ('sapiens-api', 3),
        ):
            job, created = manager.start(service)
            self.assertTrue(created)
            finished = wait_terminal(manager, job['job_id'])
            self.assertEqual(finished['status'], 'completed')
            self.assertEqual(finished['summary']['detection_count'], expected_count)
            self.assertNotIn('result', finished)

        self.assertEqual(self.sam3.infer_kwargs['prompt'], 'person')  # type: ignore[index]
        self.assertFalse(self.sam3.infer_kwargs['include_mask_png'])  # type: ignore[index]
        self.assertEqual(self.locate.infer_kwargs['prompt'], 'person')  # type: ignore[index]
        self.assertEqual(self.sapiens.file_path, '/v1/pose/infer')
        self.assertEqual(self.sapiens.file_fields['bbox_threshold'], 0.3)  # type: ignore[index]

    def test_missing_example_and_stopped_container_are_rejected(self) -> None:
        with self.assertRaisesRegex(ModelLoadRejected, '示例图不存在'):
            self.manager(image=Path(self.tmp.name) / 'missing.jpg').start('sam3-api')
        self.ops.states['sam3-api'] = 'exited'
        with self.assertRaisesRegex(ModelLoadRejected, '容器未运行'):
            self.manager().start('sam3-api')

    def test_duplicate_click_returns_the_same_active_job(self) -> None:
        self.sam3.release = threading.Event()
        manager = self.manager()
        first, first_created = manager.start('sam3-api')
        self.assertTrue(self.sam3.entered.wait(timeout=1))
        second, second_created = manager.start('sam3-api')
        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(second['job_id'], first['job_id'])
        self.sam3.release.set()
        self.assertEqual(wait_terminal(manager, first['job_id'])['status'], 'completed')

    def test_loaded_and_active_same_gpu_services_are_rejected_atomically(self) -> None:
        devices = {'sam3-api': '0', 'sapiens-api': '0', 'locate-anything-api': '2'}
        self.sapiens.status_data.update(state='loaded', model_loaded=True)
        with self.assertRaisesRegex(ModelLoadRejected, '请先停止 sapiens-api'):
            self.manager(gpu=True, devices=devices).start('sam3-api')

        self.sapiens.status_data.update(state='loading', model_loaded=False)
        with self.assertRaisesRegex(ModelLoadRejected, '正在加载'):
            self.manager(gpu=True, devices=devices).start('sam3-api')

        self.sapiens.status_data.update(state='not_loaded', model_loaded=False)
        self.sam3.release = threading.Event()
        manager = self.manager(gpu=True, devices=devices)
        sam_job, _ = manager.start('sam3-api')
        self.assertTrue(self.sam3.entered.wait(timeout=1))
        with self.assertRaisesRegex(ModelLoadRejected, '正在由 sam3-api 加载'):
            manager.start('sapiens-api')
        self.sam3.release.set()
        wait_terminal(manager, sam_job['job_id'])

    def test_cpu_mode_does_not_apply_gpu_mutex(self) -> None:
        self.sapiens.status_data.update(state='loaded', model_loaded=True)
        manager = self.manager(
            gpu=False,
            devices={'sam3-api': '0', 'sapiens-api': '0'},
        )
        job, _ = manager.start('sam3-api')
        self.assertEqual(wait_terminal(manager, job['job_id'])['status'], 'completed')

    def test_weights_missing_is_rejected_before_start(self) -> None:
        self.sam3.health_data.update(
            checkpoint_available=False,
            checkpoint_path='/models/sam3.pt',
        )
        with self.assertRaises(ModelLoadRejected) as sam_caught:
            self.manager().start('sam3-api')
        self.assertEqual(sam_caught.exception.code, 'weights_missing')

        self.sam3.health_data.pop('checkpoint_available')
        self.sapiens.status_data.update(
            weights_missing=True,
            last_load_error='checkpoint not found: pose.safetensors',
        )
        with self.assertRaises(ModelLoadRejected) as caught:
            self.manager().start('sapiens-api')
        self.assertEqual(caught.exception.code, 'weights_missing')

    def test_auth_timeout_and_cuda_oom_are_normalized(self) -> None:
        cases = (
            (RuntimeError('API HTTP error 401: invalid token'), 'authentication_failed'),
            (TimeoutError('request timed out after 10 seconds'), 'timeout'),
            (RuntimeError('CUDA out of memory'), 'cuda_oom'),
            (RuntimeError('model service request failed: connection refused'), 'service_unavailable'),
        )
        for error, code in cases:
            self.sam3.infer_result = error
            manager = self.manager()
            job, _ = manager.start('sam3-api')
            finished = wait_terminal(manager, job['job_id'])
            self.assertEqual(finished['status'], 'failed')
            self.assertEqual(finished['error']['code'], code)

    def test_invalid_response_fails_and_a_completed_job_can_be_repeated(self) -> None:
        self.sam3.infer_result = {'unexpected': []}
        manager = self.manager()
        first, _ = manager.start('sam3-api')
        failed = wait_terminal(manager, first['job_id'])
        self.assertEqual(failed['error']['code'], 'invalid_response')

        self.sam3.infer_result = {'num_detections': 0, 'detections': []}
        second, created = manager.start('sam3-api')
        self.assertTrue(created)
        self.assertNotEqual(first['job_id'], second['job_id'])
        self.assertEqual(wait_terminal(manager, second['job_id'])['status'], 'completed')

    def test_repository_warmup_image_is_decodable(self) -> None:
        with Image.open(ROOT / 'example' / 'model_warmup.jpg') as image:
            image.verify()


class FakeRouterManager:
    job = {'job_id': 'route-job', 'service': 'sam3-api', 'status': 'queued'}

    def start(self, service: str) -> tuple[dict[str, Any], bool]:
        return {**self.job, 'service': service}, True

    def latest(self, service: str) -> dict[str, Any]:
        return {**self.job, 'service': service}

    def get(self, job_id: str) -> dict[str, Any] | None:
        return self.job if job_id == self.job['job_id'] else None


class ModelLoadJobRouterTest(unittest.TestCase):
    def test_model_load_routes_are_not_captured_by_generic_service_control(self) -> None:
        app = FastAPI()
        app.include_router(create_services_router(
            sam3=object(),  # type: ignore[arg-type]
            locate=object(),  # type: ignore[arg-type]
            ops_client=object(),  # type: ignore[arg-type]
            sapiens_client=object(),  # type: ignore[arg-type]
            default_sam3_api_base_url='http://sam3',
            effective_sam3_api_base_url=lambda: 'http://sam3',
            default_locate_api_base_url='http://locate',
            default_sapiens_api_base_url='http://sapiens',
            model_load_jobs=FakeRouterManager(),  # type: ignore[arg-type]
        ))
        paths = [getattr(route, 'path', '') for route in app.routes]
        start_path = '/api/services/{service}/model-load-jobs'
        generic_path = '/api/services/{service}/{action}'
        self.assertIn(start_path, paths)
        self.assertLess(paths.index(start_path), paths.index(generic_path))

        routes = {getattr(route, 'path', ''): route for route in app.routes}
        start_route = routes[start_path]
        self.assertEqual(start_route.status_code, 202)
        started = start_route.endpoint('sam3-api')
        self.assertEqual(started['job_id'], 'route-job')
        latest = routes['/api/services/{service}/model-load-jobs/latest'].endpoint('sam3-api')
        self.assertEqual(latest['job']['status'], 'queued')
        detail = routes['/api/services/model-load-jobs/{job_id}'].endpoint('route-job')
        self.assertEqual(detail['job']['job_id'], 'route-job')


if __name__ == '__main__':
    unittest.main()
