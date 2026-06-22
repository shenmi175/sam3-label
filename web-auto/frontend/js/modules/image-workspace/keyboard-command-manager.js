export class KeyboardCommandManager {
  constructor(workspace) {
    this.workspace = workspace;
    this.lastNavAt = 0;
    this.handler = (event) => this.handleKeyDown(event);
  }

  bind() {
    this.detach();
    document.addEventListener('keydown', this.handler);
  }

  detach() {
    document.removeEventListener('keydown', this.handler);
  }

  handleKeyDown(e) {
    const ws = this.workspace;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const now = performance.now();
    if (now - this.lastNavAt < 45) return;

    const key = String(e.key || '').toLowerCase();
    const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;

    if (plainKey && key === 'v') {
      e.preventDefault();
      ws.setPromptMode('pointer');
    } else if (plainKey && key === 'b') {
      e.preventDefault();
      ws.setPromptMode('manual-box');
    } else if (plainKey && key === 'p') {
      e.preventDefault();
      ws.setPromptMode('manual-polygon');
    } else if (plainKey && key === 's') {
      e.preventDefault();
      ws.setPromptMode('box');
    } else if (plainKey && key === 'f') {
      e.preventDefault();
      if (ws.viewer) ws.viewer.fitToScreen();
    } else if (plainKey && /^[1-9]$/.test(key)) {
      e.preventDefault();
      ws.selectClassByIndex(Number(key) - 1);
    } else if (plainKey && e.key === 'Escape') {
      if (ws.promptMode !== 'pointer') {
        e.preventDefault();
        ws.setPromptMode('pointer');
      } else if (ws.focusedAnnotationId) {
        e.preventDefault();
        ws.clearAnnotationFocus();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      this.lastNavAt = now;
      ws.navigateImage(-1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.lastNavAt = now;
      ws.navigateImage(1);
    } else if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      ws.saveCurrentAnns();
    } else if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault();
      ws.undoAnnotationChange();
    } else if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault();
      ws.redoAnnotationChange();
    } else if (e.key === 'Delete') {
      const activeImageItem = document.activeElement?.closest?.('.image-item');
      if (ws.focusedAnnotationId) {
        e.preventDefault();
        ws.deleteAnnotation(ws.focusedAnnotationId);
      } else if (activeImageItem?.dataset?.id) {
        e.preventDefault();
        ws.deleteProjectImage(activeImageItem.dataset.id, activeImageItem.dataset.rel);
      }
    } else if (e.key === 'Backspace' && ws.focusedAnnotationId) {
      e.preventDefault();
      ws.deleteAnnotation(ws.focusedAnnotationId);
    }
  }
}
