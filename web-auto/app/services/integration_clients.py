from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Optional

import requests


class OpsClient:
    def __init__(self, base_url: str, token: str = ''):
        self.base_url = str(base_url or '').strip().rstrip('/')
        self.token = str(token or '').strip()

    def headers(self) -> dict[str, str]:
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        return headers

    def request(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]] = None,
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError('ops-api is not configured')
        url = self.base_url + '/' + path.lstrip('/')
        try:
            response = requests.request(
                method.upper(),
                url,
                json=payload,
                headers=self.headers(),
                timeout=timeout,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f'ops-api request failed: {exc}') from exc
        try:
            data = response.json() if response.text else {}
        except Exception:
            data = {'raw': response.text[:400]}
        if not response.ok:
            detail = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'ops-api HTTP {response.status_code}: {detail or data}')
        return data if isinstance(data, dict) else {}


class SapiensClient:
    def __init__(self, base_url: str, token: str = ''):
        self.base_url = str(base_url or '').strip().rstrip('/')
        self.token = str(token or '').strip()

    def headers(self) -> dict[str, str]:
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        return headers

    def request(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]] = None,
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        url = self.base_url + '/' + path.lstrip('/')
        try:
            response = requests.request(
                method.upper(),
                url,
                json=payload,
                headers=self.headers(),
                timeout=timeout,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f'sapiens-api request failed: {exc}') from exc
        try:
            data = response.json() if response.text else {}
        except Exception:
            data = {'raw': response.text[:400]}
        if not response.ok:
            detail = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'sapiens-api HTTP {response.status_code}: {detail or data}')
        return data if isinstance(data, dict) else {}

    def file_request(
        self,
        path: str,
        *,
        file_path: Path,
        fields: Optional[dict[str, Any]] = None,
        timeout: float = 300.0,
    ) -> dict[str, Any]:
        url = self.base_url + '/' + path.lstrip('/')
        try:
            with file_path.open('rb') as f:
                response = requests.post(
                    url,
                    files={
                        'file': (
                            file_path.name,
                            f,
                            mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream',
                        )
                    },
                    data={key: str(value) for key, value in (fields or {}).items()},
                    headers=self.headers(),
                    timeout=timeout,
                )
        except requests.RequestException as exc:
            raise RuntimeError(f'sapiens-api request failed: {exc}') from exc
        try:
            data = response.json() if response.text else {}
        except Exception:
            data = {'raw': response.text[:400]}
        if not response.ok:
            detail = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'sapiens-api HTTP {response.status_code}: {detail or data}')
        return data if isinstance(data, dict) else {}


def service_management_unavailable(error: str) -> dict[str, Any]:
    return {
        'ok': False,
        'ops_available': False,
        'error': error,
        'services': [
            {'service': 'sam3-api', 'status': 'unknown', 'manage_command': './deploy.sh services restart sam3-api'},
            {'service': 'locate-anything-api', 'status': 'unknown', 'manage_command': './deploy.sh services restart locate-anything-api'},
            {'service': 'sapiens-api', 'status': 'unknown', 'manage_command': './deploy.sh sapiens enable'},
            {'service': 'caddy', 'status': 'unknown', 'manage_command': './deploy.sh install --proxy'},
        ],
    }
