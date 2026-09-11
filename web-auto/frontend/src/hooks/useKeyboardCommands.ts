import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useImageNavigation } from './useImageNavigation';

/** Legacy keyboard-command-manager throttle for navigation commands. */
const NAV_THROTTLE_MS = 45;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export interface KeyboardCommandHandlers {
  editable: boolean;
  /** Trigger viewer fitToScreen via the viewer ref (F key). */
  onFitToScreen?: () => void;
  /** Delete an image from the list by id (Delete on a focused list row). */
  onDeleteImage?: (imageId: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Toggle AI segmentation between creating and refining an instance. */
  onToggleAiOperationMode?: () => void;
  /** Toggle the active AI point between foreground and background. */
  onToggleAiPointLabel?: () => void;
}

/**
 * Global keyboard shortcuts — 1:1 port of the legacy KeyboardCommandManager:
 * V/B/P mode keys, F fit, 1-9 class select, arrows or A/D navigate (45ms throttle),
 * Esc clears mode/focus, Ctrl+S save, Ctrl+Z/Y undo/redo, Delete/Backspace
 * delete the focused annotation (or the focused image-list row).
 * Input/textarea/select targets are ignored.
 */
export function useKeyboardCommands(handlers: KeyboardCommandHandlers) {
  const { navigate } = useImageNavigation();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const lastNavRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const project = useProjectStore.getState();
      const annotation = useAnnotationStore.getState();
      const viewer = useViewerStore.getState();
      const layout = useLayoutStore.getState();
      const key = event.key;

      // Save / undo / redo with modifier.
      if (event.ctrlKey || event.metaKey) {
        if (key === 's' || key === 'S') {
          event.preventDefault();
          if (handlersRef.current.editable) void annotation.saveCurrent();
          return;
        }
        if (key === 'z' || key === 'Z') {
          event.preventDefault();
          if (!handlersRef.current.editable) return;
          if (handlersRef.current.onUndo) handlersRef.current.onUndo();
          else annotation.undo();
          return;
        }
        if (key === 'y' || key === 'Y') {
          event.preventDefault();
          if (!handlersRef.current.editable) return;
          if (handlersRef.current.onRedo) handlersRef.current.onRedo();
          else annotation.redo();
          return;
        }
        if (event.ctrlKey && !event.metaKey && (key === 'a' || key === 'A')) {
          if (!handlersRef.current.editable || !handlersRef.current.onToggleAiOperationMode) return;
          event.preventDefault();
          handlersRef.current.onToggleAiOperationMode();
          return;
        }
        return;
      }

      switch (key) {
        case 'v':
        case 'V':
          viewer.setPromptMode('none', layout.workspaceMode);
          return;
        case 'b':
        case 'B':
          if (!handlersRef.current.editable) return;
          viewer.setPromptMode('manual-box', layout.workspaceMode);
          return;
        case 'p':
        case 'P':
          if (!handlersRef.current.editable) return;
          viewer.setPromptMode('manual-polygon', layout.workspaceMode);
          return;
        case 'f':
        case 'F':
          handlersRef.current.onFitToScreen?.();
          return;
        case 'w':
        case 'W':
          if (!handlersRef.current.editable || !handlersRef.current.onToggleAiPointLabel) return;
          event.preventDefault();
          handlersRef.current.onToggleAiPointLabel();
          return;
        case 'Escape':
          if (viewer.promptMode !== 'none') {
            viewer.setPromptMode('none', layout.workspaceMode);
          } else if (viewer.focusedAnnotationId) {
            viewer.setFocusedAnnotation(null);
          }
          return;
        case 'a':
        case 'A':
        case 'd':
        case 'D':
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'ArrowDown':
        case 'ArrowRight': {
          event.preventDefault();
          const now = performance.now();
          if (now - lastNavRef.current < NAV_THROTTLE_MS) return;
          lastNavRef.current = now;
          const delta = key === 'a' || key === 'A' || key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
          void navigate(delta);
          return;
        }
        case 'Delete':
        case 'Backspace': {
          if (key === 'Delete') {
            // An explicitly focused image row owns Delete, even if an
            // annotation is still selected on the canvas.
            const active = document.activeElement as HTMLElement | null;
            const row = active?.closest?.('[data-image-item]') as HTMLElement | null;
            const imageId = row?.dataset?.imageItem || '';
            if (imageId && handlersRef.current.onDeleteImage) {
              handlersRef.current.onDeleteImage(imageId);
              return;
            }
          }
          if (handlersRef.current.editable && viewer.focusedAnnotationId) {
            annotation.deleteAnnotation(viewer.focusedAnnotationId);
            return;
          }
          return;
        }
        default:
          break;
      }

      // 1-9: select class by index.
      if (/^[1-9]$/.test(key)) {
        const index = Number(key) - 1;
        const cls = project.classes[index];
        if (cls !== undefined) project.setSelectedClass(cls);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}
