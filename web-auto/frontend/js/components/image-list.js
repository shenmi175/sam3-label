import { escapeAttr, escapeHtml } from '../utils/html.js';

export function renderImageList(container, images, selectedImageId, emptyText) {
  if (!container) return;
  const items = Array.isArray(images) ? images : [];
  if (items.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--neu-text-light);">${escapeHtml(emptyText || 'No images')}</div>`;
    return;
  }

  const html = items.map((img) => {
    const isSelected = String(selectedImageId || '') === String(img.id || '');
    const bgState = isSelected ? 'var(--neu-bg)' : 'transparent';
    const shadowState = isSelected ? 'var(--neu-inset)' : 'none';
    const weight = isSelected ? '700' : '500';
    const imageIdAttr = escapeAttr(img.id);
    const relPathAttr = escapeAttr(img.rel_path);
    const relPathHtml = escapeHtml(img.rel_path);
    const isLabeled = img.status === 'labeled' || img.labeled;
    const dotColor = isLabeled ? '#10b981' : '#e2e8f0';

    return `
      <div class="neu-button image-item"
           data-id="${imageIdAttr}" data-rel="${relPathAttr}" tabindex="0"
           style="justify-content: flex-start; text-align: left; padding: 10px 8px 10px 12px; background: ${bgState}; box-shadow: ${shadowState}; font-weight: ${weight}; border-radius: 12px; font-size: 13px; overflow: hidden; cursor: pointer; display: flex; align-items: center; gap: 8px;">
         <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; margin-right: 12px; flex-shrink: 0; pointer-events: none;"></span>
         <span style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden; pointer-events: none; flex: 1; min-width: 0;">${relPathHtml}</span>
         <button type="button" class="neu-button btn-delete-image" data-id="${imageIdAttr}" data-rel="${relPathAttr}" title="删除图片和标注文件" aria-label="删除图片和标注文件" style="width: 24px; height: 24px; min-width: 24px; padding: 0; border-radius: 8px; color: #ef4444; font-size: 15px; font-weight: 800; line-height: 1; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">×</button>
      </div>
    `;
  }).join('');

  container.innerHTML = `<div style="display: flex; flex-direction: column; gap: 8px;">${html}</div>`;
}

export function bindImageListEvents(container, { onSelect = null, onDelete = null } = {}) {
  if (!container) return;
  container.onclick = (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    const deleteBtn = target.closest('.btn-delete-image');
    if (deleteBtn && container.contains(deleteBtn)) {
      event.preventDefault();
      event.stopPropagation();
      if (onDelete) onDelete(deleteBtn.dataset.id, deleteBtn.dataset.rel);
      return;
    }

    const item = target.closest('.image-item');
    if (item && container.contains(item)) {
      item.focus({ preventScroll: true });
      if (onSelect) onSelect(item.dataset.id, item.dataset.rel);
    }
  };
}

export function updateImageListSelection(selectedImageId, root = document) {
  root.querySelectorAll('.image-item').forEach((el) => {
    const selected = String(el.dataset.id || '') === String(selectedImageId || '');
    el.style.background = selected ? 'var(--neu-bg)' : 'transparent';
    el.style.boxShadow = selected ? 'var(--neu-inset)' : 'none';
    el.style.fontWeight = selected ? '700' : '500';
  });
}

export function focusImageListItem(imageId, root = document) {
  const item = Array.from(root.querySelectorAll('.image-item'))
    .find((el) => String(el.dataset.id || '') === String(imageId || ''));
  if (item) item.focus({ preventScroll: true });
  return item || null;
}

export function setImageListItemLabeledState(imageId, labeled, root = document) {
  const item = Array.from(root.querySelectorAll('.image-item'))
    .find((el) => String(el.dataset.id || '') === String(imageId || ''));
  const dot = item?.querySelector('span');
  if (dot) dot.style.background = labeled ? '#10b981' : '#e2e8f0';
}
