import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnnotationStore } from './annotationStore';
import { useAiAssistantStore } from './aiAssistantStore';
import { useProjectStore } from './projectStore';
import { useViewerStore } from './viewerStore';

const candidate = {
  bbox: [1, 2, 20, 30] as [number, number, number, number],
  polygon: [[1, 2], [20, 2], [20, 30]] as [number, number][],
  polygons: [[[1, 2], [20, 2], [20, 30]]] as [number, number][][],
  area: 266,
  score: 0.91,
};

describe('AI mask acceptance', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useProjectStore.getState().setProjectId('project-1');
    useProjectStore.getState().setClasses(['chair']);
    useViewerStore.getState().reset();
    useAnnotationStore.getState().reset();
    useAiAssistantStore.getState().reset();
    expect(useAiAssistantStore.getState().operationMode).toBe('new');
    useAnnotationStore.getState().setAutosaveEnabled(false);
  });

  afterEach(() => {
    useAnnotationStore.getState().clearSaveTimer();
  });

  it('adds an accepted SAM3 mask to history without saving a draft first', () => {
    useAnnotationStore.getState().resetForImage('image-1', []);
    useAnnotationStore.getState().acceptAiCandidate(candidate, '', 'chair');

    const annotation = useAnnotationStore.getState().annotations[0];
    expect(annotation.source_model).toBe('sam3');
    expect(annotation.accepted_by).toBe('manual');
    expect(annotation.polygons).toEqual(candidate.polygons);
    expect(useAnnotationStore.getState().dirty).toBe(true);

    useAnnotationStore.getState().undo();
    expect(useAnnotationStore.getState().annotations).toEqual([]);
  });

  it('maps a legacy manual annotation into SAM3 while retaining the edit audit', () => {
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'manual-1',
      class_name: 'chair',
      bbox: [0, 0, 5, 5],
      source_model: 'manual',
    }]);

    useAnnotationStore.getState().acceptAiCandidate(candidate, 'manual-1', 'chair');

    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    const annotation = useAnnotationStore.getState().annotations[0];
    expect(annotation.id).toBe('manual-1');
    expect(annotation.source_model).toBe('sam3');
    expect(annotation.ai_assisted_by).toBe('sam3');
    expect(annotation.modified_by).toBe('manual');
    expect(annotation.bbox).toEqual(candidate.bbox);
  });

  it('keeps canvas point markers aligned with prompt undo and redo', () => {
    const viewer = useViewerStore.getState();
    viewer.addPrompt('point', [10, 20, 1]);
    viewer.addPrompt('point', [30, 40, 0]);

    useViewerStore.getState().undoPrompt();
    expect(useViewerStore.getState().currentPrompts).toHaveLength(1);
    expect(useViewerStore.getState().currentPrompts[0].label).toBe(1);

    useViewerStore.getState().redoPrompt();
    expect(useViewerStore.getState().currentPrompts).toHaveLength(2);
    expect(useViewerStore.getState().currentPrompts[1].label).toBe(0);
  });

  it('rejects annotation and prompt mutations while the workspace is read-only', async () => {
    useAnnotationStore.getState().resetForImage('image-1', [{
      id: 'model-1',
      class_name: 'chair',
      bbox: [0, 0, 20, 20],
      source_model: 'sam3',
    }]);
    useAnnotationStore.getState().setEditingEnabled(false);
    useViewerStore.getState().setEditable(false);

    useViewerStore.getState().setPromptMode('manual-box');
    useViewerStore.getState().addPrompt('point', [10, 10, 1]);
    useAnnotationStore.getState().deleteAnnotation('model-1');
    useAnnotationStore.getState().clearAnnotations();
    useAnnotationStore.getState().handleGeometryUpdated('model-1', { bbox: [5, 5, 30, 30] });
    const saved = await useAnnotationStore.getState().saveCurrent();

    expect(useViewerStore.getState().promptMode).toBe('none');
    expect(useViewerStore.getState().currentPrompts).toEqual([]);
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    expect(useAnnotationStore.getState().annotations[0].bbox).toEqual([0, 0, 20, 20]);
    expect(useAnnotationStore.getState().dirty).toBe(false);
    expect(saved).toBe(false);
  });
});
