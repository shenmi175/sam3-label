import { escapeAttr, escapeHtml } from '../utils/html.js';
import { i18n } from '../i18n.js';

export function renderAnnotationList(
  container,
  annotations,
  {
    focusedAnnotationId = '',
    isLoading = false,
    loadingText = 'Loading annotations',
    emptyText = 'No annotations',
    getClassColor = () => '#64748b',
  } = {},
) {
  if (!container) return;
  const anns = Array.isArray(annotations) ? annotations : [];
  if (isLoading) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">${escapeHtml(loadingText)}</div>`;
    return;
  }
  if (anns.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">${escapeHtml(emptyText)}</div>`;
    return;
  }

  container.innerHTML = anns.map((ann) => {
    const annId = String(ann.id || '');
    const className = String(ann.class_name || '');
    const annIdAttr = escapeAttr(annId);
    const classNameHtml = escapeHtml(className);
    const isFocused = String(focusedAnnotationId || '') === annId;
    const sourceModel = String(ann.source_model || '').trim();
    const sourceLabel = sourceModel === 'locate-anything'
      ? i18n.t('source_la')
      : sourceModel === 'manual'
        ? i18n.t('source_manual')
        : sourceModel && sourceModel !== 'sam3' ? sourceModel : '';
    const sourceTagHtml = sourceLabel
      ? `<span style="font-size:9px; opacity:0.55; margin-left:4px; font-weight:600;">[${escapeHtml(sourceLabel)}]</span>`
      : '';
    return `
      <div class="neu-box ann-item-focus" data-ann-id="${annIdAttr}" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; background: ${isFocused ? 'var(--neu-bg-light)' : 'var(--neu-bg)'}; box-shadow: ${isFocused ? 'var(--neu-inset)' : 'var(--neu-inset-sm)'}; cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="width: 10px; height: 10px; border-radius: 50%; background: ${getClassColor(className)};"></span>
            <span style="font-size: 13px; font-weight: 700;">${classNameHtml}${sourceTagHtml}</span>
          </div>
          <div style="display: flex; gap: 5px;">
            <button type="button" class="neu-button ann-edit-class-btn" data-ann-id="${annIdAttr}" title="修改该标注类别" style="width: 28px; height: 24px; padding: 0; font-size: 11px; font-weight: 800; color: var(--neu-text-active);">改</button>
            <button type="button" class="neu-button ann-delete-btn" data-ann-id="${annIdAttr}" title="删除该标注" style="width: 24px; height: 24px; padding: 0; font-size: 12px; color: #ef4444;">×</button>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--neu-text-light); display: flex; justify-content: space-between;">
          <span>Conf: <b>${(ann.score || 0.98).toFixed(3)}</b></span>
          <span>${ann.polygon ? 'Polygon' : 'BBox'}</span>
        </div>
      </div>
    `;
  }).join('');
}

export function bindAnnotationListEvents(container, { onFocus = null, onEditClass = null, onDelete = null } = {}) {
  if (!container) return;
  container.onclick = (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    const editBtn = target.closest('.ann-edit-class-btn');
    if (editBtn && container.contains(editBtn)) {
      event.stopPropagation();
      if (onEditClass) onEditClass(editBtn.dataset.annId || '');
      return;
    }

    const deleteBtn = target.closest('.ann-delete-btn');
    if (deleteBtn && container.contains(deleteBtn)) {
      event.stopPropagation();
      if (onDelete) onDelete(deleteBtn.dataset.annId || '');
      return;
    }

    const item = target.closest('.ann-item-focus');
    if (item && container.contains(item)) {
      if (onFocus) onFocus(item.dataset.annId || '');
    }
  };
}

export function updateAnnotationListFocus(container, focusedAnnotationId) {
  if (!container) return;
  const focusedId = String(focusedAnnotationId || '');
  container.querySelectorAll('.ann-item-focus').forEach((item) => {
    const isFocused = String(item.dataset.annId || '') === focusedId && focusedId !== '';
    item.style.background = isFocused ? 'var(--neu-bg-light)' : 'var(--neu-bg)';
    item.style.boxShadow = isFocused ? 'var(--neu-inset)' : 'var(--neu-inset-sm)';
    item.setAttribute('aria-selected', isFocused ? 'true' : 'false');
  });
}
