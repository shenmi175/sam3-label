import { api } from '../../api.js';
import { renderExportPanel } from '../../components/export-panel.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class ExportController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  open() {
    const modal = document.getElementById('modal-export-full');
    if (!modal) return;
    modal.innerHTML = renderExportPanel();
    modal.style.display = 'flex';

    const closeExportModal = () => {
      modal.style.display = 'none';
      modal.innerHTML = '';
    };
    const closeBtn = document.getElementById('btn-close-export-modal');
    const cancelBtn = document.getElementById('btn-cancel-export-modal');
    const formatEl = document.getElementById('exp-format');
    const bboxEl = document.getElementById('exp-bbox');
    const maskEl = document.getElementById('exp-mask');
    const statusEl = document.getElementById('export-status');
    const exportBtn = document.getElementById('btn-do-export');
    if (!formatEl || !bboxEl || !maskEl || !statusEl || !exportBtn) {
      notify('导出弹窗初始化失败', 'error');
      return;
    }

    if (closeBtn) closeBtn.onclick = closeExportModal;
    if (cancelBtn) cancelBtn.onclick = closeExportModal;
    const updateExportOptions = () => {
      if (formatEl.value === 'yolo' && bboxEl.checked && maskEl.checked) {
        maskEl.checked = false;
      }
      statusEl.innerText = formatEl.value === 'yolo'
        ? 'YOLO 仅支持框检测或掩码分割其中一种导出形式。'
        : '将使用后端导出接口生成数据集文件。';
    };
    formatEl.onchange = updateExportOptions;
    bboxEl.onchange = updateExportOptions;
    maskEl.onchange = updateExportOptions;
    updateExportOptions();

    exportBtn.onclick = async () => {
      const dir = String(document.getElementById('exp-dir')?.value || '').trim();
      try {
        exportBtn.disabled = true;
        statusEl.innerText = '正在导出，请稍候...';
        const res = await api.exportProject({
          project_id: this.workspace.projectId,
          format: formatEl.value,
          include_bbox: bboxEl.checked,
          include_mask: maskEl.checked,
          output_dir: dir || null,
        });
        const output = res?.output || '';
        statusEl.innerText = output ? `导出完成: ${output}` : '导出完成';
        notify('Export successful', 'success');
      } catch (e) {
        statusEl.innerText = e.message;
        notify(e.message, 'error');
      } finally {
        exportBtn.disabled = false;
      }
    };
  }
}
