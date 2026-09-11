from __future__ import annotations

import logging
import threading
from time import perf_counter
from typing import Any, Callable

from fastapi import HTTPException

from app.annotations import parse_image_annotations
from app.data_cleaning.artifacts import cleanup_expired_previews, preview_dir
from app.data_cleaning.config import normalize_config
from app.data_cleaning.engine import analyze_project, apply_change_sets, validate_change_sets
from app.data_cleaning.rules import analyze_merge_annotations
from app.schemas import SmartFilterIn
from app.services.job_queue import PersistentJobQueue
from app.utils import new_id, now_ts


def _normalize_smart_filter_payload(payload: SmartFilterIn) -> dict[str, Any]:
    """Compatibility export used by the existing router."""
    return normalize_config(payload)


def _analyze_smart_merge_annotations(
    annotations: list[dict[str, Any]],
    *,
    merge_mode: str = 'same_class',
    spatial_mode: str = 'instance_cover',
    coverage_threshold: float = 0.98,
    canonical_class: str = '',
    source_classes: list[str] | None = None,
    area_mode: str = 'instance',
) -> dict[str, Any]:
    """Legacy synchronous API adapter backed by the rule plug-in."""
    config = {
        'merge_mode': merge_mode,
        'spatial_mode': spatial_mode,
        'coverage_threshold': coverage_threshold,
        'canonical_class': canonical_class,
        'source_classes': source_classes or [],
        'area_mode': area_mode,
    }
    analysis = analyze_merge_annotations(list(parse_image_annotations(annotations).instances), config)
    remove = set(analysis['delete_indices'])
    relabel_by_index = {int(row['annotation_index']): str(row['class_name']) for row in analysis['relabels']}
    kept: list[dict[str, Any]] = []
    relabeled: list[dict[str, Any]] = []
    for index, raw in enumerate(annotations):
        if index in remove:
            continue
        item = dict(raw)
        if index in relabel_by_index:
            item['class_name'] = relabel_by_index[index]
            relabeled.append(dict(item))
        kept.append(item)
    return {
        'pairs': analysis['pairs'],
        'remove_indices': remove,
        'kept_annotations': kept,
        'removed_annotations': [ann for index, ann in enumerate(annotations) if index in remove],
        'relabel_indices': set(relabel_by_index),
        'relabeled_annotations': relabeled,
    }


class SmartFilterJobService:
    """Thin job/API adapter around :mod:`app.data_cleaning`."""

    def __init__(self, *, get_storage: Callable[[], Any], logger: logging.Logger, queue: PersistentJobQueue) -> None:
        self._get_storage = get_storage
        self._logger = logger
        self._lock = threading.Lock()
        self.queue = queue

    @staticmethod
    def _state_default(*, job_id: str, project_id: str, job_type: str) -> dict[str, Any]:
        return {
            'job_id': job_id,
            'project_id': project_id,
            'job_type': job_type,
            'status': 'queued',
            'running': False,
            'message': 'waiting',
            'progress_done': 0,
            'progress_total': 0,
            'progress_pct': 0.0,
            'current_image_id': '',
            'current_image_rel_path': '',
            'started_at': '',
            'updated_at': now_ts(),
            'finished_at': '',
            'error': '',
            'params': {},
            'payload_dict': {},
            'result': {},
        }

    def get_job_state_or_404(self, job_id: str) -> dict[str, Any]:
        state = self.queue.get(job_id)
        if not state or not str(state.get('job_type') or '').startswith('smart_filter:'):
            raise HTTPException(status_code=404, detail='smart filter job not found')
        state['job_type'] = str(state['job_type']).split(':', 1)[1]
        return state

    def get_active_job_for_project(self, project_id: str) -> dict[str, Any] | None:
        state = self.queue.active(project_id, job_prefix='smart_filter:')
        if state:
            state['job_type'] = str(state['job_type']).split(':', 1)[1]
        return state

    @staticmethod
    def _public_rule(config: dict[str, Any]) -> dict[str, Any]:
        return {
            'schema_version': 2,
            'task_type': config['task_type'],
            'class_scope': dict(config['class_scope']),
            'params': dict(config['params']),
        }

    @staticmethod
    def _parse_payload(payload_dict: dict[str, Any]) -> SmartFilterIn:
        return SmartFilterIn(**{key: value for key, value in payload_dict.items() if not key.startswith('_')})

    @staticmethod
    def _summary(task: str, values: dict[str, Any], *, applied: bool = False) -> dict[str, Any]:
        affected = int(values.get('changed_images' if applied else 'image_count') or 0)
        if task == 'delete_unlabeled_images':
            return {'affected_images': affected, 'deleted_images': int(values.get('deleted_images' if applied else 'candidate_count') or 0)}
        if task == 'normalize_classes':
            return {'affected_images': affected, 'relabeled_annotations': int(values.get('relabeled_annotations' if applied else 'relabel_count') or 0), 'deleted_annotations': 0}
        if task in {'remove_small_components', 'remove_edge_spurs', 'shortest_bridge', 'morph_close', 'fill_small_holes'}:
            result = {
                'affected_images': affected,
                'modified_annotations': int(values.get('modified_annotations') or 0),
                'removed_pixels': int(values.get('removed_pixels') or 0),
                'added_pixels': int(values.get('bridge_pixels') or 0) + int(values.get('filled_pixels') or 0),
            }
        return {'affected_images': affected, 'deleted_annotations': int(values.get('removed_annotations' if applied else 'candidate_count') or 0)}

    def run_preview_job(self, payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
        config = normalize_config(self._parse_payload(payload_dict))
        storage = self._get_storage()
        project = storage.get_project(config['project_id'], enrich=False, include_images=True)
        if not project:
            raise RuntimeError('project not found')
        if project.get('project_type') != 'image':
            raise RuntimeError('only image project is supported')

        cleanup_expired_previews(storage.base_dir)
        token = new_id('sfp_')
        analysis = analyze_project(
            base_dir=storage.base_dir,
            preview_token=token,
            project=project,
            config=config,
            load_annotations=storage.load_annotations,
            progress_cb=progress_cb,
        )
        project_rev = int(project.get('content_rev', 1) or 1)
        entry = {
            'preview_token': token,
            'project_id': config['project_id'],
            'project_content_rev': project_rev,
            'signature': config['signature'],
            'config': self._public_rule(config),
            'change_sets': analysis.get('change_sets', []),
            'preview_artwork': dict(analysis.get('preview_artwork') or {}),
        }
        operation = str(config['operation_mode'])
        task = str(config['task_type'])
        if operation == 'component_noise':
            message = (
                f'实例内噪点预览完成：修改 {analysis["modified_annotations"]} 个实例，'
                f'删除 {analysis["removed_components"]} 个分量 / {analysis["removed_pixels"]} 像素'
            )
        elif operation == 'delete_unlabeled':
            message = f'无标注图片预览完成：命中 {analysis["candidate_count"]} 张待删除图片'
        elif operation == 'merge':
            message = f'合并预览完成：删除 {analysis["candidate_count"]} 个标注，改类 {analysis["relabel_count"]} 个标注'
        else:
            message = f'实例清理预览完成：命中 {analysis["candidate_count"]} 个待删除标注'
        return {
            '_preview_entry': entry,
            'project_id': config['project_id'],
            'schema_version': 2,
            'task_type': task,
            'effect_type': str(config['effect_type']),
            'operation_mode': operation,
            'preview_token': token,
            'project_content_rev': project_rev,
            'image_count': int(analysis.get('image_count') or 0),
            'candidate_count': int(analysis.get('candidate_count') or 0),
            'relabel_count': int(analysis.get('relabel_count') or 0),
            'modified_annotations': int(analysis.get('modified_annotations') or 0),
            'removed_components': int(analysis.get('removed_components') or 0),
            'removed_pixels': int(analysis.get('removed_pixels') or 0),
            'opening_removed_pixels': int(analysis.get('opening_removed_pixels') or 0),
            'bridges_added': int(analysis.get('bridges_added') or 0),
            'bridge_pixels': int(analysis.get('bridge_pixels') or 0),
            'filled_holes': int(analysis.get('filled_holes') or 0),
            'filled_pixels': int(analysis.get('filled_pixels') or 0),
            'collision_rejected_bridges': int(analysis.get('collision_rejected_bridges') or 0),
            'morphology_skipped_annotations': int(analysis.get('morphology_skipped_annotations') or 0),
            'incomplete_collision_checks': int(analysis.get('incomplete_collision_checks') or 0),
            'skipped_annotations': int(analysis.get('skipped_annotations') or 0),
            'sample_urls': list(analysis.get('sample_urls') or [])[:1],
            # Typical, high-impact and low-impact samples, bounded to three images.
            'preview_samples': list(analysis.get('preview_samples') or [])[:3],
            'preview_artwork': dict(analysis.get('preview_artwork') or {'version': 1, 'status': 'not_needed'}),
            'items': analysis.get('items', []),
            'hits': analysis.get('items', []),
            'warnings': list(analysis.get('warnings') or []),
            'summary': self._summary(task, analysis),
            'rule': self._public_rule(config),
            'message': message,
        }

    def _find_preview(self, project_id: str, token: str) -> dict[str, Any]:
        for queued_job in self.queue.list_jobs(project_id, limit=100):
            candidate = queued_job.get('preview_entry')
            if isinstance(candidate, dict) and str(candidate.get('preview_token') or '') == token:
                return dict(candidate)
            if str(queued_job.get('preview_token') or '') != token:
                continue
            detailed = self.queue.get(str(queued_job.get('job_id') or '')) or {}
            candidate = detailed.get('preview_entry')
            if isinstance(candidate, dict) and str(candidate.get('preview_token') or '') == token:
                return dict(candidate)
        raise RuntimeError('preview cache is missing; please rerun preview')

    def run_sync_preview(self, payload: SmartFilterIn) -> dict[str, Any]:
        """Compatibility endpoint using the same engine and preview cache."""
        payload_dict = payload.model_dump(exclude_unset=True)
        result = self.run_preview_job(payload_dict, lambda **_updates: None)
        entry = result.pop('_preview_entry')
        cached = self.queue.enqueue(
            project_id=payload.project_id,
            job_type='smart_filter:preview',
            resource_class='cpu',
            payload=payload_dict,
            state={'status': 'done', 'running': False, 'message': 'synchronous preview'},
            priority=100,
        )
        self.queue.update(str(cached['job_id']), preview_entry=entry, status='done', running=False, result=result)
        return result

    def run_sync_apply(self, payload: SmartFilterIn) -> dict[str, Any]:
        payload_dict = payload.model_dump(exclude_unset=True)
        if not str(payload.preview_token or '').strip():
            preview = self.run_sync_preview(payload)
            payload_dict['preview_token'] = str(preview.get('preview_token') or '')
        return self.run_apply_job(payload_dict, lambda **_updates: None)

    def run_apply_job(self, payload_dict: dict[str, Any], progress_cb: Callable[..., None]) -> dict[str, Any]:
        config = normalize_config(self._parse_payload(payload_dict))
        token = str(config.get('preview_token') or '')
        if not token:
            raise RuntimeError('preview_token is required; please run preview first')
        storage = self._get_storage()
        project = storage.get_project(config['project_id'], enrich=False, include_images=False)
        if not project:
            raise RuntimeError('project not found')
        entry = self._find_preview(config['project_id'], token)
        if int(entry.get('project_content_rev') or 0) != int(project.get('content_rev', 1) or 1):
            raise RuntimeError('project annotations changed after preview; please rerun preview')
        if str(entry.get('signature') or '') != str(config.get('signature') or ''):
            raise RuntimeError('filter config changed after preview; please rerun preview')
        artwork = dict(entry.get('preview_artwork') or {})
        if artwork.get('status') == 'failed' and not config.get('confirm_preview_failure'):
            raise RuntimeError('preview artwork failed; explicit confirmation is required before apply')
        change_sets = list(entry.get('change_sets') or [])
        operation = str(config['operation_mode'])

        if operation == 'delete_unlabeled':
            image_ids = [str(change.get('image_id') or '') for change in change_sets if change.get('image_id')]
            deleted = storage.delete_project_images(config['project_id'], image_ids)
            result = {
                'project_id': config['project_id'],
                'schema_version': 2,
                'task_type': config['task_type'],
                'effect_type': config['effect_type'],
                'operation_mode': operation,
                'analysis_reused': True,
                'preview_token': token,
                'rollback_run_id': '',
                'changed_images': int(deleted.get('deleted_images') or 0),
                'deleted_images': int(deleted.get('deleted_images') or 0),
                'deleted_annotation_files': int(deleted.get('deleted_annotation_files') or 0),
                'deleted_image_files': int(deleted.get('deleted_image_files') or 0),
                'failed_deletes': deleted.get('failed_deletes', []),
                'items': deleted.get('items', []),
                'message': f'无标注图片删除完成：删除 {int(deleted.get("deleted_images") or 0)} 张图片',
            }
            result['summary'] = self._summary(str(config['task_type']), result, applied=True)
            return result

        job_id = str(payload_dict.get('_job_id') or '')
        run_id = ''
        started = perf_counter()
        timings = {'validation_seconds': 0.0, 'snapshot_seconds': 0.0, 'persistence_seconds': 0.0}
        with self._lock:
            progress_cb(message='校验预览变更集', progress_done=0, progress_total=len(change_sets))
            validate_change_sets(
                storage=storage,
                project_id=config['project_id'],
                artifact_dir=preview_dir(storage.base_dir, token),
                change_sets=change_sets,
            )
            timings['validation_seconds'] = perf_counter() - started
            if change_sets:
                run_id = storage.begin_smart_filter_run(
                    project_id=config['project_id'], job_id=job_id, operation_mode=operation, rule=dict(entry.get('config') or {})
                )

            def snapshot(image_id: str, annotations: list[dict[str, Any]]) -> None:
                snapshot_started = perf_counter()
                if run_id:
                    storage.add_smart_filter_snapshot(
                        run_id=run_id, project_id=config['project_id'], image_id=image_id, annotations=annotations
                    )
                timings['snapshot_seconds'] += perf_counter() - snapshot_started

            def save_batch(rows: list[tuple[str, list[dict[str, Any]]]]) -> None:
                save_started = perf_counter()
                storage.save_annotations_batch(config['project_id'], rows)
                timings['persistence_seconds'] += perf_counter() - save_started

            try:
                applied = apply_change_sets(
                    storage=storage,
                    project_id=config['project_id'],
                    artifact_dir=preview_dir(storage.base_dir, token),
                    change_sets=change_sets,
                    snapshot_cb=snapshot,
                    progress_cb=progress_cb,
                    batch_save=save_batch if hasattr(storage, 'save_annotations_batch') else None,
                )
            except Exception:
                if run_id:
                    rollback = storage.rollback_smart_filter_run(project_id=config['project_id'], run_id=run_id)
                    if int(rollback.get('skipped_images') or 0) == 0:
                        storage.abort_smart_filter_run(project_id=config['project_id'], run_id=run_id)
                raise
        result = {
            'project_id': config['project_id'],
            'schema_version': 2,
            'task_type': config['task_type'],
            'effect_type': config['effect_type'],
            'operation_mode': operation,
            'analysis_reused': True,
            'preview_token': token,
            'timings': {**timings, 'total_seconds': perf_counter() - started},
            'rollback_run_id': run_id,
            **applied,
            'rule': self._public_rule(config),
            'message': (
                f'实例内噪点已应用：修改 {applied["modified_annotations"]} 个实例，'
                f'删除 {applied["removed_components"]} 个分量 / {applied["removed_pixels"]} 像素'
                if operation == 'component_noise'
                else f'数据清洗已应用：修改 {applied["changed_images"]} 张图片，删除 {applied["removed_annotations"]} 个标注'
            ),
            'summary': self._summary(str(config['task_type']), applied, applied=True),
        }
        if run_id:
            storage.finish_smart_filter_run(run_id=run_id, summary=result)
        return result

    def spawn_job(
        self,
        *,
        project_id: str,
        job_type: str,
        payload_dict: dict[str, Any],
        worker: Callable[[dict[str, Any], Callable[..., None]], dict[str, Any]],
    ) -> dict[str, Any]:
        del worker
        state = self._state_default(job_id='', project_id=project_id, job_type=job_type)
        operation = str(payload_dict.get('task_type') or payload_dict.get('operation_mode') or 'merge')
        labels = {
            'component_noise': '实例内噪点过滤',
            'rule': '小实例/规则清理',
            'merge': '重复/类别合并',
            'delete_unlabeled': '无标注图片删除',
        }
        state['payload_dict'] = dict(payload_dict)
        state['params'] = {'mode_label': f'{labels.get(operation, operation)} {job_type}', 'scope_label': '全部图片'}
        job = self.queue.enqueue(
            project_id=project_id,
            job_type=f'smart_filter:{job_type}',
            resource_class='cpu',
            payload=payload_dict,
            state=state,
            priority=100,
        )
        payload_with_id = dict(payload_dict)
        payload_with_id['_job_id'] = str(job.get('job_id') or '')
        self.queue.update_payload(str(job.get('job_id') or ''), payload_with_id)
        return job

    def count_running_jobs(self) -> int:
        return self.queue.count_running(job_prefix='smart_filter:')
