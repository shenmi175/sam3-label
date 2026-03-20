
(() => {
  'use strict';
  const APP_VER = '20260320.03';
  console.log(`[web-auto] app.js version ${APP_VER}`);

  const IMAGE_LIST_ROW_HEIGHT = 32;
  const IMAGE_LIST_OVERSCAN = 10;
  const IMAGE_PAGE_SIZE = 200;
  const INITIAL_IMAGE_LOAD_COUNT = 10;
  const NEARBY_PREFETCH_RADIUS = 3;
  const GKEY = 'web_auto_ui_global_v1';
  const PKEY = 'web_auto_ui_project_v1_';

  const dom = {
    annotateLayout: document.getElementById('annotateLayout'), leftSidebar: document.getElementById('leftSidebar'), rightSidebar: document.getElementById('rightSidebar'),
    projectName: document.getElementById('projectName'), imageDir: document.getElementById('imageDir'), saveDir: document.getElementById('saveDir'),
    openProjectBtn: document.getElementById('openProjectBtn'), refreshProjectsBtn: document.getElementById('refreshProjectsBtn'),
    closeProjectBtn: document.getElementById('closeProjectBtn'), deleteProjectBtn: document.getElementById('deleteProjectBtn'),
    apiBaseUrl: document.getElementById('apiBaseUrl'), testApiBtn: document.getElementById('testApiBtn'), threshold: document.getElementById('threshold'), batchSize: document.getElementById('batchSize'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    edgeToggleLeft: document.getElementById('edgeToggleLeft'), edgeToggleRight: document.getElementById('edgeToggleRight'),
    inferCurrentBtn: document.getElementById('inferCurrentBtn'), inferAllBtn: document.getElementById('inferAllBtn'), exampleMenuAnchor: document.getElementById('exampleMenuAnchor'), exampleMenuBtn: document.getElementById('exampleMenuBtn'), exampleMenuPanel: document.getElementById('exampleMenuPanel'), exampleBatchBtn: document.getElementById('exampleBatchBtn'), exportFormat: document.getElementById('exportFormat'),
    exportDir: document.getElementById('exportDir'), exportBtn: document.getElementById('exportBtn'), smartFilterBtn: document.getElementById('smartFilterBtn'), status: document.getElementById('status'),
    inferProgressWrap: document.getElementById('inferProgressWrap'), inferProgressText: document.getElementById('inferProgressText'), inferProgressMeta: document.getElementById('inferProgressMeta'), inferProgressParams: document.getElementById('inferProgressParams'), inferProgressBar: document.getElementById('inferProgressBar'), stopInferJobBtn: document.getElementById('stopInferJobBtn'), resumeInferJobBtn: document.getElementById('resumeInferJobBtn'),
    exportModal: document.getElementById('exportModal'), exportBBox: document.getElementById('exportBBox'), exportMask: document.getElementById('exportMask'),
    exportHint: document.getElementById('exportHint'), exportConfirmBtn: document.getElementById('exportConfirmBtn'), exportCancelBtn: document.getElementById('exportCancelBtn'),
    smartFilterModal: document.getElementById('smartFilterModal'), smartFilterSummary: document.getElementById('smartFilterSummary'), smartFilterList: document.getElementById('smartFilterList'), smartFilterApplyBtn: document.getElementById('smartFilterApplyBtn'), smartFilterCancelBtn: document.getElementById('smartFilterCancelBtn'), smartFilterPreviewBtn: document.getElementById('smartFilterPreviewBtn'), smartFilterMode: document.getElementById('smartFilterMode'), smartFilterCoverage: document.getElementById('smartFilterCoverage'), smartFilterAreaMode: document.getElementById('smartFilterAreaMode'), smartFilterCanonicalRow: document.getElementById('smartFilterCanonicalRow'), smartFilterCanonicalClass: document.getElementById('smartFilterCanonicalClass'), smartFilterSourceRow: document.getElementById('smartFilterSourceRow'), smartFilterSourceClasses: document.getElementById('smartFilterSourceClasses'),
    projectList: document.getElementById('projectList'), projectMeta: document.getElementById('projectMeta'), prevImgBtn: document.getElementById('prevImgBtn'),
    nextImgBtn: document.getElementById('nextImgBtn'), deleteImageBtn: document.getElementById('deleteImageBtn'), imageInfo: document.getElementById('imageInfo'), imageList: document.getElementById('imageList'),
    toolPoint: document.getElementById('toolPoint'), toolBox: document.getElementById('toolBox'), toolPan: document.getElementById('toolPan'),
    labelPos: document.getElementById('labelPos'), labelNeg: document.getElementById('labelNeg'), undoPromptBtn: document.getElementById('undoPromptBtn'),
    clearPromptBtn: document.getElementById('clearPromptBtn'), segmentBtn: document.getElementById('segmentBtn'), exampleCurrentBtn: document.getElementById('exampleCurrentBtn'),
    commitPreviewBtn: document.getElementById('commitPreviewBtn'), clearPreviewBtn: document.getElementById('clearPreviewBtn'), selectAllPreviewBtn: document.getElementById('selectAllPreviewBtn'),
    showMask: document.getElementById('showMask'),
    autoPromptInfer: document.getElementById('autoPromptInfer'),
    autoPromptMode: document.getElementById('autoPromptMode'),
    examplePureVisual: document.getElementById('examplePureVisual'),
    showBox: document.getElementById('showBox'), zoomOutBtn: document.getElementById('zoomOutBtn'), zoomSlider: document.getElementById('zoomSlider'),
    zoomValue: document.getElementById('zoomValue'), zoomInBtn: document.getElementById('zoomInBtn'), fitViewBtn: document.getElementById('fitViewBtn'),
    canvasContainer: document.getElementById('canvasContainer'), canvas: document.getElementById('canvas'),
    classesText: document.getElementById('classesText'), applyClassesBtn: document.getElementById('applyClassesBtn'), classList: document.getElementById('classList'),
    saveAnnBtn: document.getElementById('saveAnnBtn'), clearAnnBtn: document.getElementById('clearAnnBtn'), annList: document.getElementById('annList'),
    previewList: document.getElementById('previewList')
  };

  const backToProjectsBtn = document.getElementById('backToProjectsBtn');

  const ctx = dom.canvas.getContext('2d');
  const colors = ['#e53935','#1e88e5','#43a047','#fb8c00','#6d4c41','#00897b','#3949ab','#d81b60','#7cb342','#5e35b1','#00acc1','#f4511e'];

  const S = {
    projects: [], project: null, images: [], imageIndex: 0, currentImageId: '', imageEl: null, imageLoadToken: 0,
    classes: [], selectedClasses: new Set(), activeClass: '', annotations: [],
    previewAnnotations: [], previewSelectedIds: new Set(),
    focusedAnnIndex: null,
    tool: 'point', promptLabel: 1, promptPoints: [], promptBoxes: [], promptHistory: [], drawingBox: null,
    draggingPan: false, panStart: null, pointerDown: null, pointerMoved: false, spacePan: false,
    panX: 0, panY: 0, zoom: 1, minZoom: 0.1, maxZoom: 4, showMask: true, showBox: true, autoPromptInfer: false, autoPromptMode: 'visual_preview', examplePureVisual: false,
    imageViewStates: {},
    darkMode: false, exampleMenuOpen: false,
    smartFilterPreview: null,
    smartFilterConfig: { merge_mode: 'same_class', coverage_threshold: 0.98, area_mode: 'instance', canonical_class: '', source_classes: [] },
    inferJobId: '', inferJobTimer: 0, inferJobState: null,
    hideLeftSidebar: false, hideRightSidebar: false,
    imagePagesLoaded: new Set(), imagePagesLoading: {},
    imageWarmupTimer: 0, annotationCache: {}, annotationLoading: {}, imageAssetCache: {}, imageAssetLoading: {},
    imageListWindowStart: -1, imageListWindowEnd: -1, imageListRaf: 0,
    renderPending: false, busy: false, saveGlobalTimer: 0, saveProjectTimer: 0, lastGlobalState: '', lastProjectState: ''
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (t) => String(t || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const pid = () => (S.project ? S.project.id : '');
  const curImg = () => (S.images[S.imageIndex] || null);
  const selClasses = () => S.classes.filter((c) => S.selectedClasses.has(c));
  const colorFor = (c) => colors[Math.abs([...String(c||'')].reduce((a,ch)=>((a*131+ch.charCodeAt(0))>>>0),7)) % colors.length];

  function trimListForDisplay(items, maxItems=4) {
    const list = Array.isArray(items) ? items.map((x)=>String(x || '').trim()).filter(Boolean) : [];
    if (list.length <= maxItems) return list;
    return list.slice(0, maxItems).concat(`+${list.length - maxItems}`);
  }

  function buildInferParams(kind, body={}) {
    const payload = body && typeof body === 'object' ? body : {};
    const countPromptLabels = (items, labelIndex) => {
      let pos = 0;
      let neg = 0;
      (Array.isArray(items) ? items : []).forEach((raw) => {
        if (!Array.isArray(raw) || raw.length <= labelIndex) return;
        const n = Number(raw[labelIndex]);
        const isPos = Number.isFinite(n) ? n !== 0 : !!raw[labelIndex];
        if (isPos) pos += 1;
        else neg += 1;
      });
      return { pos, neg };
    };
    const pointStats = countPromptLabels(payload.points, 2);
    const boxStats = countPromptLabels(payload.boxes, 4);
    const params = {
      threshold: Number(payload.threshold ?? 0.5),
      batch_size: Math.max(0, Math.round(Number(payload.batch_size || 0))),
      classes: Array.isArray(payload.classes) ? payload.classes : [],
      active_class: String(payload.active_class || '').trim(),
      pure_visual: !!payload.pure_visual,
      selected_image_count: Array.isArray(payload.image_ids) ? payload.image_ids.filter(Boolean).length : 0,
      all_images: !!payload.all_images,
      source_image_id: String(payload.source_image_id || '').trim(),
      positive_points: pointStats.pos,
      negative_points: pointStats.neg,
      positive_boxes: boxStats.pos,
      negative_boxes: boxStats.neg,
      scope_label: '',
      mode_label: ''
    };
    if (kind === 'text_single') {
      params.mode_label = '当前图文本推理';
      params.scope_label = '当前图片';
    } else if (kind === 'text_batch') {
      params.mode_label = '全图文本批推';
      params.scope_label = params.all_images ? '全部图片' : '选中图片';
    } else if (kind === 'example_preview') {
      params.mode_label = '当前图范例分割';
      params.scope_label = '当前图片';
    } else if (kind === 'example_batch') {
      params.mode_label = '全图集范例传播';
      params.scope_label = '全部图片';
    } else if (kind === 'points_preview') {
      params.mode_label = '点提示预览';
      params.scope_label = '当前图片';
    } else if (kind === 'boxes_preview') {
      params.mode_label = '框提示预览';
      params.scope_label = '当前图片';
    }
    return params;
  }

  function formatInferParams(params, job={}) {
    const raw = params && typeof params === 'object' ? params : {};
    const parts = [];
    const modeLabel = String(raw.mode_label || raw.mode || '').trim();
    const scopeLabel = String(raw.scope_label || '').trim();
    const classes = trimListForDisplay(raw.classes, 5);
    const activeClass = String(raw.active_class || '').trim();
    const threshold = Number(raw.threshold);
    const batchSize = Math.max(0, Math.round(Number(raw.batch_size || job.batch_size || 0)));
    const selectedCount = Math.max(0, Math.round(Number(raw.selected_image_count || 0)));
    const posPoints = Math.max(0, Math.round(Number(raw.positive_points || 0)));
    const negPoints = Math.max(0, Math.round(Number(raw.negative_points || 0)));
    const posBoxes = Math.max(0, Math.round(Number(raw.positive_boxes || 0)));
    const negBoxes = Math.max(0, Math.round(Number(raw.negative_boxes || 0)));
    const sourceImageId = String(raw.source_image_id || '').trim();
    const pureVisual = !!raw.pure_visual;

    if (modeLabel) parts.push(`模式: ${modeLabel}`);
    if (scopeLabel) parts.push(`范围: ${scopeLabel}${selectedCount > 0 && scopeLabel !== '全部图片' ? ` (${selectedCount} 张)` : ''}`);
    if (classes.length) parts.push(`类别: ${classes.join(', ')}`);
    if (activeClass) parts.push(`当前类别: ${activeClass}`);
    if (pureVisual) parts.push('提示: 纯视觉');
    if (posPoints > 0 || negPoints > 0) parts.push(`点提示: +${posPoints} / -${negPoints}`);
    if (posBoxes > 0 || negBoxes > 0) parts.push(`框提示: +${posBoxes} / -${negBoxes}`);
    if (sourceImageId) parts.push(`源图: ${sourceImageId}`);
    if (Number.isFinite(threshold)) parts.push(`阈值: ${threshold.toFixed(2)}`);
    if (batchSize > 0) parts.push(`batch: ${batchSize}`);
    return parts.length ? parts.join(' | ') : '--';
  }

  function setStatus(msg, lvl='info') {
    dom.status.textContent = String(msg || '');
    dom.status.style.color = lvl==='ok' ? 'var(--ok)' : (lvl==='err' ? 'var(--danger)' : 'var(--muted)');
  }

  function normAutoPromptMode(v) {
    return String(v || '').trim() === 'example_current' ? 'example_current' : 'visual_preview';
  }

  function syncAutoPromptControls() {
    if (dom.autoPromptInfer) dom.autoPromptInfer.checked = !!S.autoPromptInfer;
    if (dom.autoPromptMode) {
      dom.autoPromptMode.value = normAutoPromptMode(S.autoPromptMode);
      dom.autoPromptMode.disabled = !S.autoPromptInfer;
      dom.autoPromptMode.title = S.autoPromptInfer
        ? '选择自动分割时走纯视觉单实例预览，还是走当前图范例分割。当前图范例分割仅对框选有效。'
        : '先勾选“点/框后自动分割”再选择自动模式。';
    }
  }

  function stopInferJobPolling() {
    if (S.inferJobTimer) {
      window.clearTimeout(S.inferJobTimer);
      S.inferJobTimer = 0;
    }
  }

  function updateInferJobControls(job=null) {
    const status = String(job?.status || '').trim().toLowerCase();
    const stoppable = status === 'queued' || status === 'running';
    const resumable = status === 'paused';
    if (dom.stopInferJobBtn) dom.stopInferJobBtn.disabled = !S.project || !stoppable;
    if (dom.resumeInferJobBtn) dom.resumeInferJobBtn.disabled = !S.project || !resumable;
  }

  function hideInferProgress() {
    stopInferJobPolling();
    S.inferJobId = '';
    S.inferJobState = null;
    if (dom.inferProgressWrap) dom.inferProgressWrap.classList.remove('hidden');
    if (dom.inferProgressText) dom.inferProgressText.textContent = '无事件';
    if (dom.inferProgressMeta) dom.inferProgressMeta.textContent = '--';
    if (dom.inferProgressParams) dom.inferProgressParams.textContent = '--';
    if (dom.inferProgressBar) {
      dom.inferProgressBar.style.width = '0%';
      dom.inferProgressBar.style.backgroundColor = 'var(--accent)';
    }
    updateInferJobControls(null);
  }

  function renderInferProgress(job) {
    if (!dom.inferProgressWrap || !dom.inferProgressText || !dom.inferProgressMeta || !dom.inferProgressBar || !job) return;
    const done = Math.max(0, Math.round(Number(job.progress_done || 0)));
    const total = Math.max(0, Math.round(Number(job.progress_total || 0)));
    const pctRaw = Number(job.progress_pct || (total > 0 ? (done * 100 / total) : 0));
    const pct = clamp(Number.isFinite(pctRaw) ? pctRaw : 0, 0, 100);
    const status = String(job.status || '').toLowerCase();
    const paramsText = formatInferParams(job.params, job);
    dom.inferProgressWrap.classList.remove('hidden');
    dom.inferProgressText.textContent = String(job.message || '处理中...');
    dom.inferProgressMeta.textContent = total > 0 ? `${done}/${total} (${pct.toFixed(1)}%)` : `${pct.toFixed(1)}%`;
    if (dom.inferProgressParams) dom.inferProgressParams.textContent = paramsText;
    dom.inferProgressBar.style.width = `${pct}%`;
    dom.inferProgressBar.style.backgroundColor = status === 'error'
      ? 'var(--danger)'
      : (status === 'done' ? 'var(--ok)' : (status === 'paused' ? '#ff8a00' : 'var(--accent)'));
    updateInferJobControls(job);
  }

  function buildInferResumeBody(job={}) {
    const type = String(job.job_type || '').trim().toLowerCase();
    const batchSize = clamp(Math.round(Number(dom.batchSize?.value || job.batch_size || 8)), 1, 32);
    if (dom.batchSize) dom.batchSize.value = String(batchSize);
    const body = {
      project_id: pid(),
      batch_size: batchSize,
      threshold: Number(dom.threshold.value || 0.5),
      api_base_url: String(dom.apiBaseUrl.value || '').trim()
    };

    if (type === 'text_batch') {
      const classes = selClasses();
      if (classes.length) body.classes = classes;
      return body;
    }

    if (type === 'example_batch') {
      const active = String(S.activeClass || '').trim();
      const im = curImg();
      if (active) body.active_class = active;
      if (im && im.id) body.source_image_id = im.id;
      if (Array.isArray(S.promptBoxes) && S.promptBoxes.length) body.boxes = S.promptBoxes;
      body.pure_visual = !!S.examplePureVisual;
      return body;
    }

    return body;
  }

  async function pollInferJob(jobId, handlers={}) {
    const doneHandler = typeof handlers.onDone === 'function' ? handlers.onDone : null;
    const errorPrefix = String(handlers.errorPrefix || '批量推理');
    try {
      const data = await api(`/api/infer/jobs/${encodeURIComponent(jobId)}`);
      const job = data.job || {};
      S.inferJobId = String(job.job_id || jobId);
      S.inferJobState = job;
      renderInferProgress(job);

      const status = String(job.status || '').toLowerCase();
      if (status === 'done') {
        stopInferJobPolling();
        setBusy(false);
        if (doneHandler) await doneHandler(job);
        return;
      }
      if (status === 'paused') {
        stopInferJobPolling();
        setBusy(false);
        setStatus(job.message || '任务已停止，可调整参数后继续', 'ok');
        return;
      }
      if (status === 'error') {
        stopInferJobPolling();
        setBusy(false);
        setStatus(`${errorPrefix}失败: ${job.error || job.message || '未知错误'}`, 'err');
        return;
      }

      S.inferJobTimer = window.setTimeout(() => {
        pollInferJob(jobId, handlers).catch((e) => setStatus(`读取推理进度失败: ${e.message}`, 'err'));
      }, 700);
    } catch (e) {
      stopInferJobPolling();
      setBusy(false);
      renderInferProgress({ status: 'error', message: `读取进度失败: ${e.message}`, progress_done: 0, progress_total: 0, progress_pct: 0 });
      setStatus(`读取推理进度失败: ${e.message}`, 'err');
    }
  }

  async function finishTextBatchJob(doneJob, fallbackBatchSize=0) {
    const result = doneJob.result || doneJob || {};
    clearPreview();
    S.annotationCache = {};
    S.annotationLoading = {};
    S.focusedAnnIndex = null;
    await reloadCurrentProject({ preserveImage:true });
    await openImageByIndex(S.imageIndex,{ fit:false, force:true });
    if (!S.annotations.length) {
      const lastImageId = String(doneJob.current_image_id || '').trim();
      if (lastImageId) {
        const lastIndex = await resolveImageIndexById(pid(), lastImageId);
        if (lastIndex >= 0 && lastIndex !== S.imageIndex) {
          await openImageByIndex(lastIndex, { fit:false, force:true });
        }
      }
    }
    renderAnnList();
    renderPreviewList();
    requestRender();
    const failed = Number(result.failed || doneJob.failed || 0);
    const succeeded = Number(result.succeeded || doneJob.succeeded || 0);
    const added = Number(result.new_annotations || doneJob.new_annotations || 0);
    const actualBatch = Number(result.batch_size || doneJob.batch_size || fallbackBatchSize || 0);
    const summary = failed > 0
      ? `批量完成: 成功 ${succeeded}, 失败 ${failed}, 新增 ${added}, batch=${actualBatch}`
      : `批量完成: 成功 ${succeeded}, 新增 ${added}, batch=${actualBatch}`;
    setStatus(summary,'ok');
  }

  async function finishExampleBatchJob(doneJob, fallbackBatchSize=0) {
    const result = doneJob.result || doneJob || {};
    clearPreview();
    clearPrompt();
    S.annotationCache = {};
    S.annotationLoading = {};
    S.focusedAnnIndex = null;
    await reloadCurrentProject({ preserveImage:true });
    await openImageByIndex(S.imageIndex,{ fit:false, force:true });
    if (!S.annotations.length) {
      const lastImageId = String(doneJob.current_image_id || '').trim();
      if (lastImageId) {
        const lastIndex = await resolveImageIndexById(pid(), lastImageId);
        if (lastIndex >= 0 && lastIndex !== S.imageIndex) {
          await openImageByIndex(lastIndex, { fit:false, force:true });
        }
      }
    }
    renderAnnList();
    renderPreviewList();
    requestRender();
    const failed = Number(result.failed || doneJob.failed || 0);
    const succeeded = Number(result.succeeded || doneJob.succeeded || 0);
    const added = Number(result.new_annotations || doneJob.new_annotations || 0);
    const actualBatch = Number(result.batch_size || doneJob.batch_size || fallbackBatchSize || 0);
    const summary = failed > 0
      ? `范例传播完成: 成功 ${succeeded}, 失败 ${failed}, 写入 ${added}, batch=${actualBatch}`
      : `范例传播完成: 成功 ${succeeded}, 写入 ${added}, batch=${actualBatch}`;
    setStatus(summary,'ok');
  }

  function inferJobHandlers(jobType, fallbackBatchSize=0) {
    const type = String(jobType || '').trim().toLowerCase();
    if (type === 'example_batch') {
      return {
        errorPrefix: '范例传播',
        onDone: (doneJob) => finishExampleBatchJob(doneJob, fallbackBatchSize)
      };
    }
    return {
      errorPrefix: '批量推理',
      onDone: (doneJob) => finishTextBatchJob(doneJob, fallbackBatchSize)
    };
  }

  async function resumeActiveInferJob(projectId) {
    const id = String(projectId || '').trim();
    if (!id) return { resumed: false, restored: false };
    try {
      const data = await api(`/api/infer/jobs/active?project_id=${encodeURIComponent(id)}`);
      const job = data.job || null;
      if (!job || typeof job !== 'object') return { resumed: false, restored: false };
      const status = String(job.status || '').toLowerCase();
      const jobId = String(job.job_id || '').trim();
      if (!jobId) return { resumed: false, restored: false };
      S.inferJobId = jobId;
      S.inferJobState = job;
      renderInferProgress(job);
      if (status === 'paused' || status === 'pausing') {
        setBusy(false);
        return { resumed: false, restored: true };
      }
      if (status !== 'queued' && status !== 'running') return { resumed: false, restored: false };
      setBusy(true);
      pollInferJob(jobId, inferJobHandlers(job.job_type, Number(job.batch_size || 0)))
        .catch((e) => setStatus(`读取推理进度失败: ${e.message}`, 'err'));
      return { resumed: true, restored: true };
    } catch (e) {
      console.warn('[web-auto] resumeActiveInferJob failed', e);
      return { resumed: false, restored: false };
    }
  }

  async function stopInferJob() {
    if (!S.project) throw new Error('请先打开项目');
    const resp = await api('/api/infer/jobs/stop', {
      method: 'POST',
      body: JSON.stringify({ project_id: pid() })
    });
    const job = resp.job || S.inferJobState || null;
    if (job) {
      S.inferJobId = String(job.job_id || S.inferJobId || '');
      S.inferJobState = job;
      renderInferProgress(job);
    }
    setStatus('已发送停止请求，当前批次结束后会尽快中断', 'ok');
  }

  async function resumeInferJob() {
    if (!S.project) throw new Error('请先打开项目');
    const job = S.inferJobState || {};
    const type = String(job.job_type || '').trim().toLowerCase();
    if (!type) throw new Error('当前没有可继续的批量任务');
    const resp = await api('/api/infer/jobs/resume', {
      method: 'POST',
      body: JSON.stringify(buildInferResumeBody(job))
    });
    const nextJob = resp.job || {};
    S.inferJobId = String(nextJob.job_id || S.inferJobId || '');
    S.inferJobState = nextJob;
    renderInferProgress(nextJob);
    setBusy(true);
    await pollInferJob(S.inferJobId, inferJobHandlers(type, Number(nextJob.batch_size || job.batch_size || 0)));
  }

  function applyTheme() {
    document.body.classList.toggle('dark', !!S.darkMode);
    if (dom.themeToggleBtn) {
      dom.themeToggleBtn.textContent = S.darkMode ? '浅色模式' : '深色模式';
    }
  }

  function closeExampleMenu() {
    S.exampleMenuOpen = false;
    if (dom.exampleMenuPanel) dom.exampleMenuPanel.classList.add('hidden');
    if (dom.exampleMenuBtn) dom.exampleMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleExampleMenu() {
    if (!dom.exampleMenuPanel || !dom.exampleMenuBtn || S.busy) return;
    S.exampleMenuOpen = !S.exampleMenuOpen;
    dom.exampleMenuPanel.classList.toggle('hidden', !S.exampleMenuOpen);
    dom.exampleMenuBtn.setAttribute('aria-expanded', S.exampleMenuOpen ? 'true' : 'false');
  }

  function setBusy(b) {
    S.busy = !!b;
    if (S.busy) closeExampleMenu();
    [dom.openProjectBtn,dom.refreshProjectsBtn,dom.closeProjectBtn,dom.deleteProjectBtn,dom.applyClassesBtn,dom.inferCurrentBtn,dom.inferAllBtn,dom.exampleMenuBtn,dom.exampleBatchBtn,dom.segmentBtn,dom.exampleCurrentBtn,dom.commitPreviewBtn,dom.clearPreviewBtn,dom.saveAnnBtn,dom.clearAnnBtn,dom.exportBtn,dom.smartFilterBtn,dom.smartFilterApplyBtn,dom.testApiBtn,dom.deleteImageBtn]
      .forEach((x)=>{ if (x) x.disabled = !!b || (x===dom.openProjectBtn && !!S.project); });
  }

  async function api(path, options={}) {
    const opt = Object.assign({ method: 'GET' }, options || {});
    opt.headers = Object.assign({}, opt.headers || {});
    if (opt.body && !(opt.body instanceof FormData) && !opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) throw new Error(String(data?.detail || `HTTP ${r.status}`));
    return data || {};
  }

  function setWorkspaceLocked(locked) {
    dom.projectName.disabled = locked; dom.imageDir.disabled = locked; dom.saveDir.disabled = locked;
    dom.openProjectBtn.disabled = locked || S.busy; dom.closeProjectBtn.disabled = !locked || S.busy; dom.deleteProjectBtn.disabled = !locked || S.busy;
  }

  function applySidebarLayout(opts={}) {
    const autoFit = !!opts.autoFit;
    if (!dom.annotateLayout) return;
    dom.annotateLayout.classList.toggle('hide-left', !!S.hideLeftSidebar);
    dom.annotateLayout.classList.toggle('hide-right', !!S.hideRightSidebar);
    if (dom.leftSidebar) dom.leftSidebar.style.display = S.hideLeftSidebar ? 'none' : '';
    if (dom.rightSidebar) dom.rightSidebar.style.display = S.hideRightSidebar ? 'none' : '';
    if (dom.edgeToggleLeft) {
      dom.edgeToggleLeft.textContent = S.hideLeftSidebar ? '▶' : '◀';
      dom.edgeToggleLeft.title = S.hideLeftSidebar ? '显示左栏' : '隐藏左栏';
    }
    if (dom.edgeToggleRight) {
      dom.edgeToggleRight.textContent = S.hideRightSidebar ? '◀' : '▶';
      dom.edgeToggleRight.title = S.hideRightSidebar ? '显示右栏' : '隐藏右栏';
    }
    if (autoFit && S.imageEl) {
      fitViewAfterLayout(true);
    } else {
      resizeCanvas();
      requestRender();
    }
  }

  function renderProjectMeta() {
    if (!S.project) { dom.projectMeta.textContent = '未加载项目'; return; }
    const p = S.project;
    dom.projectMeta.textContent = [`项目: ${p.name}`,`ID: ${p.id}`,`图片目录: ${p.image_dir}`,`保存目录: ${p.save_dir}`,`图片数: ${p.num_images ?? S.images.length}`,`已标注: ${p.labeled_images ?? 0}`,`未标注: ${p.unlabeled_images ?? 0}`].join('\n');
  }

  function renderProjectList() {
    if (!S.projects.length) { dom.projectList.innerHTML = '<div class="item muted">暂无项目</div>'; return; }
    dom.projectList.innerHTML = S.projects.map((p)=>{
      const active = S.project && S.project.id===p.id ? 'active' : '';
      const d = (p.labeled_images||0)>0 ? 'state-labeled' : 'state-unlabeled';
      return `<div class="item ${active}" data-project-id="${esc(p.id)}"><span class="state-dot ${d}">●</span><div class="grow">${esc(p.name)}<div class="muted">${esc(p.image_dir||'')}</div></div><span class="tag">${esc(`${p.labeled_images||0}/${p.num_images||0}`)}</span></div>`;
    }).join('');
  }
  function resetImageSlots(total, keepExisting=false) {
    const size = Math.max(0, Math.round(Number(total || 0)));
    const next = new Array(size).fill(null);
    if (keepExisting && Array.isArray(S.images)) {
      const count = Math.min(size, S.images.length);
      for (let i = 0; i < count; i += 1) next[i] = S.images[i] || null;
    }
    S.images = next;
    S.imagePagesLoaded = new Set();
    S.imagePagesLoading = {};
  }

  function clearImageWarmupTimer() {
    if (S.imageWarmupTimer) {
      window.clearTimeout(S.imageWarmupTimer);
      S.imageWarmupTimer = 0;
    }
  }

  function applyImagePage(items, offset) {
    const list = Array.isArray(items) ? items : [];
    const start = Math.max(0, Math.round(Number(offset || 0)));
    for (let i = 0; i < list.length; i += 1) {
      const idx = start + i;
      if (idx < 0 || idx >= S.images.length) continue;
      S.images[idx] = list[i] || null;
    }
  }

  async function loadImagePage(offset, { imageId='' }={}) {
    if (!S.project) return { items: [], total: 0, offset: 0, limit: IMAGE_PAGE_SIZE, image_index: -1 };
    const start = Math.max(0, Math.floor(Number(offset || 0) / IMAGE_PAGE_SIZE) * IMAGE_PAGE_SIZE);
    const key = String(start);
    if (!imageId && S.imagePagesLoaded.has(key)) {
      return { items: [], total: S.images.length, offset: start, limit: IMAGE_PAGE_SIZE, image_index: -1 };
    }
    if (!imageId && S.imagePagesLoading[key]) return S.imagePagesLoading[key];
    const qs = new URLSearchParams({ offset: String(start), limit: String(IMAGE_PAGE_SIZE) });
    if (imageId) qs.set('image_id', String(imageId));
    const req = api(`/api/projects/${encodeURIComponent(pid())}/images?${qs.toString()}`).then((data) => {
      const total = Math.max(0, Math.round(Number(data.total || 0)));
      if (S.images.length !== total) resetImageSlots(total, true);
      applyImagePage(data.items, data.offset || start);
      S.imagePagesLoaded.add(key);
      delete S.imagePagesLoading[key];
      return data || {};
    }).catch((e) => {
      delete S.imagePagesLoading[key];
      throw e;
    });
    if (!imageId) S.imagePagesLoading[key] = req;
    return req;
  }

  async function loadImageWindow(index, count=INITIAL_IMAGE_LOAD_COUNT) {
    if (!S.project || !S.images.length) return;
    const total = S.images.length;
    const size = Math.max(1, Math.min(total, Math.round(Number(count || INITIAL_IMAGE_LOAD_COUNT))));
    const center = clamp(Number(index || 0), 0, Math.max(0, total - 1));
    const start = Math.max(0, Math.min(total - size, center - Math.floor(size / 2)));
    const data = await api(`/api/projects/${encodeURIComponent(pid())}/images?offset=${start}&limit=${size}`);
    applyImagePage(data.items, data.offset || start);
  }

  async function ensureImageMeta(index) {
    if (!S.project || !S.images.length) return null;
    const safeIndex = clamp(Number(index || 0), 0, Math.max(0, S.images.length - 1));
    if (!S.images[safeIndex] || !S.images[safeIndex].id) {
      await loadImagePage(safeIndex);
    }
    return S.images[safeIndex] || null;
  }

  function warmImagePagesForRange(start, end) {
    if (!S.project || !S.images.length) return;
    const safeStart = Math.max(0, Math.min(S.images.length - 1, Math.floor(Number(start || 0))));
    const safeEnd = Math.max(safeStart, Math.min(S.images.length - 1, Math.floor(Number(end || 0))));
    const firstPage = Math.floor(safeStart / IMAGE_PAGE_SIZE) * IMAGE_PAGE_SIZE;
    const lastPage = Math.floor(safeEnd / IMAGE_PAGE_SIZE) * IMAGE_PAGE_SIZE;
    for (let page = firstPage; page <= lastPage; page += IMAGE_PAGE_SIZE) {
      const key = String(page);
      if (S.imagePagesLoaded.has(key) || S.imagePagesLoading[key]) continue;
      loadImagePage(page).then(() => {
        if (S.project) scheduleRenderImageList();
      }).catch(() => {});
    }
  }

  function scheduleBackgroundImagePageWarmup() {
    if (!S.project || !S.images.length) return;
    clearImageWarmupTimer();
    const currentPage = Math.floor(S.imageIndex / IMAGE_PAGE_SIZE) * IMAGE_PAGE_SIZE;
    const pages = [];
    for (let page = 0; page < S.images.length; page += IMAGE_PAGE_SIZE) {
      if (page === currentPage) continue;
      pages.push(page);
    }
    const run = () => {
      if (!S.project || !pages.length) return;
      const nextPage = pages.shift();
      if (nextPage === undefined) return;
      const key = String(nextPage);
      const after = () => {
        if (!pages.length || !S.project) return;
        S.imageWarmupTimer = window.setTimeout(run, 120);
      };
      if (S.imagePagesLoaded.has(key) || S.imagePagesLoading[key]) {
        after();
        return;
      }
      loadImagePage(nextPage).then(() => {
        if (S.project) scheduleRenderImageList();
        after();
      }).catch(() => {
        after();
      });
    };
    S.imageWarmupTimer = window.setTimeout(run, 120);
  }

  function renderImageInfo() {
    const c = curImg();
    const suffix = c && c.rel_path ? ` - ${c.rel_path}` : (S.images.length ? ' - 加载中...' : '');
    dom.imageInfo.textContent = `${S.imageIndex+1} / ${S.images.length}${suffix}`;
  }
  function imageListItemHtml(img, index) {
    if (!img || !img.id) {
      return `<div class="item muted" data-image-index="${index}"><span class="state-dot">○</span><div class="grow">加载中...</div></div>`;
    }
    const active = index===S.imageIndex ? 'active' : '';
    const d = img.status==='labeled' ? 'state-labeled' : 'state-unlabeled';
    return `<div class="item ${active}" data-image-index="${index}"><span class="state-dot ${d}">●</span><div class="grow">${esc(img.rel_path||img.id||'')}</div></div>`;
  }

  function ensureImageIndexVisible(index) {
    if (!dom.imageList || !S.images.length) return;
    const safeIndex = clamp(Number(index || 0), 0, Math.max(0, S.images.length - 1));
    const viewTop = dom.imageList.scrollTop;
    const viewHeight = dom.imageList.clientHeight || 420;
    const viewBottom = viewTop + viewHeight;
    const itemTop = safeIndex * IMAGE_LIST_ROW_HEIGHT;
    const itemBottom = itemTop + IMAGE_LIST_ROW_HEIGHT;
    if (itemTop < viewTop) {
      dom.imageList.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      dom.imageList.scrollTop = Math.max(0, itemBottom - viewHeight);
    }
  }

  function renderImageList({ ensureVisible=false }={}) {
    if (!S.project || !S.images.length) {
      dom.imageList.innerHTML = '<div class="item muted">暂无图片</div>';
      dom.imageInfo.textContent='-';
      S.imageListWindowStart = -1;
      S.imageListWindowEnd = -1;
      return;
    }
    if (ensureVisible) ensureImageIndexVisible(S.imageIndex);
    const total = S.images.length;
    const viewHeight = dom.imageList.clientHeight || 420;
    const scrollTop = dom.imageList.scrollTop || 0;
    const visibleCount = Math.max(1, Math.ceil(viewHeight / IMAGE_LIST_ROW_HEIGHT));
    const start = Math.max(0, Math.floor(scrollTop / IMAGE_LIST_ROW_HEIGHT) - IMAGE_LIST_OVERSCAN);
    const end = Math.min(total, start + visibleCount + IMAGE_LIST_OVERSCAN * 2);
    warmImagePagesForRange(start, end - 1);
    const topPad = start * IMAGE_LIST_ROW_HEIGHT;
    const bottomPad = Math.max(0, (total - end) * IMAGE_LIST_ROW_HEIGHT);
    const html = [];
    if (topPad > 0) html.push(`<div class="image-list-spacer" style="height:${topPad}px"></div>`);
    for (let i = start; i < end; i += 1) html.push(imageListItemHtml(S.images[i], i));
    if (bottomPad > 0) html.push(`<div class="image-list-spacer" style="height:${bottomPad}px"></div>`);
    dom.imageList.innerHTML = html.join('');
    S.imageListWindowStart = start;
    S.imageListWindowEnd = end;
    renderImageInfo();
  }

  function scheduleRenderImageList(opts={}) {
    if (S.imageListRaf) return;
    S.imageListRaf = window.requestAnimationFrame(() => {
      S.imageListRaf = 0;
      renderImageList(opts);
    });
  }

  function renderClassList() {
    if (!S.project) { dom.classList.innerHTML='<div class="item muted">请先创建或打开项目</div>'; return; }
    if (!S.classes.length) { dom.classList.innerHTML='<div class="item muted">暂无类别，请先添加类别</div>'; return; }
    dom.classList.innerHTML = S.classes.map((c,i)=>{
      const ck = S.selectedClasses.has(c) ? 'checked' : '';
      const rd = S.activeClass===c ? 'checked' : '';
      return `<div class="item"><input type="checkbox" class="cls-check" data-c="${esc(c)}" ${ck} title="勾选后会参与文本一键推理。"/><input type="radio" name="activeClass" class="cls-active" data-c="${esc(c)}" ${rd} title="设为当前类别，用于点选命名、范例分割和范例传播。"/><span class="grow">${esc(c)}</span><span class="tag">${i+1}</span><button class="cls-del" data-c="${esc(c)}" title="从当前项目删除这个类别。">×</button></div>`;
    }).join('');
  }

  function renderAnnList() {
    if (!S.annotations.length) { dom.annList.innerHTML='<div class="item muted">当前图片暂无标注</div>'; return; }
    if (!Number.isInteger(S.focusedAnnIndex) || S.focusedAnnIndex < 0 || S.focusedAnnIndex >= S.annotations.length) {
      S.focusedAnnIndex = null;
    }
    dom.annList.innerHTML = S.annotations.map((a,i)=>{
      const active = (S.focusedAnnIndex === i) ? 'active' : '';
      return `<div class="item ${active}" data-ann-index="${i}"><span class="tag">${esc(a.class_name||a.label||'object')}</span><div class="grow">score: ${Number(a.score||0).toFixed(3)}</div><span class="del" data-del="${i}">删除</span></div>`;
    }).join('');
  }

  function renderPreviewList() {
    if (!dom.previewList) return;
    if (!S.previewAnnotations.length) {
      dom.previewList.innerHTML = '<div class="item muted">暂无预览结果</div>';
      return;
    }
    dom.previewList.innerHTML = S.previewAnnotations.map((a, i) => {
      const id = String(a.id || `preview_${i}`);
      const checked = S.previewSelectedIds.has(id) ? 'checked' : '';
      return `<div class="item" data-preview-id="${esc(id)}"><input type="checkbox" class="preview-check" data-preview-id="${esc(id)}" ${checked}/><span class="tag">${esc(a.class_name||a.label||'object')}</span><div class="grow">score: ${Number(a.score||0).toFixed(3)}</div><span class="del" data-preview-del="${esc(id)}">删除</span></div>`;
    }).join('');
  }

  function requestRender() {
    if (S.renderPending) return;
    S.renderPending = true;
    requestAnimationFrame(()=>{ S.renderPending=false; renderCanvas(); });
  }

  function resizeCanvas() {
    const r = dom.canvasContainer.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width - 2)); const h = Math.max(1, Math.floor(r.height - 2));
    if (dom.canvas.width!==w || dom.canvas.height!==h) { dom.canvas.width=w; dom.canvas.height=h; }
  }

  const imageToScreen = (x,y)=>({ x:x*S.zoom + S.panX, y:y*S.zoom + S.panY });
  const screenToImage = (x,y)=>({ x:(x-S.panX)/S.zoom, y:(y-S.panY)/S.zoom });

  function clampToImage(pt) {
    if (!S.imageEl) return {x:0,y:0};
    return { x:clamp(pt.x,0,Math.max(0,S.imageEl.naturalWidth-1)), y:clamp(pt.y,0,Math.max(0,S.imageEl.naturalHeight-1)) };
  }
  const insideImage = (pt)=>!!S.imageEl && pt.x>=0 && pt.y>=0 && pt.x<S.imageEl.naturalWidth && pt.y<S.imageEl.naturalHeight;

  function setZoom(z, ax, ay) {
    const old = S.zoom; const nz = clamp(z, S.minZoom, S.maxZoom);
    const x = Number.isFinite(ax)?ax:dom.canvas.width/2, y = Number.isFinite(ay)?ay:dom.canvas.height/2;
    const wx = (x-S.panX)/old, wy=(y-S.panY)/old;
    S.zoom=nz; S.panX = x-wx*S.zoom; S.panY = y-wy*S.zoom;
    if (dom.zoomSlider) dom.zoomSlider.value = String(clamp(Math.round(S.zoom*100),10,400));
    if (dom.zoomValue) dom.zoomValue.textContent = `${Math.round(S.zoom*100)}%`;
    requestRender(); saveProjectStateDebounced();
  }

  function fitView(alignTop = false) {
    if (!S.imageEl) return;
    resizeCanvas();
    const cw=dom.canvas.width, ch=dom.canvas.height, iw=S.imageEl.naturalWidth, ih=S.imageEl.naturalHeight;
    S.zoom = clamp(Math.min((cw-20)/iw,(ch-20)/ih), S.minZoom, S.maxZoom);
    S.panX = (cw-iw*S.zoom)/2;
    S.panY = alignTop ? 0 : (ch-ih*S.zoom)/2;
    if (dom.zoomSlider) dom.zoomSlider.value = String(clamp(Math.round(S.zoom*100),10,400));
    if (dom.zoomValue) dom.zoomValue.textContent = `${Math.round(S.zoom*100)}%`;
    requestRender(); saveProjectStateDebounced();
  }

  function fitViewAfterLayout(alignTop=false) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        fitView(!!alignTop);
      });
    });
  }
  function drawPolygon(poly, color) {
    if (!Array.isArray(poly) || poly.length<3) return;
    ctx.save(); ctx.beginPath();
    poly.forEach((p,i)=>{ const q=imageToScreen(Number(p[0]),Number(p[1])); if(i===0)ctx.moveTo(q.x,q.y); else ctx.lineTo(q.x,q.y); });
    ctx.closePath(); ctx.fillStyle=color; ctx.globalAlpha=0.25; ctx.fill(); ctx.globalAlpha=0.95; ctx.strokeStyle=color; ctx.lineWidth=1.2; ctx.stroke(); ctx.restore();
  }

  function getMaskImage(ann) {
    if (!ann || !ann.mask_png_base64) return null;
    if (ann.__maskImg && ann.__maskReady) return ann.__maskImg;
    if (!ann.__maskImg) {
      const img = new Image(); ann.__maskReady=false;
      img.onload=()=>{ ann.__maskReady=true; requestRender(); }; img.onerror=()=>{ ann.__maskReady=false; };
      img.src = `data:image/png;base64,${ann.mask_png_base64}`; ann.__maskImg = img;
    }
    return ann.__maskReady ? ann.__maskImg : null;
  }

  function drawPromptPoint(p) {
    const q=imageToScreen(Number(p[0]),Number(p[1])); const pos=Number(p[2])===0?0:1;
    ctx.save(); ctx.beginPath(); ctx.arc(q.x,q.y,5,0,Math.PI*2); ctx.fillStyle=pos? '#00c853' : '#d50000'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='#fff'; ctx.stroke(); ctx.restore();
  }

  function drawPromptBox(b) {
    const p1=imageToScreen(Number(b[0]),Number(b[1])); const p2=imageToScreen(Number(b[2]),Number(b[3])); const pos=Number(b[4])===0?0:1;
    ctx.save(); ctx.strokeStyle=pos? '#00c853' : '#d50000'; ctx.setLineDash([6,4]); ctx.lineWidth=1.4; ctx.strokeRect(p1.x,p1.y,p2.x-p1.x,p2.y-p1.y); ctx.restore();
  }

  function renderCanvas() {
    const w=dom.canvas.width, h=dom.canvas.height;
    const canvasBoard = getComputedStyle(document.body).getPropertyValue('--canvas-board').trim() || '#18212f';
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,w,h); ctx.fillStyle=canvasBoard; ctx.fillRect(0,0,w,h);
    if (!S.imageEl) return;
    const iw=S.imageEl.naturalWidth, ih=S.imageEl.naturalHeight, dw=iw*S.zoom, dh=ih*S.zoom;
    ctx.save(); ctx.drawImage(S.imageEl,S.panX,S.panY,dw,dh); ctx.restore();

    const anns = (Number.isInteger(S.focusedAnnIndex) && S.focusedAnnIndex >= 0 && S.focusedAnnIndex < S.annotations.length)
      ? [S.annotations[S.focusedAnnIndex]]
      : S.annotations;

    function drawAnn(ann, preview=false) {
      const cls = ann.class_name || ann.label || 'object'; const c = colorFor(cls);
      const bbox = ann.bbox || ann.bbox_xyxy || []; const poly = Array.isArray(ann.polygon) ? ann.polygon : [];

      if (S.showMask) {
        if (poly.length>=3) {
          if (preview) {
            ctx.save(); ctx.globalAlpha = 0.7;
            drawPolygon(poly,c);
            ctx.restore();
          } else {
            drawPolygon(poly,c);
          }
        }
        else {
          const m = getMaskImage(ann);
          if (m) { ctx.save(); ctx.globalAlpha=preview?0.12:0.22; ctx.drawImage(m,S.panX,S.panY,dw,dh); ctx.restore(); }
        }
      }

      if (S.showBox && Array.isArray(bbox) && bbox.length===4) {
        const p1=imageToScreen(Number(bbox[0]),Number(bbox[1])), p2=imageToScreen(Number(bbox[2]),Number(bbox[3]));
        ctx.save(); ctx.strokeStyle=c; ctx.lineWidth=1.6;
        if (preview) ctx.setLineDash([5,3]);
        ctx.strokeRect(p1.x,p1.y,p2.x-p1.x,p2.y-p1.y);
        const text=`${preview?'预览 ':''}${cls} ${Number(ann.score||0).toFixed(2)}`; ctx.font='12px Segoe UI'; const tw=Math.ceil(ctx.measureText(text).width)+8, th=18;
        const lx=p1.x, ly=Math.max(0,p1.y-th); ctx.fillStyle=c; ctx.fillRect(lx,ly,tw,th); ctx.fillStyle='#fff'; ctx.fillText(text,lx+4,ly+13); ctx.restore();
      }
    }

    anns.forEach((ann)=>drawAnn(ann, false));
    S.previewAnnotations.forEach((ann)=>drawAnn(ann, true));

    S.promptBoxes.forEach(drawPromptBox); S.promptPoints.forEach(drawPromptPoint);
    if (S.drawingBox) drawPromptBox([S.drawingBox.x1,S.drawingBox.y1,S.drawingBox.x2,S.drawingBox.y2,S.drawingBox.label]);
  }

  function clearPrompt() { S.promptPoints=[]; S.promptBoxes=[]; S.promptHistory=[]; S.drawingBox=null; requestRender(); }
  function clearPreview() { S.previewAnnotations=[]; S.previewSelectedIds=new Set(); renderPreviewList(); requestRender(); }
  function selectAllPreviewAnnotations() {
    S.previewSelectedIds = new Set(S.previewAnnotations.map((a, i) => String(a.id || `preview_${i}`)));
    renderPreviewList();
  }
  function isUnknownPreviewClass(raw) {
    const v = String(raw || '').trim().toLowerCase();
    return v === 'unknown' || v === 'unknow';
  }
  function rewriteUnknownPreviewClass(ann, activeClass) {
    const next = Object.assign({}, ann || {});
    const target = String(activeClass || '').trim();
    if (!target) return next;
    if (isUnknownPreviewClass(next.class_name)) next.class_name = target;
    if (isUnknownPreviewClass(next.label)) next.label = target;
    return next;
  }
  function pushPrompt(type) { S.promptHistory.push(type); }
  function undoPrompt() {
    const t=S.promptHistory.pop(); if(!t) return;
    if (t==='point' && S.promptPoints.length) S.promptPoints.pop();
    else if (t==='box' && S.promptBoxes.length) S.promptBoxes.pop();
    requestRender();
  }

  function markCurrentImageStatus() {
    const im = curImg();
    if (!im) return;
    im.status = S.annotations.length > 0 ? 'labeled' : 'unlabeled';
    S.annotationCache[String(im.id || '')] = Array.isArray(S.annotations) ? S.annotations.map((ann) => Object.assign({}, ann)) : [];
    const row = dom.imageList.querySelector(`[data-image-index="${S.imageIndex}"] .state-dot`);
    if (row) {
      row.classList.remove('state-labeled', 'state-unlabeled');
      row.classList.add(im.status === 'labeled' ? 'state-labeled' : 'state-unlabeled');
    }
  }
  function pLocalKey(id) { return `${PKEY}${id}`; }
  function readLocal(key, fallback={}) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function writeLocal(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val || {}));
    } catch (_) {}
  }
  function removeLocal(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_) {}
  }

  async function loadImageWithTimeout(url, timeoutMs=15000) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error('图片加载超时'));
      }, timeoutMs);
      img.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('图片加载失败'));
      };
      img.src = url;
    });
    return img;
  }

  function imageFileUrl(projectId, imageId) {
    return `/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}/file`;
  }

  async function loadImageAsset(imageId, { force=false }={}) {
    const key = String(imageId || '').trim();
    if (!key || !S.project) throw new Error('当前图片不存在');
    if (!force && S.imageAssetCache[key]) return S.imageAssetCache[key];
    if (!force && S.imageAssetLoading[key]) return S.imageAssetLoading[key];
    const req = loadImageWithTimeout(`${imageFileUrl(S.project.id, key)}?t=${force ? Date.now() : 'cache'}`, 15000)
      .then((img) => {
        S.imageAssetCache[key] = img;
        delete S.imageAssetLoading[key];
        return img;
      })
      .catch((e) => {
        delete S.imageAssetLoading[key];
        throw e;
      });
    S.imageAssetLoading[key] = req;
    return req;
  }

  async function loadAnnotationsCached(imageId, { force=false }={}) {
    const key = String(imageId || '').trim();
    if (!key || !S.project) throw new Error('当前图片不存在');
    if (!force && S.annotationCache[key]) return S.annotationCache[key];
    if (!force && S.annotationLoading[key]) return S.annotationLoading[key];
    const req = api(
      `/api/projects/${encodeURIComponent(S.project.id)}/images/${encodeURIComponent(key)}/annotations`,
      { cache: 'no-store' }
    )
      .then((data) => {
        const anns = Array.isArray(data.annotations) ? data.annotations : [];
        S.annotationCache[key] = anns;
        delete S.annotationLoading[key];
        return anns;
      })
      .catch((e) => {
        delete S.annotationLoading[key];
        throw e;
      });
    S.annotationLoading[key] = req;
    return req;
  }

  function prefetchNearbyImageData(centerIndex) {
    if (!S.project || !S.images.length) return;
    for (let step = 1; step <= NEARBY_PREFETCH_RADIUS; step += 1) {
      for (const idx of [centerIndex + step, centerIndex - step]) {
        if (idx < 0 || idx >= S.images.length) continue;
        ensureImageMeta(idx).then((img) => {
          if (!img || !img.id || !S.project) return;
          loadAnnotationsCached(img.id).catch(() => {});
          loadImageAsset(img.id).catch(() => {});
        }).catch(() => {});
      }
    }
  }

  function globalPayload() {
    return {
      projectName: dom.projectName.value||'', imageDir: dom.imageDir.value||'', saveDir: dom.saveDir.value||'',
      apiBaseUrl: dom.apiBaseUrl.value||'', threshold: Number(dom.threshold.value||0.5), batchSize: Number(dom.batchSize?.value||8), exportFormat: dom.exportFormat.value||'coco', exportDir: dom.exportDir.value||'',
      exportBBox: !!(dom.exportBBox && dom.exportBBox.checked),
      exportMask: !!(dom.exportMask && dom.exportMask.checked),
      darkMode: !!S.darkMode,
      lastProjectId: S.project ? S.project.id : ''
    };
  }

  function applyGlobal(obj={}) {
    if (typeof obj.projectName==='string') dom.projectName.value=obj.projectName;
    if (typeof obj.imageDir==='string') dom.imageDir.value=obj.imageDir;
    if (typeof obj.saveDir==='string') dom.saveDir.value=obj.saveDir;
    if (typeof obj.apiBaseUrl==='string' && obj.apiBaseUrl.trim()) dom.apiBaseUrl.value=obj.apiBaseUrl;
    if (Number.isFinite(Number(obj.threshold))) dom.threshold.value=String(clamp(Number(obj.threshold),0,1));
    if (dom.batchSize && Number.isFinite(Number(obj.batchSize))) dom.batchSize.value=String(clamp(Math.round(Number(obj.batchSize)),1,32));
    if (dom.exportFormat) {
      const fmt = String(obj.exportFormat || '').toLowerCase();
      if (fmt === 'yolo') dom.exportFormat.value = 'yolo';
      else if (fmt === 'json') dom.exportFormat.value = 'coco';
      else if (fmt === 'coco') dom.exportFormat.value = 'coco';
    }
    if (typeof obj.exportDir==='string') dom.exportDir.value=obj.exportDir;
    if (dom.exportBBox && typeof obj.exportBBox === 'boolean') dom.exportBBox.checked = obj.exportBBox;
    if (dom.exportMask && typeof obj.exportMask === 'boolean') dom.exportMask.checked = obj.exportMask;
    if (typeof obj.darkMode === 'boolean') S.darkMode = obj.darkMode;
    applyTheme();
  }

  function viewStateForImage(imageId) {
    const key = String(imageId || '');
    if (!key) return null;
    const view = S.imageViewStates[key];
    return view && typeof view === 'object' ? view : null;
  }

  function rememberCurrentImageView() {
    const im = curImg();
    if (!im || !im.id) return;
    S.imageViewStates[String(im.id)] = {
      zoom: Number(S.zoom),
      panX: Number(S.panX),
      panY: Number(S.panY)
    };
  }

  function applyImageViewState(imageId) {
    const view = viewStateForImage(imageId);
    if (!view) return false;
    if (Number.isFinite(Number(view.zoom))) S.zoom = clamp(Number(view.zoom), S.minZoom, S.maxZoom);
    if (Number.isFinite(Number(view.panX))) S.panX = Number(view.panX);
    if (Number.isFinite(Number(view.panY))) S.panY = Number(view.panY);
    if (dom.zoomSlider) dom.zoomSlider.value = String(clamp(Math.round(S.zoom*100),10,400));
    if (dom.zoomValue) dom.zoomValue.textContent = `${Math.round(S.zoom*100)}%`;
    return true;
  }

  function projectPayload() {
    const im=curImg();
    return {
      selectedClasses: selClasses(), activeClass: S.activeClass, imageId: im ? im.id : '', tool: S.tool,
      promptLabel: S.promptLabel, showMask: S.showMask, showBox: S.showBox, autoPromptInfer: !!S.autoPromptInfer, autoPromptMode: normAutoPromptMode(S.autoPromptMode), examplePureVisual: !!S.examplePureVisual, imageViewStates: S.imageViewStates,
      hideLeftSidebar: !!S.hideLeftSidebar, hideRightSidebar: !!S.hideRightSidebar
    };
  }

  function applyProjectState(ps={}) {
    if (Array.isArray(ps.selectedClasses)) {
      const s=new Set(); ps.selectedClasses.forEach((c)=>{ if(S.classes.includes(c)) s.add(c); }); if (s.size) S.selectedClasses=s;
    }
    if (typeof ps.activeClass==='string' && S.classes.includes(ps.activeClass)) S.activeClass=ps.activeClass;
    if (!S.activeClass || !S.classes.includes(S.activeClass)) S.activeClass = selClasses()[0] || S.classes[0] || '';
    if (['point','box','pan'].includes(String(ps.tool||''))) S.tool=ps.tool;
    S.promptLabel = Number(ps.promptLabel)===0 ? 0 : 1;
    if (typeof ps.showMask==='boolean') S.showMask=ps.showMask;
    if (typeof ps.showBox==='boolean') S.showBox=ps.showBox;
    if (typeof ps.autoPromptInfer==='boolean') S.autoPromptInfer=ps.autoPromptInfer;
    S.autoPromptMode = normAutoPromptMode(ps.autoPromptMode);
    if (typeof ps.examplePureVisual === 'boolean') S.examplePureVisual = ps.examplePureVisual;
    S.imageViewStates = {};
    if (ps.imageViewStates && typeof ps.imageViewStates === 'object') {
      Object.entries(ps.imageViewStates).forEach(([imageId, view]) => {
        if (!view || typeof view !== 'object') return;
        const zoom = Number(view.zoom), panX = Number(view.panX), panY = Number(view.panY);
        if (!Number.isFinite(zoom) || !Number.isFinite(panX) || !Number.isFinite(panY)) return;
        S.imageViewStates[String(imageId)] = { zoom: clamp(zoom, S.minZoom, S.maxZoom), panX, panY };
      });
    }
    if (typeof ps.hideLeftSidebar==='boolean') S.hideLeftSidebar=ps.hideLeftSidebar;
    if (typeof ps.hideRightSidebar==='boolean') S.hideRightSidebar=ps.hideRightSidebar;
    S.zoom = 1; S.panX = 0; S.panY = 0;
    if (!S.selectedClasses.size) S.classes.forEach((c)=>S.selectedClasses.add(c));

    dom.showMask.checked=S.showMask; dom.showBox.checked=S.showBox;
    if (dom.examplePureVisual) dom.examplePureVisual.checked = !!S.examplePureVisual;
    syncAutoPromptControls();
    dom.labelPos.classList.toggle('active', S.promptLabel===1); dom.labelNeg.classList.toggle('active', S.promptLabel===0);
    dom.toolPoint.classList.toggle('active', S.tool==='point'); dom.toolBox.classList.toggle('active', S.tool==='box'); dom.toolPan.classList.toggle('active', S.tool==='pan');
    if (dom.zoomSlider) dom.zoomSlider.value = String(clamp(Math.round(S.zoom*100),10,400));
    if (dom.zoomValue) dom.zoomValue.textContent = `${Math.round(S.zoom*100)}%`;
    applySidebarLayout();
    renderClassList(); requestRender();
    return typeof ps.imageId==='string' ? ps.imageId : '';
  }

  function saveGlobalStateDebounced() {
    clearTimeout(S.saveGlobalTimer);
    S.saveGlobalTimer = setTimeout(()=>{
      const p=globalPayload();
      const text = JSON.stringify(p);
      if (text === S.lastGlobalState) return;
      S.lastGlobalState = text;
      writeLocal(GKEY,p);
      api('/api/ui_state',{ method:'POST', body:JSON.stringify({ state:p }) }).catch(()=>{});
    }, 500);
  }

  function saveProjectStateDebounced() {
    if (!S.project) return;
    clearTimeout(S.saveProjectTimer);
    S.saveProjectTimer = setTimeout(()=>{
      if (!S.project) return;
      const p=projectPayload();
      const text = `${S.project.id}:${JSON.stringify(p)}`;
      if (text === S.lastProjectState) return;
      S.lastProjectState = text;
      writeLocal(pLocalKey(S.project.id),p);
      api('/api/ui_state',{ method:'POST', body:JSON.stringify({ project_id:S.project.id, state:p }) }).catch(()=>{});
    }, 500);
  }

  async function loadGlobalState() {
    const local = readLocal(GKEY, {}); applyGlobal(local);
    try { const remote=(await api('/api/ui_state')).state || {}; const merged=Object.assign({},remote,local); applyGlobal(merged); writeLocal(GKEY,merged); } catch(_) {}
  }

  async function loadProjects() { const data=await api('/api/projects'); S.projects=Array.isArray(data.projects)?data.projects:[]; renderProjectList(); }

  async function resolveImageIndexById(projectId, imageId) {
    const target = String(imageId || '').trim();
    if (!projectId || !target) return -1;
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/images?offset=0&limit=1&image_id=${encodeURIComponent(target)}`);
    const idx = Number(data.image_index ?? -1);
    return Number.isFinite(idx) ? idx : -1;
  }

  async function openImageByIndex(index, { fit=false, force=false }={}) {
    if (!S.project || !S.images.length) return;
    const nextIndex = clamp(index, 0, S.images.length-1);
    if (!force && !fit && nextIndex === S.imageIndex && S.currentImageId === String((S.images[nextIndex]||{}).id || '') && S.imageEl) {
      return;
    }
    const meta = await ensureImageMeta(nextIndex);
    if (!meta || !meta.id) {
      setStatus('读取图片元数据失败','err');
      return;
    }
    rememberCurrentImageView();
    const prevIndex = S.imageIndex;
    S.imageIndex = nextIndex;
    const im = curImg(); if (!im) return; S.currentImageId = im.id;
    clearPreview();
    renderImageList({ ensureVisible:true });

    const token = ++S.imageLoadToken;
    const annReq = loadAnnotationsCached(im.id, { force });
    const imgReq = loadImageAsset(im.id, { force });
    const [annRes, imgRes] = await Promise.allSettled([annReq, imgReq]);
    if (token!==S.imageLoadToken) return;

    if (annRes.status === 'fulfilled') {
      S.annotations = Array.isArray(annRes.value) ? annRes.value : [];
      S.focusedAnnIndex = null;
      renderAnnList();
      renderPreviewList();
    } else {
      S.annotations = [];
      S.focusedAnnIndex = null;
      renderAnnList();
      renderPreviewList();
      setStatus(`读取标注失败: ${annRes.reason?.message || annRes.reason || '未知错误'}`,'err');
    }

    if (imgRes.status === 'fulfilled') {
      S.imageEl = imgRes.value;
      clearPrompt();
      if (fit) fitView(true); else if (applyImageViewState(im.id)) requestRender(); else fitView(true);
      if (annRes.status === 'fulfilled') setStatus('图片已加载','ok');
    } else {
      S.imageEl = null;
      requestRender();
      setStatus(imgRes.reason?.message || '图片加载失败','err');
    }

    prefetchNearbyImageData(S.imageIndex);

    saveProjectStateDebounced();
  }
  async function reloadCurrentProject({ preserveImage=true }={}) {
    if (!S.project) return;
    const keepId = preserveImage && curImg() ? curImg().id : '';
    const prevImages = S.images;
    const data = await api(`/api/projects/${encodeURIComponent(pid())}?include_images=false`);
    S.project = data.project;
    resetImageSlots(Number(S.project.num_images || 0), true);
    for (let i = 0; i < Math.min(S.images.length, prevImages.length); i += 1) S.images[i] = prevImages[i] || S.images[i];
    S.classes = Array.isArray(S.project.classes)?S.project.classes:[];

    const kept = new Set(); S.classes.forEach((c)=>{ if (S.selectedClasses.has(c)) kept.add(c); }); if (!kept.size) S.classes.forEach((c)=>kept.add(c)); S.selectedClasses = kept;
    if (!S.activeClass || !S.classes.includes(S.activeClass)) S.activeClass = selClasses()[0] || S.classes[0] || '';

    dom.classesText.value = '';
    if (keepId) {
      let i = prevImages.findIndex((x)=>x && x.id===keepId);
      if (i < 0) i = await resolveImageIndexById(pid(), keepId);
      S.imageIndex = i>=0 ? i : 0;
    } else S.imageIndex = 0;
    await loadImageWindow(S.imageIndex, INITIAL_IMAGE_LOAD_COUNT);
    loadImagePage(S.imageIndex).catch(()=>{});
    scheduleBackgroundImagePageWarmup();
    renderProjectMeta(); renderProjectList(); renderClassList(); renderImageList({ ensureVisible:true });
  }

  async function openProjectById(projectId) {
    const id = String(projectId||'').trim(); if (!id) return;
    let inferRestore = { resumed: false, restored: false };
    setBusy(true);
    try {
      hideInferProgress();
      const data = await api(`/api/projects/${encodeURIComponent(id)}?include_images=false`);
      S.project = data.project;
      resetImageSlots(Number(S.project.num_images || 0), false);
      S.classes = Array.isArray(S.project.classes)?S.project.classes:[];
      S.selectedClasses = new Set(S.classes); S.activeClass = S.classes[0] || ''; S.annotations=[]; S.focusedAnnIndex=null; S.imageIndex=0; S.imageEl=null; S.imageViewStates={}; clearPrompt(); clearPreview();
      S.annotationCache = {};
      S.annotationLoading = {};
      S.imageAssetCache = {};
      S.imageAssetLoading = {};
      clearImageWarmupTimer();

      dom.projectName.value = S.project.name || ''; dom.imageDir.value = S.project.image_dir || ''; dom.saveDir.value = S.project.save_base_dir || ''; dom.classesText.value = '';
      if (dom.exportDir && !String(dom.exportDir.value || '').trim()) {
        dom.exportDir.value = String(S.project.image_dir || '');
      }
      setWorkspaceLocked(true); renderProjectMeta(); renderClassList(); renderProjectList();

      let ps = readLocal(pLocalKey(S.project.id), {});
      try { const remote=(await api(`/api/ui_state?project_id=${encodeURIComponent(S.project.id)}`)).state || {}; ps = Object.assign({},remote,ps); } catch(_) {}
      const imageId = applyProjectState(ps);
      if (imageId) {
        const resolvedIndex = await resolveImageIndexById(S.project.id, imageId);
        if (resolvedIndex >= 0) S.imageIndex = resolvedIndex;
      }
      await loadImageWindow(S.imageIndex, INITIAL_IMAGE_LOAD_COUNT);
      loadImagePage(S.imageIndex).catch(()=>{});
      scheduleBackgroundImagePageWarmup();

      if (dom.imageList) dom.imageList.scrollTop = Math.max(0, S.imageIndex * IMAGE_LIST_ROW_HEIGHT);
      renderImageList({ ensureVisible:true });

      if (S.images.length) await openImageByIndex(S.imageIndex, { fit:true }); else { S.annotations=[]; renderAnnList(); renderPreviewList(); requestRender(); }
      inferRestore = await resumeActiveInferJob(S.project.id);
      const openMsg = inferRestore.resumed
        ? `已打开项目: ${S.project.name}；已恢复推理进度`
        : (inferRestore.restored ? `已打开项目: ${S.project.name}；检测到暂停中的批量任务，可调整参数后继续` : `已打开项目: ${S.project.name}`);
      setStatus(openMsg,'ok'); saveGlobalStateDebounced(); saveProjectStateDebounced();
    } catch (e) {
      setStatus(`打开项目失败: ${e.message}`,'err');
    } finally { if (!inferRestore.resumed) setBusy(false); }
  }

  async function createProject() {
    const imageDir = String(dom.imageDir.value||'').trim(); if (!imageDir) { setStatus('请先填写数据集目录','err'); return; }
    const body = { name:String(dom.projectName.value||'').trim(), image_dir:imageDir, save_dir:String(dom.saveDir.value||'').trim()||null, classes_text:String(dom.classesText.value||'').trim() };

    setBusy(true);
    try {
      setStatus('正在创建项目...');
      const data = await api('/api/projects/open', { method:'POST', body:JSON.stringify(body) });
      await loadProjects(); await openProjectById(data.project.id); setStatus('项目创建成功','ok');
    } catch (e) {
      setStatus(`创建项目失败: ${e.message}`,'err');
    } finally { setBusy(false); saveGlobalStateDebounced(); }
  }

  function closeProject() {
    S.project=null; S.images=[]; S.classes=[]; S.selectedClasses=new Set(); S.activeClass=''; S.annotations=[]; S.imageIndex=0; S.currentImageId=''; S.imageEl=null; clearPrompt(); clearPreview();
    S.imagePagesLoaded = new Set();
    S.imagePagesLoading = {};
    S.annotationCache = {};
    S.annotationLoading = {};
    S.imageAssetCache = {};
    S.imageAssetLoading = {};
    clearImageWarmupTimer();
    hideInferProgress();
    if (dom.imageList) dom.imageList.scrollTop = 0;
    setWorkspaceLocked(false); renderProjectMeta(); renderProjectList(); renderClassList(); renderImageList(); renderAnnList(); renderPreviewList(); requestRender();
    const g=readLocal(GKEY,{}); delete g.lastProjectId; writeLocal(GKEY,g); saveGlobalStateDebounced(); setStatus('已退出当前项目');
  }

  async function deleteCurrentProject() {
    if (!S.project) { setStatus('当前没有可删除项目','err'); return; }
    if (!window.confirm(`确认删除项目 ${S.project.name} (${S.project.id})?\n将删除该项目标注、状态和缓存，但不会删除原始图片。`)) return;
    setBusy(true);
    try {
      const id=S.project.id; await api(`/api/projects/${encodeURIComponent(id)}`, { method:'DELETE' }); removeLocal(pLocalKey(id)); closeProject(); await loadProjects(); setStatus('项目已删除','ok');
    } catch (e) {
      setStatus(`删除项目失败: ${e.message}`,'err');
    } finally { setBusy(false); }
  }

  async function updateClasses() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const input = String(dom.classesText.value || '').trim();
    if (!input) { setStatus('请输入要添加的类别（逗号分隔）','err'); return; }
    setBusy(true);
    try {
      const res = await api(`/api/projects/${encodeURIComponent(pid())}/classes/add`, { method:'POST', body:JSON.stringify({ classes_text: input }) });
      S.project=res.project; S.classes=Array.isArray(S.project.classes)?S.project.classes:[];
      const old = new Set(S.selectedClasses); const next = new Set(); S.classes.forEach((c)=>{ if(old.has(c)) next.add(c); }); if(!next.size) S.classes.forEach((c)=>next.add(c)); S.selectedClasses=next;
      if (!S.activeClass || !S.classes.includes(S.activeClass)) S.activeClass = selClasses()[0] || S.classes[0] || '';
      dom.classesText.value=''; renderClassList(); renderProjectMeta(); saveProjectStateDebounced(); setStatus('类别已添加','ok');
    } catch (e) {
      setStatus(`添加类别失败: ${e.message}`,'err');
    } finally { setBusy(false); }
  }

  async function deleteClass(className) {
    const name = String(className || '').trim();
    if (!name || !S.project) return;
    setBusy(true);
    try {
      const res = await api(`/api/projects/${encodeURIComponent(pid())}/classes/${encodeURIComponent(name)}`, { method:'DELETE' });
      S.project = res.project;
      S.classes = Array.isArray(S.project.classes) ? S.project.classes : [];
      S.selectedClasses.delete(name);
      const kept = new Set();
      S.classes.forEach((c)=>{ if (S.selectedClasses.has(c)) kept.add(c); });
      if (!kept.size) S.classes.forEach((c)=>kept.add(c));
      S.selectedClasses = kept;
      if (!S.activeClass || !S.classes.includes(S.activeClass)) S.activeClass = selClasses()[0] || S.classes[0] || '';
      renderClassList();
      renderProjectMeta();
      saveProjectStateDebounced();
      setStatus(`已删除类别: ${name}`,'ok');
    } catch (e) {
      setStatus(`删除类别失败: ${e.message}`,'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrentAnnotations() {
    if (!S.project) throw new Error('请先打开项目'); const im=curImg(); if (!im) throw new Error('当前无图片');
    await api('/api/annotations/save', { method:'POST', body:JSON.stringify({ project_id:pid(), image_id:im.id, annotations:S.annotations }) });
    markCurrentImageStatus(); setStatus('已保存当前图片标注','ok');
  }

  async function inferCurrentText() {
    if (!S.project) { setStatus('请先打开项目','err'); return; } const im=curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    const classes=selClasses(); if (!classes.length) { setStatus('请至少勾选一个类别','err'); return; }
    const body = { project_id:pid(), image_id:im.id, mode:'text', classes, active_class:'', points:[], boxes:[], threshold:Number(dom.threshold.value||0.5), api_base_url:String(dom.apiBaseUrl.value||'').trim() };
    const progressParams = buildInferParams('text_single', body);

    setBusy(true);
    try {
      setStatus('推理中: 当前图片 + 已选类别...');
      renderInferProgress({ status:'running', message:'当前图文本推理中...', progress_done:0, progress_total:1, progress_pct:15, params:progressParams });
      const r = await api('/api/infer',{ method:'POST', body:JSON.stringify(body) });
      S.annotations = Array.isArray(r.saved_annotations)?r.saved_annotations:(Array.isArray(r.annotations)?r.annotations:[]);
      clearPreview();
      S.focusedAnnIndex = null;
      renderInferProgress({ status:'done', message:`当前图文本推理完成: 新增 ${r.num_detections||0} 条`, progress_done:1, progress_total:1, progress_pct:100, params:progressParams });
      renderAnnList(); renderPreviewList(); requestRender(); markCurrentImageStatus(); await reloadCurrentProject({ preserveImage:true }); setStatus(`推理完成: 新增 ${r.num_detections||0} 条`,'ok');
    } catch (e) {
      renderInferProgress({ status:'error', message:`当前图文本推理失败: ${e.message}`, progress_done:0, progress_total:1, progress_pct:0, params:progressParams });
      setStatus(`推理失败: ${e.message}`,'err');
    } finally { setBusy(false); saveGlobalStateDebounced(); saveProjectStateDebounced(); }
  }

  async function inferAllText() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const classes=selClasses(); if (!classes.length) { setStatus('请至少勾选一个类别','err'); return; }
    const batchSize = clamp(Math.round(Number(dom.batchSize?.value || 8)), 1, 32);
    if (dom.batchSize) dom.batchSize.value = String(batchSize);
    const body={ project_id:pid(), classes, image_ids:[], all_images:true, batch_size: batchSize, threshold:Number(dom.threshold.value||0.5), api_base_url:String(dom.apiBaseUrl.value||'').trim() };
    const progressParams = buildInferParams('text_batch', body);

    setBusy(true);
    try {
      setStatus(`推理中: 全部图片 + 已选类别（文本批处理, batch=${batchSize}）...`);
      renderInferProgress({ status:'queued', message:'正在创建文本批量任务...', progress_done:0, progress_total:1, progress_pct:0, params:progressParams });
      const started = await api('/api/infer/jobs/start_batch',{ method:'POST', body:JSON.stringify(body) });
      const job = Object.assign({}, started.job || {});
      if (!job.params) job.params = progressParams;
      S.inferJobId = String(job.job_id || '');
      S.inferJobState = job;
      renderInferProgress(job);
      await pollInferJob(S.inferJobId, inferJobHandlers('text_batch', batchSize));
    } catch (e) {
      hideInferProgress();
      setStatus(`批量推理失败: ${e.message}`,'err');
      setBusy(false);
    } finally { saveGlobalStateDebounced(); saveProjectStateDebounced(); }
  }

  function hasPositivePromptBox(boxes) {
    if (!Array.isArray(boxes)) return false;
    return boxes.some((b) => Array.isArray(b) && b.length >= 4 && Number(b[4] ?? 1) !== 0);
  }

  async function inferAllByExample() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const im = curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    const active = String(S.activeClass||'').trim();
    if (!active) { setStatus('请先选择当前类别（active class）','err'); return; }
    if (!S.promptBoxes.length) { setStatus('请先在当前图框选正/负样本','err'); return; }
    if (!hasPositivePromptBox(S.promptBoxes)) { setStatus('至少需要一个正样本框','err'); return; }

    if (!window.confirm(`将把当前图的正/负框作为${S.examplePureVisual ? '纯视觉' : '视觉'}范例传播到全图集（类别: ${active}）。\n至少需要 1 个正样本框，负样本框可选；该操作只替换该类别结果，保留其他类别。是否继续？`)) return;

    const body = {
      project_id: pid(),
      source_image_id: im.id,
      active_class: active,
      boxes: S.promptBoxes,
      pure_visual: !!S.examplePureVisual,
      batch_size: clamp(Math.round(Number(dom.batchSize?.value || 8)), 1, 32),
      threshold: Number(dom.threshold.value||0.5),
      api_base_url: String(dom.apiBaseUrl.value||'').trim()
    };
    const progressParams = buildInferParams('example_batch', body);

    setBusy(true);
    try {
      setStatus(S.examplePureVisual ? `范例传播中: ${active} -> 全图集纯视觉传播...` : `范例传播中: ${active} -> 全图集视觉范例传播...`);
      renderInferProgress({ status:'queued', message:'正在创建范例传播任务...', progress_done:0, progress_total:1, progress_pct:0, params:progressParams });
      const started = await api('/api/infer/jobs/start_batch_example',{ method:'POST', body:JSON.stringify(body) });
      const job = Object.assign({}, started.job || {});
      if (!job.params) job.params = progressParams;
      S.inferJobId = String(job.job_id || '');
      S.inferJobState = job;
      renderInferProgress(job);
      await pollInferJob(S.inferJobId, inferJobHandlers('example_batch', body.batch_size));
    } catch (e) {
      hideInferProgress();
      setStatus(`范例传播失败: ${e.message}`,'err');
      setBusy(false);
    } finally { saveGlobalStateDebounced(); saveProjectStateDebounced(); }
  }

  async function previewCurrentExample(opts={}) {
    const auto = !!(opts && opts.auto);
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const im = curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    if (S.tool !== 'box') {
      if (!auto) setStatus('当前图范例分割仅支持框选模式','err');
      return;
    }
    const active = String(S.activeClass || '').trim();
    if (!active) { setStatus('请先选择当前类别（active class）','err'); return; }
    if (!S.promptBoxes.length) { setStatus('请先在当前图框选正/负样本','err'); return; }
    if (!hasPositivePromptBox(S.promptBoxes)) { setStatus('至少需要一个正样本框','err'); return; }

    const body = {
      project_id: pid(),
      image_id: im.id,
      active_class: active,
      boxes: S.promptBoxes,
      pure_visual: !!S.examplePureVisual,
      threshold: Number(dom.threshold.value||0.5),
      api_base_url: String(dom.apiBaseUrl.value||'').trim()
    };
    const progressParams = buildInferParams('example_preview', body);

    setBusy(true);
    try {
      setStatus(S.examplePureVisual ? `范例分割中: 当前图 -> ${active}（纯视觉）` : `范例分割中: 当前图 -> ${active}`);
      renderInferProgress({ status:'running', message:S.examplePureVisual ? `当前图纯视觉范例分割中: ${active}` : `当前图范例分割中: ${active}`, progress_done:0, progress_total:1, progress_pct:15, params:progressParams });
      const r = await api('/api/infer/example_preview', { method:'POST', body:JSON.stringify(body) });
      S.previewAnnotations = Array.isArray(r.detections) ? r.detections : [];
      S.previewSelectedIds = new Set();
      clearPrompt();
      renderInferProgress({ status:'done', message:`当前图范例分割完成: 预览 ${r.num_detections||0} 条`, progress_done:1, progress_total:1, progress_pct:100, params:progressParams });
      renderPreviewList();
      requestRender();
      setStatus(`范例分割完成: 预览 ${r.num_detections||0} 条（默认未勾选）`,'ok');
    } catch (e) {
      renderInferProgress({ status:'error', message:`当前图范例分割失败: ${e.message}`, progress_done:0, progress_total:1, progress_pct:0, params:progressParams });
      setStatus(`范例分割失败: ${e.message}`,'err');
    } finally { setBusy(false); saveProjectStateDebounced(); }
  }

  async function previewByPrompt(opts={}) {
    const auto = !!(opts && opts.auto);
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const im=curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    let mode = S.tool;
    if (mode==='pan') { if (!auto) setStatus('请先选择点选或框选工具','err'); return; }
    if (mode==='point' && !S.promptPoints.length) { setStatus('点选模式下请先添加点提示','err'); return; }
    if (mode==='box' && !S.promptBoxes.length) { setStatus('框选模式下请先添加框提示','err'); return; }
    if (!mode) { setStatus('请选择点选或框选工具后再预测','err'); return; }

    const inferPoints = mode==='point' ? S.promptPoints : [];
    const inferBoxes = mode==='box' ? S.promptBoxes : [];
    const body = {
      project_id: pid(), image_id: im.id, mode: mode==='point' ? 'points' : 'boxes', classes: selClasses(), active_class: '',
      points: inferPoints, boxes: inferBoxes, threshold: Number(dom.threshold.value||0.5), api_base_url: String(dom.apiBaseUrl.value||'').trim()
    };
    const progressParams = buildInferParams(mode==='point' ? 'points_preview' : 'boxes_preview', body);

    setBusy(true);
    try {
      setStatus(`预测中: ${mode==='point'?'点选':'框选'} 纯视觉提示`);
      renderInferProgress({ status:'running', message:`预测中: ${mode==='point'?'点选':'框选'} 纯视觉提示`, progress_done:0, progress_total:1, progress_pct:15, params:progressParams });
      const r = await api('/api/infer/preview',{ method:'POST', body:JSON.stringify(body) });
      S.previewAnnotations = Array.isArray(r.detections) ? r.detections : [];
      S.previewSelectedIds = new Set();
      clearPrompt();
      renderInferProgress({ status:'done', message:`预测完成: 预览 ${r.num_detections||0} 条`, progress_done:1, progress_total:1, progress_pct:100, params:progressParams });
      renderPreviewList();
      requestRender();
      setStatus(`预测完成: 预览 ${r.num_detections||0} 条（默认未勾选）`,'ok');
    } catch (e) {
      renderInferProgress({ status:'error', message:`预测失败: ${e.message}`, progress_done:0, progress_total:1, progress_pct:0, params:progressParams });
      setStatus(`预测失败: ${e.message}`,'err');
    } finally { setBusy(false); saveProjectStateDebounced(); }
  }

  async function commitPreviewAnnotations() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const im = curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    if (!S.previewAnnotations.length) { setStatus('当前无可提交预览','err'); return; }
    const selectedRaw = S.previewAnnotations.filter((a)=>S.previewSelectedIds.has(String(a.id || '')));
    const selected = selectedRaw.map((a)=>rewriteUnknownPreviewClass(a, S.activeClass));
    if (!selected.length) { setStatus('请先勾选要提交的预览结果','err'); return; }

    setBusy(true);
    try {
      const r = await api('/api/annotations/append', {
        method:'POST',
        body:JSON.stringify({ project_id: pid(), image_id: im.id, annotations: selected })
      });
      S.annotations = Array.isArray(r.saved_annotations) ? r.saved_annotations : S.annotations;
      const selectedIds = new Set(selected.map((a)=>String(a.id || '')));
      S.previewAnnotations = S.previewAnnotations.filter((a)=>!selectedIds.has(String(a.id || '')));
      S.previewSelectedIds = new Set();
      S.focusedAnnIndex = null;
      renderAnnList();
      renderPreviewList();
      requestRender();
      markCurrentImageStatus();
      await reloadCurrentProject({ preserveImage:true });
      setStatus(`提交完成: 新增 ${Number(r.added||0)} 条`,'ok');
    } catch (e) {
      setStatus(`提交失败: ${e.message}`,'err');
    } finally { setBusy(false); saveProjectStateDebounced(); }
  }

  function triggerAutoSegmentIfEnabled() {
    if (!S.autoPromptInfer) return;
    if (S.busy) return;
    const mode = normAutoPromptMode(S.autoPromptMode);
    if (mode === 'example_current') {
      if (S.tool !== 'box') return;
      previewCurrentExample({ auto: true });
      return;
    }
    previewByPrompt({ auto: true });
  }

  async function clearCurrentAnnotations() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    S.annotations=[]; S.focusedAnnIndex = null; renderAnnList(); requestRender();
    try { await saveCurrentAnnotations(); await reloadCurrentProject({ preserveImage:true }); } catch (e) { setStatus(`清空标注失败: ${e.message}`,'err'); }
  }

  async function deleteCurrentImage() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const im = curImg(); if (!im) { setStatus('当前无图片','err'); return; }
    const rel = String(im.rel_path || im.id || '');
    if (!window.confirm(`确认删除当前图片？\n${rel}\n\n将同时删除原始图片文件和对应标注文件（如果存在）。`)) return;

    const deletedImageId = String(im.id || '');
    const nextIndex = Math.max(0, Math.min(S.imageIndex, S.images.length - 2));
    setBusy(true);
    try {
      await api(`/api/projects/${encodeURIComponent(pid())}/images/${encodeURIComponent(im.id)}`, { method:'DELETE' });
      if (deletedImageId) delete S.imageViewStates[deletedImageId];
      if (deletedImageId) {
        delete S.annotationCache[deletedImageId];
        delete S.annotationLoading[deletedImageId];
        delete S.imageAssetCache[deletedImageId];
        delete S.imageAssetLoading[deletedImageId];
      }
      clearPreview();
      clearPrompt();
      await reloadCurrentProject({ preserveImage:false });
      if (S.images.length) {
        await openImageByIndex(nextIndex, { fit:true });
      } else {
        S.annotations = [];
        S.focusedAnnIndex = null;
        S.imageEl = null;
        renderAnnList();
        renderPreviewList();
        renderImageList();
        requestRender();
      }
      setStatus(`已删除图片: ${rel}`,'ok');
    } catch (e) {
      setStatus(`删除图片失败: ${e.message}`,'err');
    } finally { setBusy(false); saveProjectStateDebounced(); }
  }

  function updateExportHint() {
    if (!dom.exportFormat || !dom.exportHint) return;
    const fmt = String(dom.exportFormat.value || 'coco').toLowerCase();
    const bbox = !!(dom.exportBBox && dom.exportBBox.checked);
    const mask = !!(dom.exportMask && dom.exportMask.checked);

    if (!bbox && !mask) {
      dom.exportHint.textContent = '请至少选择一种保存内容（BBox 或 掩码）。';
      dom.exportHint.style.color = 'var(--danger)';
      return;
    }

    if (fmt === 'coco') {
      dom.exportHint.textContent = '提示：COCO 的掩码将以 polygon 形式保存。';
      dom.exportHint.style.color = 'var(--muted)';
      return;
    }

    if (fmt === 'yolo' && bbox && mask) {
      dom.exportHint.textContent = 'YOLO 不支持在同一导出中同时保存 BBox 和掩码，请二选一。';
      dom.exportHint.style.color = 'var(--danger)';
      return;
    }

    if (fmt === 'yolo' && mask) {
      dom.exportHint.textContent = '提示：当前将导出 YOLO-SEG（类别 + 多边形点）。';
      dom.exportHint.style.color = 'var(--muted)';
      return;
    }

    dom.exportHint.textContent = '提示：当前将导出 YOLO-DET（类别 + BBox）。';
    dom.exportHint.style.color = 'var(--muted)';
  }

  function openExportModal() {
    if (!S.project) {
      setStatus('请先打开项目', 'err');
      return;
    }
    if (dom.exportFormat) dom.exportFormat.value = 'coco';
    if (dom.exportBBox) dom.exportBBox.checked = true;
    if (dom.exportMask) dom.exportMask.checked = false;
    if (dom.exportDir) dom.exportDir.value = String(S.project.image_dir || '');
    if (dom.exportModal) dom.exportModal.classList.remove('hidden');
    updateExportHint();
    saveGlobalStateDebounced();
  }

  function closeExportModal() {
    if (dom.exportModal) dom.exportModal.classList.add('hidden');
  }

  function syncSmartFilterConfigFromDom() {
    const mergeMode = String(dom.smartFilterMode?.value || 'same_class').trim();
    const coverageValue = clamp(Number(dom.smartFilterCoverage?.value || 0.98), 0.5, 1);
    const areaMode = String(dom.smartFilterAreaMode?.value || 'instance').trim();
    const canonicalClass = String(dom.smartFilterCanonicalClass?.value || '').trim();
    const sourceClasses = dom.smartFilterSourceClasses
      ? Array.from(dom.smartFilterSourceClasses.querySelectorAll('input[type="checkbox"]:checked')).map((el) => String(el.value || '').trim()).filter(Boolean)
      : [];
    if (dom.smartFilterCoverage) dom.smartFilterCoverage.value = coverageValue.toFixed(2);
    S.smartFilterConfig = {
      merge_mode: mergeMode === 'canonical_class' ? 'canonical_class' : 'same_class',
      coverage_threshold: coverageValue,
      area_mode: areaMode === 'bbox' ? 'bbox' : 'instance',
      canonical_class: canonicalClass,
      source_classes: sourceClasses,
    };
  }

  function renderSmartFilterConfig() {
    const cfg = S.smartFilterConfig || { merge_mode: 'same_class', coverage_threshold: 0.98, area_mode: 'instance', canonical_class: '', source_classes: [] };
    if (dom.smartFilterMode) dom.smartFilterMode.value = cfg.merge_mode || 'same_class';
    if (dom.smartFilterCoverage) dom.smartFilterCoverage.value = Number(cfg.coverage_threshold || 0.98).toFixed(2);
    if (dom.smartFilterAreaMode) dom.smartFilterAreaMode.value = cfg.area_mode === 'bbox' ? 'bbox' : 'instance';
    if (dom.smartFilterCanonicalClass) {
      const options = ['<option value="">请选择目标类别</option>']
        .concat(S.classes.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`));
      dom.smartFilterCanonicalClass.innerHTML = options.join('');
      if ((!cfg.canonical_class || !S.classes.includes(cfg.canonical_class)) && S.classes.length) {
        cfg.canonical_class = String(S.classes[0] || '');
      }
      if (cfg.canonical_class && S.classes.includes(cfg.canonical_class)) {
        dom.smartFilterCanonicalClass.value = cfg.canonical_class;
      }
    }
    const showCanonical = (cfg.merge_mode || 'same_class') === 'canonical_class';
    if (dom.smartFilterCanonicalRow) dom.smartFilterCanonicalRow.classList.toggle('hidden', !showCanonical);
    if (dom.smartFilterSourceClasses) {
      const selected = new Set(Array.isArray(cfg.source_classes) ? cfg.source_classes : []);
      const canonical = String(cfg.canonical_class || '');
      const sourceItems = S.classes
        .filter((name) => String(name || '') && String(name || '') !== canonical)
        .map((name) => {
          const checked = selected.has(name) ? 'checked' : '';
          return `
            <label class="smart-filter-source-item">
              <input type="checkbox" value="${esc(name)}" ${checked} />
              <span>${esc(name)}</span>
            </label>
          `;
        });
      dom.smartFilterSourceClasses.innerHTML = sourceItems.length
        ? sourceItems.join('')
        : '<div class="item muted">没有可选来源类别。</div>';
    }
    if (dom.smartFilterSourceRow) dom.smartFilterSourceRow.classList.toggle('hidden', !showCanonical);
  }

  function renderSmartFilterPreview() {
    const data = S.smartFilterPreview || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const analyzed = !!data.analyzed;
    if (dom.smartFilterSummary) {
      const imageCount = Number(data.image_count || 0);
      const candidateCount = Number(data.candidate_count || 0);
      const relabelCount = Number(data.relabel_count || 0);
      const rule = data.rule || {};
      const mode = String(rule.merge_mode || 'same_class');
      const threshold = Number(rule.small_box_covered_by_large_gte || 0.98).toFixed(2);
      const canonical = String(rule.canonical_class || '').trim();
      const sourceClasses = Array.isArray(rule.source_classes) ? rule.source_classes : [];
      const areaMode = String(rule.area_mode || 'instance') === 'bbox' ? '目标框面积' : '实例面积';
      const ruleText = mode === 'canonical_class'
        ? `主从类别合并：对“目标类别 ${canonical || '未选择'} + 勾选来源类别”这个集合整体做合并。覆盖率 >= ${threshold} 时，删除小目标，并将保留目标统一归类为 ${canonical || '所选类别'}。来源类别：${sourceClasses.join('、') || '未选择'}。面积计算：${areaMode}。这意味着该集合内部的同类重叠也会一起参与合并。`
        : `同类合并：同类下大目标对小目标覆盖率 >= ${threshold} 时，删除小目标并保留大目标。面积计算：${areaMode}。`;
      dom.smartFilterSummary.textContent = !analyzed
        ? `请选择过滤方式并点击“分析预览”。规则：${ruleText}`
        : imageCount > 0
        ? `检测到 ${imageCount} 张图片存在候选目标，预计移除 ${candidateCount} 个目标${relabelCount > 0 ? `，改类 ${relabelCount} 个目标` : ''}。规则：${ruleText}`
        : `未检测到可合并目标。规则：${ruleText}`;
    }
    if (dom.smartFilterList) {
      if (!analyzed) {
        dom.smartFilterList.innerHTML = '<div class="item muted">尚未分析，请先配置过滤方式并点击“分析预览”。</div>';
      } else if (!items.length) {
        dom.smartFilterList.innerHTML = '<div class="item muted">当前项目没有需要智能过滤的重复目标。</div>';
      } else {
        dom.smartFilterList.innerHTML = items.map((item) => `
          <div class="item">
            <span class="tag">${esc(item.candidate_count || 0)}</span>
            <div class="grow">${esc(item.rel_path || item.image_id || '')}</div>
            <span class="muted">覆盖对 ${esc(item.pair_count || 0)}</span>
            ${Number(item.relabel_count || 0) > 0 ? `<span class="muted">改类 ${esc(item.relabel_count || 0)}</span>` : ''}
          </div>
        `).join('');
      }
    }
    if (dom.smartFilterApplyBtn) dom.smartFilterApplyBtn.disabled = !analyzed || !items.length || S.busy;
    if (dom.smartFilterPreviewBtn) dom.smartFilterPreviewBtn.disabled = !!S.busy;
  }

  function openSmartFilterModal() {
    if (!S.project) return;
    if (!S.smartFilterConfig.canonical_class && S.classes.length) {
      S.smartFilterConfig.canonical_class = String(S.classes[0] || '');
    }
    renderSmartFilterConfig();
    if (!S.smartFilterPreview) {
      S.smartFilterPreview = {
        analyzed: false,
        image_count: 0,
        candidate_count: 0,
        relabel_count: 0,
        items: [],
        rule: {
          merge_mode: S.smartFilterConfig.merge_mode,
          area_mode: S.smartFilterConfig.area_mode,
          canonical_class: S.smartFilterConfig.canonical_class,
          source_classes: Array.isArray(S.smartFilterConfig.source_classes) ? S.smartFilterConfig.source_classes : [],
          small_box_covered_by_large_gte: S.smartFilterConfig.coverage_threshold,
        },
      };
    }
    if (dom.smartFilterModal) dom.smartFilterModal.classList.remove('hidden');
    renderSmartFilterPreview();
  }

  function closeSmartFilterModal() {
    if (dom.smartFilterModal) dom.smartFilterModal.classList.add('hidden');
  }

  async function previewSmartFilter() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    syncSmartFilterConfigFromDom();
    if (S.smartFilterConfig.merge_mode === 'canonical_class' && !S.smartFilterConfig.canonical_class) {
      setStatus('请选择主从类合并的目标类别','err');
      return;
    }
    if (S.smartFilterConfig.merge_mode === 'canonical_class' && !(S.smartFilterConfig.source_classes || []).length) {
      setStatus('请至少勾选一个来源类别','err');
      return;
    }
    setBusy(true);
    try {
      setStatus('智能过滤分析中...');
      const r = await api('/api/filter/intelligent/preview', {
        method:'POST',
        body:JSON.stringify(Object.assign({ project_id: pid() }, S.smartFilterConfig))
      });
      S.smartFilterPreview = r || {};
      S.smartFilterPreview.analyzed = true;
      openSmartFilterModal();
      const candidateCount = Number(r?.candidate_count || 0);
      const relabelCount = Number(r?.relabel_count || 0);
      setStatus(
        candidateCount > 0 || relabelCount > 0
          ? `智能过滤分析完成: 可移除 ${candidateCount} 个目标${relabelCount > 0 ? `，改类 ${relabelCount} 个目标` : ''}`
          : '智能过滤分析完成: 无可合并目标',
        'ok'
      );
    } catch (e) {
      setStatus(`智能过滤分析失败: ${e.message}`,'err');
    } finally {
      setBusy(false);
      renderSmartFilterPreview();
    }
  }

  async function applySmartFilter() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    syncSmartFilterConfigFromDom();
    const preview = S.smartFilterPreview || {};
    const candidateCount = Number(preview.candidate_count || 0);
    const relabelCount = Number(preview.relabel_count || 0);
    if (candidateCount <= 0 && relabelCount <= 0) {
      setStatus('当前没有可合并目标','err');
      return;
    }
    const cfg = S.smartFilterConfig || {};
    const mergeMode = String(cfg.merge_mode || 'same_class');
    const areaModeText = String(cfg.area_mode || 'instance') === 'bbox' ? '目标框面积' : '实例面积';
    const actionText = mergeMode === 'canonical_class'
      ? `将对“目标类别 ${cfg.canonical_class || '未选择'} + 勾选来源类别”整体执行合并，移除 ${candidateCount} 个被覆盖目标，并把保留结果统一归类为 ${cfg.canonical_class || '所选类别'}。面积计算：${areaModeText}。注意：该集合内部的同类重叠也会一起参与合并。`
      : `将移除 ${candidateCount} 个被同类大目标覆盖的小目标，并保留较大目标。面积计算：${areaModeText}。`;
    if (!window.confirm(`确认执行智能过滤？\n${actionText}`)) return;
    setBusy(true);
    try {
      const r = await api('/api/filter/intelligent/apply', {
        method:'POST',
        body:JSON.stringify(Object.assign({ project_id: pid() }, cfg))
      });
      closeSmartFilterModal();
      S.smartFilterPreview = null;
      clearPreview();
      await reloadCurrentProject({ preserveImage:true });
      await openImageByIndex(S.imageIndex, { fit:false, force:true });
      setStatus(
        `智能过滤完成: 处理 ${r.changed_images||0} 张图片, 移除 ${r.removed_annotations||0} 个目标${Number(r.relabeled_annotations||0)>0 ? `, 改类 ${r.relabeled_annotations||0} 个目标` : ''}`,
        'ok'
      );
    } catch (e) {
      setStatus(`智能过滤执行失败: ${e.message}`,'err');
    } finally {
      setBusy(false);
    }
  }

  async function exportProject() {
    if (!S.project) { setStatus('请先打开项目','err'); return; }
    const fmt = String((dom.exportFormat && dom.exportFormat.value) || 'coco').toLowerCase();
    const includeBBox = !!(dom.exportBBox && dom.exportBBox.checked);
    const includeMask = !!(dom.exportMask && dom.exportMask.checked);

    if (!includeBBox && !includeMask) {
      setStatus('请至少选择一种保存内容（BBox 或 掩码）', 'err');
      updateExportHint();
      return;
    }
    if (fmt === 'yolo' && includeBBox && includeMask) {
      setStatus('YOLO 不支持同时导出 BBox 和掩码，请二选一', 'err');
      updateExportHint();
      return;
    }

    setBusy(true);
    try {
      const r = await api('/api/export', {
        method:'POST',
        body:JSON.stringify({
          project_id: pid(),
          format: fmt,
          include_bbox: includeBBox,
          include_mask: includeMask,
          output_dir: String((dom.exportDir && dom.exportDir.value) || '').trim() || null
        })
      });
      setStatus(`导出成功: ${r.output||''}`,'ok');
      closeExportModal();
    } catch (e) {
      setStatus(`导出失败: ${e.message}`,'err');
    } finally { setBusy(false); saveGlobalStateDebounced(); }
  }

  const canvasPos = (e)=>{ const r=dom.canvas.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; };
  const toolNow = ()=> S.spacePan ? 'pan' : S.tool;

  function onDown(e) {
    if (!S.imageEl) return;
    const isLeftButton = e.button === 0;
    if (!isLeftButton) return;
    const p=canvasPos(e), ipRaw=screenToImage(p.x,p.y), ip=clampToImage(ipRaw), t=toolNow();
    S.pointerDown={x:p.x,y:p.y}; S.pointerMoved=false;
    if (e.altKey) {
      e.preventDefault();
      if (window.getSelection) {
        const sel = window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      }
      S.draggingPan=true; S.panStart={ x:p.x,y:p.y,panX:S.panX,panY:S.panY };
      return;
    }
    if (t==='pan') { S.draggingPan=true; S.panStart={ x:p.x,y:p.y,panX:S.panX,panY:S.panY }; return; }
    if (t==='box') { if (!insideImage(ipRaw)) return; S.drawingBox={ x1:ip.x,y1:ip.y,x2:ip.x,y2:ip.y,label:S.promptLabel }; requestRender(); }
  }

  function onMove(e) {
    if (!S.imageEl) return;
    if (S.draggingPan) e.preventDefault();
    const p=canvasPos(e);
    if (S.pointerDown && (Math.abs(p.x-S.pointerDown.x)>4 || Math.abs(p.y-S.pointerDown.y)>4)) S.pointerMoved=true;
    if (S.draggingPan && S.panStart) { S.panX=S.panStart.panX+(p.x-S.panStart.x); S.panY=S.panStart.panY+(p.y-S.panStart.y); requestRender(); return; }
    if (S.drawingBox) { const q=clampToImage(screenToImage(p.x,p.y)); S.drawingBox.x2=q.x; S.drawingBox.y2=q.y; requestRender(); }
  }

  function onUp(e) {
    if (!S.imageEl) return;
    if (S.draggingPan) e.preventDefault();
    const p=canvasPos(e), ipRaw=screenToImage(p.x,p.y), ip=clampToImage(ipRaw), t=toolNow();
    if (S.draggingPan) { S.draggingPan=false; S.panStart=null; S.pointerDown=null; S.pointerMoved=false; saveProjectStateDebounced(); return; }

    if (S.drawingBox) {
      const b=S.drawingBox; S.drawingBox=null;
      const x1=Math.min(b.x1,b.x2), y1=Math.min(b.y1,b.y2), x2=Math.max(b.x1,b.x2), y2=Math.max(b.y1,b.y2);
      if ((x2-x1)>=2 && (y2-y1)>=2) { S.promptBoxes.push([x1,y1,x2,y2,b.label]); pushPrompt('box'); }
      S.pointerDown=null; S.pointerMoved=false; requestRender(); triggerAutoSegmentIfEnabled(); return;
    }

    if (e.button===0 && t==='point' && !S.pointerMoved && insideImage(ipRaw)) { S.promptPoints.push([ip.x,ip.y,S.promptLabel]); pushPrompt('point'); requestRender(); triggerAutoSegmentIfEnabled(); }
    S.pointerDown=null; S.pointerMoved=false;
  }

  function bindEvents() {
    if (backToProjectsBtn) {
      backToProjectsBtn.addEventListener('click', () => {
        window.location.href = '/';
      });
    }

    dom.openProjectBtn.addEventListener('click', createProject);
    dom.projectList.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('[data-project-id]') : null;
      if (!row) return;
      openProjectById(row.getAttribute('data-project-id') || '');
    });
    dom.imageList.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('[data-image-index]') : null;
      if (!row) return;
      const i = Number(row.getAttribute('data-image-index'));
      if (Number.isFinite(i)) openImageByIndex(i, { fit:false });
    });
    dom.imageList.addEventListener('scroll', () => {
      if (!S.project || !S.images.length) return;
      scheduleRenderImageList();
    });
    dom.classList.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      const c = t.getAttribute('data-c') || '';
      if (!c) return;
      if (t.classList.contains('cls-check')) {
        if (t.checked) S.selectedClasses.add(c); else S.selectedClasses.delete(c);
        if (!S.selectedClasses.size && S.classes.length) S.selectedClasses.add(S.classes[0]);
        if (!S.selectedClasses.has(S.activeClass)) S.activeClass = selClasses()[0] || S.classes[0] || '';
        renderClassList();
        saveProjectStateDebounced();
      } else if (t.classList.contains('cls-active')) {
        S.activeClass = c;
        S.selectedClasses.add(c);
        renderClassList();
        saveProjectStateDebounced();
      }
    });
    dom.classList.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.cls-del') : null;
      if (!btn) return;
      const c = btn.getAttribute('data-c') || '';
      if (!c) return;
      e.preventDefault();
      deleteClass(c);
    });
    dom.annList.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('[data-del]') : null;
      if (row) {
        const i = Number(row.getAttribute('data-del'));
        if (!Number.isFinite(i)) return;
        S.annotations.splice(i, 1);
        if (Number.isInteger(S.focusedAnnIndex)) {
          if (S.focusedAnnIndex === i) S.focusedAnnIndex = null;
          else if (S.focusedAnnIndex > i) S.focusedAnnIndex -= 1;
        }
        renderAnnList();
        requestRender();
        return;
      }
      const annRow = e.target && e.target.closest ? e.target.closest('[data-ann-index]') : null;
      if (!annRow) return;
      const i = Number(annRow.getAttribute('data-ann-index'));
      if (!Number.isFinite(i)) return;
      S.focusedAnnIndex = (S.focusedAnnIndex === i) ? null : i;
      renderAnnList();
      requestRender();
    });
    if (dom.previewList) {
      dom.previewList.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !t.classList || !t.classList.contains('preview-check')) return;
        const id = String(t.getAttribute('data-preview-id') || '');
        if (!id) return;
        if (t.checked) S.previewSelectedIds.add(id);
        else S.previewSelectedIds.delete(id);
      });
      dom.previewList.addEventListener('click', (e) => {
        const del = e.target && e.target.closest ? e.target.closest('[data-preview-del]') : null;
        if (!del) return;
        const id = String(del.getAttribute('data-preview-del') || '');
        if (!id) return;
        S.previewAnnotations = S.previewAnnotations.filter((a)=>String(a.id || '') !== id);
        S.previewSelectedIds.delete(id);
        renderPreviewList();
        requestRender();
      });
    }
    dom.refreshProjectsBtn.addEventListener('click', ()=>loadProjects().then(()=>setStatus('项目列表已刷新','ok')).catch((e)=>setStatus(`刷新项目列表失败: ${e.message}`,'err')));
    dom.closeProjectBtn.addEventListener('click', closeProject); dom.deleteProjectBtn.addEventListener('click', deleteCurrentProject);
    dom.applyClassesBtn.addEventListener('click', updateClasses); dom.testApiBtn.addEventListener('click', async ()=>{
      const u=String(dom.apiBaseUrl.value||'').trim(); if(!u){ setStatus('请填写 API 地址','err'); return; }
      setBusy(true); try { const r=await api('/api/sam3/health',{ method:'POST', body:JSON.stringify({ api_base_url:u }) }); setStatus(`API可用: ${JSON.stringify(r.result||{})}`,'ok'); }
      catch(e){ setStatus(`API测试失败: ${e.message}`,'err'); } finally { setBusy(false); saveGlobalStateDebounced(); }
    });

    dom.inferCurrentBtn.addEventListener('click', inferCurrentText); dom.inferAllBtn.addEventListener('click', inferAllText); if (dom.exampleMenuBtn) dom.exampleMenuBtn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggleExampleMenu(); }); if (dom.exampleBatchBtn) dom.exampleBatchBtn.addEventListener('click', ()=>{ closeExampleMenu(); inferAllByExample(); }); if (dom.stopInferJobBtn) dom.stopInferJobBtn.addEventListener('click', ()=>{ stopInferJob().catch((e)=>setStatus(`停止失败: ${e.message}`,'err')); }); if (dom.resumeInferJobBtn) dom.resumeInferJobBtn.addEventListener('click', ()=>{ resumeInferJob().catch((e)=>setStatus(`继续失败: ${e.message}`,'err')); }); dom.segmentBtn.addEventListener('click', previewByPrompt); if (dom.exampleCurrentBtn) dom.exampleCurrentBtn.addEventListener('click', ()=>{ closeExampleMenu(); previewCurrentExample(); });
    if (dom.commitPreviewBtn) dom.commitPreviewBtn.addEventListener('click', commitPreviewAnnotations);
    if (dom.clearPreviewBtn) dom.clearPreviewBtn.addEventListener('click', clearPreview);
    if (dom.selectAllPreviewBtn) dom.selectAllPreviewBtn.addEventListener('click', selectAllPreviewAnnotations);
    dom.saveAnnBtn.addEventListener('click', ()=>saveCurrentAnnotations().then(()=>reloadCurrentProject({ preserveImage:true })).catch((e)=>setStatus(`保存失败: ${e.message}`,'err')));
    dom.clearAnnBtn.addEventListener('click', clearCurrentAnnotations);
    dom.exportBtn.addEventListener('click', openExportModal);
    if (dom.smartFilterBtn) dom.smartFilterBtn.addEventListener('click', () => {
      if (!S.project) { setStatus('请先打开项目','err'); return; }
      S.smartFilterPreview = null;
      openSmartFilterModal();
    });
    if (dom.exportConfirmBtn) dom.exportConfirmBtn.addEventListener('click', exportProject);
    if (dom.exportCancelBtn) dom.exportCancelBtn.addEventListener('click', closeExportModal);
    if (dom.smartFilterApplyBtn) dom.smartFilterApplyBtn.addEventListener('click', applySmartFilter);
    if (dom.smartFilterPreviewBtn) dom.smartFilterPreviewBtn.addEventListener('click', previewSmartFilter);
    if (dom.smartFilterCancelBtn) dom.smartFilterCancelBtn.addEventListener('click', closeSmartFilterModal);
    if (dom.smartFilterMode) {
      dom.smartFilterMode.addEventListener('change', () => {
        syncSmartFilterConfigFromDom();
        S.smartFilterPreview = null;
        renderSmartFilterConfig();
        renderSmartFilterPreview();
      });
    }
    if (dom.smartFilterCoverage) {
      dom.smartFilterCoverage.addEventListener('change', () => {
        syncSmartFilterConfigFromDom();
        S.smartFilterPreview = null;
        renderSmartFilterConfig();
        renderSmartFilterPreview();
      });
    }
    if (dom.smartFilterAreaMode) {
      dom.smartFilterAreaMode.addEventListener('change', () => {
        syncSmartFilterConfigFromDom();
        S.smartFilterPreview = null;
        renderSmartFilterConfig();
        renderSmartFilterPreview();
      });
    }
    if (dom.smartFilterCanonicalClass) {
      dom.smartFilterCanonicalClass.addEventListener('change', () => {
        syncSmartFilterConfigFromDom();
        S.smartFilterConfig.source_classes = (S.smartFilterConfig.source_classes || []).filter((name) => name !== S.smartFilterConfig.canonical_class);
        S.smartFilterPreview = null;
        renderSmartFilterConfig();
        renderSmartFilterPreview();
      });
    }
    if (dom.smartFilterSourceClasses) {
      dom.smartFilterSourceClasses.addEventListener('change', () => {
        syncSmartFilterConfigFromDom();
        S.smartFilterPreview = null;
        renderSmartFilterConfig();
        renderSmartFilterPreview();
      });
    }
    if (dom.exportFormat) dom.exportFormat.addEventListener('change', () => { updateExportHint(); saveGlobalStateDebounced(); });
    if (dom.exportBBox) dom.exportBBox.addEventListener('change', () => { updateExportHint(); saveGlobalStateDebounced(); });
    if (dom.exportMask) dom.exportMask.addEventListener('change', () => { updateExportHint(); saveGlobalStateDebounced(); });
    if (dom.exportModal) {
      dom.exportModal.addEventListener('click', (e) => {
        if (e.target === dom.exportModal) closeExportModal();
      });
    }
    if (dom.smartFilterModal) {
      dom.smartFilterModal.addEventListener('click', (e) => {
        if (e.target === dom.smartFilterModal) closeSmartFilterModal();
      });
    }
    document.addEventListener('click', (e) => {
      if (!S.exampleMenuOpen || !dom.exampleMenuAnchor) return;
      if (dom.exampleMenuAnchor.contains(e.target)) return;
      closeExampleMenu();
    });
    dom.prevImgBtn.addEventListener('click', ()=>S.images.length && openImageByIndex(S.imageIndex-1,{ fit:false }));
    dom.nextImgBtn.addEventListener('click', ()=>S.images.length && openImageByIndex(S.imageIndex+1,{ fit:false }));
    if (dom.deleteImageBtn) dom.deleteImageBtn.addEventListener('click', deleteCurrentImage);

    dom.toolPoint.addEventListener('click', ()=>{ S.tool='point'; dom.toolPoint.classList.add('active'); dom.toolBox.classList.remove('active'); dom.toolPan.classList.remove('active'); saveProjectStateDebounced(); });
    dom.toolBox.addEventListener('click', ()=>{ S.tool='box'; dom.toolPoint.classList.remove('active'); dom.toolBox.classList.add('active'); dom.toolPan.classList.remove('active'); saveProjectStateDebounced(); });
    dom.toolPan.addEventListener('click', ()=>{ S.tool='pan'; dom.toolPoint.classList.remove('active'); dom.toolBox.classList.remove('active'); dom.toolPan.classList.add('active'); saveProjectStateDebounced(); });
    if (dom.edgeToggleLeft) dom.edgeToggleLeft.addEventListener('click', ()=>{ S.hideLeftSidebar=!S.hideLeftSidebar; applySidebarLayout({ autoFit:true }); saveProjectStateDebounced(); });
    if (dom.edgeToggleRight) dom.edgeToggleRight.addEventListener('click', ()=>{ S.hideRightSidebar=!S.hideRightSidebar; applySidebarLayout({ autoFit:true }); saveProjectStateDebounced(); });
    if (dom.themeToggleBtn) dom.themeToggleBtn.addEventListener('click', ()=>{ S.darkMode = !S.darkMode; applyTheme(); saveGlobalStateDebounced(); });
    dom.labelPos.addEventListener('click', ()=>{ S.promptLabel=1; dom.labelPos.classList.add('active'); dom.labelNeg.classList.remove('active'); });
    dom.labelNeg.addEventListener('click', ()=>{ S.promptLabel=0; dom.labelPos.classList.remove('active'); dom.labelNeg.classList.add('active'); });

    dom.undoPromptBtn.addEventListener('click', undoPrompt); dom.clearPromptBtn.addEventListener('click', clearPrompt);
    dom.showMask.addEventListener('change', ()=>{ S.showMask=!!dom.showMask.checked; requestRender(); saveProjectStateDebounced(); });
    dom.showBox.addEventListener('change', ()=>{ S.showBox=!!dom.showBox.checked; requestRender(); saveProjectStateDebounced(); });
    if (dom.examplePureVisual) dom.examplePureVisual.addEventListener('change', ()=>{ S.examplePureVisual = !!dom.examplePureVisual.checked; saveProjectStateDebounced(); });
    if (dom.autoPromptInfer) dom.autoPromptInfer.addEventListener('change', ()=>{
      S.autoPromptInfer=!!dom.autoPromptInfer.checked;
      syncAutoPromptControls();
      saveProjectStateDebounced();
    });
    if (dom.autoPromptMode) dom.autoPromptMode.addEventListener('change', ()=>{
      S.autoPromptMode = normAutoPromptMode(dom.autoPromptMode.value);
      syncAutoPromptControls();
      saveProjectStateDebounced();
    });
    if (dom.zoomOutBtn) dom.zoomOutBtn.addEventListener('click', ()=>setZoom(S.zoom*0.9));
    if (dom.zoomInBtn) dom.zoomInBtn.addEventListener('click', ()=>setZoom(S.zoom*1.1));
    if (dom.fitViewBtn) dom.fitViewBtn.addEventListener('click', fitView);
    if (dom.zoomSlider) dom.zoomSlider.addEventListener('input', ()=>setZoom(Number(dom.zoomSlider.value||100)/100));

    dom.canvas.addEventListener('mousedown', onDown); dom.canvas.addEventListener('mousemove', onMove); dom.canvas.addEventListener('mouseup', onUp);
    dom.canvas.addEventListener('mouseleave', ()=>{ if (!S.draggingPan && !S.drawingBox) { S.pointerDown=null; S.pointerMoved=false; } });
    dom.canvas.addEventListener('wheel',(e)=>{ if(!e.ctrlKey) return; e.preventDefault(); const p=canvasPos(e); setZoom(S.zoom*(e.deltaY<0?1.1:0.9),p.x,p.y); }, { passive:false });
    dom.canvas.addEventListener('contextmenu',(e)=>e.preventDefault());
    dom.canvas.addEventListener('dragstart',(e)=>e.preventDefault());
    dom.canvas.addEventListener('selectstart',(e)=>e.preventDefault());
    window.addEventListener('mousemove', (e)=>{ if (S.draggingPan || S.drawingBox || S.pointerDown) onMove(e); });
    window.addEventListener('mouseup', (e)=>{ if (S.draggingPan || S.drawingBox || S.pointerDown) onUp(e); });
    window.addEventListener('blur', ()=>{ if(S.draggingPan){S.draggingPan=false;S.panStart=null;} if(S.drawingBox){S.drawingBox=null;requestRender();} S.pointerDown=null; S.pointerMoved=false; });

    window.addEventListener('resize', ()=>{ resizeCanvas(); requestRender(); if (S.project && S.images.length) scheduleRenderImageList({ ensureVisible:true }); });
    document.addEventListener('keydown',(e)=>{
      if (e.key === 'Escape' && dom.exportModal && !dom.exportModal.classList.contains('hidden')) {
        closeExportModal();
        return;
      }
      if (e.key === 'Escape' && dom.smartFilterModal && !dom.smartFilterModal.classList.contains('hidden')) {
        closeSmartFilterModal();
        return;
      }
      if (e.key === 'Escape' && S.exampleMenuOpen) {
        closeExampleMenu();
        return;
      }
      const t=document.activeElement; const edit=t && (['INPUT','TEXTAREA','SELECT'].includes(t.tagName) || t.isContentEditable);
      if (edit) return;
      if (e.code==='Space' && !S.spacePan) { S.spacePan=true; e.preventDefault(); }
      if (S.imageEl) {
        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
          e.preventDefault();
          setZoom(S.zoom * 1.1);
          return;
        }
        if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          setZoom(S.zoom * 0.9);
          return;
        }
        if (e.key === '0' || e.code === 'Numpad0') {
          e.preventDefault();
          fitView();
          return;
        }
      }
      if (S.project && S.images.length) {
        const k = String(e.key || '').toLowerCase();
        if (k === 'a' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          openImageByIndex(S.imageIndex - 1, { fit:false });
          return;
        }
        if (k === 'd' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          openImageByIndex(S.imageIndex + 1, { fit:false });
          return;
        }
      }
      if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z') { e.preventDefault(); undoPrompt(); }
    });
    document.addEventListener('keyup',(e)=>{ if(e.code==='Space') S.spacePan=false; });

    [dom.projectName,dom.imageDir,dom.saveDir,dom.apiBaseUrl,dom.threshold,dom.batchSize,dom.exportFormat,dom.exportDir,dom.classesText].forEach((el)=>{
      el.addEventListener('change', saveGlobalStateDebounced); el.addEventListener('input', saveGlobalStateDebounced);
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== GKEY) return;
      applyGlobal(readLocal(GKEY, {}));
    });
  }

  async function bootstrap() {
    resizeCanvas(); bindEvents(); dom.showMask.checked=true; dom.showBox.checked=true; syncAutoPromptControls(); if (dom.zoomValue) dom.zoomValue.textContent='100%'; setWorkspaceLocked(false);
    applyTheme();
    applySidebarLayout();
    renderProjectMeta(); renderProjectList(); renderClassList(); renderImageList(); renderAnnList(); renderPreviewList(); requestRender();
    await loadGlobalState();
    try { await loadProjects(); } catch (e) { setStatus(`加载项目列表失败: ${e.message}`,'err'); return; }

    const queryProjectId = String(new URLSearchParams(window.location.search).get('project_id') || '').trim();
    if (!queryProjectId) {
      document.body.innerHTML = `
        <main style="padding:24px;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
          <h2 style="margin:0 0 12px;">缺少项目参数</h2>
          <p style="margin:0 0 12px;">当前地址未包含 <code>project_id</code>，请先到项目页创建/选择项目（可设置项目名）再进入标注区。</p>
          <a href="/" style="color:#111;text-decoration:underline;">返回项目页</a>
        </main>
      `;
      return;
    }

    if (!S.projects.some((p)=>p.id===queryProjectId)) {
      document.body.innerHTML = `
        <main style="padding:24px;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
          <h2 style="margin:0 0 12px;">项目不存在或已删除</h2>
          <p style="margin:0 0 12px;">未找到项目 <code>${esc(queryProjectId)}</code>，请返回项目页重新创建或选择。</p>
          <a href="/" style="color:#111;text-decoration:underline;">返回项目页</a>
        </main>
      `;
      return;
    }

    await openProjectById(queryProjectId);
    setStatus('就绪','ok');
  }

  bootstrap();
})();
