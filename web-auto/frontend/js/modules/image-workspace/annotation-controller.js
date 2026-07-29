import { bboxFromPolygon } from '../../utils/geometry.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class AnnotationController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  cloneAnnotations(annotations = this.workspace.annotations) {
    try {
      return JSON.parse(JSON.stringify(Array.isArray(annotations) ? annotations : []));
    } catch (_) {
      return [];
    }
  }

  clearSaveTimer() {
    const ws = this.workspace;
    if (ws.annotationSaveTimer) {
      clearTimeout(ws.annotationSaveTimer);
      ws.annotationSaveTimer = null;
    }
  }

  resetForImage(annotations = []) {
    const ws = this.workspace;
    ws.annotations = Array.isArray(annotations) ? annotations : [];
    ws.focusedAnnotationId = null;
    ws.annotationHistory = [];
    ws.annotationRedoStack = [];
    ws.annotationDirty = false;
    ws.annotationSaveImageId = '';
    ws.setAnnotationSaveStatus('已保存');
    ws.updateUndoRedoButtons();
    ws.updateAnnotationSelectionControls();
  }

  resetEmptySelection() {
    const ws = this.workspace;
    ws.annotations = [];
    ws.focusedAnnotationId = null;
    ws.annotationHistory = [];
    ws.annotationRedoStack = [];
    ws.annotationDirty = false;
    ws.annotationSaveImageId = '';
    ws.updateUndoRedoButtons();
    ws.updateAnnotationSelectionControls();
  }

  pushHistory() {
    const ws = this.workspace;
    if (!ws.selectedImageId) return;
    if (!ws.annotationHistory) ws.annotationHistory = [];
    const snapshot = this.cloneAnnotations();
    const previous = ws.annotationHistory[ws.annotationHistory.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    ws.annotationHistory.push(snapshot);
    if (ws.annotationHistory.length > 50) ws.annotationHistory.shift();
    ws.annotationRedoStack = [];
    ws.updateUndoRedoButtons();
  }

  restoreSnapshot(snapshot) {
    const ws = this.workspace;
    ws.annotations = this.cloneAnnotations(snapshot);
    if (ws.focusedAnnotationId && !ws.annotations.some((ann) => String(ann?.id || '') === String(ws.focusedAnnotationId))) {
      ws.focusedAnnotationId = null;
    }
    if (ws.viewer) {
      ws.viewer.setAnnotations(ws.visibleAnnotations());
      ws.viewer.setFocusedAnnotation(ws.focusedAnnotationId);
    }
    ws.updateAnnotationSelectionControls();
    ws.renderClasses();
    ws.renderAnnotations();
    this.markDirty('history');
  }

  undo() {
    const ws = this.workspace;
    if (!ws.annotationHistory || ws.annotationHistory.length === 0) return;
    if (!ws.annotationRedoStack) ws.annotationRedoStack = [];
    ws.annotationRedoStack.push(this.cloneAnnotations());
    const snapshot = ws.annotationHistory.pop();
    this.restoreSnapshot(snapshot);
    ws.updateUndoRedoButtons();
  }

  redo() {
    const ws = this.workspace;
    if (!ws.annotationRedoStack || ws.annotationRedoStack.length === 0) return;
    if (!ws.annotationHistory) ws.annotationHistory = [];
    ws.annotationHistory.push(this.cloneAnnotations());
    const snapshot = ws.annotationRedoStack.pop();
    this.restoreSnapshot(snapshot);
    ws.updateUndoRedoButtons();
  }

  markManualAnnotation(ann) {
    if (!ann || typeof ann !== 'object') return ann;
    const now = new Date().toISOString();
    ann.edited = true;
    ann.updated_at = now;
    if (!ann.source) ann.source = 'manual';
    else if (ann.source !== 'manual') ann.modified_by = 'manual';
    if (!ann.score) ann.score = 1;
    return ann;
  }

  createAnnotation(shape, className) {
    const ws = this.workspace;
    if (!ws.selectedImageId) return notify('请先选择图片', 'error');
    const now = new Date().toISOString();
    const polygon = Array.isArray(shape?.polygon) ? shape.polygon : null;
    const bbox = Array.isArray(shape?.bbox)
      ? shape.bbox
      : (polygon ? bboxFromPolygon(polygon) : null);
    if (!bbox || bbox.length !== 4) return;

    this.pushHistory();
    const ann = {
      id: `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      class_name: className,
      label: className,
      bbox: bbox.map((v) => Number(v || 0)),
      score: 1,
      source: 'manual',
      edited: true,
      created_at: now,
      updated_at: now,
    };
    if (polygon && polygon.length >= 3) ann.polygon = polygon;

    ws.annotations = [...(ws.annotations || []), ann];
    ws.focusedAnnotationId = ann.id;
    if (ws.viewer) {
      ws.viewer.setAnnotations(ws.visibleAnnotations());
      ws.viewer.setFocusedAnnotation(ann.id);
    }
    ws.setPromptMode('pointer');
    ws.renderClasses();
    ws.renderAnnotations();
    ws.updateCurrentImageBundleAnnotations(ws.annotations);
    this.markDirty('create');
  }

  selectFromCanvas(annId) {
    const ws = this.workspace;
    ws.focusedAnnotationId = annId || null;
    ws.updateAnnotationFocusListState();
    ws.updateAnnotationSelectionControls();
    ws.scheduleProjectUIStateSave();
  }

  handleGeometryUpdated(ann) {
    const ws = this.workspace;
    if (!ann) return;
    this.markManualAnnotation(ann);
    ws.updateCurrentImageBundleAnnotations(ws.annotations);
    ws.renderClasses();
    ws.renderAnnotations();
    this.markDirty('geometry');
  }

  markDirty(reason = '') {
    const ws = this.workspace;
    ws.annotationDirty = true;
    ws.annotationRev += 1;
    ws.annotationSaveImageId = ws.selectedImageId || '';
    ws.updateCurrentImageBundleAnnotations(ws.annotations);
    ws.markSelectedImageLabeledState((ws.annotations || []).length > 0);
    if (ws.annotationAutosaveEnabled) {
      this.scheduleAutosave(reason);
    } else {
      ws.setAnnotationSaveStatus('未保存', 'active');
    }
  }

  scheduleAutosave(reason = '') {
    const ws = this.workspace;
    if (!ws.selectedImageId) return;
    this.clearSaveTimer();
    ws.setAnnotationSaveStatus('待保存', 'active');
    ws.annotationSaveTimer = setTimeout(() => {
      ws.annotationSaveTimer = null;
      this.flushSave(reason);
    }, 700);
  }

  async flushSave(reason = '') {
    const ws = this.workspace;
    if (typeof ws.commitPendingManualPolygon === 'function' && !ws.commitPendingManualPolygon()) return false;
    if (!ws.selectedImageId || ws.annotationSaving || !ws.annotationDirty) return;
    const imageId = ws.annotationSaveImageId || ws.selectedImageId;
    const cached = ws.getCachedImageBundle(imageId);
    const annotations = String(imageId) === String(ws.selectedImageId)
      ? this.cloneAnnotations()
      : this.cloneAnnotations(cached?.annotations || []);
    if (!imageId) return;
    const rev = ws.annotationRev;
    try {
      ws.annotationSaving = true;
      ws.setAnnotationSaveStatus('保存中...', 'active');
      await ws.ensureAnnotationClasses(annotations);
      if (String(ws.selectedImageId) === String(imageId)) ws.renderClasses();
      await ws.saveAnnotationsToServer(imageId, annotations);
      if (ws.isUnmounted) return;
      if (String(ws.selectedImageId) === String(imageId)) {
        ws.updateCurrentImageBundleAnnotations(annotations);
        ws.markSelectedImageLabeledState(annotations.length > 0);
        if (ws.annotationRev === rev) {
          ws.annotationDirty = false;
          ws.annotationSaveImageId = '';
          ws.setAnnotationSaveStatus('已保存');
        } else {
          this.scheduleAutosave('dirty-during-save');
        }
      }
    } catch (e) {
      ws.setAnnotationSaveStatus('保存失败', 'error');
      notify(`保存失败: ${e.message}`, 'error');
    } finally {
      ws.annotationSaving = false;
    }
    return !ws.annotationDirty;
  }

  async saveCurrent() {
    const ws = this.workspace;
    if (!ws.selectedImageId) return false;
    if (typeof ws.commitPendingManualPolygon === 'function' && !ws.commitPendingManualPolygon()) return false;
    this.clearSaveTimer();
    ws.annotationDirty = true;
    ws.annotationSaveImageId = ws.selectedImageId;
    ws.annotationRev += 1;
    await this.flushSave('manual-save');
    return !ws.annotationDirty;
  }

  clearAnnotations() {
    const ws = this.workspace;
    if (!ws.selectedImageId) return;
    this.pushHistory();
    ws.annotations = [];
    ws.focusedAnnotationId = null;
    if (ws.viewer) {
      ws.viewer.setAnnotations([]);
      ws.viewer.setFocusedAnnotation(null);
    }
    ws.updateAnnotationSelectionControls();
    ws.renderClasses();
    ws.renderAnnotations();
    this.markDirty('clear');
  }

  deleteAnnotation(annId) {
    const ws = this.workspace;
    if (!ws.selectedImageId) return;
    this.pushHistory();
    const newAnns = ws.annotations.filter((ann) => String(ann?.id || '') !== String(annId || ''));
    ws.annotations = newAnns;
    if (String(ws.focusedAnnotationId || '') === String(annId || '')) ws.focusedAnnotationId = null;
    if (ws.viewer) {
      ws.viewer.setAnnotations(ws.visibleAnnotations());
      ws.viewer.setFocusedAnnotation(ws.focusedAnnotationId);
    }
    ws.updateAnnotationSelectionControls();
    ws.renderClasses();
    ws.renderAnnotations();
    this.markDirty('delete');
  }

  async updateClass(annId, nextClass) {
    const ws = this.workspace;
    if (!ws.selectedImageId) return false;
    const cleanClass = String(nextClass || '').trim();
    if (!cleanClass) {
      notify('类别名称不能为空', 'error');
      return false;
    }

    const annIndex = (ws.annotations || []).findIndex((item) => String(item?.id || '') === String(annId || ''));
    if (annIndex < 0) {
      notify('未找到该标注', 'error');
      return false;
    }

    const currentClass = String(ws.annotations[annIndex]?.class_name || '').trim();
    if (currentClass === cleanClass) {
      notify('类别未变化', 'info');
      return true;
    }

    try {
      const existingClasses = new Set((ws.projectMeta?.classes || []).map((cls) => String(cls || '').trim()));
      if (!existingClasses.has(cleanClass)) {
        await ws.addProjectClasses(cleanClass);
        ws.projectMeta.classes = Array.from(new Set([...(ws.projectMeta.classes || []), cleanClass]));
      }

      this.pushHistory();
      const newAnns = ws.annotations.map((ann) => {
        if (String(ann?.id || '') !== String(annId || '')) return ann;
        const updated = this.markManualAnnotation({ ...ann, class_name: cleanClass, label: cleanClass });
        delete updated.color;
        return updated;
      });

      ws.annotations = newAnns;
      ws.updateCurrentImageBundleAnnotations(newAnns);
      ws.selectedClass = cleanClass;
      if (ws.viewer) {
        ws.viewer.setAnnotations(ws.visibleAnnotations());
        ws.viewer.setFocusedAnnotation(ws.focusedAnnotationId);
      }
      ws.renderAnnotations();
      this.markDirty('class');
      notify(`已将标注类别改为 "${cleanClass}"`, 'success');
      return true;
    } catch (e) {
      notify(e.message, 'error');
      return false;
    }
  }
}
