import { escapeAttr, escapeHtml } from '../utils/html.js';

export function openAnnotationClassModal({
  annotation,
  classes = [],
  onConfirm,
  notify = () => {},
} = {}) {
  const annId = String(annotation?.id || '').trim();
  if (!annId) return null;

  const existing = document.getElementById('modal-edit-ann-class');
  if (existing) existing.remove();

  const currentClass = String(annotation?.class_name || '').trim();
  const options = Array.from(new Set([
    currentClass,
    ...classes.map((cls) => String(cls || '').trim()),
  ].filter(Boolean))).map((cls) => `
    <option value="${escapeAttr(cls)}" ${cls === currentClass ? 'selected' : ''}>${escapeHtml(cls)}</option>
  `).join('');

  const modal = document.createElement('div');
  modal.id = 'modal-edit-ann-class';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 9999; background: rgba(0,0,0,0.3); backdrop-filter: blur(4px);';
  modal.innerHTML = `
    <div class="neu-card" style="width: 420px; max-width: calc(100vw - 40px); padding: 28px; border-radius: 20px; position: relative;">
      <button class="neu-button" id="btn-close-edit-ann-class" style="position: absolute; top: 15px; right: 15px; width: 30px; height: 30px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">&times;</button>
      <h3 style="margin: 0 0 8px 0; font-size: 16px;">修改标注类别</h3>
      <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.7; margin-bottom: 18px;">
        当前类别：<b style="color: var(--neu-text);">${escapeHtml(currentClass || '--')}</b>
      </div>
      <label style="display: block; font-size: 12px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 8px;">选择已有类别</label>
      <select id="sel-edit-ann-class" class="neu-input" style="width: 100%; height: 38px; font-size: 13px; margin-bottom: 14px;">
        ${options}
      </select>
      <label style="display: block; font-size: 12px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 8px;">或输入新类别</label>
      <input id="inp-edit-ann-class" class="neu-input" type="text" placeholder="留空则使用上面的已有类别" style="width: 100%; height: 38px; font-size: 13px;" />
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
        <button class="neu-button" style="padding: 10px 20px;" id="btn-cancel-edit-ann-class">取消</button>
        <button class="neu-button" style="padding: 10px 20px; color: var(--neu-text-active); font-weight: 700;" id="btn-confirm-edit-ann-class">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  const classSelect = document.getElementById('sel-edit-ann-class');
  const classInput = document.getElementById('inp-edit-ann-class');
  const confirmBtn = document.getElementById('btn-confirm-edit-ann-class');
  const confirmChange = async () => {
    const nextClass = String(classInput?.value || '').trim() || String(classSelect?.value || '').trim();
    if (!nextClass) return notify('请选择或输入类别名称', 'error');
    try {
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerText = '保存中...';
      }
      const updated = await onConfirm?.(nextClass);
      if (updated) closeModal();
    } catch (e) {
      notify(e?.message || String(e), 'error');
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerText = '保存';
      }
    }
  };

  document.getElementById('btn-close-edit-ann-class').onclick = closeModal;
  document.getElementById('btn-cancel-edit-ann-class').onclick = closeModal;
  if (confirmBtn) confirmBtn.onclick = confirmChange;
  if (classInput) {
    classInput.focus();
    classInput.onkeydown = (e) => {
      if (e.key === 'Enter') confirmChange();
      if (e.key === 'Escape') closeModal();
    };
  }
  if (classSelect) {
    classSelect.onkeydown = (e) => {
      if (e.key === 'Enter') confirmChange();
      if (e.key === 'Escape') closeModal();
    };
  }

  return { close: closeModal };
}
