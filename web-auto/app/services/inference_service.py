from __future__ import annotations

import time
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.schemas import InferBatchIn, InferJobResumeIn
from app.services.inference_jobs import InferenceJobService, InferJobPaused
from app.services.inference_results import _convert_detections, _replace_by_classes
from app.services.inference_visual_prompts import (
    _filter_negative_only,
    _filter_visual_detections,
    _has_positive_visual_prompt,
    _merge_visual_annotations,
    _pick_by_positive_points,
    _reduce_points_to_single_instance,
)
from app.storage import Storage


class InferenceService:
    def __init__(
        self,
        *,
        get_storage: Callable[[], Storage],
        sam3: Any,
        infer_jobs: InferenceJobService,
        default_api_base_url: str,
        max_batch_files: int,
        max_pending_image_ids: int,
    ) -> None:
        self._get_storage = get_storage
        self._sam3 = sam3
        self._infer_jobs = infer_jobs
        self._default_api_base_url = default_api_base_url
        self._max_batch_files = max(1, int(max_batch_files or 1))
        self._max_pending_image_ids = max(1, int(max_pending_image_ids or 1))

    @property
    def storage(self) -> Storage:
        return self._get_storage()

    def _chunked(self, items: list[Any], size: int) -> list[list[Any]]:
        chunk_size = max(1, int(size))
        return [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]

    def _requested_batch_size(self, raw: Any) -> int:
        try:
            return max(1, int(raw or 1))
        except (TypeError, ValueError):
            return 1

    def _effective_sam3_batch_size(self, raw: Any) -> int:
        return min(self._requested_batch_size(raw), self._max_batch_files)

    @staticmethod
    def _remote_with_retries(call: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt, delay in enumerate((0.0, 1.0, 5.0), start=1):
            if delay > 0:
                time.sleep(delay)
            try:
                return call()
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt >= 3:
                    raise
        assert last_error is not None
        raise last_error

    def _infer_job_image_ids(self, items: list[dict[str, Any]], *, limit: int = 0) -> list[str]:
        out: list[str] = []
        for image in items:
            image_id = str(image.get('id') or '').strip()
            if image_id:
                out.append(image_id)
                if limit > 0 and len(out) >= limit:
                    break
        return out

    def _pending_image_progress_payload(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        pending_count = len(items)
        return {
            'pending_image_ids': self._infer_job_image_ids(items, limit=self._max_pending_image_ids),
            'pending_image_count': pending_count,
            'pending_image_ids_truncated': pending_count > self._max_pending_image_ids,
        }

    def _merge_infer_resume_payload(
        self,
        job_type: str,
        base_payload: dict[str, Any],
        overrides: dict[str, Any],
    ) -> dict[str, Any]:
        payload = dict(base_payload if isinstance(base_payload, dict) else {})

        if 'threshold' in overrides and overrides.get('threshold') is not None:
            payload['threshold'] = float(overrides['threshold'])
        if 'batch_size' in overrides and overrides.get('batch_size') is not None:
            payload['batch_size'] = max(1, int(overrides['batch_size']))
        if 'api_base_url' in overrides and overrides.get('api_base_url') is not None:
            payload['api_base_url'] = str(overrides['api_base_url'] or '').strip() or self._default_api_base_url

        if job_type == 'text_batch':
            if 'classes' in overrides and overrides.get('classes') is not None:
                payload['classes'] = [str(x).strip() for x in overrides.get('classes', []) if str(x).strip()]
            return payload

        return payload

    def _get_project_or_404(
        self,
        project_id: str,
        *,
        enrich: bool = False,
        include_images: bool = True,
    ) -> dict[str, Any]:
        project = self.storage.get_project(project_id, enrich=enrich, include_images=include_images)
        if not project:
            raise HTTPException(status_code=404, detail='project not found')
        return project

    def _get_image_or_404(self, project: dict[str, Any], image_id: str) -> dict[str, Any]:
        img = self.storage.find_image(project, image_id)
        if not img:
            raise HTTPException(status_code=404, detail='image not found')
        return img

    def resume_infer_job(self, payload: InferJobResumeIn) -> dict[str, Any]:
        project = self._get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='infer resume currently supports image project only')

        paused = self._infer_jobs.get_latest_job_for_project(payload.project_id, statuses={'paused'})
        if not paused:
            raise HTTPException(status_code=409, detail='no paused infer job found for this project')

        job_type = str(paused.get('job_type') or '').strip().lower()
        pending_image_ids = [str(x).strip() for x in paused.get('pending_image_ids', []) if str(x).strip()]
        pending_count = max(0, int(paused.get('pending_image_count') or len(pending_image_ids)))
        pending_truncated = bool(paused.get('pending_image_ids_truncated'))
        if pending_count <= 0:
            raise HTTPException(status_code=409, detail='paused infer job has no remaining images to continue')

        overrides = payload.model_dump(exclude_unset=True, exclude_none=True)
        merged = self._merge_infer_resume_payload(job_type, paused.get('payload_dict') or {}, overrides)

        if job_type == 'text_batch':
            scope = str(merged.get('scope_mode') or 'all').strip().lower()
            if pending_truncated:
                if scope not in {'unlabeled', 'class_related', 'class_related_unlabeled'}:
                    raise HTTPException(
                        status_code=409,
                        detail='paused job has too many remaining images to resume exactly; start a new "unlabeled only" job instead',
                    )
                merged['image_ids'] = []
                merged['retry_image_ids'] = []
            else:
                merged['image_ids'] = pending_image_ids
            merged['all_images'] = False
            job = self._infer_jobs.spawn_job(
                project_id=payload.project_id,
                job_type='text_batch',
                payload_dict=merged,
                existing_job_id=str(paused.get('job_id') or ''),
                worker=lambda data, progress_cb, should_stop, resume_state: self.run_infer_batch(
                    InferBatchIn(**data),
                    progress_cb=progress_cb,
                    should_stop=should_stop,
                    resume_state=resume_state,
                ),
            )
            return {'job': job}

        raise HTTPException(status_code=400, detail=f'unsupported paused infer job type: {job_type}')

    def _prepare_example_prompt_boxes(
        self,
        *,
        image: dict[str, Any],
        boxes: list[list[float | int]],
    ) -> list[list[float]]:
        del image
        norm_boxes = self._normalize_prompt_boxes(boxes)
        if not norm_boxes:
            raise HTTPException(status_code=400, detail='example preview requires boxes')
        if not _has_positive_visual_prompt([], norm_boxes):
            raise HTTPException(status_code=400, detail='example boxes require at least one positive prompt')
        return norm_boxes

    def infer_single(
        self,
        *,
        project: dict[str, Any],
        image: dict[str, Any],
        mode: str,
        classes: list[str],
        active_class: str,
        points: list[list[float | int]],
        boxes: list[list[float | int]],
        threshold: float,
        api_base_url: str,
        save_result: bool = True,
    ) -> dict[str, Any]:
        final_classes = [str(c).strip() for c in classes if str(c).strip()]
        if not final_classes:
            final_classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]

        infer_mode = str(mode).strip().lower()
        if infer_mode == 'text':
            if not final_classes:
                raise HTTPException(status_code=400, detail='no classes selected')
            prompt = ', '.join(final_classes)
            forced_class = ''
            impacted_classes = final_classes
            infer_points = []
            infer_boxes = []
        elif infer_mode == 'points':
            if not points:
                raise HTTPException(status_code=400, detail='points mode requires points')
            if not _has_positive_visual_prompt(points, []):
                raise HTTPException(status_code=400, detail='points mode requires at least one positive prompt')
            active_hint = str(active_class).strip()
            forced_class = active_hint or 'unknown'
            prompt = ''
            impacted_classes = []
            infer_points = points
            infer_boxes = []
        elif infer_mode == 'boxes':
            if not boxes:
                raise HTTPException(status_code=400, detail='boxes mode requires boxes')
            if not _has_positive_visual_prompt([], boxes):
                raise HTTPException(status_code=400, detail='boxes mode requires at least one positive prompt')
            active_hint = str(active_class).strip()
            forced_class = active_hint or 'unknown'
            prompt = ''
            impacted_classes = []
            infer_points = []
            infer_boxes = boxes
        else:
            raise HTTPException(status_code=400, detail='mode must be text/points/boxes')

        def _run_once(
            *,
            point_box_size: float | None = None,
            threshold_value: float | None = None,
        ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
            result_local = self._sam3.infer(
                api_base_url=api_base_url,
                image_path=str(image.get('abs_path') or ''),
                mode=infer_mode,
                prompt=prompt,
                threshold=float(threshold if threshold_value is None else threshold_value),
                points=infer_points,
                boxes=infer_boxes,
                point_box_size=point_box_size,
                include_mask_png=True,
            )
            detections_local = result_local.get('detections', [])
            detections_local = detections_local if isinstance(detections_local, list) else []
            converted_local = _convert_detections(
                detections=detections_local,
                classes=final_classes,
                forced_class=forced_class,
            )
            return result_local, converted_local

        def _apply_visual_scope(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
            if infer_mode not in {'points', 'boxes'}:
                return list(detections)
            return _filter_visual_detections(detections, points=infer_points, boxes=infer_boxes)

        if infer_mode == 'points':
            result, converted_unfiltered = _run_once(point_box_size=0.12)
            converted = _apply_visual_scope(converted_unfiltered)
            if not converted:
                retry_threshold = max(0.2, float(threshold) * 0.8)
                result_retry, converted_retry_unfiltered = _run_once(point_box_size=0.22, threshold_value=retry_threshold)
                converted_retry = _apply_visual_scope(converted_retry_unfiltered)
                if converted_retry:
                    result, converted_unfiltered, converted = result_retry, converted_retry_unfiltered, converted_retry
        else:
            result, converted_unfiltered = _run_once()
            converted = _apply_visual_scope(converted_unfiltered)

        converted_all = list(converted_unfiltered)
        if infer_mode == 'points' and not converted:
            fallback_pool = _filter_negative_only(converted_all, points=infer_points, boxes=infer_boxes)
            converted = _pick_by_positive_points(fallback_pool, points=infer_points)
        if infer_mode == 'points':
            converted = _reduce_points_to_single_instance(converted, points=infer_points)

        storage = self.storage
        project_id = str(project.get('id'))
        image_id = str(image.get('id'))
        if save_result:
            old = storage.load_annotations(project_id, image_id)
            if infer_mode == 'text':
                merged = _replace_by_classes(
                    old_annotations=old,
                    impacted_classes=impacted_classes,
                    new_annotations=converted,
                )
            else:
                merged = _merge_visual_annotations(
                    old,
                    new_annotations=converted,
                    points=infer_points,
                    boxes=infer_boxes,
                )
            storage.save_annotations(project_id, image_id, merged)
            merged = storage.load_annotations(project_id, image_id)
        else:
            merged = storage.load_annotations(project_id, image_id)

        return {
            'result': result,
            'detections': converted,
            'saved_annotations': merged,
            'impacted_classes': impacted_classes,
        }

    def infer_example_preview(
        self,
        *,
        project: dict[str, Any],
        image: dict[str, Any],
        active_class: str,
        boxes: list[list[float | int]],
        threshold: float,
        api_base_url: str,
    ) -> dict[str, Any]:
        active = str(active_class or '').strip()
        if not active:
            raise HTTPException(status_code=400, detail='active_class is required for example preview')
        prompt_boxes = self._prepare_example_prompt_boxes(
            image=image,
            boxes=boxes,
        )

        try:
            result = self._sam3.infer(
                api_base_url=api_base_url,
                image_path=str(image.get('abs_path') or ''),
                mode='boxes',
                prompt='',
                boxes=prompt_boxes,
                threshold=float(threshold),
                include_mask_png=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f'remote visual inference failed: {exc}') from exc

        detections = result.get('detections', [])
        detections = detections if isinstance(detections, list) else []
        converted = _convert_detections(detections=detections, classes=[active], forced_class=active)
        merged = self.storage.load_annotations(str(project.get('id')), str(image.get('id')))
        return {
            'result': result,
            'detections': converted,
            'saved_annotations': merged,
            'impacted_classes': [active],
        }

    def _select_text_batch_target_images(
        self,
        project: dict[str, Any],
        payload: InferBatchIn,
        *,
        impacted_classes: list[str],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        project_id = str(project.get('id') or payload.project_id or '').strip()
        scope_mode = str(payload.scope_mode or 'all').strip().lower()
        retry_image_ids = [str(x).strip() for x in payload.retry_image_ids if str(x).strip()]
        explicit_ids = [str(x).strip() for x in payload.image_ids if str(x).strip()]
        related_classes = [str(x).strip() for x in payload.related_classes if str(x).strip()]
        if not related_classes:
            related_classes = [str(x).strip() for x in impacted_classes if str(x).strip()]

        reason = 'all_images'
        if retry_image_ids:
            target_images = self.storage.get_project_images_for_infer_scope(project_id, image_ids=retry_image_ids)
            reason = 'retry_image_ids'
        elif explicit_ids and not payload.all_images:
            target_images = self.storage.get_project_images_for_infer_scope(project_id, image_ids=explicit_ids)
            reason = 'explicit_image_ids'
        elif payload.all_images or scope_mode == 'all':
            target_images = self.storage.get_project_images_for_infer_scope(project_id, scope_mode='all')
            reason = 'all_images'
        elif scope_mode == 'unlabeled':
            target_images = self.storage.get_project_images_for_infer_scope(project_id, scope_mode='unlabeled')
            reason = 'unlabeled_only'
        else:
            target_images = self.storage.get_project_images_for_infer_scope(
                project_id,
                scope_mode=scope_mode,
                related_classes=related_classes,
            )
            reason = scope_mode

        return target_images, {
            'scope_mode': scope_mode,
            'reason': reason,
            'related_classes': related_classes,
            'requested_selector_count': len(retry_image_ids or explicit_ids),
            'selector_backend': 'sqlite',
        }

    def run_infer_batch(
        self,
        payload: InferBatchIn,
        *,
        progress_cb: Optional[Callable[..., None]] = None,
        should_stop: Optional[Callable[[], bool]] = None,
        resume_state: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        project = self._get_project_or_404(payload.project_id, include_images=False)
        if project.get('project_type') != 'image':
            raise HTTPException(status_code=400, detail='batch infer currently supports image project only')

        classes = [str(c).strip() for c in payload.classes if str(c).strip()]
        if not classes:
            classes = [str(c).strip() for c in project.get('classes', []) if str(c).strip()]
        if not classes:
            raise HTTPException(status_code=400, detail='no classes selected')

        target_images, selection_meta = self._select_text_batch_target_images(project, payload, impacted_classes=classes)
        if not target_images:
            raise HTTPException(status_code=400, detail='no target images')

        requested_batch_size = self._requested_batch_size(payload.batch_size)
        batch_size = self._effective_sam3_batch_size(payload.batch_size)
        prior = resume_state if isinstance(resume_state, dict) else {}
        succeeded = max(0, int(prior.get('succeeded') or 0))
        failed = max(0, int(prior.get('failed') or 0))
        skipped = max(0, int(prior.get('skipped') or 0))
        total_new = max(0, int(prior.get('new_annotations') or 0))
        errors = list(prior.get('errors', [])) if isinstance(prior.get('errors'), list) else []
        failed_image_ids = [str(x).strip() for x in prior.get('failed_image_ids', []) if str(x).strip()]
        skipped_image_ids = [str(x).strip() for x in prior.get('skipped_image_ids', []) if str(x).strip()]
        image_results = list(prior.get('image_results', [])) if isinstance(prior.get('image_results'), list) else []
        completed_image_ids = {
            str(item.get('image_id') or '').strip()
            for item in image_results
            if isinstance(item, dict) and str(item.get('status') or '') == 'saved'
        }
        if completed_image_ids:
            target_images = [
                image for image in target_images
                if str(image.get('id') or '').strip() not in completed_image_ids
            ]
        class_additions = dict(prior.get('class_additions', {})) if isinstance(prior.get('class_additions'), dict) else {}
        processed = max(0, int(prior.get('progress_done') or 0))
        total = max(int(prior.get('progress_total') or 0), processed + len(target_images))
        prompt = ', '.join(classes)
        pending_images = list(target_images)

        def emit_progress(**extra: Any) -> None:
            if not progress_cb:
                return
            progress_cb(
                requested=total,
                batch_size=batch_size,
                requested_batch_size=requested_batch_size,
                max_remote_batch_size=self._max_batch_files,
                succeeded=succeeded,
                failed=failed,
                skipped=skipped,
                new_annotations=total_new,
                failed_image_ids=failed_image_ids,
                skipped_image_ids=skipped_image_ids,
                class_additions=class_additions,
                image_results=image_results,
                selection=selection_meta,
                **self._pending_image_progress_payload(pending_images),
                **extra,
            )

        emit_progress(
            message=f'Preparing text batch inference, remaining {len(target_images)} images',
            progress_done=processed,
            progress_total=total,
        )

        for batch_images in self._chunked(target_images, batch_size):
            if should_stop and should_stop():
                emit_progress(
                    status='paused',
                    message='Paused. Adjust parameters and resume when ready.',
                    progress_done=processed,
                    progress_total=total,
                )
                raise InferJobPaused('Paused. Adjust parameters and resume when ready.')

            batch_paths = [str(img.get('abs_path') or '') for img in batch_images]
            try:
                batch_result = self._remote_with_retries(
                    lambda: self._sam3.infer_batch(
                        api_base_url=payload.api_base_url,
                        image_paths=batch_paths,
                        mode='text',
                        prompt=prompt,
                        threshold=payload.threshold,
                        include_mask_png=True,
                    )
                )
                items = batch_result.get('items', [])
                if not isinstance(items, list) or len(items) != len(batch_images):
                    raise RuntimeError(
                        f'remote batch result count mismatch: {len(items) if isinstance(items, list) else "invalid"} != {len(batch_images)}'
                    )
            except Exception as exc:  # noqa: BLE001
                for image in batch_images:
                    processed += 1
                    failed += 1
                    image_id = str(image.get('id') or '')
                    rel_path = str(image.get('rel_path') or image_id)
                    errors.append({'image_id': image_id, 'error': str(exc)})
                    failed_image_ids.append(image_id)
                    image_results.append(
                        {
                            'image_id': image_id,
                            'rel_path': rel_path,
                            'status': 'failed',
                            'reason': 'remote_batch_error',
                            'new_annotations': 0,
                            'error': str(exc),
                        }
                    )
                    if pending_images:
                        pending_images.pop(0)
                    emit_progress(
                        message=f'Failed {processed}/{total}: {rel_path}',
                        progress_done=processed,
                        progress_total=total,
                        current_image_id=image_id,
                        current_image_rel_path=rel_path,
                    )
                continue

            for image, item in zip(batch_images, items):
                if should_stop and should_stop():
                    emit_progress(
                        status='paused',
                        message='Paused. Adjust parameters and resume when ready.',
                        progress_done=processed,
                        progress_total=total,
                    )
                    raise InferJobPaused('Paused. Adjust parameters and resume when ready.')

                processed += 1
                image_id = str(image.get('id') or '')
                rel_path = str(image.get('rel_path') or image_id)
                message = f'Processing {processed}/{total}: {rel_path}'
                try:
                    if not isinstance(item, dict):
                        raise RuntimeError('remote batch item is not an object')
                    if not bool(item.get('ok', False)):
                        raise RuntimeError(str(item.get('error') or 'remote batch item failed'))
                    result = item.get('result', {})
                    if not isinstance(result, dict):
                        raise RuntimeError('remote batch item result is invalid')
                    detections = result.get('detections', [])
                    detections = detections if isinstance(detections, list) else []
                    converted = _convert_detections(detections=detections, classes=classes, forced_class='')
                    old = self.storage.load_annotations(payload.project_id, image_id)
                    merged = _replace_by_classes(
                        old_annotations=old,
                        impacted_classes=classes,
                        new_annotations=converted,
                    )
                    self.storage.save_annotations(payload.project_id, image_id, merged)
                    succeeded += 1
                    total_new += len(converted)
                    for ann in converted:
                        cls = str(ann.get('class_name') or '').strip()
                        if cls:
                            class_additions[cls] = int(class_additions.get(cls, 0) or 0) + 1
                    image_results.append(
                        {
                            'image_id': image_id,
                            'rel_path': rel_path,
                            'status': 'saved',
                            'reason': 'ok',
                            'new_annotations': len(converted),
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    message = f'Failed {processed}/{total}: {rel_path}'
                    errors.append({'image_id': image_id, 'error': str(exc)})
                    failed_image_ids.append(image_id)
                    image_results.append(
                        {
                            'image_id': image_id,
                            'rel_path': rel_path,
                            'status': 'failed',
                            'reason': 'save_failed',
                            'new_annotations': 0,
                            'error': str(exc),
                        }
                    )
                if pending_images:
                    pending_images.pop(0)
                emit_progress(
                    message=message,
                    progress_done=processed,
                    progress_total=total,
                    current_image_id=image_id,
                    current_image_rel_path=rel_path,
                )

        summary = (
            f'Text batch complete: success {succeeded}, failed {failed}, skipped {skipped}, new {total_new}, batch={batch_size}'
            if failed > 0 or skipped > 0
            else f'Text batch complete: success {succeeded}, new {total_new}, batch={batch_size}'
        )
        return {
            'project_id': payload.project_id,
            'requested': total,
            'processed_images': processed,
            'saved_images': succeeded,
            'failed_images': failed,
            'skipped_images': skipped,
            'requested_batch_size': requested_batch_size,
            'batch_size': batch_size,
            'max_remote_batch_size': self._max_batch_files,
            'succeeded': succeeded,
            'failed': failed,
            'skipped': skipped,
            'new_annotations': total_new,
            'errors': errors,
            'failed_image_ids': failed_image_ids,
            'skipped_image_ids': skipped_image_ids,
            'retry_image_ids': failed_image_ids + skipped_image_ids,
            'class_additions': class_additions,
            'image_results': image_results,
            'selection': selection_meta,
            'message': summary,
        }


    def _normalize_prompt_boxes(self, raw: Any) -> list[list[float]]:
        boxes: list[list[float]] = []
        if not isinstance(raw, list):
            return boxes
        for item in raw:
            if not isinstance(item, list) or len(item) < 4:
                continue
            try:
                x1, y1, x2, y2 = [float(item[i]) for i in range(4)]
            except (TypeError, ValueError):
                continue
            label = 1.0
            if len(item) >= 5:
                try:
                    label = float(item[4])
                except (TypeError, ValueError):
                    label = 1.0
            if x2 < x1:
                x1, x2 = x2, x1
            if y2 < y1:
                y1, y2 = y2, y1
            if x2 <= x1 or y2 <= y1:
                continue
            boxes.append([x1, y1, x2, y2, label])
        return boxes
