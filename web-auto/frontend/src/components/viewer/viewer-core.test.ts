import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../api/types';
import { ImageViewerCore } from './viewer-core';

describe('ImageViewerCore canvas pointer policy', () => {
  let container: HTMLDivElement;
  let viewer: ImageViewerCore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    viewer = new ImageViewerCore(container);
    (viewer as unknown as { image: { width: number; height: number } }).image = { width: 100, height: 100 };
  });

  afterEach(() => {
    viewer.destroy();
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('blocks the browser context menu and opens the explicit AI action menu', () => {
    const added = vi.fn();
    const opened = vi.fn();
    viewer.onPromptAdded = added;
    viewer.onCanvasContextMenu = opened;
    viewer.setPromptMode('point');
    const canvas = container.querySelectorAll('canvas')[1];

    const down = new MouseEvent('mousedown', { button: 2, detail: 1, bubbles: true, cancelable: true });
    canvas.dispatchEvent(down);
    const contextMenu = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
    canvas.dispatchEvent(contextMenu);

    expect(down.defaultPrevented).toBe(true);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(added).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('uses the explicitly selected point label for a left click', () => {
    const added = vi.fn();
    viewer.onPromptAdded = added;
    viewer.setPromptMode('point');
    viewer.setPointPromptLabel(0);
    const canvas = container.querySelectorAll('canvas')[1];

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(220);

    expect(added).toHaveBeenCalledWith('point', [0, 0, 0]);
  });

  it('double click adds no point and never completes the interaction', () => {
    const added = vi.fn();
    const completed = vi.fn();
    viewer.onPromptAdded = added;
    viewer.onInteractionComplete = completed;
    viewer.setPromptMode('point');
    const canvas = container.querySelectorAll('canvas')[1];

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, bubbles: true, cancelable: true }));

    vi.advanceTimersByTime(300);

    expect(added).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('keeps annotations selectable but blocks editing and manual tools when read-only', () => {
    const annotation = {
      id: 'readonly-ann',
      class_name: 'chair',
      bbox: [10, 10, 30, 30],
    } as Annotation;
    const selected = vi.fn();
    const editStarted = vi.fn();
    const updated = vi.fn();
    const created = vi.fn();
    viewer.onAnnotationSelected = selected;
    viewer.onAnnotationEditStart = editStarted;
    viewer.onAnnotationUpdated = updated;
    viewer.onAnnotationCreated = created;
    vi.spyOn(viewer, 'hitTestAnnotation').mockReturnValue({ annotation, operation: 'move' });

    viewer.setEditable(false);
    viewer.setPromptMode('manual-box');
    expect((viewer as unknown as { promptMode: string }).promptMode).toBe('none');

    const canvas = container.querySelectorAll('canvas')[1];
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 20, clientY: 20, bubbles: true }));

    expect(selected).toHaveBeenCalledWith('readonly-ann');
    expect(editStarted).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect((viewer as unknown as { isDraggingAnnotation: boolean }).isDraggingAnnotation).toBe(false);
  });

  it('ignores a temporary AI candidate when selecting an underlying annotation', () => {
    const annotation = {
      id: 'persisted-ann', class_name: 'chair', bbox: [10, 10, 40, 40],
    } as Annotation;
    const candidate = {
      id: '__sam3_ai_candidate__', class_name: 'AI candidate', bbox: [10, 10, 40, 40], temporary: true,
    } as Annotation;
    viewer.setAnnotations([annotation, candidate]);

    const hit = viewer.hitTestAnnotation([20, 20]);

    expect(hit?.annotation.id).toBe('persisted-ann');
  });

  it('prefers the smallest target when annotations overlap', () => {
    viewer.setAnnotations([
      { id: 'small-face', class_name: 'face', bbox: [40, 40, 60, 60], area: 400 } as Annotation,
      { id: 'large-person', class_name: 'person', bbox: [10, 10, 90, 90], area: 6400 } as Annotation,
    ]);

    const hit = viewer.hitTestAnnotation([50, 50]);

    expect(hit?.annotation.id).toBe('small-face');
  });

  it('keeps a live overlay while a group of annotations is highlighted', () => {
    expect(viewer.hasLiveOverlay()).toBe(false);

    viewer.setHighlightedAnnotations(['ann-1', 'ann-2']);
    expect(viewer.hasLiveOverlay()).toBe(true);

    viewer.setHighlightedAnnotations([]);
    expect(viewer.hasLiveOverlay()).toBe(false);
  });

  it('keeps every disconnected contour when a main-polygon vertex is edited', () => {
    const main: [number, number][] = [[10, 10], [40, 10], [40, 40], [10, 40]];
    const detached: [number, number][] = [[70, 70], [90, 70], [90, 90], [70, 90]];
    const annotation = {
      id: 'multi-contour',
      class_name: 'stool',
      bbox: [10, 10, 90, 90],
      polygon: main.map((point) => [...point]),
      polygons: [
        main.map((point) => [...point]),
        detached.map((point) => [...point]),
      ],
    } as Annotation;
    const original = {
      bbox: [10, 10, 90, 90] as [number, number, number, number],
      polygon: main.map((point) => [...point]) as [number, number][],
      polygons: [
        main.map((point) => [...point]) as [number, number][],
        detached.map((point) => [...point]) as [number, number][],
      ],
      points: null,
    };

    (viewer as unknown as {
      applyPolygonVertexDrag: (
        target: Annotation,
        geometry: typeof original,
        vertexIndex: number,
        point: [number, number],
      ) => void;
    }).applyPolygonVertexDrag(annotation, original, 0, [15, 15]);

    expect(annotation.polygon?.[0]).toEqual([15, 15]);
    expect(annotation.polygons).toHaveLength(2);
    expect(annotation.polygons?.[0]?.[0]).toEqual([15, 15]);
    expect(annotation.polygons?.[1]).toEqual(detached);
    expect(annotation.bbox).toEqual([10, 10, 90, 90]);
  });

  it('keeps polygon geometry synchronized when its bounding box is resized', () => {
    const polygon: [number, number][] = [[10, 10], [30, 10], [30, 30], [10, 30]];
    const annotation = {
      id: 'resized-mask', class_name: 'chair', bbox: [10, 10, 30, 30],
      polygon: polygon.map((point) => [...point]),
      polygons: [polygon.map((point) => [...point])],
    } as Annotation;
    const original = {
      bbox: [10, 10, 30, 30] as [number, number, number, number],
      polygon: polygon.map((point) => [...point]) as [number, number][],
      polygons: [polygon.map((point) => [...point]) as [number, number][]],
      points: null,
    };

    (viewer as unknown as {
      applyBboxResize: (
        target: Annotation,
        geometry: typeof original,
        handle: string,
        point: [number, number],
      ) => void;
    }).applyBboxResize(annotation, original, 'se', [50, 50]);

    expect(annotation.bbox).toEqual([10, 10, 50, 50]);
    expect(annotation.polygon).toEqual([[10, 10], [50, 10], [50, 50], [10, 50]]);
    expect(annotation.polygons?.[0]).toEqual(annotation.polygon);
  });

  it('does not overwrite an existing contour when imported main geometry is unmatched', () => {
    const first: [number, number][] = [[5, 5], [20, 5], [20, 20], [5, 20]];
    const second: [number, number][] = [[70, 70], [90, 70], [90, 90], [70, 90]];
    const importedMain: [number, number][] = [[30, 30], [60, 30], [60, 60], [30, 60]];
    const annotation = {
      id: 'inconsistent-multi-contour',
      class_name: 'stool',
      bbox: [5, 5, 90, 90],
      polygon: importedMain.map((point) => [...point]),
      polygons: [
        first.map((point) => [...point]),
        second.map((point) => [...point]),
      ],
    } as Annotation;
    const original = {
      bbox: [5, 5, 90, 90] as [number, number, number, number],
      polygon: importedMain.map((point) => [...point]) as [number, number][],
      polygons: [
        first.map((point) => [...point]) as [number, number][],
        second.map((point) => [...point]) as [number, number][],
      ],
      points: null,
    };

    (viewer as unknown as {
      applyPolygonVertexDrag: (
        target: Annotation,
        geometry: typeof original,
        vertexIndex: number,
        point: [number, number],
      ) => void;
    }).applyPolygonVertexDrag(annotation, original, 0, [35, 35]);

    expect(annotation.polygons).toHaveLength(3);
    expect(annotation.polygons?.[0]).toEqual(first);
    expect(annotation.polygons?.[1]).toEqual(second);
    expect(annotation.polygons?.[2]?.[0]).toEqual([35, 35]);
  });
});
