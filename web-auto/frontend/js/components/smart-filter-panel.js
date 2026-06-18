import { escapeAttr, escapeHtml } from '../utils/html.js';

function renderClassOptions(classes = []) {
  return (Array.isArray(classes) ? classes : []).map((className) => {
    const label = String(className || '');
    return `<option value="${escapeAttr(label)}">${escapeHtml(label)}</option>`;
  }).join('');
}

function renderClassCheckboxes(classes = [], checkboxClass, checked = false) {
  return (Array.isArray(classes) ? classes : []).map((className) => {
    const label = String(className || '');
    return `
      <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
        <input type="checkbox" class="${checkboxClass}" value="${escapeAttr(label)}" ${checked ? 'checked' : ''} />
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }).join('');
}

export function renderSmartFilterPanel(classes = []) {
  return `
    <div class="neu-card" style="width: 860px; max-width: calc(100vw - 40px); padding: 28px; position: relative; max-height: 90vh; overflow-y: auto;">
      <button id="btn-close-filter-modal" class="neu-button" style="position: absolute; top: 16px; right: 16px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;">&times;</button>
      <h2 style="margin-top: 0; margin-bottom: 8px;">智能过滤工作台</h2>
      <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.7; margin-bottom: 18px;">
        先生成候选预览，再确认应用；应用时会为受影响图片写入 SQLite 回滚快照。
      </div>
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <div id="filter-rollback-panel" class="neu-box" style="display: none; padding: 14px; border-radius: 12px; background: var(--neu-bg-light);"></div>

        <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;">
          <button class="neu-button filter-recipe-card" data-filter-preset="dedupe" style="padding: 14px; text-align: left; display: flex; flex-direction: column; align-items: stretch; gap: 8px;">
            <b style="font-size: 13px;">同类去重</b>
            <span style="font-size: 11px; color: var(--neu-text-light); line-height: 1.5;">同一类别高覆盖/重叠时保留更大实例，适合清理批推重复框。</span>
          </button>
          <button class="neu-button filter-recipe-card" data-filter-preset="canonical" style="padding: 14px; text-align: left; display: flex; flex-direction: column; align-items: stretch; gap: 8px;">
            <b style="font-size: 13px;">类别合并</b>
            <span style="font-size: 11px; color: var(--neu-text-light); line-height: 1.5;">把来源类别并入目标类别，例如 face/head 合并到 human face。</span>
          </button>
          <button class="neu-button filter-recipe-card" data-filter-preset="cleanup" style="padding: 14px; text-align: left; display: flex; flex-direction: column; align-items: stretch; gap: 8px;">
            <b style="font-size: 13px;">小目标/低置信度</b>
            <span style="font-size: 11px; color: var(--neu-text-light); line-height: 1.5;">按类别范围删除小面积噪声或低分实例，必须预览后才能执行。</span>
          </button>
          <button class="neu-button filter-recipe-card" data-filter-preset="delete_unlabeled" style="padding: 14px; text-align: left; display: flex; flex-direction: column; align-items: stretch; gap: 8px;">
            <b style="font-size: 13px;">删除无标注图片</b>
            <span style="font-size: 11px; color: var(--neu-text-light); line-height: 1.5;">删除没有任何标注的图片文件和对应标注 JSON，适合清理空样本。</span>
          </button>
        </div>

        <div class="neu-box" style="padding: 8px; border-radius: 14px; display: flex; gap: 8px;">
          <button id="btn-filter-op-merge" class="neu-button" style="flex: 1; font-weight: 700;">合并过滤</button>
          <button id="btn-filter-op-rule" class="neu-button" style="flex: 1; font-weight: 700;">规则过滤</button>
          <button id="btn-filter-op-delete-unlabeled" class="neu-button" style="flex: 1; font-weight: 700;">删除无标注图片</button>
        </div>

        <div id="filter-op-hint" class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light); font-size: 12px; line-height: 1.8;"></div>

        <div id="filter-merge-panel" style="display: flex; flex-direction: column; gap: 18px;">
          <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px;">
            <div>
              <label class="neu-label">合并模式</label>
              <select id="filter-mode-sel" class="neu-input" style="width: 100%;">
                <option value="same_class">同类去重</option>
                <option value="canonical_class">来源类并入目标类</option>
              </select>
            </div>
            <div>
              <label class="neu-label">空间判定</label>
              <select id="filter-spatial-sel" class="neu-input" style="width: 100%;">
                <option value="instance_cover">实例嵌套</option>
                <option value="bbox_cover">边框嵌套</option>
              </select>
            </div>
            <div>
              <label class="neu-label">面积指标</label>
              <select id="filter-area-sel" class="neu-input" style="width: 100%;">
                <option value="instance">实例面积</option>
                <option value="bbox">边框面积</option>
              </select>
            </div>
          </div>

          <div id="filter-ms-panel" style="display: none; flex-direction: column; gap: 14px; padding: 16px; border-radius: 14px; background: var(--neu-bg-light);">
            <div>
              <label class="neu-label">目标类别</label>
              <select id="filter-target-cls" class="neu-input" style="width: 100%;">
                ${renderClassOptions(classes)}
              </select>
            </div>
            <div>
              <label class="neu-label">来源类别</label>
              <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 140px; overflow-y: auto; padding: 10px; border-radius: 10px; background: var(--neu-bg); box-shadow: var(--neu-inset);">
                ${renderClassCheckboxes(classes, 'source-cls-chk')}
              </div>
            </div>
          </div>

          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
              <label class="neu-label">包含阈值</label>
              <span id="filter-cov-val" style="font-size:12px; font-weight:700; color: var(--neu-text-active);">0.98</span>
            </div>
            <input type="range" id="filter-cov" min="0.5" max="1" step="0.01" value="0.98" style="width:100%;" />
            <div style="margin-top: 6px; font-size: 11px; color: var(--neu-text-light);">当较大实例覆盖较小实例达到该比例时，删除较小实例。</div>
          </div>
        </div>

        <div id="filter-rule-panel" style="display: none; flex-direction: column; gap: 18px;">
          <div class="neu-box" style="padding: 14px; border-radius: 12px; background: rgba(239, 68, 68, 0.08); font-size: 12px; line-height: 1.8; color: var(--neu-text);">
            规则过滤只会删除命中的标注，不会改类或合并。请先预览，确认命中范围后再执行删除。
          </div>

          <div class="neu-box" style="padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 14px;">
            <div style="font-size: 12px; font-weight: 800; color: var(--neu-text-light);">筛选条件</div>
            <div>
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">类别范围</div>
              <div style="display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; max-height: 140px; overflow-y:auto;">
                ${renderClassCheckboxes(classes, 'rule-cls-chk', true)}
              </div>
            </div>
            <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;">
              <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-small-enabled" /> 小目标过滤</label>
                <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">仅删除面积占比不超过该值的目标。</div>
                <input type="number" id="filter-small-ratio" class="neu-input" min="0" max="1" step="0.001" value="0.02" />
              </div>
              <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-count-enabled" /> 实例数量过滤</label>
                <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">仅删除实例总数落在该范围内的图片标注。左边是最少数量，右边是最多数量，0 表示不限制上限。</div>
                <div style="display:flex; gap: 8px;">
                  <input type="number" id="filter-min-count" class="neu-input" min="0" value="1" placeholder="最小值" />
                  <input type="number" id="filter-max-count" class="neu-input" min="0" value="0" placeholder="最大值(0=不限)" />
                </div>
              </div>
              <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-pos-enabled" /> 位置过滤</label>
                <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">中心矩形内命中的标注会被删除。</div>
                <div style="display:flex; gap: 8px;">
                  <input type="number" id="filter-center-x" class="neu-input" min="0" max="0.5" step="0.01" value="0.25" placeholder="半宽" />
                  <input type="number" id="filter-center-y" class="neu-input" min="0" max="0.5" step="0.01" value="0.05" placeholder="半高" />
                </div>
              </div>
              <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-conf-enabled" /> 置信度过滤</label>
                <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">仅删除置信度落在该区间内的标注。左边是最小分数，右边是最大分数。</div>
                <div style="display:flex; gap: 8px;">
                  <input type="number" id="filter-conf-min" class="neu-input" min="0" max="1" step="0.01" value="0.00" placeholder="最小分数" />
                  <input type="number" id="filter-conf-max" class="neu-input" min="0" max="1" step="0.01" value="1.00" placeholder="最大分数" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
          <div style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 6px;">执行摘要</div>
          <div id="filter-rule-text" style="font-size: 12px; line-height: 1.7;">--</div>
        </div>

        <div class="neu-box" style="padding: 16px; border-radius: 12px; display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 800; color: var(--neu-text-light);">任务进度</span>
            <span id="filter-job-progress-text" style="font-size: 11px; color: var(--neu-text-light);">空闲</span>
          </div>
          <div style="height: 8px; background: rgba(0,0,0,0.05); border-radius: 999px; overflow: hidden;">
            <div id="filter-job-progress-fill" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.25s ease;"></div>
          </div>
          <div id="filter-job-status" style="font-size: 12px; color: var(--neu-text); min-height: 18px;">先执行预览以查看命中结果。</div>
          <div id="filter-preview-summary" style="display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto;"></div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 12px;">
          <button id="btn-cancel-filter-modal" class="neu-button" style="padding: 10px 24px;">取消</button>
          <button id="btn-start-filter-preview" class="neu-button" style="padding: 10px 24px; color: var(--neu-text-active); font-weight: 700;">开始预览</button>
          <button id="btn-apply-filter" class="neu-button" style="padding: 10px 24px; color: #10b981; font-weight: 700; display: none;">确认合并</button>
        </div>
      </div>
    </div>
  `;
}
