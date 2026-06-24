import { i18n } from '../../i18n.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class ReviewController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  bind() {
    const btnReviewContinuous = document.getElementById('btn-review-continuous');
    if (btnReviewContinuous) btnReviewContinuous.onclick = () => this.toggleContinuousMode();

    const btnReviewApplyClass = document.getElementById('btn-review-apply-class');
    if (btnReviewApplyClass) btnReviewApplyClass.onclick = () => this.applySelectedClassToFocusedAnnotation();

    const btnReviewDeleteAnn = document.getElementById('btn-review-delete-ann');
    if (btnReviewDeleteAnn) btnReviewDeleteAnn.onclick = () => {
      const ws = this.workspace;
      if (!ws.focusedAnnotationId) return notify('请先选中一个标注', 'info');
      ws.deleteAnnotation(ws.focusedAnnotationId);
    };

    const btnReviewSaveNext = document.getElementById('btn-review-save-next');
    if (btnReviewSaveNext) btnReviewSaveNext.onclick = () => this.saveAndNavigate(1);

    const btnReviewNextUnlabeled = document.getElementById('btn-review-next-unlabeled');
    if (btnReviewNextUnlabeled) btnReviewNextUnlabeled.onclick = () => this.workspace.navigateUnlabeledImage(1);
  }

  setWorkspaceMode(mode) {
    const ws = this.workspace;
    const nextMode = mode === 'review' ? 'review' : 'auto';
    ws.workspaceMode = nextMode;
    if (nextMode === 'review' && ws.promptMode === 'box') {
      ws.setPromptMode('pointer');
    }
    this.syncWorkspaceModeUI();
    ws.scheduleProjectUIStateSave();
  }

  setModeElementVisibility(selector, visible) {
    document.querySelectorAll(selector).forEach((el) => {
      const defaultDisplay = el.dataset.defaultDisplay || 'flex';
      el.style.display = visible ? defaultDisplay : 'none';
    });
  }

  syncWorkspaceModeUI() {
    const ws = this.workspace;
    const isReview = ws.workspaceMode === 'review';
    this.setModeElementVisibility('.ws-auto-only', !isReview);
    this.setModeElementVisibility('.ws-review-only', isReview);

    const autoBtn = document.getElementById('btn-workspace-mode-auto');
    const reviewBtn = document.getElementById('btn-workspace-mode-review');
    const syncModeButton = (btn, active) => {
      if (!btn) return;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.style.boxShadow = active ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      btn.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text)';
    };
    syncModeButton(autoBtn, !isReview);
    syncModeButton(reviewBtn, isReview);

    const btnReviewContinuous = document.getElementById('btn-review-continuous');
    if (btnReviewContinuous) {
      btnReviewContinuous.textContent = ws.reviewContinuousMode ? '连续: 开' : '连续: 关';
      btnReviewContinuous.style.boxShadow = ws.reviewContinuousMode ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      btnReviewContinuous.style.color = ws.reviewContinuousMode ? 'var(--neu-text-active)' : 'var(--neu-text)';
    }
    this.syncReviewModeSummary();
    ws.updateAnnotationSelectionControls();
    ws.updateActionBar();
  }

  syncReviewModeSummary() {
    const ws = this.workspace;
    const currentClassEl = document.getElementById('review-current-class');
    if (currentClassEl) {
      const selected = ws.selectedClass || ws.projectMeta?.classes?.[0] || '';
      currentClassEl.textContent = selected || '未选择';
      currentClassEl.title = selected || '未选择类别';
    }
  }

  toggleContinuousMode() {
    const ws = this.workspace;
    ws.reviewContinuousMode = !ws.reviewContinuousMode;
    this.syncWorkspaceModeUI();
    ws.scheduleProjectUIStateSave();
  }

  async saveAndNavigate(delta = 1) {
    const ws = this.workspace;
    if (!ws.selectedImageId) return notify('请先选择图片', 'error');
    try {
      if (ws.annotationDirty) {
        await ws.flushAnnotationAutosave('review-save-next');
      } else {
        const saved = await ws.annotationController.saveCurrent();
        if (saved) notify(i18n.t('save_success'), 'success');
      }
      if (ws.annotationDirty) return notify('当前图片标注尚未保存，保存成功后再切换图片', 'error');
      ws.navigateImage(delta);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  selectClassByIndex(index) {
    const ws = this.workspace;
    const classes = ws.projectMeta?.classes || [];
    const cls = classes[index];
    if (!cls) return;
    ws.selectClass(cls);
    notify(`当前类别: ${cls}`, 'info');
  }

  async applySelectedClassToFocusedAnnotation() {
    const ws = this.workspace;
    if (!ws.focusedAnnotationId) return notify('请先选中一个标注', 'info');
    const nextClass = ws.selectedClass || ws.projectMeta?.classes?.[0] || '';
    if (!nextClass) return notify('请先选择类别', 'error');
    await ws.updateAnnotationClass(ws.focusedAnnotationId, nextClass);
  }
}
