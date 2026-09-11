import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveAnnotations } = vi.hoisted(() => ({
  saveAnnotations: vi.fn(async (): Promise<{ ok: boolean; saved_annotations?: unknown[] }> => ({ ok: true })),
}));

vi.mock('../../api/annotations', () => ({
  saveAnnotations,
}));

import { useAnnotationStore } from './annotationStore';
import { useNavigationGuardStore } from './navigationGuardStore';
import { useProjectStore } from './projectStore';
import { useViewerStore } from './viewerStore';

describe('annotation save flow', () => {
  beforeEach(() => {
    saveAnnotations.mockClear();
    useProjectStore.getState().reset();
    useProjectStore.getState().setProjectId('project-1');
    useProjectStore.getState().setClasses(['chair']);
    useViewerStore.getState().reset();
    useAnnotationStore.getState().reset();
    useAnnotationStore.getState().resetForImage('image-1', []);
  });

  it('saves each completed operation and waits before navigation', async () => {
    useAnnotationStore.getState().createAnnotation({ bbox: [1, 2, 10, 12] }, 'chair');

    expect(useAnnotationStore.getState().saveStatus).toBe('pending');
    expect(await useAnnotationStore.getState().prepareForNavigation()).toBe(true);
    expect(saveAnnotations).toHaveBeenCalledTimes(1);
    expect(saveAnnotations).toHaveBeenCalledWith(
      'project-1',
      'image-1',
      expect.arrayContaining([expect.objectContaining({ class_name: 'chair' })]),
    );
    expect(useAnnotationStore.getState().dirty).toBe(false);
    expect(useAnnotationStore.getState().saveStatus).toBe('saved');
  });

  it('creates a fixed-field annotation in the currently selected result layer', () => {
    useAnnotationStore.getState().setAutosaveEnabled(false);
    useAnnotationStore.getState().setSourceFilter('locate-anything');
    useAnnotationStore.getState().createAnnotation({ bbox: [1, 2, 10, 12] }, 'chair');

    const annotation = useAnnotationStore.getState().annotations[0];
    expect(annotation.source_model).toBe('locate-anything');
    expect(annotation.source).toBeUndefined();
    expect(annotation.polygon).toEqual([]);
    expect(annotation.polygons).toEqual([]);
    expect(annotation.mask_url).toBe('');
  });

  it('keeps an edited SAM3 record in SAM3 and invalidates stale mask geometry', () => {
    useAnnotationStore.getState().setAutosaveEnabled(false);
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'sam-mask', class_name: 'chair', bbox: [0, 0, 10, 10],
      polygon: [[0, 0], [10, 0], [10, 10]], source_model: 'sam3', mask_url: '/old.png',
    }]);
    useAnnotationStore.getState().handleGeometryUpdated('sam-mask', {
      bbox: [1, 1, 11, 11], polygon: [[1, 1], [11, 1], [11, 11]],
    });

    const annotation = useAnnotationStore.getState().annotations[0];
    expect(annotation.source_model).toBe('sam3');
    expect(annotation.source).toBeUndefined();
    expect(annotation.mask_url).toBe('');
    expect(annotation.__invalidate_mask).toBe(true);
    expect(annotation.modified_by).toBe('manual');
  });

  it('replaces transient edit markers with the normalized save response', async () => {
    saveAnnotations.mockResolvedValueOnce({
      ok: true,
      saved_annotations: [{
        schema_version: 3, id: 'sam-mask', class_name: 'chair', raw_label: 'chair',
        bbox: [1, 1, 11, 11], polygon: [[1, 1], [11, 1], [11, 11]],
        polygons: [[[1, 1], [11, 1], [11, 11]]], area: 50, mask_url: '',
        overlay_url: '/overlay.webp', source_model: 'sam3', component_count: 1,
        edited: true, modified_by: 'manual', accepted_by: '', ai_assisted_by: '',
        created_at: '', updated_at: '', score: 1,
      }],
    });
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'sam-mask', class_name: 'chair', bbox: [0, 0, 10, 10],
      polygon: [[0, 0], [10, 0], [10, 10]], source_model: 'sam3', mask_url: '/old.png',
    }]);
    useAnnotationStore.getState().handleGeometryUpdated('sam-mask', {
      bbox: [1, 1, 11, 11], polygon: [[1, 1], [11, 1], [11, 11]],
    });

    expect(await useAnnotationStore.getState().prepareForNavigation()).toBe(true);
    const annotation = useAnnotationStore.getState().annotations[0];
    expect(annotation.__invalidate_mask).toBeUndefined();
    expect(annotation.__geometry_edited).toBeUndefined();
    expect(annotation.overlay_url).toBe('/overlay.webp');
  });

  it('manual mode can discard and switch without persisting the operation', async () => {
    useAnnotationStore.getState().setAutosaveEnabled(false);
    useAnnotationStore.getState().createAnnotation({ bbox: [1, 2, 10, 12] }, 'chair');

    const decision = useAnnotationStore.getState().prepareForNavigation();
    expect(useNavigationGuardStore.getState().open).toBe(true);
    useNavigationGuardStore.getState().decide('discard');

    expect(await decision).toBe(true);
    expect(saveAnnotations).not.toHaveBeenCalled();
    expect(useAnnotationStore.getState().annotations).toEqual([]);
    expect(useAnnotationStore.getState().dirty).toBe(false);
  });

  it('manual mode can save and switch from the same navigation dialog', async () => {
    useAnnotationStore.getState().setAutosaveEnabled(false);
    useAnnotationStore.getState().createAnnotation({ bbox: [1, 2, 10, 12] }, 'chair');

    const decision = useAnnotationStore.getState().prepareForNavigation();
    useNavigationGuardStore.getState().decide('save');

    expect(await decision).toBe(true);
    expect(saveAnnotations).toHaveBeenCalledTimes(1);
    expect(useAnnotationStore.getState().dirty).toBe(false);
  });
});
