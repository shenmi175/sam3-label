import { api } from '../api.js';
import { router } from '../router.js';

export const PoseWorkspace = {
  projectId: '',
  project: null,
  images: [],
  total: 0,
  selectedImageId: '',
  selectedImageIndex: -1,
  annotations: [],
  selectedAnnotationId: '',
  naturalWidth: 1,
  naturalHeight: 1,
  dragging: null,
  keyHandler: null,
  container: null,

  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    this.project = null;
    this.images = [];
    this.total = 0;
    this.selectedImageId = '';
    this.selectedImageIndex = -1;
    this.annotations = [];
    this.selectedAnnotationId = '';
    this.naturalWidth = 1;
    this.naturalHeight = 1;
    this.dragging = null;
    window.poseWorkspace = this;

    container.innerHTML = `
      <div class="app-container" style="height:100vh; overflow:hidden; display:grid; grid-template-rows:auto 1fr;">
        <div style="height:56px; padding:0 18px; display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid rgba(255,255,255,0.04); background:var(--neu-bg);">
          <div style="display:flex; align-items:center; gap:12px; min-width:0;">
            <button id="pose-back" class="neu-button" style="width:32px; height:32px; padding:0;">←</button>
            <div style="min-width:0;">
              <div id="pose-title" style="font-size:16px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">姿态估计标注</div>
              <div id="pose-subtitle" style="font-size:11px; color:var(--neu-text-light); margin-top:2px;">加载中...</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
            <button id="pose-prev" class="neu-button" style="padding:7px 12px;">上一张</button>
            <button id="pose-next" class="neu-button" style="padding:7px 12px;">下一张</button>
            <button id="pose-run" class="neu-button" style="padding:7px 14px; color:var(--neu-text-active); font-weight:800;">姿态估计</button>
            <button id="pose-save" class="neu-button" style="padding:7px 14px;">保存</button>
          </div>
        </div>
        <div style="min-height:0; display:grid; grid-template-columns:280px minmax(0,1fr) 320px; gap:14px; padding:14px;">
          <aside class="neu-card" style="padding:14px; min-height:0; display:grid; grid-template-rows:auto 1fr; gap:12px;">
            <div>
              <div style="font-weight:800; font-size:15px;">图片列表</div>
              <div id="pose-image-count" style="font-size:12px; color:var(--neu-text-light); margin-top:4px;">0 张</div>
            </div>
            <div id="pose-image-list" style="min-height:0; overflow:auto; display:grid; gap:8px; align-content:start;"></div>
          </aside>
          <main class="neu-card" style="padding:0; min-height:0; overflow:hidden; position:relative;">
            <div id="pose-canvas-wrap" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.16); overflow:hidden;">
              <div id="pose-stage" style="position:relative; max-width:100%; max-height:100%; line-height:0;">
                <img id="pose-image" alt="" style="display:block; max-width:100%; max-height:calc(100vh - 92px); user-select:none;" />
                <svg id="pose-overlay" style="position:absolute; inset:0; width:100%; height:100%; overflow:visible; touch-action:none;"></svg>
              </div>
            </div>
          </main>
          <aside class="neu-card" style="padding:14px; min-height:0; display:grid; grid-template-rows:auto auto 1fr; gap:14px;">
            <div>
              <div style="font-weight:800; font-size:15px;">姿态标注</div>
              <div id="pose-status" style="font-size:12px; color:var(--neu-text-light); margin-top:4px;">等待选择图片</div>
            </div>
            <div class="neu-box" style="padding:12px; display:grid; gap:10px; box-shadow:var(--neu-inset);">
              <label style="font-size:12px; color:var(--neu-text-light); display:grid; gap:6px;">
                人体检测阈值
                <input id="pose-bbox-thr" class="neu-input" type="number" min="0" max="1" step="0.05" value="0.3" />
              </label>
              <label style="font-size:12px; color:var(--neu-text-light); display:grid; gap:6px;">
                关键点显示阈值
                <input id="pose-kpt-thr" class="neu-input" type="number" min="0" max="1" step="0.05" value="0.3" />
              </label>
              <button id="pose-clear" class="neu-button" style="padding:7px 10px; color:#ef4444;">清空当前图标注</button>
            </div>
            <div id="pose-ann-list" style="min-height:0; overflow:auto; display:grid; gap:8px; align-content:start;"></div>
          </aside>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.loadProject();
  },

  unmount() {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    window.poseWorkspace = null;
    this.container = null;
  },

  bindEvents() {
    document.getElementById('pose-back').onclick = () => router.navigate('/');
    document.getElementById('pose-prev').onclick = () => this.selectByOffset(-1);
    document.getElementById('pose-next').onclick = () => this.selectByOffset(1);
    document.getElementById('pose-run').onclick = () => this.runPose();
    document.getElementById('pose-save').onclick = () => this.saveAnnotations();
    document.getElementById('pose-clear').onclick = () => this.clearAnnotations();
    document.getElementById('pose-kpt-thr').oninput = () => this.renderOverlay();
    const img = document.getElementById('pose-image');
    img.onload = () => {
      this.naturalWidth = img.naturalWidth || 1;
      this.naturalHeight = img.naturalHeight || 1;
      this.renderOverlay();
    };
    this.keyHandler = (event) => {
      if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      if (event.key === 'ArrowLeft') this.selectByOffset(-1);
      if (event.key === 'ArrowRight') this.selectByOffset(1);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.saveAnnotations();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  },

  async loadProject() {
    try {
      const data = await api.getProject(this.projectId, false);
      this.project = data.project || {};
      if ((this.project.project_type || 'image') !== 'pose') {
        showToast('该项目不是姿态估计项目', 'error');
        router.navigate('/');
        return;
      }
      document.getElementById('pose-title').textContent = this.project.name || this.projectId;
      document.getElementById('pose-subtitle').textContent = '姿态估计 · 图片项目';
      await this.loadImages();
      const first = this.images[0];
      if (first) await this.selectImage(first.id);
    } catch(e) {
      showToast(e.message, 'error');
    }
  },

  async loadImages(targetImageId = '') {
    const limit = 1000;
    let offset = 0;
    let total = 0;
    const items = [];
    do {
      const data = await api.getImages(this.projectId, offset, limit, targetImageId ? { imageId: targetImageId } : {});
      const pageItems = data.items || [];
      items.push(...pageItems);
      total = Number(data.total || items.length || 0);
      offset += pageItems.length;
      if (!pageItems.length) break;
    } while (offset < total);
    this.images = items;
    this.total = total || this.images.length;
    document.getElementById('pose-image-count').textContent = `${this.total} 张`;
    this.renderImageList();
  },

  renderImageList() {
    const list = document.getElementById('pose-image-list');
    if (!list) return;
    if (!this.images.length) {
      list.innerHTML = `<div style="font-size:13px; color:var(--neu-text-light); padding:14px;">没有图片</div>`;
      return;
    }
    list.innerHTML = this.images.map((img, index) => {
      const selected = img.id === this.selectedImageId;
      const status = img.status === 'labeled' ? '已标注' : '待标注';
      return `
        <button class="neu-button" onclick="window.poseWorkspace.selectImage('${this.jsString(img.id)}')" style="padding:10px 12px; display:grid; gap:4px; text-align:left; box-shadow:${selected ? 'var(--neu-inset)' : 'var(--neu-outset)'};">
          <span style="font-size:13px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${index + 1}. ${this.escapeHtml(img.rel_path || img.id)}</span>
          <span style="font-size:11px; color:${img.status === 'labeled' ? '#10b981' : 'var(--neu-text-light)'};">${status}</span>
        </button>
      `;
    }).join('');
  },

  async selectImage(imageId) {
    const image = this.images.find((item) => item.id === imageId);
    if (!image) return;
    this.selectedImageId = imageId;
    this.selectedImageIndex = this.images.findIndex((item) => item.id === imageId);
    this.selectedAnnotationId = '';
    this.annotations = [];
    this.renderImageList();
    this.setStatus('加载图片和标注...');
    const img = document.getElementById('pose-image');
    img.src = `/api/projects/${encodeURIComponent(this.projectId)}/images/${encodeURIComponent(imageId)}/file?rev=${Date.now()}`;
    try {
      const data = await api.getAnnotations(this.projectId, imageId);
      this.annotations = this.normalizeAnnotations(data.annotations || []);
      this.renderAnnotationList();
      this.renderOverlay();
      this.setStatus(`${this.annotations.length} 个人体姿态`);
    } catch(e) {
      showToast(e.message, 'error');
      this.setStatus('标注加载失败');
    }
  },

  async selectByOffset(delta) {
    if (!this.images.length) return;
    const current = this.selectedImageIndex >= 0 ? this.selectedImageIndex : 0;
    const next = Math.max(0, Math.min(this.images.length - 1, current + Number(delta || 0)));
    if (next === current && this.selectedImageId) return;
    await this.selectImage(this.images[next].id);
  },

  normalizeAnnotations(annotations) {
    return (annotations || [])
      .filter((ann) => ann && typeof ann === 'object')
      .map((ann, index) => ({
        ...ann,
        id: ann.id || `pose_local_${index + 1}`,
        type: 'pose',
        label: ann.label || ann.class_name || 'person_pose',
        class_name: ann.class_name || ann.label || 'person_pose',
        keypoints: Array.isArray(ann.keypoints) ? ann.keypoints : [],
        skeleton_links: Array.isArray(ann.skeleton_links) ? ann.skeleton_links : [],
      }));
  },

  async runPose() {
    if (!this.selectedImageId) return;
    const btn = document.getElementById('pose-run');
    btn.disabled = true;
    btn.textContent = '推理中...';
    this.setStatus('Sapiens2 姿态估计推理中...');
    try {
      const data = await api.inferPose({
        project_id: this.projectId,
        image_id: this.selectedImageId,
        bbox_threshold: Number(document.getElementById('pose-bbox-thr').value || 0.3),
        keypoint_threshold: Number(document.getElementById('pose-kpt-thr').value || 0.3),
        nms_threshold: 0.3,
      });
      this.annotations = this.normalizeAnnotations(data.saved_annotations || data.annotations || []);
      const img = this.images.find((item) => item.id === this.selectedImageId);
      if (img) img.status = this.annotations.length ? 'labeled' : 'unlabeled';
      this.renderImageList();
      this.renderAnnotationList();
      this.renderOverlay();
      this.setStatus(`已生成 ${this.annotations.length} 个人体姿态`);
      showToast('姿态估计完成', 'success');
    } catch(e) {
      showToast(e.message, 'error');
      this.setStatus('姿态估计失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '姿态估计';
    }
  },

  async saveAnnotations() {
    if (!this.selectedImageId) return;
    try {
      const data = await api.saveAnnotations(this.projectId, this.selectedImageId, this.annotations);
      this.annotations = this.normalizeAnnotations(data.saved_annotations || []);
      const img = this.images.find((item) => item.id === this.selectedImageId);
      if (img) img.status = this.annotations.length ? 'labeled' : 'unlabeled';
      this.renderImageList();
      this.renderAnnotationList();
      this.renderOverlay();
      this.setStatus('已保存');
      showToast('保存成功', 'success');
    } catch(e) {
      showToast(e.message, 'error');
    }
  },

  async clearAnnotations() {
    if (!this.selectedImageId) return;
    this.annotations = [];
    this.selectedAnnotationId = '';
    await this.saveAnnotations();
  },

  deleteAnnotation(id) {
    this.annotations = this.annotations.filter((ann) => ann.id !== id);
    if (this.selectedAnnotationId === id) this.selectedAnnotationId = '';
    this.renderAnnotationList();
    this.renderOverlay();
  },

  selectAnnotation(id) {
    this.selectedAnnotationId = id;
    this.renderAnnotationList();
    this.renderOverlay();
  },

  renderAnnotationList() {
    const list = document.getElementById('pose-ann-list');
    if (!list) return;
    if (!this.annotations.length) {
      list.innerHTML = `<div style="font-size:13px; color:var(--neu-text-light); padding:14px;">当前图片没有姿态标注</div>`;
      return;
    }
    list.innerHTML = this.annotations.map((ann, index) => {
      const selected = ann.id === this.selectedAnnotationId;
      const points = (ann.keypoints || []).filter((kp) => Number(kp[3] ?? 1) > 0).length;
      const score = Number(ann.score || 0);
      return `
        <div class="neu-box" style="padding:12px; display:grid; gap:8px; box-shadow:${selected ? 'var(--neu-inset)' : 'var(--neu-outset)'};">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <button class="neu-button" onclick="window.poseWorkspace.selectAnnotation('${this.jsString(ann.id)}')" style="padding:6px 8px; text-align:left; flex:1; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">#${index + 1} ${this.escapeHtml(ann.label || 'person_pose')}</button>
            <button class="neu-button" onclick="window.poseWorkspace.deleteAnnotation('${this.jsString(ann.id)}')" style="width:30px; height:30px; padding:0; color:#ef4444;">×</button>
          </div>
          <div style="font-size:12px; color:var(--neu-text-light); display:flex; justify-content:space-between;">
            <span>${points}/${(ann.keypoints || []).length} 点</span>
            <span>Conf. ${score.toFixed(3)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  renderOverlay() {
    const svg = document.getElementById('pose-overlay');
    if (!svg) return;
    const width = this.naturalWidth || 1;
    const height = this.naturalHeight || 1;
    const threshold = Number(document.getElementById('pose-kpt-thr')?.value || 0.3);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = this.annotations.map((ann) => this.renderAnnotationSvg(ann, threshold)).join('');
    svg.querySelectorAll('[data-kpt]').forEach((node) => {
      node.addEventListener('pointerdown', (event) => this.startDrag(event));
    });
    svg.onpointermove = (event) => this.moveDrag(event);
    svg.onpointerup = () => this.endDrag();
    svg.onpointercancel = () => this.endDrag();
  },

  renderAnnotationSvg(ann, threshold) {
    const keypoints = Array.isArray(ann.keypoints) ? ann.keypoints : [];
    const selected = ann.id === this.selectedAnnotationId;
    const visible = (kp) => Number(kp?.[3] ?? 1) > 0 && Number(kp?.[2] ?? 1) >= threshold;
    const color = selected ? '#38bdf8' : '#fbbf24';
    const links = (Array.isArray(ann.skeleton_links) ? ann.skeleton_links : [])
      .map((pair) => {
        const a = Number(pair?.[0]);
        const b = Number(pair?.[1]);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return '';
        const ka = keypoints[a];
        const kb = keypoints[b];
        if (!visible(ka) || !visible(kb)) return '';
        return `<line x1="${Number(ka[0])}" y1="${Number(ka[1])}" x2="${Number(kb[0])}" y2="${Number(kb[1])}" stroke="${color}" stroke-width="${selected ? 2.8 : 1.8}" opacity="0.78" vector-effect="non-scaling-stroke" />`;
      })
      .join('');
    const points = keypoints.map((kp, idx) => {
      if (!visible(kp)) return '';
      const radius = selected ? 4.2 : 3.2;
      return `<circle data-ann="${this.escapeHtml(ann.id)}" data-kpt="${idx}" cx="${Number(kp[0])}" cy="${Number(kp[1])}" r="${radius}" fill="${color}" stroke="#0f172a" stroke-width="1.5" vector-effect="non-scaling-stroke" style="cursor:grab;" />`;
    }).join('');
    const bbox = Array.isArray(ann.bbox) && ann.bbox.length >= 4
      ? `<rect x="${Number(ann.bbox[0])}" y="${Number(ann.bbox[1])}" width="${Math.max(0, Number(ann.bbox[2]) - Number(ann.bbox[0]))}" height="${Math.max(0, Number(ann.bbox[3]) - Number(ann.bbox[1]))}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="6 4" opacity="0.55" vector-effect="non-scaling-stroke" />`
      : '';
    return `<g data-ann-group="${this.escapeHtml(ann.id)}">${bbox}${links}${points}</g>`;
  },

  startDrag(event) {
    const annId = event.currentTarget.getAttribute('data-ann') || '';
    const keypointIndex = Number(event.currentTarget.getAttribute('data-kpt'));
    const ann = this.annotations.find((item) => item.id === annId);
    if (!ann || !Number.isInteger(keypointIndex)) return;
    this.selectedAnnotationId = annId;
    this.dragging = { annId, keypointIndex };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    this.renderAnnotationList();
    event.preventDefault();
  },

  moveDrag(event) {
    if (!this.dragging) return;
    const pos = this.eventToImagePoint(event);
    const ann = this.annotations.find((item) => item.id === this.dragging.annId);
    if (!ann || !ann.keypoints[this.dragging.keypointIndex]) return;
    const kp = ann.keypoints[this.dragging.keypointIndex];
    kp[0] = pos.x;
    kp[1] = pos.y;
    kp[3] = 1;
    this.renderOverlay();
  },

  endDrag() {
    this.dragging = null;
  },

  eventToImagePoint(event) {
    const svg = document.getElementById('pose-overlay');
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * (this.naturalWidth || 1);
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * (this.naturalHeight || 1);
    return {
      x: Math.max(0, Math.min(this.naturalWidth || 1, x)),
      y: Math.max(0, Math.min(this.naturalHeight || 1, y)),
    };
  },

  setStatus(text) {
    const node = document.getElementById('pose-status');
    if (node) node.textContent = text;
  },

  escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  },

  jsString(value) {
    return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  },
};
