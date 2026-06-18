import { i18n } from '../i18n.js';
import { renderAutoAnnotatePanel } from './auto-annotate-panel.js';
import { renderReviewToolbar } from './review-toolbar.js';

export function renderWorkspaceToolbar() {
  return `
    <div class="neu-box" style="height: 64px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 90; border-radius: 0; gap: 15px; background: var(--neu-bg); border-bottom: 1px solid rgba(0,0,0,0.03); box-sizing: border-box;">
      <div id="workspace-mode-switch" class="neu-box" style="height: 34px; display: flex; align-items: center; gap: 4px; padding: 3px; border-radius: 12px; box-shadow: var(--neu-inset); flex-shrink: 0;">
        <button id="btn-workspace-mode-auto" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 11px; font-weight: 800;">自动标注</button>
        <button id="btn-workspace-mode-review" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 11px; font-weight: 800;">人工校对</button>
      </div>

      ${renderAutoAnnotatePanel()}
      ${renderReviewToolbar()}

      <div style="flex: 1;"></div>

      <div style="display: flex; gap: 8px;">
        <button id="btn-open-data-dashboard" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('data_dashboard')}</button>
        <button id="btn-open-filter" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('smart_filter')}</button>
        <button id="btn-open-export" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('export')}</button>
      </div>
    </div>
  `;
}
