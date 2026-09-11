from __future__ import annotations

from app.exporting.models import ExportStats
from app.exporting.normalization import IssueCollector


def add_common_preflight_issues(
    *,
    stats: ExportStats,
    issues: IssueCollector,
    allow_no_valid_instances: bool = False,
) -> None:
    if stats.annotations_selected <= 0:
        issues.add(
            code='EXPORT_EMPTY',
            message='No annotations match the selected sources and classes.',
            severity='blocker',
        )
    elif stats.instances_written <= 0 and not allow_no_valid_instances:
        issues.add(
            code='NO_VALID_INSTANCES',
            message='No selected annotation could be normalized into a valid instance.',
            severity='blocker',
        )
