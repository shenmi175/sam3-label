(() => {
  'use strict';
  const APP_VER = '20260319.02';
  console.log(`[web-auto] projects.js version ${APP_VER}`);
  const GKEY = 'web_auto_ui_global_v1';

  const dom = {
    projectName: document.getElementById('projectName'),
    projectType: document.getElementById('projectType'),
    imageDirWrap: document.getElementById('imageDirWrap'),
    imageDir: document.getElementById('imageDir'),
    videoPathWrap: document.getElementById('videoPathWrap'),
    videoPath: document.getElementById('videoPath'),
    saveDir: document.getElementById('saveDir'),
    classesText: document.getElementById('classesText'),
    createProjectBtn: document.getElementById('createProjectBtn'),
    refreshProjectsBtn: document.getElementById('refreshProjectsBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    status: document.getElementById('status'),
    projectCards: document.getElementById('projectCards'),
    uploadModal: document.getElementById('uploadModal'),
    uploadProjectMeta: document.getElementById('uploadProjectMeta'),
    uploadDropzone: document.getElementById('uploadDropzone'),
    uploadPickBtn: document.getElementById('uploadPickBtn'),
    uploadFileInput: document.getElementById('uploadFileInput'),
    uploadQueueHint: document.getElementById('uploadQueueHint'),
    uploadList: document.getElementById('uploadList'),
    uploadConfirmBtn: document.getElementById('uploadConfirmBtn'),
    uploadCancelBtn: document.getElementById('uploadCancelBtn')
  };

  const S = {
    darkMode: false,
    uploadProjectId: '',
    uploadProjectName: '',
    uploadProjectDir: '',
    uploadItems: []
  };

  const ALLOWED_UPLOAD_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tiff']);

  function esc(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function projectTypeValue() {
    return String(dom.projectType?.value || 'image').trim().toLowerCase() === 'video' ? 'video' : 'image';
  }

  function setStatus(msg, level = 'info') {
    dom.status.textContent = String(msg || '');
    dom.status.style.color = level === 'ok' ? 'var(--ok)' : (level === 'err' ? 'var(--danger)' : 'var(--muted)');
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

  async function saveGlobalState() {
    const payload = { darkMode: !!S.darkMode };
    writeLocal(GKEY, Object.assign({}, readLocal(GKEY, {}), payload));
    try {
      await api('/api/ui_state', { method: 'POST', body: JSON.stringify({ state: payload }) });
    } catch (_) {}
  }

  function applyTheme() {
    document.body.classList.toggle('dark', !!S.darkMode);
    if (dom.themeToggleBtn) {
      dom.themeToggleBtn.textContent = S.darkMode ? '浅色模式' : '深色模式';
    }
  }

  function applyGlobalState(obj = {}) {
    if (typeof obj.darkMode === 'boolean') {
      S.darkMode = !!obj.darkMode;
    }
    applyTheme();
  }

  async function loadGlobalState() {
    const local = readLocal(GKEY, {});
    applyGlobalState(local);
    try {
      const remote = (await api('/api/ui_state')).state || {};
      const merged = Object.assign({}, remote, local);
      applyGlobalState(merged);
      writeLocal(GKEY, merged);
    } catch (_) {}
  }

  function toggleProjectInputs() {
    const isVideo = projectTypeValue() === 'video';
    dom.imageDirWrap?.classList.toggle('hidden', isVideo);
    dom.videoPathWrap?.classList.toggle('hidden', !isVideo);
  }

  function setBusy(busy) {
    const v = !!busy;
    dom.createProjectBtn.disabled = v;
    dom.refreshProjectsBtn.disabled = v;
    dom.projectCards.querySelectorAll('button').forEach((btn) => {
      btn.disabled = v;
    });
    if (dom.uploadCancelBtn) dom.uploadCancelBtn.disabled = v;
    if (dom.uploadConfirmBtn) dom.uploadConfirmBtn.disabled = v || !S.uploadItems.length;
    if (dom.uploadDropzone) {
      dom.uploadDropzone.style.pointerEvents = v ? 'none' : 'auto';
      dom.uploadDropzone.setAttribute('aria-disabled', v ? 'true' : 'false');
    }
  }

  function updateUploadConfirmState() {
    if (!dom.uploadConfirmBtn) return;
    dom.uploadConfirmBtn.disabled = !S.uploadItems.length;
  }

  function gotoAnnotate(project) {
    const pid = encodeURIComponent(project.id);
    const page = String(project.project_type || 'image') === 'video' ? '/video-annotate' : '/annotate';
    window.location.href = `${page}?project_id=${pid}`;
  }

  function fmtSize(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderUploadList() {
    if (!dom.uploadList) return;
    if (!S.uploadItems.length) {
      dom.uploadList.innerHTML = '<div class="item muted">尚未选择文件</div>';
      updateUploadConfirmState();
      return;
    }
    dom.uploadList.innerHTML = S.uploadItems.map((item) => `
      <div class="item">
        <div class="upload-file-meta grow">
          <div class="upload-file-name">${esc(item.name || '')}</div>
          <div class="upload-file-status">${esc(item.status || '')}</div>
        </div>
        <span class="tag">${esc(fmtSize(item.size || 0))}</span>
      </div>
    `).join('');
    updateUploadConfirmState();
  }

  function videoPreviewCard(project) {
    const frameCount = Number(project.num_frames || 0);
    const size = project.video_name ? `${esc(project.video_name)}` : 'Video';
    return `
      <div class="project-preview-video">
        <div class="project-preview-video-tag">VIDEO</div>
        <div class="project-preview-video-title">${size}</div>
        <div class="project-preview-video-meta">${frameCount} 帧</div>
      </div>
    `;
  }

  function renderProjects(projects) {
    if (!projects.length) {
      dom.projectCards.innerHTML = '<div class="project-empty">暂无项目，请先创建项目。</div>';
      return;
    }

    dom.projectCards.innerHTML = projects.map((p) => {
      const isVideo = String(p.project_type || 'image') === 'video';
      const total = Number(isVideo ? (p.num_frames || p.num_images || 0) : (p.num_images || 0));
      const labeled = Number(p.labeled_images || 0);
      const progress = total > 0 ? Math.round((labeled * 100) / total) : 0;
      const ratio = `${labeled} / ${total}`;
      const preview = !isVideo && p.first_image_id
        ? `/api/projects/${encodeURIComponent(p.id)}/images/${encodeURIComponent(p.first_image_id)}/file?t=${Date.now()}`
        : '';
      const typeLabel = isVideo ? '视频项目' : '图片项目';
      const source = isVideo ? (p.video_path || '-') : (p.image_dir || '-');

      return `
        <article class="project-card" data-project-id="${esc(p.id)}">
          <div class="project-preview-wrap">
            ${
              preview
                ? `<img class="project-preview" src="${preview}" alt="preview" loading="lazy" />`
                : (isVideo ? videoPreviewCard(p) : '<div class="project-preview-empty">无预览</div>')
            }
          </div>
          <div class="project-body">
            <div class="project-title">${esc(p.name)}</div>
            <div class="project-line">类型: ${esc(typeLabel)}</div>
            <div class="project-line">来源: ${esc(source)}</div>
            <div class="project-line">进度: <span class="ok-text">${esc(ratio)}</span> (${progress}%)</div>
            <div class="project-line">首图/首帧: ${esc(p.first_image_rel_path || '-')}</div>
            <div class="project-actions">
              <button class="enter-btn" data-enter="${esc(p.id)}" title="打开这个项目进入标注工作区。">进入标注</button>
              ${
                isVideo
                  ? ''
                  : `<button class="refresh-data-btn" data-refresh-images="${esc(p.id)}" title="给当前项目追加新图片，保存到项目图片目录。">新增数据</button>`
              }
              <button class="delete-btn" data-delete="${esc(p.id)}" title="删除项目记录、状态与标注，不删除原始源数据。">删除项目</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    dom.projectCards.querySelectorAll('[data-enter]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = String(el.getAttribute('data-enter') || '');
        const p = projects.find((x) => x.id === id);
        if (p) gotoAnnotate(p);
      });
    });

    dom.projectCards.querySelectorAll('[data-delete]').forEach((el) => {
      el.addEventListener('click', async () => {
        const id = String(el.getAttribute('data-delete') || '');
        if (!id) return;
        const ok = window.confirm(`确认删除项目 ${id}？\n将删除该项目标注、状态和缓存，不会删除原始源数据。`);
        if (!ok) return;
        setBusy(true);
        try {
          await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await refreshProjects();
          setStatus('项目已删除', 'ok');
        } catch (err) {
          setStatus(`删除失败: ${err.message}`, 'err');
        } finally {
          setBusy(false);
        }
      });
    });

    dom.projectCards.querySelectorAll('[data-refresh-images]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = String(el.getAttribute('data-refresh-images') || '');
        if (!id) return;
        const p = projects.find((x) => x.id === id);
        if (!p || String(p.project_type || 'image') !== 'image') return;
        openUploadModal(p);
      });
    });
  }

  function openUploadModal(project) {
    S.uploadProjectId = String(project.id || '');
    S.uploadProjectName = String(project.name || '');
    S.uploadProjectDir = String(project.image_dir || '');
    S.uploadItems = [];
    if (dom.uploadProjectMeta) {
      dom.uploadProjectMeta.textContent = `项目: ${S.uploadProjectName}\n保存目录: ${S.uploadProjectDir}`;
    }
    if (dom.uploadQueueHint) {
      dom.uploadQueueHint.textContent = '支持 JPG / PNG / BMP / WEBP / TIFF。可以多次选择或拖拽，确认后才会真正写入项目。';
    }
    if (dom.uploadFileInput) {
      dom.uploadFileInput.value = '';
    }
    renderUploadList();
    dom.uploadModal?.classList.remove('hidden');
  }

  function closeUploadModal() {
    S.uploadProjectId = '';
    S.uploadProjectName = '';
    S.uploadProjectDir = '';
    S.uploadItems = [];
    dom.uploadModal?.classList.add('hidden');
    if (dom.uploadFileInput) {
      dom.uploadFileInput.value = '';
    }
    renderUploadList();
  }

  function queueUploadFiles(filesLike) {
    const rawFiles = Array.from(filesLike || []).filter((f) => f);
    const files = rawFiles.filter((f) => {
      if (!f || !f.name) return false;
      const idx = String(f.name).lastIndexOf('.');
      const ext = idx >= 0 ? String(f.name).slice(idx).toLowerCase() : '';
      return ALLOWED_UPLOAD_EXT.has(ext);
    });
    if (!S.uploadProjectId) {
      setStatus('当前未选择项目', 'err');
      return;
    }
    if (!files.length) {
      setStatus(rawFiles.length ? '未检测到支持的图片文件' : '未选择图片文件', 'err');
      return;
    }

    const seen = new Set(S.uploadItems.map((item) => `${item.name}::${item.size || 0}::${item.lastModified || 0}`));
    let added = 0;
    files.forEach((file) => {
      const next = {
        name: String(file.name || ''),
        size: Number(file.size || 0),
        lastModified: Number(file.lastModified || 0),
        status: '待确认',
        file
      };
      const key = `${next.name}::${next.size}::${next.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      S.uploadItems.push(next);
      added += 1;
    });
    renderUploadList();
    if (dom.uploadQueueHint) {
      dom.uploadQueueHint.textContent = added > 0
        ? `已加入待上传列表: 新增 ${added} 个文件，当前共 ${S.uploadItems.length} 个，确认后才会真正写入项目。`
        : `待上传列表未变化: 当前共 ${S.uploadItems.length} 个文件。`;
    }
    setStatus(added > 0 ? `已加入待上传列表 ${added} 个文件` : '选择的文件已在待上传列表中', added > 0 ? 'ok' : 'info');
  }

  async function submitUploadQueue() {
    if (!S.uploadProjectId) {
      setStatus('当前未选择项目', 'err');
      return;
    }
    if (!S.uploadItems.length) {
      setStatus('请先选择要添加的图片', 'err');
      return;
    }

    const body = new FormData();
    S.uploadItems.forEach((item) => {
      if (item && item.file) {
        body.append('files', item.file, item.name || item.file.name || 'upload.bin');
      }
    });

    setBusy(true);
    try {
      S.uploadItems = S.uploadItems.map((item) => ({ ...item, status: '上传中...' }));
      renderUploadList();
      if (dom.uploadQueueHint) {
        dom.uploadQueueHint.textContent = `正在上传 ${S.uploadItems.length} 个文件到当前项目目录...`;
      }
      setStatus(`正在上传 ${S.uploadItems.length} 个文件...`);
      const resp = await api(`/api/projects/${encodeURIComponent(S.uploadProjectId)}/images/upload`, {
        method: 'POST',
        body
      });
      await refreshProjects();
      const saved = Number(resp.saved_files || 0);
      const added = Number(resp.added_images || 0);
      S.uploadItems = S.uploadItems.map((item) => ({ ...item, status: '上传完成' }));
      renderUploadList();
      if (dom.uploadQueueHint) {
        dom.uploadQueueHint.textContent = `上传完成: 保存 ${saved} 个文件, 追加 ${added} 张图片`;
      }
      setStatus(`新增数据完成: 保存 ${saved} 个文件, 追加 ${added} 张图片`, 'ok');
      window.setTimeout(closeUploadModal, 500);
    } catch (err) {
      const uploadMsg = String((err && err.message) || '未知错误');
      S.uploadItems = S.uploadItems.map((item) => ({ ...item, status: `上传失败: ${uploadMsg}` }));
      renderUploadList();
      if (dom.uploadQueueHint) {
        dom.uploadQueueHint.textContent = `上传失败: ${uploadMsg}`;
      }
      setStatus(`新增数据失败: ${uploadMsg}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function refreshProjects() {
    const data = await api('/api/projects');
    renderProjects(Array.isArray(data.projects) ? data.projects : []);
  }

  async function createProject() {
    const type = projectTypeValue();
    const imageDir = String(dom.imageDir?.value || '').trim();
    const videoPath = String(dom.videoPath?.value || '').trim();
    if (type === 'image' && !imageDir) {
      setStatus('请填写图片目录', 'err');
      return;
    }
    if (type === 'video' && !videoPath) {
      setStatus('请填写视频路径', 'err');
      return;
    }

    const body = {
      name: String(dom.projectName?.value || '').trim(),
      project_type: type,
      image_dir: type === 'image' ? imageDir : '',
      video_path: type === 'video' ? videoPath : '',
      save_dir: String(dom.saveDir?.value || '').trim() || null,
      classes_text: String(dom.classesText?.value || '').trim()
    };

    setBusy(true);
    try {
      setStatus('正在创建项目...');
      const data = await api('/api/projects/open', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      setStatus('项目创建成功，正在进入工作区...', 'ok');
      gotoAnnotate(data.project);
    } catch (err) {
      setStatus(`创建失败: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    dom.projectType?.addEventListener('change', toggleProjectInputs);
    dom.themeToggleBtn?.addEventListener('click', async () => {
      S.darkMode = !S.darkMode;
      applyTheme();
      await saveGlobalState();
    });
    dom.createProjectBtn?.addEventListener('click', createProject);
    dom.refreshProjectsBtn?.addEventListener('click', async () => {
      setBusy(true);
      try {
        await refreshProjects();
        setStatus('项目列表已刷新', 'ok');
      } catch (err) {
        setStatus(`刷新失败: ${err.message}`, 'err');
      } finally {
        setBusy(false);
      }
    });
    dom.uploadDropzone?.addEventListener('click', () => {
      dom.uploadFileInput?.click();
    });
    dom.uploadDropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.uploadDropzone.classList.add('dragover');
    });
    dom.uploadDropzone?.addEventListener('dragleave', () => {
      dom.uploadDropzone.classList.remove('dragover');
    });
    dom.uploadDropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.uploadDropzone.classList.remove('dragover');
      if (e.dataTransfer?.files?.length) {
        queueUploadFiles(e.dataTransfer.files);
      }
    });
    dom.uploadPickBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.uploadFileInput?.click();
    });
    dom.uploadFileInput?.addEventListener('change', () => {
      if (dom.uploadFileInput?.files?.length) {
        queueUploadFiles(dom.uploadFileInput.files);
      }
    });
    dom.uploadConfirmBtn?.addEventListener('click', submitUploadQueue);
    dom.uploadCancelBtn?.addEventListener('click', closeUploadModal);
    dom.uploadModal?.addEventListener('click', (e) => {
      if (e.target === dom.uploadModal) closeUploadModal();
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== GKEY) return;
      applyGlobalState(readLocal(GKEY, {}));
    });
  }

  async function bootstrap() {
    applyTheme();
    toggleProjectInputs();
    bind();
    setBusy(true);
    try {
      await loadGlobalState();
      await refreshProjects();
      setStatus('就绪', 'ok');
    } catch (err) {
      setStatus(`加载项目失败: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  bootstrap();
})();
