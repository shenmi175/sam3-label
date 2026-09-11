from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_AUTO = ROOT / 'web-auto'
if str(WEB_AUTO) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO))

from app.storage import Storage  # noqa: E402
from app.schemas import AiSessionIn, AiSessionOpenIn  # noqa: E402
from app.services.ai_assistant_service import AiAssistantService  # noqa: E402
from fastapi import HTTPException  # noqa: E402
import pytest


def _project(storage: Storage, tmp_path: Path) -> tuple[dict, dict]:
    image_dir = tmp_path / 'images'
    image_dir.mkdir()
    (image_dir / 'one.png').write_bytes(b'not-decoded-in-storage-tests')
    project = storage.create_project(
        name='features',
        image_dir=str(image_dir),
        save_dir=str(tmp_path / 'output'),
        classes_text='chair',
    )
    image = storage.get_project(str(project['id']), include_images=True)['images'][0]
    return project, image


def test_feature_directory_is_lazy_and_index_tracks_files(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, image = _project(storage, tmp_path)
    project_id = str(project['id'])
    image_id = str(image['id'])
    feature_root = storage.ai_feature_root(project_id)

    assert not feature_root.exists()
    empty = storage.ai_feature_status(project_id)
    assert empty['count'] == 0
    assert not feature_root.exists()

    feature_root.mkdir(parents=True)
    feature_file = feature_root / 'key.safetensors'
    feature_file.write_bytes(b'feature-data')
    storage.upsert_ai_feature(
        project_id,
        image_id,
        {
            'feature_status': 'saved',
            'feature_key': 'key',
            'feature_relative_path': 'feature/key.safetensors',
            'feature_bytes': feature_file.stat().st_size,
            'image_digest': 'image-sha',
            'model_fingerprint': 'model-sha',
            'input_size': 1008,
            'dtype': 'bfloat16',
            'format_version': 'sam3-inst-v1',
        },
    )

    one = storage.ai_feature_status(project_id, image_id)['feature']
    assert one['feature_key'] == 'key'
    assert one['file_exists'] is True
    summary = storage.ai_feature_status(project_id)
    assert summary['count'] == 1
    assert summary['bytes'] == len(b'feature-data')

    deleted = storage.delete_ai_features(project_id)
    assert deleted['deleted_files'] == 1
    assert not feature_root.exists()
    assert storage.ai_feature_status(project_id)['indexed_count'] == 0


def test_project_deletion_removes_feature_directory_and_index(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, image = _project(storage, tmp_path)
    project_id = str(project['id'])
    root = storage.ai_feature_root(project_id)
    root.mkdir(parents=True)
    (root / 'x.safetensors').write_bytes(b'x')
    storage.upsert_ai_feature(
        project_id,
        str(image['id']),
        {
            'feature_status': 'saved',
            'feature_key': 'x',
            'feature_relative_path': 'feature/x.safetensors',
            'feature_bytes': 1,
        },
    )

    storage.delete_project(project_id)

    assert not root.exists()
    conn = storage._db_connect()
    try:
        count = conn.execute(
            'SELECT COUNT(*) FROM ai_feature_index WHERE project_id=?', (project_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    assert count == 0


def test_project_name_can_change_without_mutating_paths(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, _image = _project(storage, tmp_path)
    project_id = str(project['id'])
    original_image_dir = project['image_dir']
    original_save_dir = project['project_save_dir']

    updated = storage.update_project_name(project_id, 'renamed project')

    assert updated['name'] == 'renamed project'
    assert updated['image_dir'] == original_image_dir
    assert updated['project_save_dir'] == original_save_dir


def test_ai_refinement_rejects_non_sam_non_manual_annotations(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, image = _project(storage, tmp_path)
    project_id = str(project['id'])
    image_id = str(image['id'])
    storage.save_annotations(project_id, image_id, [{
        'id': 'la-1',
        'class_name': 'chair',
        'bbox': [0, 0, 10, 10],
        'source_model': 'locate-anything',
    }])
    service = AiAssistantService(
        get_storage=lambda: storage,
        sam3=object(),
        acquire_gpu=lambda: 'lease',
        release_gpu=lambda _lease: None,
        active_infer_job=lambda _project_id: None,
    )

    with pytest.raises(HTTPException, match='当前仅支持在 SAM3 标注层') as exc:
        service._selected_annotation(project_id, image_id, 'la-1')
    assert exc.value.status_code == 400


def test_neighbor_prefetch_crosses_page_boundaries_in_navigation_order(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    image_dir = tmp_path / 'many-images'
    image_dir.mkdir()
    for index in range(8):
        (image_dir / f'{index:02d}.png').write_bytes(bytes([index]))
    project = storage.create_project(
        name='neighbors', image_dir=str(image_dir), save_dir=str(tmp_path / 'out-many'), classes_text='chair'
    )
    project_id = str(project['id'])
    images = storage.get_project(project_id, include_images=True)['images']
    service = AiAssistantService(
        get_storage=lambda: storage,
        sam3=object(),
        acquire_gpu=lambda: 'lease',
        release_gpu=lambda _lease: None,
        active_infer_job=lambda _project_id: None,
    )
    payload = AiSessionOpenIn(project_id=project_id, image_id=str(images[4]['id']))

    neighbors = service._neighbors(payload)

    assert neighbors == [images[3]['id'], images[5]['id'], images[2]['id'], images[6]['id']]


def _write_indexed_feature(
    storage: Storage,
    project_id: str,
    image_id: str,
    *,
    key: str,
    used_by_ai: bool = False,
    persisted_by_batch: bool = False,
) -> Path:
    root = storage.ai_feature_root(project_id)
    root.mkdir(parents=True, exist_ok=True)
    path = root / f'{key}.safetensors'
    path.write_bytes(key.encode())
    storage.upsert_ai_feature(project_id, image_id, {
        'feature_status': 'saved',
        'feature_key': key,
        'feature_relative_path': f'feature/{key}.safetensors',
        'feature_bytes': path.stat().st_size,
        'used_by_ai': used_by_ai,
        'persisted_by_batch': persisted_by_batch,
    })
    return path


def test_expired_cleanup_deletes_only_ai_session_features(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    image_dir = tmp_path / 'owned-images'
    image_dir.mkdir()
    (image_dir / 'ai.png').write_bytes(b'ai')
    (image_dir / 'batch.png').write_bytes(b'batch')
    project = storage.create_project(
        name='ownership', image_dir=str(image_dir), save_dir=str(tmp_path / 'owned-out'), classes_text='chair'
    )
    project_id = str(project['id'])
    images = storage.get_project(project_id, include_images=True)['images']
    ai_path = _write_indexed_feature(
        storage, project_id, str(images[0]['id']), key='ai-only', used_by_ai=True
    )
    batch_path = _write_indexed_feature(
        storage, project_id, str(images[1]['id']), key='batch-only', persisted_by_batch=True
    )

    result = storage.delete_transient_ai_features(project_id)

    assert result['deleted_files'] == 1
    assert not ai_path.exists()
    assert batch_path.exists()
    features = storage.ai_feature_status(project_id)['features']
    assert [item['feature_key'] for item in features] == ['batch-only']


@pytest.mark.parametrize('first_owner', ['ai', 'batch'])
def test_batch_promotion_survives_ai_expiry(tmp_path: Path, first_owner: str) -> None:
    storage = Storage(tmp_path / f'data-{first_owner}')
    case_root = tmp_path / first_owner
    case_root.mkdir()
    project, image = _project(storage, case_root)
    project_id = str(project['id'])
    image_id = str(image['id'])
    path = _write_indexed_feature(
        storage,
        project_id,
        image_id,
        key='shared',
        used_by_ai=first_owner == 'ai',
        persisted_by_batch=first_owner == 'batch',
    )
    storage.upsert_ai_feature(project_id, image_id, {
        'feature_status': 'saved',
        'feature_key': 'shared',
        'feature_relative_path': 'feature/shared.safetensors',
        'feature_bytes': path.stat().st_size,
        'used_by_ai': first_owner == 'batch',
        'persisted_by_batch': first_owner == 'ai',
    })

    storage.delete_transient_ai_features(project_id)

    feature = storage.ai_feature_status(project_id, image_id)['feature']
    assert feature['used_by_ai'] == 1
    assert feature['persisted_by_batch'] == 1
    assert path.exists()


def test_cleanup_keeps_file_referenced_by_persistent_batch_row(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    image_dir = tmp_path / 'shared-images'
    image_dir.mkdir()
    (image_dir / 'a.png').write_bytes(b'a')
    (image_dir / 'b.png').write_bytes(b'b')
    project = storage.create_project(
        name='shared-path', image_dir=str(image_dir), save_dir=str(tmp_path / 'shared-out'), classes_text='chair'
    )
    project_id = str(project['id'])
    images = storage.get_project(project_id, include_images=True)['images']
    shared = _write_indexed_feature(
        storage, project_id, str(images[0]['id']), key='same', used_by_ai=True
    )
    storage.upsert_ai_feature(project_id, str(images[1]['id']), {
        'feature_status': 'saved',
        'feature_key': 'same',
        'feature_relative_path': 'feature/same.safetensors',
        'feature_bytes': shared.stat().st_size,
        'persisted_by_batch': True,
    })

    storage.delete_transient_ai_features(project_id)

    assert shared.exists()
    features = storage.ai_feature_status(project_id)['features']
    assert len(features) == 1
    assert features[0]['persisted_by_batch'] == 1


@pytest.mark.parametrize('has_batch_job', [False, True])
def test_legacy_feature_ownership_uses_durable_batch_job_history(
    tmp_path: Path,
    has_batch_job: bool,
) -> None:
    base_dir = tmp_path / f'legacy-data-{has_batch_job}'
    base_dir.mkdir()
    db_path = base_dir / 'web_auto_index.sqlite3'
    conn = sqlite3.connect(db_path)
    try:
        conn.execute('''
            CREATE TABLE ai_feature_index (
                project_id TEXT NOT NULL,
                image_id TEXT NOT NULL,
                image_digest TEXT NOT NULL DEFAULT '',
                model_fingerprint TEXT NOT NULL DEFAULT '',
                input_size INTEGER NOT NULL DEFAULT 1008,
                dtype TEXT NOT NULL DEFAULT 'bfloat16',
                format_version TEXT NOT NULL DEFAULT '',
                feature_key TEXT NOT NULL DEFAULT '',
                relative_path TEXT NOT NULL DEFAULT '',
                byte_size INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                accessed_at TEXT NOT NULL,
                PRIMARY KEY (project_id, image_id)
            )
        ''')
        conn.execute(
            '''INSERT INTO ai_feature_index
               (project_id, image_id, created_at, accessed_at) VALUES (?, ?, ?, ?)''',
            ('legacy-project', 'legacy-image', 'old', 'old'),
        )
        if has_batch_job:
            conn.execute('''
                CREATE TABLE background_jobs (
                    job_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    job_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}'
                )
            ''')
            conn.execute(
                '''INSERT INTO background_jobs
                   (job_id, project_id, job_type, payload_json) VALUES (?, ?, ?, ?)''',
                ('legacy-job', 'legacy-project', 'infer:text', '{"save_ai_features": true}'),
            )
        conn.commit()
    finally:
        conn.close()

    storage = Storage(base_dir)
    conn = storage._db_connect()
    try:
        row = conn.execute(
            'SELECT used_by_ai, persisted_by_batch FROM ai_feature_index'
        ).fetchone()
    finally:
        conn.close()

    assert tuple(row) == ((1, 1) if has_batch_job else (1, 0))


class _InteractiveSam3:
    def __init__(self) -> None:
        self.next_session = 0
        self.closed: list[str] = []
        self.open_calls: list[dict] = []

    def open_interactive_session(self, **kwargs):
        self.open_calls.append(dict(kwargs))
        self.next_session += 1
        session_id = f'session-{self.next_session}'
        return {
            'session_id': session_id,
            'image_id': kwargs['image_id'],
            'feature_status': 'memory_only',
            'feature_key': session_id,
            'feature_relative_path': '',
            'feature_bytes': 0,
        }

    def interactive_close(self, _api_base_url: str, session_id: str):
        self.closed.append(session_id)
        return {'closed': True}


def test_ai_sessions_request_memory_only_features_and_never_index_them(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, image = _project(storage, tmp_path)
    project_id = str(project['id'])
    image_id = str(image['id'])
    sam3 = _InteractiveSam3()
    service = AiAssistantService(
        get_storage=lambda: storage,
        sam3=sam3,
        acquire_gpu=lambda: 'lease',
        release_gpu=lambda _lease: None,
        active_infer_job=lambda _project_id: None,
    )

    opened, _neighbors, _generation = service.open_session(
        AiSessionOpenIn(project_id=project_id, image_id=image_id)
    )
    service.close(AiSessionIn(project_id=project_id, session_id=opened['session_id']))

    assert sam3.open_calls[0]['persist_feature'] is False
    assert not storage.ai_feature_root(project_id).exists()
    assert storage.ai_feature_status(project_id)['indexed_count'] == 0


def test_startup_cleanup_immediately_removes_legacy_transient_features(tmp_path: Path) -> None:
    storage = Storage(tmp_path / 'data')
    project, image = _project(storage, tmp_path)
    project_id = str(project['id'])
    _write_indexed_feature(
        storage,
        project_id,
        str(image['id']),
        key='orphaned-session',
        used_by_ai=True,
    )
    service = AiAssistantService(
        get_storage=lambda: storage,
        sam3=object(),
        acquire_gpu=lambda: 'lease',
        release_gpu=lambda _lease: None,
        active_infer_job=lambda _project_id: None,
    )

    cleaned = service.cleanup_transient_features()

    assert cleaned[0]['deleted_files'] == 1
    assert storage.ai_feature_status(project_id)['indexed_count'] == 0
