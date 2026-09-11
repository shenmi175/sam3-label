from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ops_api_test_main', ROOT / 'ops-api' / 'app' / 'main.py')
assert SPEC and SPEC.loader
ops_main = importlib.util.module_from_spec(SPEC)
docker_stub = types.ModuleType('docker')
docker_stub.from_env = lambda: None  # type: ignore[attr-defined]
docker_errors_stub = types.ModuleType('docker.errors')
docker_errors_stub.DockerException = type('DockerException', (Exception,), {})
docker_errors_stub.NotFound = type('NotFound', (Exception,), {})
docker_types_stub = types.ModuleType('docker.types')
docker_types_stub.DeviceRequest = type('DeviceRequest', (), {'__init__': lambda self, **kwargs: None})
docker_types_stub.LogConfig = type('LogConfig', (), {
    'types': type('LogTypes', (), {'JSON': 'json-file'}),
    '__init__': lambda self, **kwargs: None,
})
with patch.dict(sys.modules, {
    'docker': docker_stub,
    'docker.errors': docker_errors_stub,
    'docker.types': docker_types_stub,
}):
    SPEC.loader.exec_module(ops_main)


class FakeImage:
    tags = ['fake:latest']
    short_id = 'sha256:fake'


class FakeContainer:
    def __init__(self, name: str, service: str) -> None:
        self.name = name
        self.short_id = 'abc123'
        self.status = 'running'
        self.image = FakeImage()
        self.attrs = {
            'Config': {'Labels': {'com.docker.compose.service': service}},
            'State': {'Health': {'Status': 'healthy'}},
            'Created': '2026-01-01T00:00:00Z',
            'NetworkSettings': {'Ports': {}},
        }

    def reload(self) -> None:
        return None

    def logs(self, **_kwargs):
        return [b'line one\n', b'line two\n']


class FakeContainers:
    def list(self, *, all: bool, filters):  # noqa: A002
        del all
        labels = filters['label']
        service = next(item.rsplit('=', 1)[-1] for item in labels if '.service=' in item)
        if service == 'missing-service':
            return []
        return [FakeContainer(f'unsafe/{service}', service)]


class FakeClient:
    containers = FakeContainers()


class LogDownloadTest(unittest.TestCase):
    def test_ops_created_service_gets_compose_dns_alias(self) -> None:
        network_name = 'sam3-auto-label_default'

        class Container:
            name = 'sam3-auto-label-sapiens-api-1'
            attrs = {
                'NetworkSettings': {
                    'Networks': {network_name: {'Aliases': None}},
                },
            }

            def reload(self) -> None:
                return None

        class Network:
            disconnected = False
            aliases: list[str] = []

            def disconnect(self, container, force: bool = False) -> None:
                del container
                self.disconnected = force

            def connect(self, container, aliases) -> None:
                del container
                self.aliases = list(aliases)

        network = Network()
        client = types.SimpleNamespace(
            networks=types.SimpleNamespace(get=lambda name: network if name == network_name else None),
        )
        ops_main._ensure_service_network_alias(
            client,
            Container(),
            network_name,
            'sapiens-api',
        )
        self.assertTrue(network.disconnected)
        self.assertIn('sapiens-api', network.aliases)

    def test_archive_contains_manifest_audit_legacy_and_degraded_services(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            root = Path(tmp_text)
            shared = root / 'shared'
            scratch = root / 'scratch'
            shared.mkdir()
            (shared / 'events.jsonl').write_text('{"event":1}\n', encoding='utf-8')
            (shared / 'events.jsonl.1').write_text('{"event":0}\n', encoding='utf-8')
            (shared / 'web-auto.log').write_text('legacy\n', encoding='utf-8')
            (shared / 'events.jsonl.lock').write_text('lock', encoding='utf-8')

            with (
                patch.object(ops_main, 'OPS_SHARED_LOG_DIR', shared),
                patch.object(ops_main, 'OPS_LOG_TMP_DIR', scratch),
                patch.object(ops_main, 'LOGGABLE_SERVICES', {'web-auto', 'missing-service'}),
                patch.object(ops_main, '_client', return_value=FakeClient()),
            ):
                archive_path, filename = ops_main._build_logs_archive()

            self.assertRegex(filename, r'^sam3-logs-\d{8}-\d{6}\.zip$')
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())
                self.assertIn('manifest.json', names)
                self.assertIn('audit/events.jsonl', names)
                self.assertIn('audit/events.jsonl.1', names)
                self.assertIn('legacy/web-auto.log', names)
                self.assertNotIn('audit/events.jsonl.lock', names)
                service_logs = [name for name in names if name.startswith('services/')]
                self.assertEqual(len(service_logs), 1)
                self.assertNotIn('/', Path(service_logs[0]).name.replace('services/', ''))
                manifest = json.loads(archive.read('manifest.json'))
                self.assertIn('services/missing-service', manifest['missing'])
                self.assertEqual(manifest['services'][0]['service'], 'missing-service')
            archive_path.unlink()

    def test_stream_response_deletes_temporary_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            archive_path = Path(tmp_text) / 'temporary.zip'
            archive_path.write_bytes(b'zip payload')
            body = b''.join(ops_main._stream_archive_and_delete(archive_path))
            self.assertEqual(body, b'zip payload')
            self.assertFalse(archive_path.exists())


if __name__ == '__main__':
    unittest.main()
