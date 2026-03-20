from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tiff'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.mkv', '.webm'}


def now_ts() -> str:
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())


def new_id(prefix: str = '') -> str:
    token = uuid.uuid4().hex[:12]
    return f'{prefix}{token}' if prefix else token


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix='.tmp_', suffix='.json', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # Windows can transiently raise PermissionError when another thread/process
        # is reading the destination file. Retry a few times before failing.
        last_err: Exception | None = None
        for i in range(12):
            try:
                os.replace(tmp_name, path)
                last_err = None
                break
            except PermissionError as exc:
                last_err = exc
                # 10ms, 20ms, ... up to 120ms
                time.sleep(0.01 * float(i + 1))
        if last_err is not None:
            raise last_err
    except Exception:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with path.open('r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def norm_text(value: str) -> str:
    return ' '.join(str(value or '').strip().lower().replace('_', ' ').replace('-', ' ').split())


def parse_classes_text(text: str) -> list[str]:
    classes: list[str] = []
    seen = set()
    for raw in str(text or '').split(','):
        name = raw.strip()
        if not name:
            continue
        key = norm_text(name)
        if key in seen:
            continue
        seen.add(key)
        classes.append(name)
    return classes


def list_images_recursive(root: Path) -> list[dict[str, str]]:
    images: list[dict[str, str]] = []
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        if p.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        rel = p.relative_to(root).as_posix()
        image_id = uuid.uuid5(uuid.NAMESPACE_URL, rel).hex[:16]
        images.append({'id': image_id, 'rel_path': rel, 'abs_path': str(p.resolve())})
    return images


def list_frames_from_dir(root: Path, *, video_name: str = 'video') -> list[dict[str, str | int]]:
    frames: list[dict[str, str | int]] = []
    idx = 0
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        if p.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        rel_name = f'{video_name}_{idx:06d}{p.suffix.lower()}'
        frame_id = uuid.uuid5(uuid.NAMESPACE_URL, rel_name).hex[:16]
        frames.append(
            {
                'id': frame_id,
                'rel_path': rel_name,
                'abs_path': str(p.resolve()),
                'frame_index': idx,
            }
        )
        idx += 1
    return frames


def list_video_files_recursive(root: Path) -> list[Path]:
    videos: list[Path] = []
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        if p.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        videos.append(p.resolve())
    return videos


def probe_video_info(video_file: Path) -> dict[str, Any]:
    video_file = video_file.expanduser().resolve()
    if not video_file.exists() or not video_file.is_file():
        raise ValueError(f'video file does not exist: {video_file}')
    if video_file.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError(f'unsupported video extension: {video_file.suffix}')

    try:
        import cv2  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError('opencv-python is required for video probing') from exc

    cap = cv2.VideoCapture(str(video_file))
    if not cap.isOpened():
        raise RuntimeError(f'failed to open video: {video_file}')
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if frame_count <= 0:
        raise RuntimeError(f'video has no frames: {video_file}')
    return {
        'video_path': str(video_file),
        'video_name': video_file.stem,
        'fps': fps,
        'width': width,
        'height': height,
        'num_frames': frame_count,
        'updated_at': now_ts(),
    }


def build_virtual_frames(video_name: str, num_frames: int) -> list[dict[str, str | int]]:
    frames: list[dict[str, str | int]] = []
    safe_name = str(video_name or 'video').strip() or 'video'
    total = max(0, int(num_frames))
    for idx in range(total):
        rel_name = f'{safe_name}_{idx:06d}.jpg'
        frame_id = uuid.uuid5(uuid.NAMESPACE_URL, rel_name).hex[:16]
        frames.append(
            {
                'id': frame_id,
                'rel_path': rel_name,
                'abs_path': '',
                'frame_index': idx,
            }
        )
    return frames


def extract_video_to_frames(video_file: Path, frames_dir: Path) -> tuple[list[dict[str, str | int]], dict[str, Any]]:
    video_file = video_file.expanduser().resolve()
    if not video_file.exists() or not video_file.is_file():
        raise ValueError(f'video file does not exist: {video_file}')
    if video_file.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError(f'unsupported video extension: {video_file.suffix}')

    ensure_dir(frames_dir)
    manifest_path = frames_dir / 'manifest.json'
    cached = read_json(manifest_path, {})
    if isinstance(cached, dict) and cached.get('video_path') == str(video_file):
        frames = cached.get('frames', [])
        if isinstance(frames, list) and all(isinstance(x, dict) for x in frames) and len(frames) > 0:
            return frames, cached

    try:
        import cv2  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError('opencv-python is required for video extraction') from exc

    cap = cv2.VideoCapture(str(video_file))
    if not cap.isOpened():
        raise RuntimeError(f'failed to open video: {video_file}')

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    video_name = video_file.stem

    frames: list[dict[str, str | int]] = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        rel_name = f'{video_name}_{idx:06d}.jpg'
        out_path = frames_dir / rel_name
        ok_write = cv2.imwrite(str(out_path), frame)
        if not ok_write:
            cap.release()
            raise RuntimeError(f'failed to write frame: {out_path}')
        frame_id = uuid.uuid5(uuid.NAMESPACE_URL, rel_name).hex[:16]
        frames.append(
            {
                'id': frame_id,
                'rel_path': rel_name,
                'abs_path': str(out_path.resolve()),
                'frame_index': idx,
            }
        )
        idx += 1
    cap.release()

    if not frames:
        raise RuntimeError('no frame extracted from video')

    manifest = {
        'video_path': str(video_file),
        'video_name': video_name,
        'fps': fps,
        'width': width,
        'height': height,
        'num_frames': len(frames),
        'frames': frames,
        'updated_at': now_ts(),
    }
    atomic_write_json(manifest_path, manifest)
    return frames, manifest
