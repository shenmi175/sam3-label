import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { escapeAttr } from '../../utils/html.js';

export class PreviewController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  bindListEvents() {
    const list = document.getElementById('preview-list');
    if (!list) return;
    list.onclick = (e) => {
      const target = e.target.closest('[data-preview-action]');
      if (!target || !list.contains(target)) return;
      const id = target.dataset.previewId;
      if (!id) return;
      if (target.dataset.previewAction === 'remove') {
        this.remove(id);
      } else if (target.dataset.previewAction === 'apply') {
        this.keepSingle(id);
      }
    };
  }

  render() {
    const ws = this.workspace;
    const list = document.getElementById('preview-list');
    if (!list) return;
    const previews = ws.previews || [];
    if (previews.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
           <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">✨</div>
           <div style="font-size: 13px;">${i18n.t('preview_results_desc')}</div>
        </div>
      `;
      return;
    }

    list.innerHTML = previews.map((p, idx) => {
      const score = Number(p.score ?? 0.98);
      const confidence = Number.isFinite(score) ? score : 0.98;
      return `
        <div class="neu-box" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--neu-bg); box-shadow: var(--neu-outset-sm);">
           <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 11px; font-weight: 700; color: var(--neu-text-active); text-transform: uppercase;">Preview Result #${idx + 1}</span>
              <button class="neu-button" data-preview-action="remove" data-preview-id="${escapeAttr(p.id)}" style="width: 24px; height: 24px; border-radius: 50%; padding: 0; font-size: 10px; color: #ef4444;">×</button>
           </div>
           <div style="font-size: 12px; color: var(--neu-text-light);">
              Confidence: <span style="font-weight: 600; color: var(--neu-text);">${confidence.toFixed(3)}</span>
           </div>
           <div style="display: flex; gap: 8px;">
              <button class="neu-button" data-preview-action="apply" data-preview-id="${escapeAttr(p.id)}" style="flex: 1; font-size: 11px; padding: 6px;">Apply to Image</button>
           </div>
        </div>
      `;
    }).join('');
  }

  updateActionBar() {
    const ws = this.workspace;
    const bar = document.getElementById('ws-action-bar');
    const btn = document.getElementById('btn-submit-preview');
    const btnAll = document.getElementById('btn-select-all-previews');
    if (!bar || !btn) return;
    if (ws.workspaceMode === 'review') {
      bar.style.display = 'none';
      if (btnAll) btnAll.style.display = 'none';
      return;
    }

    const previews = ws.previews || [];
    if (previews.length > 0) {
      bar.style.display = 'block';
      if (btnAll) btnAll.style.display = 'block';
      const className = ws.selectedClass || (ws.projectMeta?.classes?.[0] || 'Object');
      btn.textContent = `Submit ${previews.length} Previews to [${className}]`;
    } else {
      bar.style.display = 'none';
      if (btnAll) btnAll.style.display = 'none';
    }
  }

  selectAll() {
    return this.keepAll();
  }

  async keepAll() {
    const ws = this.workspace;
    const previews = ws.previews || [];
    if (previews.length === 0) return;
    const className = ws.selectedClass || (ws.projectMeta?.classes?.[0] || 'Object');

    try {
      const existing = await api.getAnnotations(ws.projectId, ws.selectedImageId);
      const newAnns = [...(existing.annotations || []), ...previews.map(p => ({
        ...p,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }))];

      await api.saveAnnotations(ws.projectId, ws.selectedImageId, newAnns);

      ws.previews = [];
      ws.currentPrompts = [];
      if (ws.viewer) {
        ws.viewer.setPrompts([]);
        ws.viewer.setPreviews([]);
      }
      this.render();
      this.updateActionBar();

      await ws.loadProjectInfo();
      ws.invalidateImageBundle(ws.selectedImageId);
      await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
    } catch(e) {
      alert("Failed to save: " + e.message);
    }
  }

  remove(id) {
    const ws = this.workspace;
    ws.previews = (ws.previews || []).filter(p => p.id !== id);
    if (ws.viewer) ws.viewer.setPreviews(ws.previews);
    this.render();
    this.updateActionBar();
  }

  async keepSingle(id) {
    const ws = this.workspace;
    const pre = (ws.previews || []).find(p => p.id === id);
    if (!pre) return;

    const className = ws.selectedClass || (ws.projectMeta?.classes?.[0] || 'Object');
    try {
      const existing = await api.getAnnotations(ws.projectId, ws.selectedImageId);
      const newAnns = [...(existing.annotations || []), {
        ...pre,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }];

      await api.saveAnnotations(ws.projectId, ws.selectedImageId, newAnns);
      this.remove(id);
      await ws.loadProjectInfo();
      ws.invalidateImageBundle(ws.selectedImageId);
      await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
    } catch(e) {
      alert(e.message);
    }
  }
}
