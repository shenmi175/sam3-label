from __future__ import annotations

import hashlib
import math
import os
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image

from app.annotations import CanonicalAnnotation, ParseContext, parse_image_annotations, resolve_annotation_mask
from app.services.annotation_masks import annotation_mask_path
from app.utils import norm_text
from app.utils import ensure_dir


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _write_png_atomic(path: Path, encoded: bytes) -> None:
    ensure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix='.tmp_', suffix='.png', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _polygon_mask(ann: CanonicalAnnotation, size: tuple[int, int], *, require_multiple: bool = True) -> Any | None:
    try:
        import numpy as np
        resolved = resolve_annotation_mask(ann, size=size, require_multiple_regions=require_multiple)
        return np.asarray(resolved.image, dtype=np.uint8) if resolved is not None else None
    except Exception:
        return None


def _polygons_from_mask(mask: Any) -> list[list[list[float]]]:
    import cv2

    contours, _hierarchy = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=lambda contour: float(cv2.contourArea(contour)), reverse=True)
    polygons: list[list[list[float]]] = []
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, max(1.0, 0.003 * perimeter), True)
        if approx is None or len(approx) < 3:
            approx = contour
        if approx is None or len(approx) < 3:
            continue
        polygons.append([[float(point[0]), float(point[1])] for point in approx.reshape(-1, 2)])
    return polygons


def _threshold_match(
    area: int,
    main_area: int,
    *,
    abs_enabled: bool,
    abs_limit: int,
    relative_enabled: bool,
    relative_limit: float,
    require_all: bool,
) -> tuple[bool, list[str]]:
    checks: list[tuple[bool, str]] = []
    if abs_enabled:
        checks.append((int(area) <= int(abs_limit), 'absolute_area'))
    if relative_enabled:
        checks.append((float(area) / float(max(1, main_area)) <= float(relative_limit), 'main_ratio'))
    if not checks:
        return False, []
    matched = all(value for value, _reason in checks) if require_all else any(value for value, _reason in checks)
    return matched, [reason for value, reason in checks if value]


def _should_remove(area: int, main_area: int, config: dict[str, Any]) -> bool:
    matched, _reasons = _threshold_match(
        area,
        main_area,
        abs_enabled=bool(config.get('component_abs_area_enabled')),
        abs_limit=int(config.get('component_max_area_px') or 0),
        relative_enabled=bool(config.get('component_relative_area_enabled')),
        relative_limit=float(config.get('component_max_main_ratio') or 0.0),
        require_all=bool(config.get('component_require_all_thresholds', True)),
    )
    return matched


def _should_fill_hole(area: int, main_area: int, config: dict[str, Any]) -> tuple[bool, list[str]]:
    return _threshold_match(
        area,
        main_area,
        abs_enabled=bool(config.get('component_hole_abs_area_enabled')),
        abs_limit=int(config.get('component_max_hole_area_px') or 0),
        relative_enabled=bool(config.get('component_hole_relative_area_enabled')),
        relative_limit=float(config.get('component_max_hole_main_ratio') or 0.0),
        require_all=bool(config.get('component_hole_require_all_thresholds', True)),
    )


def _internal_holes(binary: Any) -> tuple[Any, Any, list[int]]:
    import cv2
    import numpy as np

    background = (binary == 0).astype(np.uint8)
    label_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(background, connectivity=8)
    border_labels = set(int(value) for value in labels[0, :])
    border_labels.update(int(value) for value in labels[-1, :])
    border_labels.update(int(value) for value in labels[:, 0])
    border_labels.update(int(value) for value in labels[:, -1])
    holes = [label for label in range(1, label_count) if label not in border_labels]
    return labels, stats, holes


def _component_boundaries(labels: Any, component_labels: list[int]) -> dict[int, Any]:
    import cv2
    import numpy as np

    output: dict[int, Any] = {}
    for label in component_labels:
        component = np.where(labels == label, 255, 0).astype(np.uint8)
        contours, _hierarchy = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        points = [contour.reshape(-1, 2) for contour in contours if contour is not None and len(contour) > 0]
        if points:
            output[label] = np.concatenate(points, axis=0).astype(np.int32)
    return output


def _nearest_boundary_points(first: Any, second: Any) -> tuple[float, tuple[int, int], tuple[int, int]]:
    import numpy as np

    best_distance_sq = float('inf')
    best_first = (0, 0)
    best_second = (0, 0)
    second_float = second.astype(np.float32)
    for start in range(0, len(first), 256):
        chunk = first[start:start + 256].astype(np.float32)
        delta = chunk[:, None, :] - second_float[None, :, :]
        distances = np.sum(delta * delta, axis=2)
        flat_index = int(np.argmin(distances))
        row, column = np.unravel_index(flat_index, distances.shape)
        value = float(distances[row, column])
        if value < best_distance_sq:
            best_distance_sq = value
            best_first = tuple(int(x) for x in chunk[row])
            best_second = tuple(int(x) for x in second[column])
    return max(0.0, math.sqrt(best_distance_sq) - 1.0), best_first, best_second


def _shortest_bridges(binary: Any, occupied: Any, config: dict[str, Any]) -> tuple[Any, Any, int, int, list[dict[str, Any]]]:
    import cv2
    import numpy as np

    label_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    component_labels = list(range(1, label_count))
    empty = np.zeros_like(binary, dtype=bool)
    if len(component_labels) <= 1:
        return binary, empty, 0, 0, []
    boundaries = _component_boundaries(labels, component_labels)
    main_label = max(component_labels, key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
    topology = str(config.get('component_bridge_topology') or 'mst')
    pairs = (
        [(main_label, label) for label in component_labels if label != main_label]
        if topology == 'main_only'
        else [(first, second) for pos, first in enumerate(component_labels) for second in component_labels[pos + 1:]]
    )
    max_gap = float(config.get('component_bridge_max_gap_px') or 0)
    edges: list[tuple[float, int, int, tuple[int, int], tuple[int, int]]] = []
    for first_label, second_label in pairs:
        if first_label not in boundaries or second_label not in boundaries:
            continue
        first_x, first_y, first_width, first_height = [int(value) for value in stats[first_label, :4]]
        second_x, second_y, second_width, second_height = [int(value) for value in stats[second_label, :4]]
        bbox_gap_x = max(0, second_x - (first_x + first_width), first_x - (second_x + second_width))
        bbox_gap_y = max(0, second_y - (first_y + first_height), first_y - (second_y + second_height))
        if math.hypot(bbox_gap_x, bbox_gap_y) > max_gap:
            continue
        gap, first_point, second_point = _nearest_boundary_points(boundaries[first_label], boundaries[second_label])
        if gap <= max_gap:
            edges.append((gap, first_label, second_label, first_point, second_point))
    edges.sort(key=lambda edge: (edge[0], edge[1], edge[2]))

    parents = {label: label for label in component_labels}

    def find(label: int) -> int:
        while parents[label] != label:
            parents[label] = parents[parents[label]]
            label = parents[label]
        return label

    def union(first: int, second: int) -> bool:
        first_root = find(first)
        second_root = find(second)
        if first_root == second_root:
            return False
        parents[second_root] = first_root
        return True

    bridge_mask = np.zeros_like(binary, dtype=np.uint8)
    accepted = 0
    rejected = 0
    details: list[dict[str, Any]] = []
    thickness = int(config.get('component_bridge_width_px') or 1)
    avoid_collisions = bool(config.get('component_gap_avoid_other_instances', True))
    for gap, first_label, second_label, first_point, second_point in edges:
        if find(first_label) == find(second_label):
            continue
        candidate = np.zeros_like(binary, dtype=np.uint8)
        cv2.line(candidate, first_point, second_point, 255, thickness=thickness, lineType=cv2.LINE_8)
        added = (candidate > 0) & (binary == 0) & (bridge_mask == 0)
        if avoid_collisions and bool(np.any(added & occupied)):
            rejected += 1
            details.append({'action': 'bridge_rejected_collision', 'gap_px': gap, 'from': first_label, 'to': second_label})
            continue
        if not union(first_label, second_label):
            continue
        bridge_mask[added] = 255
        accepted += 1
        details.append({'action': 'bridge_added', 'gap_px': gap, 'pixels': int(np.count_nonzero(added)), 'from': first_label, 'to': second_label})
    output = np.where((binary > 0) | (bridge_mask > 0), 1, 0).astype(np.uint8)
    return output, bridge_mask > 0, accepted, rejected, details


def _closing_bridges(binary: Any, occupied: Any, config: dict[str, Any]) -> tuple[Any, Any, int, int, list[dict[str, Any]]]:
    import cv2
    import numpy as np

    before_count, before_labels = cv2.connectedComponents(binary.astype(np.uint8), connectivity=8)
    empty = np.zeros_like(binary, dtype=bool)
    if before_count <= 2:
        return binary, empty, 0, 0, []
    radius = int(config.get('component_closing_radius_px') or 1)
    iterations = int(config.get('component_closing_iterations') or 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    closed = cv2.morphologyEx((binary * 255).astype(np.uint8), cv2.MORPH_CLOSE, kernel, iterations=iterations) > 0
    potential = closed & (binary == 0)
    hole_labels, _hole_stats, holes = _internal_holes(binary)
    if holes:
        potential[np.isin(hole_labels, np.asarray(holes, dtype=hole_labels.dtype))] = False
    added_count, added_labels = cv2.connectedComponents(potential.astype(np.uint8), connectivity=8)
    accepted_mask = np.zeros_like(binary, dtype=bool)
    accepted = 0
    rejected = 0
    details: list[dict[str, Any]] = []
    avoid_collisions = bool(config.get('component_gap_avoid_other_instances', True))
    neighbor_kernel = np.ones((3, 3), dtype=np.uint8)
    for label in range(1, added_count):
        region = added_labels == label
        expanded = cv2.dilate(region.astype(np.uint8), neighbor_kernel, iterations=1) > 0
        touched = set(int(value) for value in np.unique(before_labels[expanded]) if int(value) > 0)
        if len(touched) < 2:
            continue
        if avoid_collisions and bool(np.any(region & occupied)):
            rejected += 1
            details.append({'action': 'closing_rejected_collision', 'pixels': int(np.count_nonzero(region))})
            continue
        accepted_mask |= region
        accepted += 1
        details.append({'action': 'closing_bridge_added', 'pixels': int(np.count_nonzero(region)), 'components_joined': len(touched)})
    output = np.where((binary > 0) | accepted_mask, 1, 0).astype(np.uint8)
    return output, accepted_mask, accepted, rejected, details


def analyze_component_noise_image(
    *,
    base_dir: Path,
    preview_dir: Path,
    project_id: str,
    image: dict[str, Any],
    annotations: list[tuple[int, CanonicalAnnotation]] | list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Analyze one image and stage deterministic topology-cleaned masks."""
    import cv2
    import numpy as np

    image_id = str(image.get('id') or '')
    image_path = Path(str(image.get('abs_path') or ''))
    try:
        with Image.open(image_path) as source:
            image_size = (int(source.width), int(source.height))
    except Exception:
        return {'updates': [], 'skipped': len(annotations), 'skip_reason': 'image_dimensions_unavailable'}

    # Source-compatible adapter for direct algorithm callers. The project
    # engine supplies canonical entries and therefore does not reparse here.
    if annotations and isinstance(annotations[0], dict):
        raw_annotations = annotations
        parsed = parse_image_annotations(
            raw_annotations,
            ParseContext(image_id=image_id, image_width=image_size[0], image_height=image_size[1]),
        )
        by_id = {instance.source_annotation_ids[0]: instance for instance in parsed.instances if len(instance.source_annotation_ids) == 1}
        annotations = [
            (index, by_id[ann_id])
            for index, raw in enumerate(raw_annotations)
            if (ann_id := str(raw.get('id') or '').strip()) in by_id
        ]

    # Load every usable geometry once.  Collision protection can then consider
    # other annotations without changing the per-annotation cleanup semantics.
    sources: list[dict[str, Any] | None] = []
    for _raw_index, ann in annotations:
        if len(ann.source_annotation_ids) != 1:
            sources.append(None)
            continue
        ann_id = ann.source_annotation_ids[0]
        sidecar = annotation_mask_path(base_dir, project_id, image_id, ann_id)
        resolved = resolve_annotation_mask(
            ann, size=image_size, sidecar_path=sidecar, require_multiple_regions=True,
        )
        if resolved is None:
            sources.append(None)
            continue
        sources.append({
            'binary': (np.asarray(resolved.image) > 127).astype(np.uint8),
            'kind': resolved.source_kind,
            'hash': resolved.sha256,
        })

    occupancy_count = np.zeros((image_size[1], image_size[0]), dtype=np.uint16)
    unavailable_geometry_count = 0
    for source_index, source in enumerate(sources):
        _source_raw_index, source_annotation = annotations[source_index]
        occupancy = source['binary'] if source is not None else (
            _polygon_mask(source_annotation, image_size, require_multiple=False)
        )
        if occupancy is None:
            unavailable_geometry_count += 1
            continue
        occupancy_count += (occupancy > 0).astype(np.uint16)

    updates: list[dict[str, Any]] = []
    skipped = 0
    morphology_skipped = 0
    incomplete_collision_checks = 0
    collision_rejected_total = 0
    aggregate_bridged = np.zeros((image_size[1], image_size[0]), dtype=np.uint8)
    aggregate_filled = np.zeros_like(aggregate_bridged)

    for entry_index, (ann_index, ann) in enumerate(annotations):
        wanted = {norm_text(str(name)) for name in config.get('scope_classes', []) if norm_text(str(name))}
        class_name = norm_text(ann.class_name)
        if wanted and class_name not in wanted:
            continue
        source = sources[entry_index] if entry_index < len(sources) else None
        if source is None:
            skipped += 1
            continue
        ann_id = ann.source_annotation_ids[0]
        original = source['binary'].copy()
        if int(np.count_nonzero(original)) == 0:
            skipped += 1
            continue
        working = original.copy()
        decisions: list[dict[str, Any]] = []
        opening_removed_mask = np.zeros_like(working, dtype=bool)

        if config.get('component_opening_enabled'):
            radius = int(config.get('component_opening_radius_px') or 1)
            iterations = int(config.get('component_opening_iterations') or 1)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
            opened = cv2.morphologyEx((working * 255).astype(np.uint8), cv2.MORPH_OPEN, kernel, iterations=iterations) > 0
            opened &= working > 0
            if int(np.count_nonzero(opened)) == 0:
                morphology_skipped += 1
                decisions.append({'action': 'opening_skipped_empty'})
            else:
                opening_removed_mask = (working > 0) & (~opened)
                working = opened.astype(np.uint8)

        original_count = int(cv2.connectedComponents(original, connectivity=8)[0] - 1)
        label_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(working, connectivity=8)
        component_labels = list(range(1, label_count))
        if not component_labels:
            skipped += 1
            continue
        main_label = max(component_labels, key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
        main_area = int(stats[main_label, cv2.CC_STAT_AREA])
        remove_labels: list[int] = []
        component_areas: list[int] = []
        filter_enabled = bool(config.get('component_abs_area_enabled') or config.get('component_relative_area_enabled'))
        for label in component_labels:
            area = int(stats[label, cv2.CC_STAT_AREA])
            component_areas.append(area)
            matched, reasons = _threshold_match(
                area,
                main_area,
                abs_enabled=bool(config.get('component_abs_area_enabled')),
                abs_limit=int(config.get('component_max_area_px') or 0),
                relative_enabled=bool(config.get('component_relative_area_enabled')),
                relative_limit=float(config.get('component_max_main_ratio') or 0.0),
                require_all=bool(config.get('component_require_all_thresholds', True)),
            )
            is_main = label == main_label
            remove = filter_enabled and not is_main and matched
            if remove:
                remove_labels.append(label)
            decisions.append({
                'stage': 'component',
                'area': area,
                'main_ratio': float(area) / float(max(1, main_area)),
                'is_largest': is_main,
                'action': 'remove' if remove else 'keep',
                'reasons': reasons,
            })
        component_removed_mask = (
            np.isin(labels, np.asarray(remove_labels, dtype=labels.dtype))
            if remove_labels else np.zeros_like(working, dtype=bool)
        )
        working[component_removed_mask] = 0
        component_removed_pixels = int(np.count_nonzero(component_removed_mask))

        other_occupancy = np.zeros_like(working, dtype=bool)
        unavailable_other = 0
        gap_component_count = int(cv2.connectedComponents(working, connectivity=8)[0] - 1)
        gap_repair_needed = bool(config.get('component_gap_repair_enabled')) and gap_component_count > 1
        if gap_repair_needed and config.get('component_gap_avoid_other_instances', True):
            own_occupancy = (source['binary'] > 0).astype(np.uint16)
            other_occupancy = (occupancy_count - own_occupancy) > 0
            unavailable_other = unavailable_geometry_count
            if unavailable_other:
                incomplete_collision_checks += 1

        bridge_mask = np.zeros_like(working, dtype=bool)
        bridges_added = 0
        collision_rejected = 0
        if gap_repair_needed:
            if str(config.get('component_gap_repair_method') or 'shortest_bridge') == 'morph_close':
                working, bridge_mask, bridges_added, collision_rejected, bridge_details = _closing_bridges(working, other_occupancy, config)
            else:
                working, bridge_mask, bridges_added, collision_rejected, bridge_details = _shortest_bridges(working, other_occupancy, config)
            decisions.extend(bridge_details)
            collision_rejected_total += collision_rejected

        filled_mask = np.zeros_like(working, dtype=bool)
        filled_holes = 0
        if config.get('component_hole_fill_enabled'):
            foreground_count, _foreground_labels, foreground_stats, _foreground_centroids = cv2.connectedComponentsWithStats(working, connectivity=8)
            foreground_areas = [int(foreground_stats[label, cv2.CC_STAT_AREA]) for label in range(1, foreground_count)]
            hole_main_area = max(foreground_areas) if foreground_areas else int(np.count_nonzero(working))
            hole_labels, hole_stats, holes = _internal_holes(working)
            fill_labels: list[int] = []
            for label in holes:
                area = int(hole_stats[label, cv2.CC_STAT_AREA])
                matched, reasons = _should_fill_hole(area, hole_main_area, config)
                decisions.append({
                    'stage': 'hole',
                    'area': area,
                    'main_ratio': float(area) / float(max(1, hole_main_area)),
                    'action': 'fill' if matched else 'keep',
                    'reasons': reasons,
                })
                if matched:
                    fill_labels.append(label)
            if fill_labels:
                filled_mask = np.isin(hole_labels, np.asarray(fill_labels, dtype=hole_labels.dtype))
                working[filled_mask] = 1
                filled_holes = len(fill_labels)

        final = (working > 0).astype(np.uint8)
        if np.array_equal(final, original):
            skipped += 1
            continue
        polygons_out = _polygons_from_mask((final * 255).astype(np.uint8))
        ys, xs = np.nonzero(final)
        if len(xs) == 0 or not polygons_out:
            skipped += 1
            continue
        final_components = int(cv2.connectedComponents(final, connectivity=8)[0] - 1)
        patch = {
            'mask_url': f'/api/projects/{project_id}/images/{image_id}/masks/{ann_id}.png',
            'polygons': polygons_out,
            'polygon': polygons_out[0],
            'bbox': [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)],
            'area': float(len(xs)),
            'component_count': final_components,
        }
        ok, encoded = cv2.imencode('.png', (final * 255).astype(np.uint8))
        if not ok:
            skipped += 1
            continue
        staged_rel = f'masks/{image_id}/{ann_id}.png'
        _write_png_atomic(preview_dir / staged_rel, encoded.tobytes())
        removed_mask = (original > 0) & (final == 0)
        aggregate_bridged[bridge_mask] = 255
        aggregate_filled[filled_mask] = 255
        updates.append({
            'annotation_index': ann_index,
            'annotation_id': ann_id,
            'source_kind': source['kind'],
            'original_mask_sha256': source['hash'],
            'staged_mask': staged_rel,
            'patch': patch,
            'components_before': original_count,
            'components_after': final_components,
            'removed_components': len(remove_labels),
            'removed_pixels': int(np.count_nonzero(removed_mask)),
            'component_removed_pixels': component_removed_pixels,
            'opening_removed_pixels': int(np.count_nonzero(opening_removed_mask)),
            'bridges_added': bridges_added,
            'bridge_pixels': int(np.count_nonzero(bridge_mask)),
            'filled_holes': filled_holes,
            'filled_pixels': int(np.count_nonzero(filled_mask)),
            'collision_rejected_bridges': collision_rejected,
            'collision_check_incomplete': bool(unavailable_other),
            'component_areas': component_areas,
            'decisions': decisions[:100],
        })

    preview_layers: dict[str, str] = {}
    if updates:
        for layer_name, layer_mask in (('bridged', aggregate_bridged), ('filled', aggregate_filled)):
            if int(np.count_nonzero(layer_mask)) <= 0:
                continue
            ok, encoded = cv2.imencode('.png', layer_mask)
            if not ok:
                continue
            layer_rel = f'layers/{image_id}_{layer_name}.png'
            _write_png_atomic(preview_dir / layer_rel, encoded.tobytes())
            preview_layers[layer_name] = layer_rel
    return {
        'updates': updates,
        'skipped': skipped,
        'morphology_skipped_annotations': morphology_skipped,
        'incomplete_collision_checks': incomplete_collision_checks,
        'collision_rejected_bridges': collision_rejected_total,
        'preview_layers': preview_layers,
    }
