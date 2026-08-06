import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { renderExportPanel } from '../../components/export-panel.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export class ExportController {
  constructor(workspace) {
    this.workspace = workspace;
    this.preview = null;
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
    const statsEl = document.getElementById('export-stats');
    const hintEl = document.getElementById('exp-format-hint');
    const yoloBlock = document.getElementById('exp-yolo-block');
    const exportBtn = document.getElementById('btn-do-export');
    if (!formatEl || !bboxEl || !maskEl || !statusEl || !exportBtn) {
      notify('导出弹窗初始化失败', 'error');
      return;
    }

    if (closeBtn) closeBtn.onclick = closeExportModal;
    if (cancelBtn) cancelBtn.onclick = closeExportModal;

    const updateExportOptions = () => {
      const isYolo = formatEl.value === 'yolo';
      if (isYolo && bboxEl.checked && maskEl.checked) maskEl.checked = false;
      if (yoloBlock) yoloBlock.style.display = isYolo ? 'block' : 'none';
      if (hintEl) hintEl.innerText = isYolo ? i18n.t('export_yolo_hint') : i18n.t('export_coco_hint');
    };
    formatEl.onchange = updateExportOptions;
    bboxEl.onchange = updateExportOptions;
    maskEl.onchange = updateExportOptions;
    updateExportOptions();

    const allBtn = document.getElementById('btn-exp-class-all');
    const invertBtn = document.getElementById('btn-exp-class-invert');
    const classBoxes = () => Array.from(document.querySelectorAll('.exp-class'));
    if (allBtn) {
      allBtn.onclick = () => {
        const boxes = classBoxes();
        const target = !boxes.every(b => b.checked);
        boxes.forEach(b => { b.checked = target; });
      };
    }
    if (invertBtn) {
      invertBtn.onclick = () => classBoxes().forEach(b => { b.checked = !b.checked; });
    }

    this.loadPreview(statusEl);

    exportBtn.onclick = async () => {
      const dir = String(document.getElementById('exp-dir')?.value || '').trim();
      const sources = Array.from(document.querySelectorAll('.exp-source'))
        .filter(el => el.checked)
        .map(el => el.dataset.source);
      if (!sources.length) {
        statusEl.innerText = i18n.t('export_empty_title');
        return;
      }
      const boxes = classBoxes();
      const selectedClasses = boxes.filter(b => b.checked).map(b => b.dataset.class);
      const allSelected = boxes.length > 0 && selectedClasses.length === boxes.length;
      try {
        exportBtn.disabled = true;
        statusEl.innerText = i18n.t('export_running');
        if (statsEl) statsEl.innerText = '';
        const res = await api.exportProject({
          project_id: this.workspace.projectId,
          format: formatEl.value,
          include_bbox: bboxEl.checked,
          include_mask: maskEl.checked,
          output_dir: dir || null,
          source_models: sources,
          classes: allSelected ? [] : selectedClasses,
          val_ratio: Number(document.getElementById('exp-val-ratio')?.value || 0) || 0,
          write_data_yaml: document.getElementById('exp-data-yaml')?.checked !== false,
        });
        statusEl.innerText = i18n.t('export_done', { output: res?.output || '' });
        if (statsEl) statsEl.innerText = this.formatStats(res?.stats || {});
        notify('Export successful', 'success');
      } catch (e) {
        const detail = e?.detail;
        if (detail && detail.code === 'EXPORT_EMPTY') {
          const bySource = Object.entries(detail.by_source || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
          statusEl.innerText = `${i18n.t('export_empty_title')}${bySource ? ` (${bySource})` : ''}`;
        } else {
          statusEl.innerText = e.message;
          notify(e.message, 'error');
        }
      } finally {
        exportBtn.disabled = false;
      }
    };
  }

  formatStats(stats) {
    return i18n.t('export_stats', {
      anns: Number(stats.annotations_written || 0),
      images: Number(stats.images_written || 0),
      source: Number(stats.skipped_source || 0),
      cls: Number(stats.skipped_class || 0),
      poly: Number(stats.skipped_no_polygon || 0),
      bbox: Number(stats.skipped_no_bbox || 0),
      missing: Number(stats.images_missing || 0),
    });
  }

  async loadPreview(statusEl) {
    let preview = null;
    try {
      preview = await api.previewExport({ project_id: this.workspace.projectId });
    } catch (e) {
      if (statusEl) statusEl.innerText = i18n.t('export_preview_failed');
    }
    this.preview = preview;
    const bySource = preview?.by_source || {};
    const noPolygon = preview?.no_polygon_by_source || {};
    document.querySelectorAll('.exp-source-count').forEach(el => {
      const src = el.dataset.source;
      const count = Number(bySource[src] || 0);
      const blank = Number(noPolygon[src] || 0);
      el.innerText = blank
        ? `(${count}, ${i18n.t('export_no_polygon_hint', { count: blank })})`
        : `(${count})`;
    });

    const container = document.getElementById('exp-class-list');
    if (!container) return;
    const classes = preview?.classes || this.workspace.projectClasses || [];
    const byClass = preview?.by_class || {};
    if (!classes.length) {
      container.innerHTML = `<div style="color: var(--neu-text-light);">${i18n.t('no_annotations_visible')}</div>`;
      return;
    }
    container.innerHTML = classes.map(cls => `
      <label><input type="checkbox" class="exp-class" data-class="${escapeHtml(cls)}" checked /> ${escapeHtml(cls)}
        <span style="color: var(--neu-text-light);">(${Number(byClass[cls] || 0)})</span></label>
    `).join('');
  }
}
