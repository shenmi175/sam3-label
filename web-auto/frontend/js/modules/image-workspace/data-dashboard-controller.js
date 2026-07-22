import { api } from '../../api.js';
import { renderDataDashboardPanel } from '../../components/data-dashboard-panel.js';
import { i18n } from '../../i18n.js';
import { escapeAttr, escapeHtml } from '../../utils/html.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

function fmt(value) {
  return Number(value || 0).toLocaleString();
}

function pct(part, total) {
  return total > 0 ? `${((Number(part || 0) / Number(total || 1)) * 100).toFixed(1)}%` : '0.0%';
}

function renderBar(label, value, maxValue, sub = '') {
  const width = maxValue > 0 ? Math.max(2, Math.min(100, (Number(value || 0) / maxValue) * 100)) : 0;
  const safeLabel = escapeHtml(label);
  return `
    <div style="display: grid; grid-template-columns: minmax(110px, 180px) 1fr auto; gap: 10px; align-items: center;">
      <div style="font-weight: 700; color: var(--neu-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(label)}">${safeLabel}</div>
      <div style="height: 10px; border-radius: 999px; background: rgba(0,0,0,0.06); overflow: hidden;">
        <div style="width: ${width}%; height: 100%; border-radius: 999px; background: var(--neu-text-active);"></div>
      </div>
      <div style="font-variant-numeric: tabular-nums; color: var(--neu-text-light); text-align: right;">${fmt(value)}${escapeHtml(sub)}</div>
    </div>
  `;
}

export class DataDashboardController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  async open() {
    const ws = this.workspace;
    const modal = document.getElementById('modal-dashboard-full');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.innerHTML = renderDataDashboardPanel();
    const closeDashboardBtn = document.getElementById('btn-close-dashboard-modal');
    if (closeDashboardBtn) closeDashboardBtn.onclick = () => {
      modal.style.display = 'none';
      modal.innerHTML = '';
    };
    const body = document.getElementById('dashboard-body');
    if (!body) return;

    try {
      const res = await api.getAnnotationDashboard(ws.projectId);
      const stats = res?.stats || {};
      const classes = Array.isArray(stats.classes) ? stats.classes : [];
      const density = Array.isArray(stats.annotation_density) ? stats.annotation_density : [];
      const maxClassInstances = Math.max(1, ...classes.map((row) => Number(row.instance_count || 0)));
      const maxDensity = Math.max(1, ...density.map((row) => Number(row.image_count || 0)));
      const topClasses = classes.slice(0, 30);
      const rebuildHint = stats.needs_rebuild
        ? `<div class="neu-box" style="padding: 12px; border-radius: 12px; background: rgba(245, 158, 11, 0.12); color: var(--neu-text); line-height: 1.7;">${i18n.t('dashboard_rebuild_hint')}</div>`
        : '';

      body.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 16px;">
          ${rebuildHint}
          <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;">
            <div class="neu-box" style="padding: 14px; border-radius: 14px;"><div style="color: var(--neu-text-light);">总图片</div><b style="font-size: 22px;">${fmt(stats.total_images)}</b></div>
            <div class="neu-box" style="padding: 14px; border-radius: 14px;"><div style="color: var(--neu-text-light);">已标注</div><b style="font-size: 22px; color: #10b981;">${fmt(stats.labeled_images)}</b><div>${pct(stats.labeled_images, stats.total_images)}</div></div>
            <div class="neu-box" style="padding: 14px; border-radius: 14px;"><div style="color: var(--neu-text-light);">实例数</div><b style="font-size: 22px;">${fmt(stats.annotation_count)}</b></div>
            <div class="neu-box" style="padding: 14px; border-radius: 14px;"><div style="color: var(--neu-text-light);">SQLite 标注</div><b style="font-size: 22px;">${fmt(stats.annotation_store_images)}</b><div>${pct(stats.annotation_store_images, stats.total_images)}</div></div>
          </div>

          <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px;">
            <div class="neu-box" style="padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                <b style="font-size: 14px;">类别实例分布</b>
                <span style="color: var(--neu-text-light);">${topClasses.length}/${classes.length}</span>
              </div>
              ${topClasses.length ? topClasses.map((row) => renderBar(row.class_name, row.instance_count, maxClassInstances, ` / ${fmt(row.image_count)}图`)).join('') : '<div style="color: var(--neu-text-light); padding: 20px 0;">暂无类别索引数据</div>'}
            </div>
            <div class="neu-box" style="padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 10px;">
              <b style="font-size: 14px;">每图实例数分布</b>
              ${density.map((row) => renderBar(row.bucket, row.image_count, maxDensity)).join('')}
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button id="btn-dashboard-migrate-annotations" class="neu-button" style="padding: 10px 18px; font-weight: 700;">${i18n.t('migrate_annotation_layout')}</button>
            <button id="btn-dashboard-rebuild-index" class="neu-button" style="padding: 10px 18px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('rebuild_annotation_index')}</button>
          </div>
        </div>
      `;

      const rebuildBtn = document.getElementById('btn-dashboard-rebuild-index');
      const migrateBtn = document.getElementById('btn-dashboard-migrate-annotations');
      if (migrateBtn) migrateBtn.onclick = async () => {
        try {
          migrateBtn.disabled = true;
          const preview = await api.migrateAnnotationLayout(ws.projectId, true);
          const planned = Number(preview?.moved || 0);
          const conflicts = Number(preview?.conflicts || 0);
          if (planned <= 0 && conflicts <= 0) {
            notify('标注目录已是最新结构', 'success');
            return;
          }
          if (!confirm(`将迁移 ${planned} 个标注文件，发现 ${conflicts} 个冲突。冲突文件会保留到 .legacy_conflicts，是否继续？`)) return;
          migrateBtn.innerText = i18n.t('migrating_annotation_layout');
          const result = await api.migrateAnnotationLayout(ws.projectId, false);
          notify(`迁移完成：移动 ${fmt(result?.moved)}，冲突 ${fmt(result?.conflicts)}，失败 ${fmt(result?.failed)}`, result?.failed ? 'error' : 'success');
          await this.open();
        } catch (e) {
          notify(e.message, 'error');
        } finally {
          migrateBtn.disabled = false;
          migrateBtn.innerText = i18n.t('migrate_annotation_layout');
        }
      };
      if (rebuildBtn) rebuildBtn.onclick = async () => {
        if (!confirm(i18n.t('confirm_rebuild_annotation_index'))) return;
        try {
          rebuildBtn.disabled = true;
          rebuildBtn.innerText = i18n.t('rebuilding_index');
          const rebuildRes = await api.rebuildAnnotationIndex(ws.projectId);
          const result = rebuildRes?.result || {};
          notify(`标注存储/索引重建完成：${fmt(result.annotation_store_images || result.indexed_images)} 张图片`, 'success');
          await ws.loadProjectInfo();
          await ws.loadImages();
          await this.open();
        } catch (e) {
          notify(e.message, 'error');
        } finally {
          rebuildBtn.disabled = false;
          rebuildBtn.innerText = i18n.t('rebuild_annotation_index');
        }
      };
    } catch (e) {
      body.innerHTML = `<div style="color: #ef4444;">${escapeHtml(e.message)}</div>`;
    }
  }
}
