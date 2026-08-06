import { i18n } from '../i18n.js';

export function renderExportPanel() {
  return `
    <div class="neu-card" style="width: 540px; max-height: 88vh; overflow-y: auto; padding: 30px; position: relative;">
      <button id="btn-close-export-modal" class="neu-button" style="position: absolute; top: 15px; right: 15px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;">×</button>
      <h2 style="margin-top: 0;">${i18n.t('export')}</h2>
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <div style="display: flex; gap: 16px;">
          <div style="flex: 1;">
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">${i18n.t('export_format')}</label>
            <select id="exp-format" class="neu-input" style="width: 100%;">
              <option value="coco">COCO</option>
              <option value="yolo">YOLO</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <div style="flex: 1;">
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">${i18n.t('export_content')}</label>
            <div style="display: flex; gap: 20px; font-size: 12px; padding-top: 8px;">
              <label><input type="checkbox" id="exp-bbox" checked /> BBox</label>
              <label><input type="checkbox" id="exp-mask" /> Mask</label>
            </div>
          </div>
        </div>

        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">${i18n.t('export_sources')}</label>
          <div id="exp-source-list" style="display: flex; flex-direction: column; gap: 6px; font-size: 12px;">
            <label><input type="checkbox" class="exp-source" data-source="sam3" checked /> sam3 <span class="exp-source-count" data-source="sam3" style="color: var(--neu-text-light);"></span></label>
            <label><input type="checkbox" class="exp-source" data-source="locate-anything" /> ${i18n.t('source_la')} <span class="exp-source-count" data-source="locate-anything" style="color: var(--neu-text-light);"></span></label>
            <label><input type="checkbox" class="exp-source" data-source="manual" checked /> ${i18n.t('source_manual')} <span class="exp-source-count" data-source="manual" style="color: var(--neu-text-light);"></span></label>
          </div>
        </div>

        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <label style="font-size: 11px; font-weight: 700;">${i18n.t('export_classes')}</label>
            <div style="display: flex; gap: 6px;">
              <button id="btn-exp-class-all" class="neu-button" style="height: 22px; padding: 0 10px; font-size: 10px;">${i18n.t('export_select_all')}</button>
              <button id="btn-exp-class-invert" class="neu-button" style="height: 22px; padding: 0 10px; font-size: 10px;">${i18n.t('export_invert')}</button>
            </div>
          </div>
          <div id="exp-class-list" class="neu-box" style="max-height: 150px; overflow-y: auto; padding: 10px; border-radius: 12px; background: var(--neu-bg-light); font-size: 12px; display: flex; flex-direction: column; gap: 4px;"></div>
        </div>

        <div id="exp-yolo-block" style="display: none;">
          <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">YOLO</label>
          <div style="display: flex; gap: 16px; align-items: center; font-size: 12px;">
            <label style="display: flex; align-items: center; gap: 6px;">
              ${i18n.t('export_val_ratio')}
              <input type="number" id="exp-val-ratio" class="neu-input" min="0" max="0.9" step="0.05" value="0" style="width: 80px;" />
            </label>
            <label><input type="checkbox" id="exp-data-yaml" checked /> ${i18n.t('export_write_data_yaml')}</label>
          </div>
        </div>

        <div>
          <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">${i18n.t('export_dir')}</label>
          <input type="text" id="exp-dir" class="neu-input" style="width: 100%;" placeholder="${i18n.t('export_dir_placeholder')}" />
          <div id="exp-format-hint" style="margin-top: 6px; font-size: 11px; color: var(--neu-text-light);"></div>
        </div>

        <div class="neu-box" style="padding: 12px; border-radius: 12px; background: var(--neu-bg-light);">
          <div id="export-status" style="font-size: 12px; color: var(--neu-text-light);">${i18n.t('export_ready_hint')}</div>
          <div id="export-stats" style="margin-top: 6px; font-size: 11px; color: var(--neu-text-light);"></div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="btn-cancel-export-modal" class="neu-button">${i18n.t('cancel')}</button>
          <button id="btn-do-export" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">${i18n.t('export_confirm')}</button>
        </div>
      </div>
    </div>
  `;
}
