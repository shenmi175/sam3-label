(() => {
  'use strict';

  const APP_VER = '20260319.03';
  const GKEY = 'web_auto_ui_global_v1';
  console.log(`[web-auto] video_app.js version ${APP_VER}`);

  const dom = {
    projectMeta: document.getElementById('projectMeta'),
    apiBaseUrl: document.getElementById('apiBaseUrl'),
    threshold: document.getElementById('threshold'),
    imgsz: document.getElementById('imgsz'),
    segmentSize: document.getElementById('segmentSize'),
    apiHealthBtn: document.getElementById('apiHealthBtn'),
    transcodeBtn: document.getElementById('transcodeBtn'),
    promptMode: document.getElementById('promptMode'),
    activeClass: document.getElementById('activeClass'),
    promptText: document.getElementById('promptText'),
    startFrame: document.getElementById('startFrame'),
    endFrame: document.getElementById('endFrame'),
    promptFrame: document.getElementById('promptFrame'),
    startJobBtn: document.getElementById('startJobBtn'),
    stopJobBtn: document.getElementById('stopJobBtn'),
    resumeJobBtn: document.getElementById('resumeJobBtn'),
    clearBoxesBtn: document.getElementById('clearBoxesBtn'),
    backBtn: document.getElementById('backBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    status: document.getElementById('status'),
    jobSummary: document.getElementById('jobSummary'),
    jobProgressBar: document.getElementById('jobProgressBar'),
    jobDetail: document.getElementById('jobDetail'),
    frameSeekInput: document.getElementById('frameSeekInput'),
    seekFrameBtn: document.getElementById('seekFrameBtn'),
    prevFrameBtn: document.getElementById('prevFrameBtn'),
    nextFrameBtn: document.getElementById('nextFrameBtn'),
    videoMeta: document.getElementById('videoMeta'),
    promptBoxList: document.getElementById('promptBoxList'),
    annotationList: document.getElementById('annotationList'),
    videoPlayer: document.getElementById('videoPlayer'),
    videoOverlay: document.getElementById('videoOverlay')
  };

  const qs = new URLSearchParams(window.location.search);
  const projectId = String(qs.get('project_id') || '').trim();

  const S = {
    darkMode: false,
    project: null,
    job: null,
    fps: 25,
    currentFrameIndex: 0,
    promptBoxes: [],
    annotations: [],
    currentImageId: '',
    frameLoadSeq: 0,
    pollTimer: 0,
    drawing: null
  };

  function esc(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function readLocal(key, fallback = {}) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value || {}));
    } catch (_) {}
  }

  async function api(path, options = {}) {
    const opt = Object.assign({ method: 'GET' }, options || {});
    opt.headers = Object.assign({}, opt.headers || {});
    if (opt.body && !(opt.body instanceof FormData) && !opt.headers['Content-Type']) {
      opt.headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(path, opt);
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      data = null;
    }
    if (!resp.ok) {
      throw new Error(String((data && data.detail) || `HTTP ${resp.status}`));
    }
    return data || {};
  }

  function setStatus(msg, level = 'info') {
    dom.status.textContent = String(msg || '');
    dom.status.style.color = level === 'ok' ? 'var(--ok)' : (level === 'err' ? 'var(--danger)' : 'var(--muted)');
  }

  function parseClasses(text) {
    const seen = new Set();
    const out = [];
    String(text || '').split(',').forEach((raw) => {
      const item = String(raw || '').trim();
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    return out;
  }

  function clampFrame(value) {
    const total = Number(S.project?.num_frames || 0);
    const maxFrame = Math.max(total - 1, 0);
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(Math.round(n), maxFrame));
  }

  function saveGlobalState() {
    writeLocal(GKEY, Object.assign({}, readLocal(GKEY, {}), { darkMode: !!S.darkMode }));
  }

  function applyTheme() {
    document.body.classList.toggle('dark', !!S.darkMode);
    if (dom.themeToggleBtn) {
      dom.themeToggleBtn.textContent = S.darkMode ? '浅色模式' : '深色模式';
    }
  }

  function loadTheme() {
    const local = readLocal(GKEY, {});
    if (typeof local.darkMode === 'boolean') {
      S.darkMode = !!local.darkMode;
    }
    applyTheme();
  }

  function renderActiveClassOptions() {
    const classes = Array.isArray(S.project?.classes) ? S.project.classes : [];
    const current = String(dom.activeClass.value || '').trim();
    const options = classes.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    dom.activeClass.innerHTML = options || '<option value="">tracked_object</option>';
    if (current && classes.includes(current)) {
      dom.activeClass.value = current;
    } else if (classes.length) {
      dom.activeClass.value = classes[0];
    }
  }

  function syncOverlaySize() {
    const video = dom.videoPlayer;
    const canvas = dom.videoOverlay;
    const width = Math.max(1, Number(video.videoWidth || 0));
    const height = Math.max(1, Number(video.videoHeight || 0));
    canvas.width = width;
    canvas.height = height;
    redrawOverlay();
  }

  function videoNaturalSize() {
    return {
      width: Math.max(1, Number(dom.videoPlayer.videoWidth || S.project?.video_meta?.width || 1)),
      height: Math.max(1, Number(dom.videoPlayer.videoHeight || S.project?.video_meta?.height || 1))
    };
  }

  function overlayToVideoPoint(evt) {
    const rect = dom.videoOverlay.getBoundingClientRect();
    const natural = videoNaturalSize();
    const scaleX = natural.width / Math.max(rect.width, 1);
    const scaleY = natural.height / Math.max(rect.height, 1);
    const x = (evt.clientX - rect.left) * scaleX;
    const y = (evt.clientY - rect.top) * scaleY;
    return [
      Math.max(0, Math.min(natural.width, x)),
      Math.max(0, Math.min(natural.height, y))
    ];
  }

  function drawBox(ctx, box, color, dashed = false, lineWidth = 2) {
    if (!Array.isArray(box) || box.length < 4) return;
    const x1 = Number(box[0] || 0);
    const y1 = Number(box[1] || 0);
    const x2 = Number(box[2] || 0);
    const y2 = Number(box[3] || 0);
    if (!(x2 > x1 && y2 > y1)) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [10, 8] : []);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.restore();
  }

  function redrawOverlay() {
    const canvas = dom.videoOverlay;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    S.annotations.forEach((ann) => {
      drawBox(ctx, ann.bbox || ann.bbox_xyxy || [], '#0b6b2e', false, 2);
    });
    S.promptBoxes.forEach((box) => {
      drawBox(ctx, box, '#275df5', true, 2);
    });
    if (S.drawing && Array.isArray(S.drawing.box)) {
      drawBox(ctx, S.drawing.box, '#ff8a00', true, 2);
    }
  }

  function renderPromptBoxes() {
    if (!S.promptBoxes.length) {
      dom.promptBoxList.innerHTML = '<div class="item muted">当前没有提示框</div>';
      return;
    }
    dom.promptBoxList.innerHTML = S.promptBoxes.map((box, idx) => `
      <div class="item">
        <div class="grow">#${idx + 1} [${box.slice(0, 4).map((v) => Math.round(v)).join(', ')}]</div>
        <button class="cls-del" data-drop-box="${idx}" title="删除这个提示框。">删</button>
      </div>
    `).join('');
    dom.promptBoxList.querySelectorAll('[data-drop-box]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-drop-box') || -1);
        if (idx < 0) return;
        S.promptBoxes.splice(idx, 1);
        renderPromptBoxes();
        redrawOverlay();
      });
    });
  }

  function renderAnnotations() {
    if (!S.annotations.length) {
      dom.annotationList.innerHTML = '<div class="item muted">当前帧还没有标注</div>';
      return;
    }
    dom.annotationList.innerHTML = S.annotations.map((ann) => {
      const score = Number(ann.score || 0).toFixed(3);
      const label = ann.class_name || ann.label || 'object';
      const bbox = Array.isArray(ann.bbox || ann.bbox_xyxy) ? (ann.bbox || ann.bbox_xyxy) : [];
      const bboxText = bbox.length === 4 ? bbox.map((v) => Math.round(v)).join(', ') : '-';
      return `
        <div class="item">
          <div class="grow">
            <strong>${esc(label)}</strong>
            <div class="muted">score=${esc(score)} bbox=[${esc(bboxText)}]</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderVideoMeta() {
    const meta = S.project?.video_meta || {};
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    const numFrames = Number(S.project?.num_frames || 0);
    const fps = Number(meta.fps || S.fps || 25);
    dom.videoMeta.textContent = [
      `项目: ${S.project?.name || '-'}`,
      `类型: 视频项目`,
      `分辨率: ${width} x ${height}`,
      `总帧数: ${numFrames}`,
      `FPS: ${fps.toFixed(3)}`,
      `视频: ${S.project?.video_path || '-'}`
    ].join('\n');
  }

  function setCurrentFrame(frameIndex, { updateVideo = false, force = false } = {}) {
    const next = clampFrame(frameIndex);
    if (next === S.currentFrameIndex && !updateVideo && !force) return;
    S.currentFrameIndex = next;
    dom.frameSeekInput.value = String(next);
    if (!dom.promptFrame.matches(':focus')) {
      dom.promptFrame.value = String(next);
    }
    if (updateVideo && S.fps > 0) {
      dom.videoPlayer.currentTime = next / S.fps;
    }
    loadFrameAnnotations(next).catch((err) => {
      setStatus(`加载帧标注失败: ${err.message}`, 'err');
    });
  }

  async function loadFrameAnnotations(frameIndex) {
    const seq = ++S.frameLoadSeq;
    const page = await api(`/api/projects/${encodeURIComponent(projectId)}/images?offset=${clampFrame(frameIndex)}&limit=1`);
    const items = Array.isArray(page.items) ? page.items : [];
    const item = items[0] || null;
    if (!item) {
      if (seq === S.frameLoadSeq) {
        S.currentImageId = '';
        S.annotations = [];
        renderAnnotations();
        redrawOverlay();
      }
      return;
    }
    const annResp = await api(`/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(item.id)}/annotations`);
    if (seq !== S.frameLoadSeq) return;
    S.currentImageId = String(item.id || '');
    S.annotations = Array.isArray(annResp.annotations) ? annResp.annotations : [];
    renderAnnotations();
    redrawOverlay();
  }

  function renderJob(job) {
    S.job = job || null;
    if (!job) {
      dom.jobSummary.textContent = '尚未启动';
      dom.jobDetail.textContent = '';
      dom.jobProgressBar.style.width = '0%';
      if (dom.stopJobBtn) dom.stopJobBtn.disabled = true;
      if (dom.resumeJobBtn) dom.resumeJobBtn.disabled = true;
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(job.progress_pct || 0)));
    const status = String(job.status || 'idle');
    const nextFrame = Number(job.next_frame_index || 0);
    const currentFrame = Number(job.current_frame_index || -1);
    dom.jobSummary.textContent = `${status} | ${pct.toFixed(1)}% | 当前帧 ${currentFrame >= 0 ? currentFrame : '-'} | 下一帧 ${nextFrame}`;
    dom.jobDetail.textContent = [
      `prompt=${job.prompt_mode || '-'} threshold=${job.threshold ?? '-'}`,
      `imgsz=${job.imgsz ?? '-'} segment=${job.segment_size_frames ?? '-'}`,
      `range=[${job.start_frame_index ?? '-'}, ${job.end_frame_index ?? '-'}]`,
      job.last_error ? `error=${job.last_error}` : ''
    ].filter(Boolean).join(' | ');
    dom.jobProgressBar.style.width = `${pct}%`;
    if (dom.stopJobBtn) dom.stopJobBtn.disabled = !(status === 'queued' || status === 'running');
    if (dom.resumeJobBtn) dom.resumeJobBtn.disabled = !(status === 'paused');
  }

  async function refreshJob() {
    const resp = await api(`/api/video/jobs/${encodeURIComponent(projectId)}`);
    const job = resp.job || null;
    renderJob(job);
    if (job && Number(job.current_frame_index) >= 0) {
      setCurrentFrame(Number(job.current_frame_index), { updateVideo: true });
    }
  }

  function startPolling() {
    stopPolling();
    S.pollTimer = window.setInterval(() => {
      refreshJob().catch((err) => {
        setStatus(`刷新任务状态失败: ${err.message}`, 'err');
      });
    }, 1500);
  }

  function stopPolling() {
    if (S.pollTimer) {
      window.clearInterval(S.pollTimer);
      S.pollTimer = 0;
    }
  }

  async function loadProject() {
    const resp = await api(`/api/projects/${encodeURIComponent(projectId)}?include_images=false`);
    const project = resp.project || null;
    if (!project) throw new Error('project not found');
    if (String(project.project_type || 'image') !== 'video') {
      throw new Error('当前项目不是视频项目');
    }
    S.project = project;
    S.fps = Number(project.video_meta?.fps || 25) || 25;
    dom.projectMeta.textContent = `${project.name} | ${project.video_name || 'video'} | ${project.num_frames || 0} 帧`;
    dom.startFrame.value = '0';
    dom.endFrame.value = String(Math.max(Number(project.num_frames || 1) - 1, 0));
    dom.promptFrame.value = '0';
    dom.frameSeekInput.value = '0';
    renderActiveClassOptions();
    dom.promptText.value = Array.isArray(project.classes) ? project.classes.join(', ') : '';
    renderVideoMeta();
    dom.videoPlayer.src = `/api/projects/${encodeURIComponent(projectId)}/video/file?t=${Date.now()}`;
    dom.videoPlayer.load();
  }

  function togglePromptMode() {
    const isBoxes = String(dom.promptMode.value || 'text') === 'boxes';
    dom.promptText.closest('.video-prompt-text-field')?.classList.toggle('muted', isBoxes);
  }

  function collectStartPayload() {
    const promptMode = String(dom.promptMode.value || 'text');
    const startFrame = clampFrame(dom.startFrame.value);
    const endFrame = clampFrame(dom.endFrame.value);
    const promptFrame = clampFrame(dom.promptFrame.value);
    const threshold = Number(dom.threshold.value || 0.5);
    const imgsz = Math.max(128, Number(dom.imgsz.value || 640));
    const segmentSize = Math.max(1, Number(dom.segmentSize.value || 300));
    const promptText = String(dom.promptText.value || '').trim();
    const activeClass = String(dom.activeClass.value || '').trim();

    const body = {
      project_id: projectId,
      classes: [],
      mode: 'keyframe',
      start_frame_index: startFrame,
      end_frame_index: endFrame,
      segment_size_frames: segmentSize,
      threshold,
      imgsz,
      api_base_url: String(dom.apiBaseUrl.value || '').trim(),
      prompt_mode: promptMode,
      prompt_frame_index: promptFrame,
      active_class: '',
      points: [],
      boxes: []
    };

    if (promptMode === 'text') {
      const classes = parseClasses(promptText || (Array.isArray(S.project?.classes) ? S.project.classes.join(', ') : ''));
      if (!classes.length) {
        throw new Error('文本模式下至少需要一个 Prompt');
      }
      body.classes = classes;
    } else {
      if (!S.promptBoxes.length) {
        throw new Error('框模式下请先在视频上画至少一个提示框');
      }
      const label = activeClass || (Array.isArray(S.project?.classes) && S.project.classes[0]) || 'tracked_object';
      body.classes = [label];
      body.active_class = label;
      body.boxes = S.promptBoxes.map((box) => [box[0], box[1], box[2], box[3], 1]);
    }
    return body;
  }

  function collectResumePayload() {
    const job = S.job || {};
    const promptMode = String(dom.promptMode.value || job.prompt_mode || 'text');
    const body = {
      project_id: projectId,
      threshold: Number(dom.threshold.value || job.threshold || 0.5),
      imgsz: Math.max(128, Number(dom.imgsz.value || job.imgsz || 640)),
      segment_size_frames: Math.max(1, Number(dom.segmentSize.value || job.segment_size_frames || 300)),
      api_base_url: String(dom.apiBaseUrl.value || job.api_base_url || '').trim(),
      prompt_mode: promptMode,
      prompt_frame_index: clampFrame(dom.promptFrame.value || job.prompt_frame_index || 0)
    };

    if (promptMode === 'text') {
      const classes = parseClasses(dom.promptText.value || (Array.isArray(S.project?.classes) ? S.project.classes.join(', ') : ''));
      if (classes.length) body.classes = classes;
    } else {
      const label = String(dom.activeClass.value || job.active_class || '').trim();
      if (label) {
        body.active_class = label;
        body.classes = [label];
      }
      if (Array.isArray(S.promptBoxes) && S.promptBoxes.length) {
        body.boxes = S.promptBoxes.map((box) => [box[0], box[1], box[2], box[3], 1]);
      }
    }
    return body;
  }

  async function startJob() {
    const payload = collectStartPayload();
    setStatus('正在启动视频跟踪任务...');
    const resp = await api('/api/video/jobs/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    renderJob(resp.job || null);
    startPolling();
    setStatus('视频跟踪任务已启动', 'ok');
  }

  async function stopJob() {
    const resp = await api('/api/video/jobs/stop', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId })
    });
    renderJob(resp.job || null);
    setStatus('已发送停止请求，当前传播批次结束后会尽快中断', 'ok');
  }

  async function resumeJob() {
    const resp = await api('/api/video/jobs/resume', {
      method: 'POST',
      body: JSON.stringify(collectResumePayload())
    });
    renderJob(resp.job || null);
    startPolling();
    setStatus('任务继续运行', 'ok');
  }

  async function transcodeVideo() {
    setStatus('正在转码视频...');
    await api(`/api/projects/${encodeURIComponent(projectId)}/video/transcode_h264`, { method: 'POST' });
    dom.videoPlayer.src = `/api/projects/${encodeURIComponent(projectId)}/video/file?t=${Date.now()}`;
    dom.videoPlayer.load();
    setStatus('视频已转码为 H.264', 'ok');
  }

  async function healthCheck() {
    setStatus('正在检查 API...');
    const resp = await api('/api/sam3/health', {
      method: 'POST',
      body: JSON.stringify({ api_base_url: String(dom.apiBaseUrl.value || '').trim() })
    });
    const device = resp.result?.device || '-';
    const videoLoaded = resp.result?.video_model_loaded;
    setStatus(`API 正常 | device=${device} | video_model_loaded=${videoLoaded}`, 'ok');
  }

  function clearBoxes() {
    S.promptBoxes = [];
    renderPromptBoxes();
    redrawOverlay();
  }

  function onOverlayMouseDown(evt) {
    if (String(dom.promptMode.value || 'text') !== 'boxes') return;
    const [x, y] = overlayToVideoPoint(evt);
    S.drawing = { startX: x, startY: y, box: [x, y, x, y, 1] };
    redrawOverlay();
  }

  function onOverlayMouseMove(evt) {
    if (!S.drawing) return;
    const [x, y] = overlayToVideoPoint(evt);
    S.drawing.box = [
      Math.min(S.drawing.startX, x),
      Math.min(S.drawing.startY, y),
      Math.max(S.drawing.startX, x),
      Math.max(S.drawing.startY, y),
      1
    ];
    redrawOverlay();
  }

  function onOverlayMouseUp(evt) {
    if (!S.drawing) return;
    onOverlayMouseMove(evt);
    const box = S.drawing.box;
    S.drawing = null;
    if (box[2] - box[0] >= 2 && box[3] - box[1] >= 2) {
      S.promptBoxes.push(box);
      renderPromptBoxes();
    }
    redrawOverlay();
  }

  function bind() {
    dom.backBtn?.addEventListener('click', () => {
      window.location.href = '/';
    });
    dom.themeToggleBtn?.addEventListener('click', () => {
      S.darkMode = !S.darkMode;
      applyTheme();
      saveGlobalState();
    });
    dom.apiHealthBtn?.addEventListener('click', () => {
      healthCheck().catch((err) => setStatus(`API 检查失败: ${err.message}`, 'err'));
    });
    dom.transcodeBtn?.addEventListener('click', () => {
      transcodeVideo().catch((err) => setStatus(`转码失败: ${err.message}`, 'err'));
    });
    dom.startJobBtn?.addEventListener('click', () => {
      startJob().catch((err) => setStatus(`启动失败: ${err.message}`, 'err'));
    });
    dom.stopJobBtn?.addEventListener('click', () => {
      stopJob().catch((err) => setStatus(`停止失败: ${err.message}`, 'err'));
    });
    dom.resumeJobBtn?.addEventListener('click', () => {
      resumeJob().catch((err) => setStatus(`继续失败: ${err.message}`, 'err'));
    });
    dom.clearBoxesBtn?.addEventListener('click', clearBoxes);
    dom.promptMode?.addEventListener('change', togglePromptMode);
    dom.seekFrameBtn?.addEventListener('click', () => {
      setCurrentFrame(dom.frameSeekInput.value, { updateVideo: true });
    });
    dom.prevFrameBtn?.addEventListener('click', () => {
      setCurrentFrame(S.currentFrameIndex - 1, { updateVideo: true });
    });
    dom.nextFrameBtn?.addEventListener('click', () => {
      setCurrentFrame(S.currentFrameIndex + 1, { updateVideo: true });
    });
    dom.videoPlayer?.addEventListener('loadedmetadata', () => {
      syncOverlaySize();
      setCurrentFrame(0, { force: true });
    });
    dom.videoPlayer?.addEventListener('timeupdate', () => {
      if (S.fps <= 0) return;
      const frameIndex = Math.round(Number(dom.videoPlayer.currentTime || 0) * S.fps);
      if (frameIndex !== S.currentFrameIndex) {
        setCurrentFrame(frameIndex);
      }
    });
    window.addEventListener('resize', syncOverlaySize);
    dom.videoOverlay?.addEventListener('mousedown', onOverlayMouseDown);
    dom.videoOverlay?.addEventListener('mousemove', onOverlayMouseMove);
    dom.videoOverlay?.addEventListener('mouseup', onOverlayMouseUp);
    dom.videoOverlay?.addEventListener('mouseleave', onOverlayMouseUp);
  }

  async function bootstrap() {
    if (!projectId) {
      setStatus('缺少 project_id', 'err');
      return;
    }
    loadTheme();
    bind();
    togglePromptMode();
    try {
      await loadProject();
      await refreshJob();
      startPolling();
      renderPromptBoxes();
      renderAnnotations();
      setStatus('就绪', 'ok');
    } catch (err) {
      setStatus(`加载失败: ${err.message}`, 'err');
    }
  }

  bootstrap();
})();
