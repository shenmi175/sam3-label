from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import json
import requests


class LocateAnythingClient:
    """HTTP client for the locate-anything-api service.

    Wire-compatible with ``Sam3Client.infer`` / ``infer_batch``:
    same multipart shape, same response JSON layout. Differences:

    * only ``mode='text'`` is honored
    * ``include_mask_png`` is forced to ``false`` (the service never returns masks)
    * no confidence scores — LocateAnything-3B is a generative VLM
    """

    def __init__(self, timeout_sec: float = 240.0):
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
        root = LocateAnythingClient._normalize_api_root(base_url)
        raw_allowed = os.getenv(
            'WEB_AUTO_ALLOWED_LOCATE_API_BASE_URLS',
            os.getenv('WEB_AUTO_DEFAULT_LOCATE_API_BASE_URL', 'http://127.0.0.1:8004'),
        )
        allowed_roots = {
            LocateAnythingClient._normalize_api_root(item)
            for item in str(raw_allowed or '').split(',')
            if str(item or '').strip()
        }
        if allowed_roots and root not in allowed_roots:
            allowed_text = ', '.join(sorted(allowed_roots))
            raise ValueError(f'api_base_url is not allowed: {root}; allowed: {allowed_text}')
        return root

    @staticmethod
    def _auth_headers() -> dict[str, str]:
        token = os.getenv('WEB_AUTO_LOCATE_API_TOKEN', '').strip()
        if not token:
            return {}
        return {'Authorization': f'Bearer {token}'}

    def health(self, base_url: str) -> dict[str, Any]:
        url = self._api_root(base_url) + '/health'
        resp = requests.get(url, headers=self._auth_headers(), timeout=10)
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')
        return data if isinstance(data, dict) else {}

    def unload(self, base_url: str) -> dict[str, Any]:
        """Release VRAM held by the LocateAnything model. Used by the OOM-avoidance flow."""
        url = self._api_root(base_url) + '/v1/unload'
        resp = requests.post(url, headers=self._auth_headers(), timeout=20)
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')
        return data if isinstance(data, dict) else {}

    def infer(
        self,
        *,
        api_base_url: str,
        image_path: str,
        mode: str,
        prompt: str,
        points: list[list[float | int]] | None = None,
        boxes: list[list[float | int]] | None = None,
        point_box_size: float | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        mode_norm = str(mode or 'text').strip().lower()
        if mode_norm != 'text':
            raise ValueError('LocateAnything supports mode=text only')
        del points, boxes, point_box_size, include_mask_png  # not honored by this backend

        infer_url = self._api_root(api_base_url) + '/v1/infer'
        image_file = Path(image_path)
        if not image_file.exists() or not image_file.is_file():
            raise ValueError(f'image does not exist: {image_file}')

        payload: dict[str, str] = {
            'mode': 'text',
            'include_mask_png': 'false',
            'max_detections': str(int(max_detections)),
        }
        if prompt:
            payload['prompt'] = prompt

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
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')

        return data

    def infer_batch(
        self,
        *,
        api_base_url: str,
        image_paths: list[str],
        mode: str,
        prompt: str,
        points: list[list[float | int]] | None = None,
        boxes: list[list[float | int]] | None = None,
        point_box_size: float | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        """Loop sequentially over images with the single-image endpoint.

        The locate-anything service does not expose a dedicated batch
        route; ``batch_size`` semantics are handled by the caller
        (``InferenceService``) via chunking.
        """
        mode_norm = str(mode or 'text').strip().lower()
        if mode_norm != 'text':
            raise ValueError('LocateAnything supports mode=text only')
        del points, boxes, point_box_size, include_mask_png

        succeeded = 0
        failed = 0
        items: list[dict[str, Any]] = []
        for path in image_paths or []:
            try:
                result = self.infer(
                    api_base_url=api_base_url,
                    image_path=path,
                    mode='text',
                    prompt=prompt,
                    max_detections=max_detections,
                )
                succeeded += 1
                items.append({'filename': Path(path).name, 'ok': True, 'result': result, 'error': None})
            except Exception as exc:
                failed += 1
                items.append({'filename': Path(path).name, 'ok': False, 'result': None, 'error': str(exc)})

        return {
            'total': len(image_paths or []),
            'succeeded': succeeded,
            'failed': failed,
            'items': items,
        }
