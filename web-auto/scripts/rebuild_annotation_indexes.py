from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


WEB_AUTO_ROOT = Path(__file__).resolve().parents[1]
if str(WEB_AUTO_ROOT) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO_ROOT))

from app.storage import Storage  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description='Rebuild annotation and analytics indexes from annotation JSON files.')
    parser.add_argument('--data-dir', default=str(WEB_AUTO_ROOT / 'data'))
    parser.add_argument('--project-id', action='append', default=[], help='repeat to limit projects; default is all image projects')
    parser.add_argument('--annotation-only', action='store_true')
    parser.add_argument('--analytics-only', action='store_true')
    args = parser.parse_args()
    if args.annotation_only and args.analytics_only:
        parser.error('--annotation-only and --analytics-only are mutually exclusive')

    storage = Storage(Path(args.data_dir).expanduser().resolve())
    requested = {str(value).strip() for value in args.project_id if str(value).strip()}
    projects = [
        project for project in storage._load_projects()
        if str(project.get('project_type') or 'image') == 'image'
        and (not requested or str(project.get('id') or '') in requested)
    ]
    found = {str(project.get('id') or '') for project in projects}
    missing = sorted(requested.difference(found))
    if missing:
        raise SystemExit(f'project not found: {", ".join(missing)}')

    reports = []
    for project in projects:
        project_id = str(project.get('id') or '')
        item: dict[str, object] = {'project_id': project_id}
        if not args.analytics_only:
            item['annotation_index'] = storage.rebuild_annotation_index(project_id)
        if not args.annotation_only:
            item['analytics_index'] = storage.rebuild_analytics_index(
                project_id,
                progress_cb=lambda **updates: print(json.dumps({
                    'project_id': project_id, 'stage': 'analytics', **updates,
                }, ensure_ascii=False), flush=True),
            )
        reports.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
    print(json.dumps({'projects': reports}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
