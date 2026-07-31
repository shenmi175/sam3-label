import { i18n } from '../i18n.js';
import { store } from '../store.js';

export function renderAutoAnnotatePanel() {
  return `
    <div class="ws-auto-only" data-default-display="flex" style="display: flex; align-items: center; gap: 8px;">
      <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('sam3_api')}</label>
      <input type="text" id="inp-sam3-url" class="neu-input" style="width: 180px; height: 32px; font-size: 11px;" value="${store.state.config.sam3ApiUrl}" />
      <button id="btn-test-api" class="neu-button" style="height: 32px; padding: 0 10px; font-size: 11px;">${i18n.t('test_api')}</button>
      <select id="sel-backend" class="neu-input" style="width: 140px; height: 32px; font-size: 11px;">
        <option value="sam3">${i18n.t('sam3_backend')}</option>
        <option value="locate-anything">${i18n.t('locate_backend')}</option>
      </select>
      <input type="text" id="inp-locate-url" class="neu-input" style="width: 180px; height: 32px; font-size: 11px; display: ${store.state.config.defaultBackend === 'locate-anything' ? '' : 'none'};" value="${store.state.config.locateApiUrl}" placeholder="${i18n.t('locate_api_url')}" />
    </div>

    <div class="ws-auto-only" data-default-display="block" style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

    <div class="ws-auto-only" data-default-display="flex" style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
      <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); white-space: nowrap;">${i18n.t('threshold')}</label>
      <div class="neu-box" style="height: 32px; display: flex; align-items: center; gap: 2px; padding: 0 4px; border-radius: 10px; box-shadow: var(--neu-inset);">
        <button id="btn-threshold-dec" class="neu-button" title="Threshold -0.05" style="width: 24px; height: 24px; padding: 0; border-radius: 8px; font-size: 12px;">-</button>
        <span id="lbl-threshold-value" style="min-width: 42px; text-align: center; font-size: 12px; font-weight: 800; color: var(--neu-text); font-variant-numeric: tabular-nums;">${Number(store.state.config.threshold).toFixed(2)}</span>
        <button id="btn-threshold-inc" class="neu-button" title="Threshold +0.05" style="width: 24px; height: 24px; padding: 0; border-radius: 8px; font-size: 12px;">+</button>
      </div>

      <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-left: 5px; white-space: nowrap;">${i18n.t('batch_size')}</label>
      <div class="neu-box" style="height: 32px; display: flex; align-items: center; gap: 2px; padding: 0 4px; border-radius: 10px; box-shadow: var(--neu-inset);">
        <button id="btn-batch-dec" class="neu-button" title="Batch size -1" style="width: 24px; height: 24px; padding: 0; border-radius: 8px; font-size: 12px;">-</button>
        <span id="lbl-batch-size-value" style="min-width: 32px; text-align: center; font-size: 12px; font-weight: 800; color: var(--neu-text); font-variant-numeric: tabular-nums;">${store.state.config.batchSize}</span>
        <button id="btn-batch-inc" class="neu-button" title="Batch size +1" style="width: 24px; height: 24px; padding: 0; border-radius: 8px; font-size: 12px;">+</button>
      </div>

      <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-left: 5px; white-space: nowrap;">${i18n.t('contour_mode')}</label>
      <select id="sel-contour-mode" class="neu-input" style="width: 132px; height: 32px; font-size: 11px;">
        <option value="split">${i18n.t('contour_split')}</option>
        <option value="merged">${i18n.t('contour_merged')}</option>
      </select>
    </div>

    <div class="ws-auto-only" data-default-display="block" style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

    <div class="ws-auto-only" data-default-display="flex" style="display: flex; gap: 8px;">
      <button id="btn-infer-current" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('infer_current')}</button>
      <button id="btn-batch-infer" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('batch_infer')}</button>
      <button id="btn-la-boxes-batch" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('la_boxes_batch')}</button>
      <button id="btn-example-segment" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('example_segment')}</button>
    </div>
  `;
}
