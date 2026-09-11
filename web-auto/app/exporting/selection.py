from __future__ import annotations

from typing import Any


def resolve_class_list(project: dict[str, Any], classes: list[str] | None) -> list[str]:
    source = classes if classes else project.get('classes') or []
    output: list[str] = []
    for value in source:
        name = str(value or '').strip()
        if name and name not in output:
            output.append(name)
    return output
