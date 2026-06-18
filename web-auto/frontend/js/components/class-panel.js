import { escapeAttr, escapeHtml } from '../utils/html.js';

export function classCountsFromAnnotations(annotations = []) {
  const counts = {};
  (Array.isArray(annotations) ? annotations : []).forEach((ann) => {
    const className = String(ann?.class_name || '');
    if (!className) return;
    counts[className] = (counts[className] || 0) + 1;
  });
  return counts;
}

export function renderClassPanel(
  container,
  classes,
  {
    selectedClass = '',
    annotations = [],
    emptyText = 'No classes',
    getClassColor = () => '#64748b',
  } = {},
) {
  if (!container) return;
  const items = Array.isArray(classes) ? classes : [];
  if (items.length === 0) {
    container.innerHTML = `<div style="color:var(--neu-text-light); font-size:12px; text-align:center;">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const counts = classCountsFromAnnotations(annotations);
  container.innerHTML = items.map((className) => {
    const escapedClass = escapeAttr(className);
    const classLabel = escapeHtml(className);
    const isSelected = String(selectedClass || '') === String(className || '');
    return `
      <div class="neu-button class-item ${isSelected ? 'active' : ''}"
           data-cls="${escapedClass}"
           style="justify-content: space-between; padding: 10px 15px; font-size: 13px; border-radius: 12px; ${isSelected ? 'box-shadow: var(--neu-inset);' : ''}">
        <div class="cls-select" style="display: flex; align-items: center; gap: 10px; flex: 1; cursor: pointer; pointer-events: auto;">
           <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${getClassColor(className)}; box-shadow: 0 2px 5px rgba(0,0,0,0.1); pointer-events: none;"></span>
           <span style="font-weight: 600; pointer-events: none;">${classLabel}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
           <span style="font-size: 11px; opacity: 0.6; font-family: monospace;">(${counts[className] || 0})</span>
           <input type="checkbox" class="cls-chk-infer" data-cls="${escapedClass}" title="Include in text inference" checked style="width: 14px; height: 14px; cursor: pointer;" />
           <button type="button" class="cls-delete-btn neu-button" data-delete-cls="${escapedClass}" style="width: 22px; height: 22px; padding: 0; border-radius: 50%; font-size: 11px; color: #ef4444; flex-shrink: 0;" title="删除类别">×</button>
        </div>
      </div>
    `;
  }).join('');
}

export function bindClassPanelEvents(container, { onSelect = null, onDelete = null } = {}) {
  if (!container) return;
  container.onclick = (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    const deleteBtn = target.closest('.cls-delete-btn');
    if (deleteBtn && container.contains(deleteBtn)) {
      event.stopPropagation();
      if (onDelete) onDelete(deleteBtn.dataset.deleteCls);
      return;
    }

    const selectArea = target.closest('.cls-select');
    if (selectArea && container.contains(selectArea)) {
      const item = target.closest('.class-item');
      if (item && onSelect) onSelect(item.dataset.cls);
    }
  };
}
