import { i18n } from '../i18n.js';

export function renderExportPanel() {
  return `
    <div class="neu-card" style="width: 400px; padding: 30px; position: relative;">
      <button id="btn-close-export-modal" class="neu-button" style="position: absolute; top: 15px; right: 15px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;">×</button>
      <h2 style="margin-top: 0;">${i18n.t('export')}</h2>
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出格式</label>
          <select id="exp-format" class="neu-input" style="width: 100%;">
            <option value="coco">COCO</option>
            <option value="yolo">YOLO</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div>
           <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">保存内容</label>
           <div style="display: flex; gap: 20px; font-size: 12px;">
              <label><input type="checkbox" id="exp-bbox" checked /> BBox</label>
              <label><input type="checkbox" id="exp-mask" /> Mask</label>
           </div>
        </div>
        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出目录</label>
          <input type="text" id="exp-dir" class="neu-input" style="width: 100%;" placeholder="留空则导出到项目默认目录" />
          <div style="margin-top: 6px; font-size: 11px; color: var(--neu-text-light);">YOLO 只能导出框或掩码其中一种；JSON/COCO 可以同时导出。</div>
        </div>
        <div class="neu-box" style="padding: 12px; border-radius: 12px; background: var(--neu-bg-light);">
          <div id="export-status" style="font-size: 12px; color: var(--neu-text-light);">请先选择格式和内容，再点击确认导出。</div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
          <button id="btn-cancel-export-modal" class="neu-button">${i18n.t('cancel')}</button>
          <button id="btn-do-export" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">确认导出</button>
        </div>
      </div>
    </div>
  `;
}
