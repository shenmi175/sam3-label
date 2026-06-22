import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { store } from '../../store.js';

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
      ws.setPromptMode('box');
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
        pure_visual: false,
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

    const batchConfig = await ws.openBatchConfigModal(classes);
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
        if (nameEl) nameEl.innerText = i18n.t(job.job_type === 'example_batch' ? 'example_propagate' : 'batch_infer');
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (statusEl) statusEl.innerText = `${job.message || `${Math.round(pct)}%`}`;

        if (job.status === 'done' || job.status === 'error') {
          if (bar) setTimeout(() => { bar.style.display = 'none'; }, 3000);
          if (job.job_type === 'text_batch' && job.status === 'done') {
            ws.showBatchResultModal(job);
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
}
