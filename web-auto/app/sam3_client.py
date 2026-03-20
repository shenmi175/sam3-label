from __future__ import annotations

from pathlib import Path
from typing import Any

import json
import requests


class Sam3Client:
    def __init__(self, timeout_sec: float = 120.0):
        self.timeout_sec = timeout_sec

    @staticmethod
    def _api_root(base_url: str) -> str:
        url = str(base_url or '').strip()
        if not url:
            raise ValueError('api_base_url is required')
        if not url.startswith(('http://', 'https://')):
            raise ValueError('api_base_url must start with http:// or https://')
        url = url.rstrip('/')
        if url.lower().endswith('/v1/infer'):
            return url[:-len('/v1/infer')]
        if url.lower().endswith('/v1/semantic/infer'):
            return url[:-len('/v1/semantic/infer')]
        if url.lower().endswith('/v1/semantic/infer_batch'):
            return url[:-len('/v1/semantic/infer_batch')]
        if url.lower().endswith('/health'):
            return url[:-len('/health')]
        return url

    @staticmethod
    def _infer_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/infer'

    @staticmethod
    def _semantic_infer_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/semantic/infer'

    @staticmethod
    def _semantic_batch_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/semantic/infer_batch'

    @staticmethod
    def _health_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/health'

    @staticmethod
    def _video_start_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/start'

    @staticmethod
    def _video_start_upload_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/start_upload'

    @staticmethod
    def _video_session_url(base_url: str, session_id: str) -> str:
        sid = str(session_id or '').strip()
        if not sid:
            raise ValueError('session_id is required')
        return Sam3Client._api_root(base_url) + f'/v1/video/session/{sid}'

    @staticmethod
    def _video_add_prompt_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/add_prompt'

    @staticmethod
    def _video_propagate_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/propagate'

    @staticmethod
    def _video_close_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/close'

    @staticmethod
    def _video_reset_url(base_url: str) -> str:
        return Sam3Client._api_root(base_url) + '/v1/video/session/reset'

    def _get_json(self, url: str, timeout: float | None = None) -> dict[str, Any]:
        resp = requests.get(url, timeout=timeout or max(self.timeout_sec, 1.0))
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')
        return data if isinstance(data, dict) else {}

    def _post_json(self, url: str, payload: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        resp = requests.post(url, json=payload, timeout=timeout or max(self.timeout_sec, 1.0))
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')
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
            resp = requests.post(infer_url, data=payload, files=files, timeout=max(self.timeout_sec, 1.0))

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')

        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')

        return data

    def semantic_infer(
        self,
        *,
        api_base_url: str,
        image_path: str,
        prompt: str,
        threshold: float,
        boxes: list[list[float | int]] | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        infer_url = self._semantic_infer_url(api_base_url)
        image_file = Path(image_path)
        if not image_file.exists() or not image_file.is_file():
            raise ValueError(f'image does not exist: {image_file}')

        payload: dict[str, str] = {
            'prompt': str(prompt or '').strip(),
            'threshold': str(float(threshold)),
            'include_mask_png': 'true' if include_mask_png else 'false',
            'max_detections': str(int(max_detections)),
            'boxes': json.dumps(boxes or []),
        }

        with image_file.open('rb') as f:
            files = {'file': (image_file.name, f, 'application/octet-stream')}
            resp = requests.post(infer_url, data=payload, files=files, timeout=max(self.timeout_sec, 1.0))

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')

        if not resp.ok:
            err = data.get('detail') if isinstance(data, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')

        return data if isinstance(data, dict) else {}

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
            resp = requests.post(infer_url, data=payload, files=files, timeout=max(self.timeout_sec * 4.0, 120.0))
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
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')

        return data if isinstance(data, dict) else {}

    def semantic_infer_batch(
        self,
        *,
        api_base_url: str,
        source_image_path: str,
        target_image_paths: list[str],
        prompt: str,
        boxes: list[list[float | int]] | None = None,
        threshold: float,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        infer_url = self._semantic_batch_url(api_base_url)
        source_file = Path(source_image_path)
        if not source_file.exists() or not source_file.is_file():
            raise ValueError(f'source image does not exist: {source_file}')
        clean_targets = [Path(p) for p in (target_image_paths or []) if str(p).strip()]
        if not clean_targets:
            raise ValueError('target_image_paths must not be empty')
        for item in clean_targets:
            if not item.exists() or not item.is_file():
                raise ValueError(f'target image does not exist: {item}')

        payload: dict[str, str] = {
            'prompt': str(prompt or '').strip(),
            'threshold': str(float(threshold)),
            'include_mask_png': 'true' if include_mask_png else 'false',
            'max_detections': str(int(max_detections)),
            'boxes': json.dumps(boxes or []),
        }

        handles = []
        try:
            handles.append(source_file.open('rb'))
            files: list[tuple[str, tuple[str, Any, str]]] = [
                ('source_file', (source_file.name, handles[-1], 'application/octet-stream'))
            ]
            for item in clean_targets:
                handles.append(item.open('rb'))
                files.append(('files', (item.name, handles[-1], 'application/octet-stream')))

            resp = requests.post(infer_url, data=payload, files=files, timeout=max(self.timeout_sec * 4.0, 120.0))
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
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or data}')

        return data if isinstance(data, dict) else {}

    def video_start_session(
        self,
        *,
        api_base_url: str,
        resource_path: str,
        session_id: str | None = None,
        threshold: float | None = None,
        imgsz: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {'resource_path': str(resource_path)}
        if session_id:
            payload['session_id'] = str(session_id)
        if threshold is not None:
            payload['threshold'] = float(threshold)
        if imgsz is not None:
            payload['imgsz'] = int(imgsz)
        return self._post_json(self._video_start_url(api_base_url), payload)

    def video_get_session(
        self,
        *,
        api_base_url: str,
        session_id: str,
    ) -> dict[str, Any]:
        return self._get_json(self._video_session_url(api_base_url, session_id))

    def video_add_prompt(
        self,
        *,
        api_base_url: str,
        session_id: str,
        frame_index: int,
        text: str = '',
        points: list[list[float | int]] | None = None,
        boxes: list[list[float | int]] | None = None,
        obj_id: int | None = None,
        normalized: bool = False,
        include_mask_png: bool = True,
        max_detections: int = 200,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'session_id': str(session_id),
            'frame_index': int(frame_index),
            'normalized': bool(normalized),
            'include_mask_png': bool(include_mask_png),
            'max_detections': int(max_detections),
        }
        if str(text or '').strip():
            payload['text'] = str(text).strip()
        if points:
            payload['points'] = points
        if boxes:
            payload['boxes'] = boxes
        if obj_id is not None:
            payload['obj_id'] = int(obj_id)
        return self._post_json(self._video_add_prompt_url(api_base_url), payload)

    def video_start_session_upload(
        self,
        *,
        api_base_url: str,
        video_path: str,
        session_id: str | None = None,
        threshold: float | None = None,
        imgsz: int | None = None,
    ) -> dict[str, Any]:
        path = Path(str(video_path or '')).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise ValueError(f'video file does not exist: {path}')

        data: dict[str, str] = {}
        if session_id:
            data['session_id'] = str(session_id)
        if threshold is not None:
            data['threshold'] = str(float(threshold))
        if imgsz is not None:
            data['imgsz'] = str(int(imgsz))

        with path.open('rb') as f:
            files = {'file': (path.name, f, 'application/octet-stream')}
            resp = requests.post(
                self._video_start_upload_url(api_base_url),
                data=data,
                files=files,
                timeout=max(self.timeout_sec * 10.0, 120.0),
            )
        try:
            payload = resp.json()
        except Exception:
            raise RuntimeError(f'API response is not JSON: HTTP {resp.status_code} {resp.text[:240]}')
        if not resp.ok:
            err = payload.get('detail') if isinstance(payload, dict) else None
            raise RuntimeError(f'API HTTP error {resp.status_code}: {err or payload}')
        return payload if isinstance(payload, dict) else {}

    def video_propagate(
        self,
        *,
        api_base_url: str,
        session_id: str,
        propagation_direction: str = 'forward',
        start_frame_index: int | None = None,
        max_frame_num_to_track: int | None = None,
        include_mask_png: bool = True,
        max_detections: int = 200,
        max_frames: int = 0,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            'session_id': str(session_id),
            'propagation_direction': str(propagation_direction),
            'include_mask_png': bool(include_mask_png),
            'max_detections': int(max_detections),
            'max_frames': int(max_frames),
        }
        if start_frame_index is not None:
            payload['start_frame_index'] = int(start_frame_index)
        if max_frame_num_to_track is not None:
            payload['max_frame_num_to_track'] = int(max_frame_num_to_track)
        return self._post_json(
            self._video_propagate_url(api_base_url),
            payload,
            timeout=max(self.timeout_sec * 5.0, 60.0),
        )

    def video_close_session(
        self,
        *,
        api_base_url: str,
        session_id: str,
    ) -> dict[str, Any]:
        return self._post_json(self._video_close_url(api_base_url), {'session_id': str(session_id)})

    def video_reset_session(
        self,
        *,
        api_base_url: str,
        session_id: str,
    ) -> dict[str, Any]:
        return self._post_json(self._video_reset_url(api_base_url), {'session_id': str(session_id)})
