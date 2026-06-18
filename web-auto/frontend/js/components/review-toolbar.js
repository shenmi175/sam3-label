export function renderReviewToolbar() {
  return `
    <div class="ws-review-only" data-default-display="flex" style="display: none; align-items: center; gap: 8px; min-width: 0;">
      <div class="neu-box" title="当前手工标注类别，可用数字键 1-9 快速切换" style="height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 10px; box-shadow: var(--neu-inset); min-width: 0;">
        <span style="font-size: 11px; font-weight: 800; color: var(--neu-text-light); white-space: nowrap;">当前类</span>
        <span id="review-current-class" style="font-size: 12px; font-weight: 800; color: var(--neu-text-active); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">--</span>
      </div>
      <button id="btn-review-continuous" class="neu-button" title="人工模式下画完一个框/多边形后继续保持当前工具" style="height: 32px; padding: 0 10px; font-size: 11px; font-weight: 700;">连续: 开</button>
      <button id="btn-review-apply-class" class="neu-button" title="将选中标注改为当前类别" style="height: 32px; padding: 0 10px; font-size: 11px; font-weight: 700;">改为当前类</button>
      <button id="btn-review-delete-ann" class="neu-button" title="删除当前选中标注，快捷键 Delete" style="height: 32px; padding: 0 10px; font-size: 11px; font-weight: 700; color: #ef4444;">删标注</button>
      <button id="btn-review-save-next" class="neu-button" title="保存当前标注并切换下一张" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 800; color: var(--neu-text-active);">保存下一张</button>
      <button id="btn-review-next-unlabeled" class="neu-button" title="切换到下一张未标注图片" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 700;">下一张未标注</button>
    </div>
  `;
}
