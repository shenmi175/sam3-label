from __future__ import annotations

import base64
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.storage import Storage  # noqa: E402
from app.utils import read_json  # noqa: E402


PNG_1X1 = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l1VGYAAAAABJRU5ErkJggg=='
)


def expect(condition: bool, message: str, detail: Any = None) -> None:
    if condition:
        return
    if detail is None:
        raise AssertionError(message)
    raise AssertionError(f'{message}: {detail!r}')


def write_image(path: Path) -> None:
    path.write_bytes(PNG_1X1)


def image_page(storage: Storage, project_id: str) -> list[dict[str, Any]]:
    items, total, _, _, _ = storage.get_project_images_page(project_id, limit=100)
    expect(len(items) == total, 'image page should contain all smoke images', {'items': len(items), 'total': total})
    return items


def image_ids(storage: Storage, project_id: str) -> list[str]:
    return [str(item.get('id') or '') for item in image_page(storage, project_id)]


def annotation_path(project: dict[str, Any], image_id: str) -> Path:
    return Path(str(project.get('annotation_dir') or '')).expanduser().resolve() / f'{image_id}.json'


def run() -> None:
    tmp = Path(tempfile.mkdtemp(prefix='web-auto-storage-smoke-'))
    try:
        image_dir = tmp / 'images'
        save_dir = tmp / 'save'
        image_dir.mkdir(parents=True)
        save_dir.mkdir(parents=True)
        write_image(image_dir / 'a.png')
        write_image(image_dir / 'b.png')
        write_image(image_dir / 'c.png')

        storage = Storage(tmp / 'cache')
        project = storage.create_project(
            name='storage smoke',
            image_dir=str(image_dir),
            save_dir=str(save_dir),
            classes_text='cat,dog',
        )
        project_id = str(project['id'])
        ids = image_ids(storage, project_id)
        expect(len(ids) == 3, 'project should start with three images', ids)
        labeled_id, empty_id, untouched_id = ids

        storage.save_annotations(
            project_id,
            labeled_id,
            [
                {
                    'id': 'ann_cat_1',
                    'class_name': 'cat',
                    'bbox': [0, 0, 1, 1],
                    'polygon': [[0, 0], [1, 0], [1, 1]],
                    'score': 0.9,
                }
            ],
        )
        storage.save_annotations(project_id, empty_id, [])
        rebuild = storage.rebuild_annotation_index(project_id)
        expect(rebuild['indexed_images'] == 3, 'rebuild should index all images', rebuild)
        expect(rebuild['labeled_images'] == 1, 'rebuild should count one labeled image', rebuild)
        expect(annotation_path(project, labeled_id).is_file(), 'non-empty annotation file should exist')
        saved_labeled = storage.load_annotations(project_id, labeled_id)
        expect(
            saved_labeled[0].get('polygon') == [[0, 0], [1, 0], [1, 1]],
            'polygon annotations should round-trip through storage',
            saved_labeled,
        )
        expect(read_json(annotation_path(project, empty_id), None) == [], 'empty annotation file should contain []')

        deleted_project, deleted_image = storage.delete_image(project_id, empty_id)
        expect(str(deleted_image.get('id') or '') == empty_id, 'delete_image should return deleted image', deleted_image)
        expect(deleted_project['num_images'] == 2, 'single delete should decrement total images', deleted_project)
        expect(deleted_project['labeled_images'] == 1, 'single delete should keep labeled count', deleted_project)
        expect(deleted_project['unlabeled_images'] == 1, 'single delete should decrement unlabeled count', deleted_project)
        expect(not (image_dir / 'b.png').exists(), 'single delete should remove the source image file')
        expect(not annotation_path(project, empty_id).exists(), 'single delete should remove annotation JSON')
        expect(empty_id not in image_ids(storage, project_id), 'single delete should remove image from sqlite list')

        dashboard = storage.get_annotation_dashboard(project_id)
        expect(dashboard['total_images'] == 2, 'dashboard total should match project after delete', dashboard)
        expect(dashboard['annotation_store_images'] == 2, 'annotation store rows should match remaining images', dashboard)
        expect(dashboard['indexed_images'] == 2, 'annotation stats rows should match remaining images', dashboard)
        expect(dashboard['annotation_count'] == 1, 'dashboard should keep one annotation', dashboard)
        expect(dashboard['classes'][0]['class_name'] == 'cat', 'dashboard class index should keep cat class', dashboard)

        batch = storage.delete_project_images(project_id, [untouched_id])
        expect(batch['deleted_images'] == 1, 'batch delete should remove one image', batch)
        expect(batch['deleted_image_files'] == 1, 'batch delete should remove image file', batch)
        expect(batch['deleted_annotation_files'] == 0, 'batch delete should not invent annotation file deletes', batch)
        expect(batch['project']['num_images'] == 1, 'batch delete should leave one image', batch)
        expect(batch['project']['labeled_images'] == 1, 'batch delete should leave labeled image count', batch)
        expect(batch['project']['unlabeled_images'] == 0, 'batch delete should leave no unlabeled images', batch)
        expect(not (image_dir / 'c.png').exists(), 'batch delete should remove source image file')
        expect(untouched_id not in image_ids(storage, project_id), 'batch delete should remove image from sqlite list')

        final_dashboard = storage.get_annotation_dashboard(project_id)
        expect(final_dashboard['total_images'] == 1, 'final dashboard total should match project', final_dashboard)
        expect(final_dashboard['indexed_images'] == 1, 'final index should have one image', final_dashboard)
        expect(final_dashboard['annotation_store_images'] == 1, 'final annotation store should have one image', final_dashboard)
        expect(final_dashboard['annotation_count'] == 1, 'final annotation count should remain one', final_dashboard)

        print(f'OK storage workflow smoke project={project_id}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    run()
