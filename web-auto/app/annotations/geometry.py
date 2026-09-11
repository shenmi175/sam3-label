from __future__ import annotations

import math
from typing import Any, Iterable

from app.annotations.models import AnnotationIssue, BoundingBox, Point, Polygon


def finite_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def polygon_area(points: Polygon) -> float:
    if len(points) < 3:
        return 0.0
    return abs(sum(
        points[index][0] * points[(index + 1) % len(points)][1]
        - points[(index + 1) % len(points)][0] * points[index][1]
        for index in range(len(points))
    )) / 2.0


def _orientation(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a: Point, b: Point, point: Point) -> bool:
    epsilon = 1e-9
    return (
        min(a[0], b[0]) - epsilon <= point[0] <= max(a[0], b[0]) + epsilon
        and min(a[1], b[1]) - epsilon <= point[1] <= max(a[1], b[1]) + epsilon
        and abs(_orientation(a, b, point)) <= epsilon
    )


def _segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    epsilon = 1e-9
    ab_c, ab_d = _orientation(a, b, c), _orientation(a, b, d)
    cd_a, cd_b = _orientation(c, d, a), _orientation(c, d, b)
    if ((ab_c > epsilon and ab_d < -epsilon) or (ab_c < -epsilon and ab_d > epsilon)) and (
        (cd_a > epsilon and cd_b < -epsilon) or (cd_a < -epsilon and cd_b > epsilon)
    ):
        return True
    return any(
        abs(value) <= epsilon and _on_segment(start, end, point)
        for value, start, end, point in (
            (ab_c, a, b, c),
            (ab_d, a, b, d),
            (cd_a, c, d, a),
            (cd_b, c, d, b),
        )
    )


def polygon_self_intersects(points: Polygon) -> bool:
    count = len(points)
    for first in range(count):
        a, b = points[first], points[(first + 1) % count]
        for second in range(first + 1, count):
            if second == first or second == (first + 1) % count or (second + 1) % count == first:
                continue
            if _segments_intersect(a, b, points[second], points[(second + 1) % count]):
                return True
    return False


def parse_polygon(raw: Any, *, field: str) -> tuple[Polygon | None, AnnotationIssue | None]:
    if not isinstance(raw, list):
        return None, AnnotationIssue('INVALID_POLYGON', 'error', field)
    points: list[Point] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            return None, AnnotationIssue('INVALID_POLYGON_POINT', 'error', field)
        x, y = finite_number(item[0]), finite_number(item[1])
        if x is None or y is None:
            return None, AnnotationIssue('INVALID_POLYGON_POINT', 'error', field)
        points.append((x, y))
    polygon = tuple(points)
    if len(set(polygon)) < 3:
        return None, AnnotationIssue('DEGENERATE_POLYGON', 'error', field)
    if polygon_self_intersects(polygon):
        return None, AnnotationIssue('SELF_INTERSECTING_POLYGON', 'error', field)
    if polygon_area(polygon) <= 0:
        return None, AnnotationIssue('DEGENERATE_POLYGON', 'error', field)
    return polygon, None


def parse_bbox(raw: Any, *, field: str = 'bbox') -> tuple[BoundingBox | None, AnnotationIssue | None]:
    if not isinstance(raw, (list, tuple)) or len(raw) < 4:
        return None, AnnotationIssue('INVALID_BBOX', 'error', field)
    values = tuple(finite_number(raw[index]) for index in range(4))
    if any(value is None for value in values):
        return None, AnnotationIssue('INVALID_BBOX', 'error', field)
    x1, y1, x2, y2 = (float(value) for value in values if value is not None)
    if x2 <= x1 or y2 <= y1:
        return None, AnnotationIssue('DEGENERATE_BBOX', 'error', field)
    return BoundingBox(x1, y1, x2, y2), None


def bbox_from_polygons(polygons: Iterable[Polygon]) -> BoundingBox | None:
    points = [point for polygon in polygons for point in polygon]
    if not points:
        return None
    xs, ys = [point[0] for point in points], [point[1] for point in points]
    if max(xs) <= min(xs) or max(ys) <= min(ys):
        return None
    return BoundingBox(min(xs), min(ys), max(xs), max(ys))


def union_bboxes(boxes: Iterable[BoundingBox]) -> BoundingBox | None:
    values = list(boxes)
    if not values:
        return None
    return BoundingBox(
        min(box.x1 for box in values),
        min(box.y1 for box in values),
        max(box.x2 for box in values),
        max(box.y2 for box in values),
    )
