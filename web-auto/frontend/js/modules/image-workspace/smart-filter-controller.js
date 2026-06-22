import { api } from '../../api.js';
import { renderSmartFilterPanel } from '../../components/smart-filter-panel.js';
import { i18n } from '../../i18n.js';
import { escapeHtml } from '../../utils/html.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

function byId(id) {
  return document.getElementById(id);
}

function checkedValues(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => el.value);
}

function setNumberInput(id, value) {
  const el = byId(id);
  if (el) el.value = value;
}

function isChecked(id) {
  return Boolean(byId(id)?.checked);
}

function setChecked(id, checked) {
  const el = byId(id);
  if (el) el.checked = Boolean(checked);
}

export class SmartFilterController {
  constructor(workspace) {
    this.workspace = workspace;
    this.filterJobTimer = null;
    this.currentFilterToken = '';
    this.operationMode = 'merge';
  }

  clearTimer() {
    if (this.filterJobTimer) {
      clearTimeout(this.filterJobTimer);
      this.filterJobTimer = null;
    }
  }

  closeModal(modal) {
    this.clearTimer();
    this.currentFilterToken = '';
    if (modal) {
      modal.style.display = 'none';
      modal.innerHTML = '';
    }
  }

  open() {
    const ws = this.workspace;
    const modal = byId('modal-filter-full');
    if (!modal) return notify('智能过滤弹窗初始化失败', 'error');

    modal.innerHTML = renderSmartFilterPanel(ws.projectMeta?.classes || []);
    modal.style.display = 'flex';
    this.operationMode = 'merge';

    const mergeBtn = byId('btn-filter-op-merge');
    const ruleBtn = byId('btn-filter-op-rule');
    const deleteUnlabeledBtn = byId('btn-filter-op-delete-unlabeled');
    const opHint = byId('filter-op-hint');
    const mergePanel = byId('filter-merge-panel');
    const rulePanel = byId('filter-rule-panel');
    const modeSel = byId('filter-mode-sel');
    const msPanel = byId('filter-ms-panel');
    const statusEl = byId('filter-job-status');
    const progressFillEl = byId('filter-job-progress-fill');
    const progressTextEl = byId('filter-job-progress-text');
    const summaryEl = byId('filter-preview-summary');
    const rollbackPanel = byId('filter-rollback-panel');
    const previewBtn = byId('btn-start-filter-preview');
    const applyBtn = byId('btn-apply-filter');
    const cov = byId('filter-cov');
    const recipeButtons = Array.from(document.querySelectorAll('.filter-recipe-card'));
    const filterInputs = [
      'filter-spatial-sel', 'filter-area-sel', 'filter-target-cls', 'filter-small-enabled', 'filter-small-ratio',
      'filter-count-enabled', 'filter-min-count', 'filter-max-count', 'filter-pos-enabled', 'filter-center-x',
      'filter-center-y', 'filter-conf-enabled', 'filter-conf-min', 'filter-conf-max',
    ].map(byId).filter(Boolean);

    const required = [
      mergeBtn, ruleBtn, deleteUnlabeledBtn, opHint, mergePanel, rulePanel, modeSel, msPanel,
      statusEl, progressFillEl, progressTextEl, summaryEl, previewBtn, applyBtn, cov,
    ];
    if (required.some((el) => !el)) {
      return notify('智能过滤控件初始化失败', 'error');
    }

    const closeFilterModal = () => this.closeModal(modal);
    const closeFilterBtn = byId('btn-close-filter-modal');
    const cancelFilterBtn = byId('btn-cancel-filter-modal');
    if (closeFilterBtn) closeFilterBtn.onclick = closeFilterModal;
    if (cancelFilterBtn) cancelFilterBtn.onclick = closeFilterModal;

    const syncOperationUI = () => {
      const mergeActive = this.operationMode === 'merge';
      const ruleActive = this.operationMode === 'rule';
      const deleteActive = this.operationMode === 'delete_unlabeled';
      mergePanel.style.display = mergeActive ? 'flex' : 'none';
      rulePanel.style.display = ruleActive ? 'flex' : 'none';
      msPanel.style.display = mergeActive && modeSel.value === 'canonical_class' ? 'flex' : 'none';
      mergeBtn.style.boxShadow = mergeActive ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      ruleBtn.style.boxShadow = ruleActive ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      deleteUnlabeledBtn.style.boxShadow = deleteActive ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      mergeBtn.style.color = mergeActive ? 'var(--neu-text-active)' : 'var(--neu-text)';
      ruleBtn.style.color = ruleActive ? '#ef4444' : 'var(--neu-text)';
      deleteUnlabeledBtn.style.color = deleteActive ? '#ef4444' : 'var(--neu-text)';
      if (mergeActive) {
        opHint.innerText = '合并过滤：用于处理重复标注或把来源类别并入目标类别。该模式不会使用规则过滤条件。';
      } else if (ruleActive) {
        opHint.innerText = '规则过滤：只根据已勾选的规则筛出命中标注，并在确认后删除这些命中标注。该模式不会做改类或合并。';
      } else {
        opHint.innerText = '删除无标注图片：扫描当前项目中没有任何标注的图片，确认后删除原图文件和 annotations 目录下对应 JSON。该操作不能通过智能过滤回滚恢复。';
      }
      applyBtn.innerText = mergeActive ? '确认合并' : (deleteActive ? '确认删除图片' : '删除命中标注');
      applyBtn.style.color = mergeActive ? '#10b981' : '#ef4444';
      this.updateRuleText(this.operationMode);
    };

    const updateUI = () => {
      syncOperationUI();
      this.updateRuleText(this.operationMode);
    };

    const resetPreviewState = () => {
      applyBtn.style.display = 'none';
      summaryEl.innerHTML = '';
      this.currentFilterToken = '';
      progressFillEl.style.width = '0%';
      progressFillEl.style.background = 'var(--neu-text-active)';
      progressTextEl.innerText = '空闲';
      statusEl.innerText = '先执行预览以查看命中结果。';
    };

    const setActivePreset = (preset) => {
      recipeButtons.forEach((btn) => {
        const active = btn.dataset.filterPreset === preset;
        btn.style.boxShadow = active ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
        btn.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text)';
      });
    };

    const renderRollbackPanel = (run) => {
      if (!rollbackPanel) return;
      if (!run?.run_id) {
        rollbackPanel.style.display = 'none';
        rollbackPanel.innerHTML = '';
        return;
      }
      const summary = run.summary || {};
      const changed = summary.changed_images || run.snapshot_count || 0;
      const removed = summary.removed_annotations || 0;
      const relabeled = summary.relabeled_annotations || 0;
      rollbackPanel.style.display = 'block';
      rollbackPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="font-size: 12px; line-height: 1.7;">
            <b>最近一次过滤可回滚</b>
            <div style="color: var(--neu-text-light);">影响 ${changed} 张，删除 ${removed} 个，改类 ${relabeled} 个。回滚会把这些图片恢复到过滤前的标注快照。</div>
          </div>
          <button id="btn-filter-rollback-run" class="neu-button" style="padding: 8px 14px; font-size: 12px; color: #ef4444; font-weight: 700;">回滚本次过滤</button>
        </div>
      `;
      const rollbackBtn = byId('btn-filter-rollback-run');
      if (!rollbackBtn) return;
      rollbackBtn.onclick = async () => {
        if (!confirm('确认回滚最近一次智能过滤吗？受影响图片会恢复到过滤前的标注快照。')) return;
        try {
          rollbackBtn.disabled = true;
          rollbackBtn.innerText = '回滚中...';
          const res = await api.rollbackFilterRun(ws.projectId, run.run_id);
          const result = res?.result || {};
          notify(`已回滚 ${result.restored_images || 0} 张图片`, 'success');
          ws.clearImageBundleCache();
          await ws.loadProjectInfo();
          if (ws.selectedImageId && ws.selectedImagePath) {
            await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
          }
          renderRollbackPanel(null);
        } catch (e) {
          notify(e.message, 'error');
        } finally {
          rollbackBtn.disabled = false;
          rollbackBtn.innerText = '回滚本次过滤';
        }
      };
    };

    const refreshLatestRollback = async () => {
      try {
        const res = await api.getLatestFilterRun(ws.projectId);
        renderRollbackPanel(res?.run || null);
      } catch (e) {
        console.warn('load latest smart filter run failed', e);
      }
    };

    const applyPreset = (preset) => {
      resetPreviewState();
      setActivePreset(preset);
      setChecked('filter-small-enabled', false);
      setChecked('filter-count-enabled', false);
      setChecked('filter-pos-enabled', false);
      setChecked('filter-conf-enabled', false);
      setNumberInput('filter-conf-min', '0.00');
      setNumberInput('filter-conf-max', '1.00');
      setNumberInput('filter-small-ratio', '0.02');
      if (preset === 'delete_unlabeled') {
        this.operationMode = 'delete_unlabeled';
      } else if (preset === 'cleanup') {
        this.operationMode = 'rule';
        setChecked('filter-small-enabled', true);
        setChecked('filter-conf-enabled', true);
        setNumberInput('filter-conf-max', '0.35');
        document.querySelectorAll('.rule-cls-chk').forEach((el) => { el.checked = true; });
      } else {
        this.operationMode = 'merge';
        modeSel.value = preset === 'canonical' ? 'canonical_class' : 'same_class';
        byId('filter-spatial-sel').value = 'instance_cover';
        byId('filter-area-sel').value = 'instance';
        cov.value = preset === 'canonical' ? '0.95' : '0.98';
        byId('filter-cov-val').innerText = Number(cov.value).toFixed(2);
      }
      updateUI();
    };

    mergeBtn.onclick = () => {
      this.operationMode = 'merge';
      resetPreviewState();
      setActivePreset('');
      updateUI();
    };
    deleteUnlabeledBtn.onclick = () => {
      this.operationMode = 'delete_unlabeled';
      resetPreviewState();
      setActivePreset('');
      updateUI();
    };
    ruleBtn.onclick = () => {
      this.operationMode = 'rule';
      resetPreviewState();
      setActivePreset('');
      updateUI();
    };

    cov.oninput = () => {
      resetPreviewState();
      byId('filter-cov-val').innerText = Number(cov.value).toFixed(2);
      this.updateRuleText(this.operationMode);
    };
    modeSel.onchange = () => {
      resetPreviewState();
      updateUI();
    };
    recipeButtons.forEach((btn) => {
      btn.onclick = () => applyPreset(btn.dataset.filterPreset || 'dedupe');
    });
    Array.from(document.querySelectorAll('.source-cls-chk, .rule-cls-chk')).forEach((el) => {
      el.onchange = () => {
        resetPreviewState();
        this.updateRuleText(this.operationMode);
      };
    });
    filterInputs.forEach((el) => {
      el.onchange = () => {
        resetPreviewState();
        this.updateRuleText(this.operationMode);
      };
      el.oninput = () => {
        resetPreviewState();
        this.updateRuleText(this.operationMode);
      };
    });
    updateUI();
    setActivePreset('dedupe');
    refreshLatestRollback();

    const collectPayload = () => {
      const mode = modeSel.value;
      const target = byId('filter-target-cls').value;
      const sources = checkedValues('.source-cls-chk:checked');
      const ruleClasses = checkedValues('.rule-cls-chk:checked');
      const smallEnabled = isChecked('filter-small-enabled');
      const countEnabled = isChecked('filter-count-enabled');
      const posEnabled = isChecked('filter-pos-enabled');
      const confEnabled = isChecked('filter-conf-enabled');

      if (this.operationMode === 'delete_unlabeled') {
        return {
          project_id: ws.projectId,
          operation_mode: this.operationMode,
          merge_mode: 'same_class',
          spatial_mode: 'instance_cover',
          coverage_threshold: parseFloat(cov.value),
          canonical_class: '',
          source_classes: [],
          area_mode: byId('filter-area-sel').value,
          rule_classes: [],
          small_target_enabled: false,
          max_area_ratio: parseFloat(byId('filter-small-ratio').value || '0.02'),
          instance_count_enabled: false,
          min_instances: parseInt(byId('filter-min-count').value || '1', 10),
          max_instances: parseInt(byId('filter-max-count').value || '0', 10),
          position_enabled: false,
          center_x_half_width: parseFloat(byId('filter-center-x').value || '0.25'),
          center_y_half_height: parseFloat(byId('filter-center-y').value || '0.05'),
          confidence_enabled: false,
          min_confidence: parseFloat(byId('filter-conf-min').value || '0'),
          max_confidence: parseFloat(byId('filter-conf-max').value || '1'),
        };
      }

      if (this.operationMode === 'merge' && mode === 'canonical_class' && sources.length === 0) {
        throw new Error('请至少选择一个来源类别');
      }
      if (this.operationMode === 'rule' && ruleClasses.length === 0) {
        throw new Error('请至少选择一个类别范围');
      }
      if (this.operationMode === 'rule' && !(smallEnabled || countEnabled || posEnabled || confEnabled)) {
        throw new Error('规则过滤至少要启用一条规则条件');
      }

      return {
        project_id: ws.projectId,
        operation_mode: this.operationMode,
        merge_mode: this.operationMode === 'merge' ? mode : 'same_class',
        spatial_mode: this.operationMode === 'merge' ? byId('filter-spatial-sel').value : 'instance_cover',
        coverage_threshold: parseFloat(cov.value),
        canonical_class: this.operationMode === 'merge' && mode === 'canonical_class' ? target : '',
        source_classes: this.operationMode === 'merge' && mode === 'canonical_class' ? sources : [],
        area_mode: byId('filter-area-sel').value,
        rule_classes: this.operationMode === 'rule' ? ruleClasses : [],
        small_target_enabled: this.operationMode === 'rule' ? smallEnabled : false,
        max_area_ratio: parseFloat(byId('filter-small-ratio').value || '0.02'),
        instance_count_enabled: this.operationMode === 'rule' ? countEnabled : false,
        min_instances: parseInt(byId('filter-min-count').value || '1', 10),
        max_instances: parseInt(byId('filter-max-count').value || '0', 10),
        position_enabled: this.operationMode === 'rule' ? posEnabled : false,
        center_x_half_width: parseFloat(byId('filter-center-x').value || '0.25'),
        center_y_half_height: parseFloat(byId('filter-center-y').value || '0.05'),
        confidence_enabled: this.operationMode === 'rule' ? confEnabled : false,
        min_confidence: parseFloat(byId('filter-conf-min').value || '0'),
        max_confidence: parseFloat(byId('filter-conf-max').value || '1'),
      };
    };

    const renderFilterSummary = (result, kind) => {
      const items = Array.isArray(result?.items) ? result.items : [];
      const op = String(result?.operation_mode || this.operationMode || 'merge');
      const imageCount = kind === 'preview' ? (result?.image_count || 0) : (result?.changed_images || 0);
      const candidateCount = kind === 'preview' ? (result?.candidate_count || 0) : (result?.removed_annotations || 0);
      const relabelCount = kind === 'preview' ? (result?.relabel_count || 0) : (result?.relabeled_annotations || 0);
      if (op === 'delete_unlabeled') {
        const deletedImages = kind === 'preview' ? imageCount : (result?.deleted_images || result?.changed_images || 0);
        const deletedImageFiles = kind === 'preview' ? 0 : (result?.deleted_image_files || 0);
        const deletedAnnotationFiles = kind === 'preview' ? 0 : (result?.deleted_annotation_files || 0);
        const failedCount = Array.isArray(result?.failed_deletes) ? result.failed_deletes.length : 0;
        const header = `
          <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;">
            <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${deletedImages}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">${kind === 'preview' ? '待删图片' : '删除图片'}</div></div>
            <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${kind === 'preview' ? candidateCount : deletedImageFiles}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">${kind === 'preview' ? '命中样本' : '原图文件'}</div></div>
            <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${deletedAnnotationFiles}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">标注 JSON</div></div>
            <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${failedCount}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">文件失败</div></div>
          </div>
        `;
        if (items.length === 0) {
          summaryEl.innerHTML = `${header}<div style="font-size: 12px; color: var(--neu-text-light);">当前项目没有无标注图片。</div>`;
          return;
        }
        summaryEl.innerHTML = header + items.slice(0, 30).map((item) => {
          const detail = kind === 'preview'
            ? '<span>待删除图片和对应标注 JSON</span>'
            : `<span>原图${item.deleted_image_file ? '已删除' : '未删除或不存在'}</span><span>标注 JSON ${item.deleted_annotation_file ? '已删除' : '未删除或不存在'}</span>`;
          const title = escapeHtml(item.rel_path || item.image_id || '--');
          return `
            <div class="neu-box" style="padding: 10px 12px; border-radius: 10px; background: var(--neu-bg-light);">
              <div style="font-size: 12px; font-weight: 700; color: var(--neu-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</div>
              <div style="margin-top: 6px; display: flex; gap: 12px; font-size: 11px; color: var(--neu-text-light); flex-wrap: wrap;">${detail}</div>
            </div>
          `;
        }).join('');
        return;
      }

      const header = `
        <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;">
          <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${imageCount}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">${kind === 'preview' ? '命中图片' : '修改图片'}</div></div>
          <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${candidateCount}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">${kind === 'preview' ? '待删除' : '已删除'}</div></div>
          <div class="neu-box" style="padding: 10px; border-radius: 10px; background: var(--neu-bg-light);"><b>${relabelCount}</b><div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">${kind === 'preview' ? '待改类' : '已改类'}</div></div>
        </div>
      `;
      if (items.length === 0) {
        summaryEl.innerHTML = `${header}<div style="font-size: 12px; color: var(--neu-text-light);">${op === 'merge' ? '当前合并规则下没有候选图片。' : '当前规则下没有命中标注。'}</div>`;
        return;
      }
      summaryEl.innerHTML = header + items.slice(0, 30).map((item) => {
        const primaryCount = kind === 'preview'
          ? (op === 'merge' ? `预览删除 ${item.candidate_count || 0}` : `命中待删 ${item.candidate_count || 0}`)
          : (op === 'merge' ? `已删除 ${item.removed_count || 0}` : `已删除 ${item.removed_count || 0}`);
        const relabelText = op === 'merge' ? `<span>改类 ${item.relabel_count || 0}</span>` : '';
        const scopedText = op === 'merge' && item.scoped_annotation_count != null
          ? `<span>命中范围 ${item.scoped_annotation_count}</span>`
          : '';
        const title = escapeHtml(item.rel_path || item.image_id || '--');
        return `
          <div class="neu-box" style="padding: 10px 12px; border-radius: 10px; background: var(--neu-bg-light);">
            <div style="font-size: 12px; font-weight: 700; color: var(--neu-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</div>
            <div style="margin-top: 6px; display: flex; gap: 12px; font-size: 11px; color: var(--neu-text-light); flex-wrap: wrap;">
              <span>${primaryCount}</span>
              ${relabelText}
              ${scopedText}
            </div>
          </div>
        `;
      }).join('');
    };

    const pollFilterJob = async (jobId, kind) => {
      if (!jobId) return;
      this.clearTimer();
      try {
        const res = await api.getFilterJob(jobId);
        const job = res?.job || null;
        if (!job) {
          statusEl.innerText = '未找到智能过滤任务状态';
          return;
        }
        const pct = Number(job.progress_pct || 0);
        progressFillEl.style.width = `${pct}%`;
        progressTextEl.innerText = `${Math.round(pct)}%`;
        statusEl.innerText = job.message || '处理中...';

        if (job.status === 'done') {
          const result = job.result || {};
          if (kind === 'preview') {
            this.currentFilterToken = result.preview_token || '';
            renderFilterSummary(result, 'preview');
            applyBtn.style.display = this.currentFilterToken ? 'inline-flex' : 'none';
          } else {
            renderFilterSummary(result, 'apply');
            applyBtn.style.display = 'none';
            this.currentFilterToken = '';
            if (result.operation_mode === 'delete_unlabeled') {
              renderRollbackPanel(null);
            } else if (result.rollback_run_id) {
              renderRollbackPanel({
                run_id: result.rollback_run_id,
                summary: result,
                snapshot_count: result.changed_images || 0,
              });
            }
            ws.clearImageBundleCache();
            await ws.loadProjectInfo();
            if (result.operation_mode === 'delete_unlabeled') {
              await ws.loadImages();
              const selectedVisible = ws.images.some((img) => String(img.id) === String(ws.selectedImageId || ''));
              if (selectedVisible && ws.selectedImageId && ws.selectedImagePath) {
                await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
              } else if (ws.images.length > 0) {
                await ws.selectImage(ws.images[0].id, ws.images[0].rel_path);
              } else {
                ws.selectedImageId = null;
                ws.selectedImagePath = null;
                ws.annotations = [];
                if (ws.viewer) {
                  ws.viewer.clearImage();
                  ws.viewer.setAnnotations([]);
                }
                ws.renderAnnotations();
                ws.updateActionBar();
                ws.setCanvasPlaceholder(true, i18n.t('select_image_prompt'));
              }
            } else if (ws.selectedImageId && ws.selectedImagePath) {
              await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
            }
          }
          return;
        }

        if (job.status === 'error') {
          progressFillEl.style.background = '#ef4444';
          statusEl.innerText = job.error || job.message || '智能过滤任务失败';
          return;
        }

        progressFillEl.style.background = 'var(--neu-text-active)';
        this.filterJobTimer = setTimeout(() => pollFilterJob(jobId, kind), 1200);
      } catch (e) {
        statusEl.innerText = `轮询失败: ${e.message}`;
      }
    };

    previewBtn.onclick = async () => {
      try {
        const payload = collectPayload();
        previewBtn.disabled = true;
        applyBtn.style.display = 'none';
        this.currentFilterToken = '';
        summaryEl.innerHTML = '';
        progressFillEl.style.width = '0%';
        progressFillEl.style.background = 'var(--neu-text-active)';
        progressTextEl.innerText = '0%';
        statusEl.innerText = '提交预览任务...';
        const res = await api.smartFilterPreview(payload);
        const job = res?.job || null;
        if (!job?.job_id) throw new Error('预览任务未返回 job_id');
        statusEl.innerText = '预览任务已启动...';
        await pollFilterJob(job.job_id, 'preview');
      } catch (e) {
        statusEl.innerText = e.message;
        notify(e.message, 'error');
      } finally {
        previewBtn.disabled = false;
      }
    };

    applyBtn.onclick = async () => {
      if (!this.currentFilterToken) return notify(i18n.t('filter_preview_expired'), 'error');
      const confirmText = this.operationMode === 'merge'
        ? '确认按预览结果执行合并过滤吗？'
        : (
            this.operationMode === 'delete_unlabeled'
              ? '确认删除所有无标注图片吗？该操作会删除原图文件和对应标注 JSON，不能通过智能过滤回滚恢复。'
              : '确认删除所有命中规则的标注吗？该操作会直接修改标注。'
          );
      if (!confirm(confirmText)) return;
      try {
        applyBtn.disabled = true;
        summaryEl.innerHTML = '';
        progressFillEl.style.width = '0%';
        progressFillEl.style.background = 'var(--neu-text-active)';
        progressTextEl.innerText = '0%';
        statusEl.innerText = '提交确认任务...';
        const res = await api.smartFilterApply({
          ...collectPayload(),
          preview_token: this.currentFilterToken,
        });
        const job = res?.job || null;
        if (!job?.job_id) throw new Error('确认任务未返回 job_id');
        statusEl.innerText = this.operationMode === 'merge'
          ? '正在应用合并结果...'
          : (this.operationMode === 'delete_unlabeled' ? '正在删除无标注图片...' : '正在删除命中标注...');
        await pollFilterJob(job.job_id, 'apply');
        notify(
          this.operationMode === 'merge'
            ? '合并过滤已应用'
            : (this.operationMode === 'delete_unlabeled' ? '无标注图片删除已应用' : '规则过滤删除已应用'),
          'success',
        );
      } catch (e) {
        notify(e.message, 'error');
      } finally {
        applyBtn.disabled = false;
      }
    };
  }

  updateRuleText(operationMode = this.operationMode) {
    const mode = byId('filter-mode-sel')?.value;
    const spatialMode = byId('filter-spatial-sel')?.value || 'instance_cover';
    const cov = parseFloat(byId('filter-cov')?.value || '0.98');
    const areaMode = byId('filter-area-sel')?.value || 'instance';
    const target = byId('filter-target-cls')?.value;
    const sources = checkedValues('.source-cls-chk:checked');
    const ruleClasses = checkedValues('.rule-cls-chk:checked');
    const chunks = [];
    const spatialLabel = spatialMode === 'bbox_cover' ? '边框嵌套' : '实例嵌套';
    const areaLabel = areaMode === 'bbox' ? '边框面积' : '实例面积';

    if (operationMode === 'delete_unlabeled') {
      chunks.push('删除无标注图片：扫描当前项目中标注数组为空的图片，预览后删除这些原图文件和 annotations 目录下对应的 JSON 文件。该操作不会删除任何有标注的图片。');
      chunks.push('删除后项目图片索引、标注索引和项目统计会同步更新；物理删除不能通过智能过滤回滚恢复。');
    } else if (operationMode === 'merge') {
      if (mode === 'same_class') {
        chunks.push(`合并过滤：使用${spatialLabel}判定同类重复，当较大实例对较小实例的覆盖达到 ${(cov * 100).toFixed(0)}% 时，删除较小实例。`);
      } else {
        chunks.push(`合并过滤：使用${spatialLabel}判定重复，当来源类 [${sources.join(', ') || '未选择'}] 被 [${target || '--'}] 覆盖达到 ${(cov * 100).toFixed(0)}% 时，执行并入。`);
      }
      if (spatialMode === 'instance_cover') {
        chunks.push('实例嵌套会优先使用 polygon / mask 计算较小实例被覆盖的比例；缺少实例轮廓时会回退到边框嵌套。');
      }
      chunks.push(`保留对象由${areaLabel}判定：默认保留面积更大的实例。该模式只会执行合并 / 改类逻辑，不会应用规则删除条件。`);
    } else {
      chunks.push(`规则过滤：在 [${ruleClasses.length > 0 ? ruleClasses.join(', ') : '未选择'}] 范围内查找命中规则的标注，预览后删除命中项。`);
      if (isChecked('filter-small-enabled')) {
        chunks.push(`小目标：面积占比 <= ${byId('filter-small-ratio').value}。`);
      }
      if (isChecked('filter-count-enabled')) {
        const maxValue = byId('filter-max-count').value || '不限';
        chunks.push(`实例数量：${byId('filter-min-count').value} 到 ${maxValue}。`);
      }
      if (isChecked('filter-pos-enabled')) {
        chunks.push(`位置：中心半宽 ${byId('filter-center-x').value}，中心半高 ${byId('filter-center-y').value}。`);
      }
      if (isChecked('filter-conf-enabled')) {
        chunks.push(`置信度：${byId('filter-conf-min').value} - ${byId('filter-conf-max').value}。`);
      }
      if (chunks.length === 1) {
        chunks.push('请至少启用一条规则条件，否则不会允许执行删除。');
      }
    }

    const el = byId('filter-rule-text');
    if (el) el.innerText = chunks.join(' ');
  }
}
