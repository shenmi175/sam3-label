import { api } from '../../api.js';
import { bindClassPanelEvents, renderClassPanel } from '../../components/class-panel.js';
import { i18n } from '../../i18n.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class ClassController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  render() {
    const ws = this.workspace;
    const list = document.getElementById('classes-list');
    const classes = ws.projectMeta?.classes || [];
    ws.renderImageFilterControls();

    if (!ws.selectedClass) ws.selectedClass = classes[0];
    renderClassPanel(list, classes, {
      selectedClass: ws.selectedClass,
      annotations: ws.annotations,
      emptyText: i18n.t('no_classes'),
      getClassColor: (className) => ws.getClassColor(className),
    });
    bindClassPanelEvents(list, {
      onSelect: (className) => this.select(className),
      onDelete: (className) => this.delete(className),
    });

    ws.syncReviewModeSummary();
    ws.updateActionBar();
  }

  select(className) {
    const ws = this.workspace;
    ws.selectedClass = className;
    this.render();
    ws.syncReviewModeSummary();
  }

  async delete(className) {
    const ws = this.workspace;
    if (!confirm(`确认删除类别 "${className}" ？`)) return;
    try {
      await api.deleteClass(ws.projectId, className);
      if (ws.selectedClass === className) ws.selectedClass = null;
      await ws.loadProjectInfo();
      notify(`类别 "${className}" 已删除`, 'success');
    } catch(e) {
      notify(e.message, 'error');
    }
  }

  showAddModal() {
    const ws = this.workspace;
    const existing = document.getElementById('modal-add-class');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-add-class';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 9999; background: rgba(0,0,0,0.3); backdrop-filter: blur(4px);';
    modal.innerHTML = `
      <div class="neu-card" style="width: 380px; padding: 28px; border-radius: 20px; position: relative;">
        <button id="btn-close-add-class" class="neu-button" style="position: absolute; top: 15px; right: 15px; width: 30px; height: 30px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">&times;</button>
        <h3 style="margin: 0 0 20px 0; font-size: 16px;">\u65B0\u589E\u7C7B\u522B</h3>
        <textarea id="inp-new-class-names" class="neu-input" rows="4" placeholder="\u6BCF\u884C\u4E00\u4E2A\u7C7B\u522B\uFF0C\u4E5F\u652F\u6301\u9017\u53F7\u6216\u5206\u53F7\u6279\u91CF\u8F93\u5165" style="width: 100%; resize: vertical; font-size: 13px; padding: 10px;"></textarea>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;">
          <button class="neu-button" style="padding: 10px 20px;" id="btn-cancel-add-class">\u53D6\u6D88</button>
          <button class="neu-button" style="padding: 10px 20px; color: var(--neu-text-active); font-weight: 700;" id="btn-confirm-add-class">\u786E\u8BA4</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const inp = document.getElementById('inp-new-class-names');
    if (inp) inp.focus();

    document.getElementById('btn-close-add-class').onclick = () => modal.remove();
    document.getElementById('btn-cancel-add-class').onclick = () => modal.remove();
    document.getElementById('btn-confirm-add-class').onclick = async () => {
      const names = String(inp?.value || '').replace(/\r\n?/g, '\n').trim();
      if (!names) return notify('\u8BF7\u8F93\u5165\u7C7B\u522B\u540D\u79F0', 'error');
      try {
        await api.addClass(ws.projectId, names);
        modal.remove();
        await ws.loadProjectInfo();
        notify('\u7C7B\u522B\u5DF2\u6DFB\u52A0', 'success');
      } catch (e) {
        notify(e.message, 'error');
      }
    };
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') modal.remove();
      });
    }
  }
}
