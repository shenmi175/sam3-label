from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


WEB_AUTO_ROOT = Path(__file__).resolve().parents[1]
if str(WEB_AUTO_ROOT) not in sys.path:
    sys.path.insert(0, str(WEB_AUTO_ROOT))

from app.annotations.schema_migration import migrate_annotation_schema  # noqa: E402
from app.storage import Storage  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description='Normalize annotation schema and remove manual producer records.')
    parser.add_argument('--data-dir', default=str(WEB_AUTO_ROOT / 'data'))
    parser.add_argument('--project-id', action='append', default=[], help='repeat to limit projects; default is all image projects')
    parser.add_argument('--manual-source', choices=('sam3', 'locate-anything'), default='sam3')
    parser.add_argument(
        '--include-snapshots', action='store_true',
        help='also normalize rollback snapshots; excluded by default because they may contain embedded masks',
    )
    parser.add_argument('--apply', action='store_true', help='write changes; without this flag the command is dry-run only')
    args = parser.parse_args()

    storage = Storage(Path(args.data_dir).expanduser().resolve())
    report = migrate_annotation_schema(
        storage,
        apply=bool(args.apply),
        project_ids=args.project_id,
        manual_source=args.manual_source,
        include_snapshots=bool(args.include_snapshots),
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get('failures'):
        raise SystemExit(2)


if __name__ == '__main__':
    main()
