import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
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
  /** Trigger viewer fitToScreen via the viewer ref (F key). */
  onFitToScreen?: () => void;
  /** Delete an image from the list by id (Delete on a focused list row). */
  onDeleteImage?: (imageId: string) => void;
}

/**
 * Global keyboard shortcuts — 1:1 port of the legacy KeyboardCommandManager:
 * V/B/P/S mode keys, F fit, 1-9 class select, arrows navigate (45ms throttle),
 * Esc clears mode/focus, Ctrl+S save, Ctrl+Z/Y undo/redo, Delete/Backspace
 * delete the focused annotation (or the focused image-list row).
 * Input/textarea/select targets are ignored.
 */
export function useKeyboardCommands(handlers: KeyboardCommandHandlers = {}) {
  const { navigate } = useImageNavigation();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const lastNavRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const project = useProjectStore.getState();
      const image = useImageStore.getState();
      const annotation = useAnnotationStore.getState();
      const viewer = useViewerStore.getState();
      const layout = useLayoutStore.getState();
      const key = event.key;

      // Save / undo / redo with modifier.
      if (event.ctrlKey || event.metaKey) {
        if (key === 's' || key === 'S') {
          event.preventDefault();
          void annotation.saveCurrent();
          return;
        }
        if (key === 'z' || key === 'Z') {
          event.preventDefault();
          annotation.undo();
          return;
        }
        if (key === 'y' || key === 'Y') {
          event.preventDefault();
          annotation.redo();
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
          viewer.setPromptMode('manual-box', layout.workspaceMode);
          return;
        case 'p':
        case 'P':
          viewer.setPromptMode('manual-polygon', layout.workspaceMode);
          return;
        case 's':
        case 'S':
          viewer.setBoxPromptLabel(1);
          return;
        case 'f':
        case 'F':
          handlersRef.current.onFitToScreen?.();
          return;
        case 'Escape':
          if (viewer.promptMode !== 'none') {
            viewer.setPromptMode('none', layout.workspaceMode);
          } else if (viewer.focusedAnnotationId) {
            viewer.setFocusedAnnotation(null);
          }
          return;
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'ArrowDown':
        case 'ArrowRight': {
          event.preventDefault();
          const now = performance.now();
          if (now - lastNavRef.current < NAV_THROTTLE_MS) return;
          lastNavRef.current = now;
          const delta = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
          void navigate(delta);
          return;
        }
        case 'Delete':
        case 'Backspace': {
          if (viewer.focusedAnnotationId) {
            annotation.deleteAnnotation(viewer.focusedAnnotationId);
            return;
          }
          if (key === 'Delete') {
            // Legacy fallback: delete the image row containing focus.
            const active = document.activeElement as HTMLElement | null;
            const row = active?.closest?.('[data-image-item]') as HTMLElement | null;
            const imageId = row?.dataset?.imageItem || '';
            if (imageId && handlersRef.current.onDeleteImage) {
              handlersRef.current.onDeleteImage(imageId);
            } else if (image.selectedImageId && handlersRef.current.onDeleteImage) {
              handlersRef.current.onDeleteImage(image.selectedImageId);
            }
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
