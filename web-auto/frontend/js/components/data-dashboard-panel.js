import { i18n } from '../i18n.js';

export function renderDataDashboardPanel() {
  return `
    <div class="neu-card" style="width: 920px; max-width: calc(100vw - 40px); padding: 28px; position: relative; max-height: 90vh; overflow-y: auto;">
      <button id="btn-close-dashboard-modal" class="neu-button" style="position: absolute; top: 16px; right: 16px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;">&times;</button>
      <h2 style="margin: 0 0 8px 0;">${i18n.t('data_dashboard')}</h2>
      <div id="dashboard-body" style="font-size: 12px; color: var(--neu-text-light); padding: 30px 0;">${i18n.t('loading_images')}</div>
    </div>
  `;
}
