from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import json
import requests


class Sam3ApiError(RuntimeError):
    def __init__(self, status_code: int, detail: Any):
        self.status_code = int(status_code)
        self.detail = detail
        super().__init__(f'API HTTP error {self.status_code}: {detail}')


class Sam3Client:
    def __init__(self, timeout_sec: float = 120.0):
        self.timeout_sec = timeout_sec

    @staticmethod
    def _normalize_api_root(base_url: str) -> str:
        url = str(base_url or '').strip()
        if not url:
            raise ValueError('api_base_url is required')
        if not url.startswith(('http://', 'https://')):
            raise ValueError('api_base_url must start with http:// or https://')
        url = url.rstrip('/')
        if url.lower().endswith('/v1/infer'):
            return url[:-len('/v1/infer')]
        if url.lower().endswith('/health'):
            return url[:-len('/health')]
        return url

    @staticmethod
    def _api_root(base_url: str) -> str:
        root = Sam3Client._normalize_api_root(base_url)
        raw_allowed = os.getenv(
            'WEB_AUTO_ALLOWED_SAM3_API_BASE_URLS',
            os.getenv('WEB_AUTO_DEFAULT_SAM3_API_BASE_URL', 'http://127.0.0.1:8001'),
        )
        allowed_roots = {
            Sam3Client._normalize_api_root(item)
            for item in str(raw_allowed or '').split(',')
            if str(item or '').strip()
        }
        if allowed_roots and root not in allowed_roots:
            allowed_text = ', '.join(sorted(allowed_roots))
            raise ValueError(f'api_base_url is not allowed: {root}; allowed: {allowed_text}')
        return root

    @staticmethod
    def _auth_headers() -> dict[str, str]:
        token = os.getenv('WEB_AUTO_SAM3_API_TOKEN', '').strip()
        if not token:
            return {}
        return {'Authorization': f'Bearer {token}'}

    @staticmethod
    def _infer_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/infer'

    @staticmethod
    def _health_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/health'

    def _get_json(self, url: str, timeout: float | None = None) -> dict[str, Any]:
        resp = requests.get(url, headers=self._auth_headers(), timeout=timeout or max(self.timeout_sec, 1.0))
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise Sam3ApiError(resp.status_code, err or data)
        return data if isinstance(data, dict) else {}

    def _post_json(self, url: str, payload: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        resp = requests.post(
            url,
            json=payload,
            headers=self._auth_headers(),
            timeout=timeout or max(self.timeout_sec, 1.0),
        )
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise Sam3ApiError(resp.status_code, err or data)
        return data if isinstance(data, dict) else {}

    def health(self, base_url: str) -> dict[str, Any]:
        url = self._health_url(base_url)
        return self._get_json(url, timeout=10)

    def infer(
        self,
        *,
        api_base_url: str,
        image_path: str,
        mode: str,
        prompt: str,
        threshold: float,
        points: list[list[float | int]] | None = None,
        boxes: list[list[float | int]] | None = None,
        point_box_size: float | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        infer_url = self._infer_url(api_base_url)
        image_file = Path(image_path)
        if not image_file.exists() or not image_file.is_file():
            raise ValueError(f'image does not exist: {image_file}')

        payload: dict[str, str] = {
            'mode': str(mode).strip().lower(),
            'threshold': str(float(threshold)),
            'include_mask_png': 'true' if include_mask_png else 'false',
            'max_detections': str(int(max_detections)),
        }
        payload['contour_mode'] = 'merged'
        if prompt:
            payload['prompt'] = prompt

        if payload['mode'] == 'points':
            payload['points'] = json.dumps(points or [])
            if point_box_size is not None:
                payload['point_box_size'] = str(float(point_box_size))
        elif payload['mode'] == 'boxes':
            payload['boxes'] = json.dumps(boxes or [])

        with image_file.open('rb') as f:
            files = {'file': (image_file.name, f, 'application/octet-stream')}
            resp = requests.post(
                infer_url,
                data=payload,
                files=files,
                headers=self._auth_headers(),
                timeout=max(self.timeout_sec, 1.0),
            )

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')

        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise Sam3ApiError(resp.status_code, err or data)

        return data


    def infer_batch(
        self,
        *,
        api_base_url: str,
        image_paths: list[str],
        mode: str,
        prompt: str,
        threshold: float,
        points: list[list[float | int]] | None = None,
        boxes: list[list[float | int]] | None = None,
        point_box_size: float | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
        save_ai_features: bool = False,
        feature_root: str = '',
    ) -> dict[str, Any]:
        infer_url = self._api_root(api_base_url) + '/v1/infer_batch'
        clean_paths = [Path(p) for p in (image_paths or []) if str(p).strip()]
        if not clean_paths:
            raise ValueError('image_paths must not be empty')
        for item in clean_paths:
            if not item.exists() or not item.is_file():
                raise ValueError(f'image does not exist: {item}')

        payload: dict[str, str] = {
            'mode': str(mode).strip().lower(),
            'threshold': str(float(threshold)),
            'include_mask_png': 'true' if include_mask_png else 'false',
            'max_detections': str(int(max_detections)),
        }
        payload['contour_mode'] = 'merged'
        payload['save_ai_features'] = 'true' if save_ai_features else 'false'
        if save_ai_features:
            payload['feature_root'] = str(feature_root or '')
        if prompt:
            payload['prompt'] = prompt
        if payload['mode'] == 'points':
            payload['points'] = json.dumps(points or [])
            if point_box_size is not None:
                payload['point_box_size'] = str(float(point_box_size))
        elif payload['mode'] == 'boxes':
            payload['boxes'] = json.dumps(boxes or [])

        handles = []
        try:
            files: list[tuple[str, tuple[str, Any, str]]] = []
            for item in clean_paths:
                handles.append(item.open('rb'))
                files.append(('files', (item.name, handles[-1], 'application/octet-stream')))
            resp = requests.post(
                infer_url,
                data=payload,
                files=files,
                headers=self._auth_headers(),
                timeout=max(self.timeout_sec * 4.0, 120.0),
            )
        finally:
            for handle in handles:
                try:
                    handle.close()
                except Exception:
                    pass

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')

        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise Sam3ApiError(resp.status_code, err or data)

        return data if isinstance(data, dict) else {}

    def wait_feature_writes(
        self,
        *,
        api_base_url: str,
        write_ids: list[str],
    ) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/features/writes/wait',
            {'write_ids': [str(item) for item in write_ids if str(item).strip()]},
            timeout=max(self.timeout_sec * 4.0, 120.0),
        )

    def open_interactive_session(
        self,
        *,
        api_base_url: str,
        image_path: str,
        project_id: str,
        image_id: str,
        feature_root: str,
        session_id: str = '',
        initial_polygons: list | None = None,
        keep_session: bool = True,
        persist_feature: bool = False,
    ) -> dict[str, Any]:
        url = self._api_root(api_base_url) + '/v1/interactive/session/open'
        image_file = Path(image_path)
        payload = {
            'project_id': project_id,
            'image_id': image_id,
            'feature_root': feature_root,
            'session_id': session_id,
            'initial_polygons': json.dumps(initial_polygons or []),
            'keep_session': 'true' if keep_session else 'false',
            'persist_feature': 'true' if persist_feature else 'false',
        }
        with image_file.open('rb') as handle:
            resp = requests.post(
                url,
                data=payload,
                files={'file': (image_file.name, handle, 'application/octet-stream')},
                headers=self._auth_headers(),
                timeout=max(self.timeout_sec * 2.0, 240.0),
            )
        return self._response_json(resp)

    def interactive_predict(self, api_base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post_json(self._api_root(api_base_url) + '/v1/interactive/predict', payload)

    def interactive_reset(self, api_base_url: str, session_id: str) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/interactive/reset', {'session_id': session_id}
        )

    def interactive_prompt_undo(self, api_base_url: str, session_id: str) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/interactive/prompts/undo',
            {'session_id': session_id},
        )

    def interactive_prompt_redo(self, api_base_url: str, session_id: str) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/interactive/prompts/redo',
            {'session_id': session_id},
        )

    def interactive_close(self, api_base_url: str, session_id: str) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/interactive/close', {'session_id': session_id}
        )

    def interactive_clear_project(self, api_base_url: str, project_id: str) -> dict[str, Any]:
        return self._post_json(
            self._api_root(api_base_url) + '/v1/interactive/project/clear', {'project_id': project_id}
        )

    @staticmethod
    def _response_json(resp: requests.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise Sam3ApiError(resp.status_code, err or data)
        return data if isinstance(data, dict) else {}
