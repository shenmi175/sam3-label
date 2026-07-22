import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { store } from '../../store.js';
import { escapeAttr, escapeHtml } from '../../utils/html.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class InferenceController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  async runSingle() {
    const ws = this.workspace;
    if (!ws.selectedImageId) return notify("Select an image first", "error");
    if (ws.annotationDirty) {
      await ws.flushAnnotationAutosave('before-infer');
      if (ws.annotationDirty) return notify('当前图片标注尚未保存，保存成功后再推理', 'error');
    }

    const btn = document.getElementById('btn-infer-current');
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerText = i18n.t('inferring');
      }

      const payload = {
        project_id: ws.projectId,
        image_id: ws.selectedImageId,
        mode: 'text',
        classes: ws.getSelectedClassesForInference(),
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };

      await api.infer(payload);
      notify(i18n.t('save_success'), "success");
      ws.invalidateImageBundle(ws.selectedImageId);
      await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
      await ws.loadProjectInfo();
    } catch(e) {
      notify(e.message, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerText = i18n.t('infer_current');
      }
    }
  }

  async runExamplePreview() {
    const ws = this.workspace;
    if (!ws.selectedImageId) return notify(i18n.t('select_image_first'), "error");

    const boxes = ws.currentPrompts
      .filter(p => p.type === 'box')
      .map(p => p.data);
    const btn = document.getElementById('btn-example-segment');
    if (boxes.length === 0) {
      ws.setBoxPromptLabel(1);
      return notify(i18n.t('box_exemplar_mode_hint'), "info");
    }
    if (!ws.selectedClass) return notify(i18n.t('select_class_first'), "error");

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerText = i18n.t('finding_similar');
      }

      const payload = {
        project_id: ws.projectId,
        image_id: ws.selectedImageId,
        active_class: ws.selectedClass,
        boxes,
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };

      const res = await api.inferExample(payload);
      const detections = res.detections || [];
      ws.previews = detections.map(d => ({
        ...d,
        id: 'preview_' + Math.random().toString(36).substr(2, 9),
        class_name: ws.selectedClass
      }));

      if (ws.viewer) ws.viewer.setPreviews(ws.previews);
      ws.renderPreviews();
      ws.updateActionBar();
      notify(i18n.t('found_matches', { count: ws.previews.length }), "info");
    } catch(e) {
      notify(e.message, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerText = i18n.t('example_segment');
      }
    }
  }

  async startBatchTask() {
    const ws = this.workspace;
    const classes = ws.getSelectedClassesForInference();
    if (classes.length === 0) return notify("Select at least one class for text inference", "error");

    const payload = {
      project_id: ws.projectId,
      threshold: store.state.config.threshold,
      batch_size: store.state.config.batchSize,
      api_base_url: store.state.config.sam3ApiUrl
    };

    const batchConfig = await this.openBatchConfigModal(classes);
    if (!batchConfig) return;
    payload.classes = classes;
    payload.scope_mode = batchConfig.scope_mode;
    payload.related_classes = batchConfig.related_classes || [];
    payload.image_ids = batchConfig.image_ids || [];
    payload.retry_image_ids = batchConfig.retry_image_ids || [];
    payload.all_images = batchConfig.scope_mode === 'all' && payload.image_ids.length === 0 && payload.retry_image_ids.length === 0;

    try {
      const res = await api.startBatchInfer(payload);

      ws.activeJobId = res?.job?.job_id || '';
      if (!ws.activeJobId) throw new Error('batch task did not return job_id');
      ws.batchResultShownForJobId = '';
      this.pollTaskStatus();
      notify("Batch task started", "success");
    } catch(e) {
       notify(e.message, "error");
    }
  }

  async pollTaskStatus() {
    const ws = this.workspace;
    if (ws.isPolling) return;
    ws.isPolling = true;

    const bar = document.getElementById('ws-task-bar');
    const nameEl = document.getElementById('task-name');
    const fillEl = document.getElementById('task-progress-fill');
    const statusEl = document.getElementById('task-status-text');
    const stopBtn = document.getElementById('btn-task-stop');
    const resumeBtn = document.getElementById('btn-task-resume');

    if (bar) bar.style.display = 'flex';

    const poll = async () => {
      if (ws.isUnmounted || !ws.activeJobId) {
        ws.isPolling = false;
        return;
      }

      try {
        const res = await api.getInferJob(ws.activeJobId);
        const job = res?.job || null;
        if (!job) {
          ws.activeJobId = null;
          ws.isPolling = false;
          if (bar) bar.style.display = 'none';
          return;
        }
        const pct = Number(job.progress_pct || 0);
        if (nameEl) nameEl.innerText = i18n.t('batch_infer');
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (statusEl) statusEl.innerText = `${job.message || `${Math.round(pct)}%`}`;

        if (job.status === 'done' || job.status === 'error') {
          if (bar) setTimeout(() => { bar.style.display = 'none'; }, 3000);
          if (job.job_type === 'text_batch' && job.status === 'done') {
            this.showBatchResultModal(job);
          }
          if (job.status === 'done') {
            ws.clearImageBundleCache();
          }
          ws.activeJobId = null;
          ws.isPolling = false;
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
          await ws.loadProjectInfo();
          if (ws.selectedImageId && ws.selectedImagePath) {
            await ws.selectImage(ws.selectedImageId, ws.selectedImagePath);
          }
          return;
        } else if (job.status === 'pausing') {
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = true;
            stopBtn.innerText = 'Stopping...';
          }
        } else if (job.status === 'paused') {
          if (resumeBtn) resumeBtn.style.display = 'block';
          if (stopBtn) {
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
        } else {
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
        }

        setTimeout(poll, 1000);
      } catch(e) {
        console.error("Poll error", e);
        ws.isPolling = false;
      }
    };

    poll();
  }

  async stopActiveTask() {
    const ws = this.workspace;
    try {
      const res = await api.stopInferJob(ws.projectId);
      const job = res?.job || null;
      const stopBtn = document.getElementById('btn-task-stop');
      const statusEl = document.getElementById('task-status-text');
      if (job?.job_id) ws.activeJobId = job.job_id;
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.innerText = 'Stopping...';
      }
      if (statusEl) statusEl.innerText = 'Stopping task...';
      notify("Stopping task...");
    } catch(e) {
      notify(e.message, "error");
    }
  }

  async resumeActiveTask() {
    const ws = this.workspace;
    try {
      const payload = {
        project_id: ws.projectId,
        threshold: store.state.config.threshold,
        batch_size: store.state.config.batchSize,
        api_base_url: store.state.config.sam3ApiUrl
      };
      const res = await api.resumeInferJob(payload);
      const job = res?.job || null;
      if (job?.job_id) ws.activeJobId = job.job_id;
      const stopBtn = document.getElementById('btn-task-stop');
      const resumeBtn = document.getElementById('btn-task-resume');
      const statusEl = document.getElementById('task-status-text');
      if (resumeBtn) resumeBtn.style.display = 'none';
      if (stopBtn) {
        stopBtn.style.display = 'block';
        stopBtn.disabled = false;
        stopBtn.innerText = 'Stop';
      }
      if (statusEl) statusEl.innerText = 'Resuming task...';
      if (!ws.isPolling && ws.activeJobId) this.pollTaskStatus();
      notify("Resuming task...");
    } catch(e) {
      notify(e.message, "error");
    }
  }

  openBatchConfigModal(defaultClasses = []) {
    const ws = this.workspace;
    return new Promise((resolve) => {
      const modal = document.getElementById('modal-batch-full');
      if (!modal) {
        resolve(null);
        return;
      }
      const classes = ws.projectMeta?.classes || [];
      const defaultSet = new Set((defaultClasses || []).map(x => String(x)));
      modal.innerHTML = `
        <div class="neu-card" style="width: 520px; max-width: calc(100vw - 40px); padding: 28px; position: relative;">
          <button class="neu-button" id="btn-close-batch-modal" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; color: #ef4444;">×</button>
          <h2 style="margin: 0 0 18px 0; font-size: 18px;">全图文本推理</h2>
          <div style="display: flex; flex-direction: column; gap: 18px;">
            <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 10px;">本次将推理这些类别</div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${(defaultClasses || []).map(cls => `<span class="neu-box" style="padding: 4px 10px; border-radius: 999px; font-size: 12px; box-shadow: var(--neu-inset);">${escapeHtml(cls)}</span>`).join('') || '<span style="font-size: 12px; color: var(--neu-text-light);">未选择类别</span>'}
              </div>
            </div>
            <div>
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">处理范围</div>
              <select id="batch-scope-mode" class="neu-input" style="width: 100%;">
                <option value="all">重新标注全部图片</option>
                <option value="unlabeled">只标注未标注图片</option>
                <option value="class_related">重新标注指定类别相关图片</option>
                <option value="class_related_unlabeled">只标注当前缺少这些类别的图片</option>
              </select>
            </div>
            <div id="batch-related-classes-panel" style="display: none;">
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">相关类别范围</div>
              <div class="neu-box" style="padding: 12px; border-radius: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 180px; overflow-y: auto;">
                ${classes.map(cls => `
                  <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                    <input type="checkbox" class="batch-related-cls" value="${escapeAttr(cls)}" ${defaultSet.has(cls) ? 'checked' : ''} />
                    <span>${escapeHtml(cls)}</span>
                  </label>
                `).join('')}
              </div>
              <div style="margin-top: 8px; font-size: 11px; color: var(--neu-text-light);">按现有标注判断“相关图片”；“缺少这些类别”表示当前图片里还没有这些类别的标注。</div>
            </div>
            <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
              <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.6;">
                阈值：${escapeHtml(store.state.config.threshold)}，批大小：${escapeHtml(store.state.config.batchSize)}<br />
                任务完成后会显示结果汇总，并支持一键重试失败图片。
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button id="btn-cancel-batch-modal" class="neu-button">取消</button>
              <button id="btn-confirm-batch-modal" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">开始任务</button>
            </div>
          </div>
        </div>
      `;
      modal.style.display = 'flex';

      const cleanup = (result) => {
        modal.style.display = 'none';
        modal.innerHTML = '';
        resolve(result);
      };
      const scopeSel = document.getElementById('batch-scope-mode');
      const relatedPanel = document.getElementById('batch-related-classes-panel');
      if (!scopeSel || !relatedPanel) {
        cleanup(null);
        return;
      }
      const syncScope = () => {
        const needRelated = scopeSel.value === 'class_related' || scopeSel.value === 'class_related_unlabeled';
        relatedPanel.style.display = needRelated ? 'block' : 'none';
      };
      syncScope();
      scopeSel.onchange = syncScope;
      document.getElementById('btn-close-batch-modal').onclick = () => cleanup(null);
      document.getElementById('btn-cancel-batch-modal').onclick = () => cleanup(null);
      document.getElementById('btn-confirm-batch-modal').onclick = () => {
        const related = Array.from(document.querySelectorAll('.batch-related-cls:checked')).map(el => el.value);
        if ((scopeSel.value === 'class_related' || scopeSel.value === 'class_related_unlabeled') && related.length === 0) {
          notify('请至少选择一个相关类别', 'error');
          return;
        }
        cleanup({
          scope_mode: scopeSel.value,
          related_classes: related,
          image_ids: [],
          retry_image_ids: []
        });
      };
    });
  }

  showBatchResultModal(job) {
    const ws = this.workspace;
    if (!job || ws.batchResultShownForJobId === job.job_id) return;
    ws.batchResultShownForJobId = job.job_id;
    const modal = document.getElementById('modal-batch-result');
    if (!modal) return;
    const result = job.result || {};
    const classAdditions = result.class_additions || {};
    const retryImageIds = result.retry_image_ids || [];
    const classRows = Object.entries(classAdditions);
    modal.innerHTML = `
      <div class="neu-card" style="width: 560px; max-width: calc(100vw - 40px); padding: 28px; position: relative;">
        <button class="neu-button" id="btn-close-batch-result" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; color: #ef4444;">×</button>
        <h2 style="margin: 0 0 18px 0; font-size: 18px;">批量推理结果</h2>
        <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>请求图片</b><div style="margin-top: 6px;">${escapeHtml(result.requested || job.requested || 0)}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>已处理</b><div style="margin-top: 6px;">${escapeHtml(result.processed_images || job.progress_done || 0)}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>成功</b><div style="margin-top: 6px; color: #10b981;">${escapeHtml(result.saved_images || result.succeeded || job.succeeded || 0)}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>失败</b><div style="margin-top: 6px; color: #ef4444;">${escapeHtml(result.failed_images || result.failed || job.failed || 0)}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>跳过</b><div style="margin-top: 6px;">${escapeHtml(result.skipped_images || result.skipped || job.skipped || 0)}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>新增标注</b><div style="margin-top: 6px;">${escapeHtml(result.new_annotations || job.new_annotations || 0)}</div></div>
        </div>
        <div class="neu-box" style="padding: 14px; border-radius: 12px; margin-top: 16px; background: var(--neu-bg-light);">
          <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">类别新增统计</div>
          ${classRows.length > 0 ? classRows.map(([cls, count]) => `<div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0;"><span>${escapeHtml(cls)}</span><b>${escapeHtml(count)}</b></div>`).join('') : '<div style="font-size: 12px; color: var(--neu-text-light);">无新增类别统计</div>'}
        </div>
        <div style="margin-top: 16px; font-size: 12px; color: var(--neu-text-light); line-height: 1.7;">${escapeHtml(job.message || result.message || '任务结束')}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
          ${retryImageIds.length > 0 ? '<button id="btn-retry-batch-result" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">重试未完成</button>' : ''}
          <button id="btn-confirm-batch-result" class="neu-button">关闭</button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    const close = () => {
      modal.style.display = 'none';
      modal.innerHTML = '';
    };
    document.getElementById('btn-close-batch-result').onclick = close;
    document.getElementById('btn-confirm-batch-result').onclick = close;
    const retryBtn = document.getElementById('btn-retry-batch-result');
    if (retryBtn) {
      retryBtn.onclick = async () => {
        close();
        try {
          const res = await api.startBatchInfer({
            project_id: ws.projectId,
            classes: ws.getSelectedClassesForInference(),
            retry_image_ids: retryImageIds,
            threshold: store.state.config.threshold,
            batch_size: store.state.config.batchSize,
            api_base_url: store.state.config.sam3ApiUrl
          });
          ws.activeJobId = res?.job?.job_id || '';
          if (!ws.activeJobId) throw new Error('batch task did not return job_id');
          ws.batchResultShownForJobId = '';
          this.pollTaskStatus();
          notify('已启动未完成图片重试', 'success');
        } catch (e) {
          notify(e.message, 'error');
        }
      };
    }
  }
}
