import { api } from '../api.js';
import { CanvasViewer } from '../components/canvas-viewer.js';
import { FilterUI } from '../components/filter.js';
import { i18n } from '../i18n.js';
import { store } from '../store.js';

export const ImageWorkspace = {
  container: null,
  projectId: null,
  projectMeta: null,
  images: [],
  offset: 0,
  limit: 50,
  totalImages: 0,
  selectedImageId: null,
  selectedImagePath: null,
  viewer: null,
  isUnmounted: false,
  promptMode: 'point',
  currentPrompts: [],
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    this.isUnmounted = false;
    this.currentPrompts = [];
    this.previews = []; // Storage for Pure Vision results
    this.promptMode = 'point';
    window.currentWorkspace = this;
    
    container.innerHTML = `
      <div class="workspace-layout" style="display: flex; height: 100vh; flex-direction: column; background: var(--neu-bg); overflow: hidden;">
        <!-- 1. Top Navigation Bar -->
        <div class="neu-box" style="height: 56px; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px; border-bottom: 1px solid rgba(0,0,0,0.05);">
          <div style="display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.location.hash='/'">
            <span style="font-size: 18px;">⬅️</span>
            <div style="display: flex; flex-direction: column;">
              <span id="ws-pj-name" style="font-weight: 700; font-size: 14px; color: var(--neu-text);">${i18n.t('backend_checking')}</span>
              <div style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--neu-text-light);">
                <span id="health-status-header-ws">${i18n.t('backend_checking')}</span>
                <span>•</span>
                <span id="ws-pj-type">${i18n.t('image_project')}</span>
              </div>
            </div>
          </div>
          
          <div style="flex: 1;"></div>

          <div style="display: flex; gap: 12px; align-items: center;">
             <div id="backend-health" class="health-indicator" style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--neu-text-light);">
                <span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #fbbf24;"></span> ${i18n.t('backend_checking')}
             </div>
             <button id="btn-toggle-theme" class="neu-button" title="${i18n.t('toggle_theme')}" style="padding: 6px 10px; font-size: 14px;">
                <span id="theme-icon">🌓</span>
             </button>
             <button class="neu-button" onclick="window.location.hash='/'" style="padding: 6px 14px; font-size: 12px; font-weight: 600;">${i18n.t('dashboard')}</button>
          </div>
        </div>

        <!-- 2. Top Operation Bar -->
        <div class="neu-box" style="height: 64px; display: flex; align-items: center; padding: 0 24px; z-index: 90; border-radius: 0; gap: 15px; background: var(--neu-bg); border-bottom: 1px solid rgba(0,0,0,0.03);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('sam3_api')}</label>
            <input type="text" id="inp-sam3-url" class="neu-input" style="width: 180px; height: 32px; font-size: 11px;" value="${store.state.config.sam3ApiUrl}" />
            <button id="btn-test-api" class="neu-button" style="height: 32px; padding: 0 10px; font-size: 11px;">${i18n.t('test_api')}</button>
          </div>

          <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('threshold')}</label>
            <input type="number" id="inp-threshold" class="neu-input" style="width: 60px; height: 32px; font-size: 11px;" step="0.05" min="0" max="1" value="${store.state.config.threshold}" />
            
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-left: 5px;">${i18n.t('batch_size')}</label>
            <input type="number" id="inp-batch-size" class="neu-input" style="width: 60px; height: 32px; font-size: 11px;" min="1" max="100" value="${store.state.config.batchSize}" />
          </div>

          <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

          <div style="display: flex; gap: 8px;">
            <button id="btn-infer-current" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('infer_current')}</button>
            <button id="btn-batch-infer" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('batch_infer')}</button>
            <button id="btn-example-segment" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('example_segment')}</button>
            <button id="btn-example-prop" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('example_propagate')}</button>
          </div>

          <div style="flex: 1;"></div>

          <div style="display: flex; gap: 8px;">
            <button id="btn-open-filter" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('smart_filter')}</button>
            <button id="btn-open-export" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('export')}</button>
          </div>
        </div>

        <!-- 3. Task Progress Bar (Shadow Row) -->
        <div id="ws-task-bar" class="neu-box" style="display: none; height: 50px; align-items: center; padding: 0 24px; z-index: 80; border-radius: 0; background: var(--neu-bg-light); border-bottom: 1px solid rgba(0,0,0,0.03); gap: 20px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 200px;">
            <span style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('task_header')}:</span>
            <span id="task-name" style="font-size: 11px; font-weight: 800;">--</span>
          </div>
          <div style="flex: 1; display: flex; align-items: center; gap: 15px;">
            <div style="flex: 1; height: 4px; background: rgba(0,0,0,0.05); border-radius: 2px; overflow: hidden;">
              <div id="task-progress-fill" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.3s ease;"></div>
            </div>
            <span id="task-status-text" style="font-size: 10px; font-weight: 600; min-width: 100px; text-align: right; color: var(--neu-text-light);">--</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="btn-task-stop" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 10px; font-weight: 700; color: #ef4444;">${i18n.t('stop')}</button>
            <button id="btn-task-resume" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 10px; font-weight: 700; color: #10b981; display: none;">${i18n.t('resume')}</button>
          </div>
        </div>
        
        <!-- 4. Main Workspace Area -->
        <div style="display: flex; flex: 1; overflow: hidden;">
          
          <!-- Left Column: Project Meta & Image List -->
          <div class="neu-box" style="width: 320px; border-radius: 0; box-shadow: 4px 0 12px var(--neu-shadow-dark); display: flex; flex-direction: column; z-index: 50; padding: 0;">
            <!-- Project Meta Card -->
            <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); background: var(--neu-bg);">
               <div class="neu-card" style="padding: 15px; margin-bottom: 10px;">
                 <h3 id="ws-pj-card-name" style="margin: 0 0 5px 0; font-size: 15px;">--</h3>
                 <div style="font-size: 10px; color: var(--neu-text-light); word-break: break-all; font-family: monospace;" id="ws-pj-card-id">--</div>
                 <div style="margin-top: 10px; display: flex; justify-content: space-between; font-size: 11px;">
                   <span>${i18n.t('total')}: <b id="ws-meta-total">0</b></span>
                   <span>${i18n.t('labeled')}: <b id="ws-meta-labeled" style="color: #10b981;">0</b></span>
                 </div>
               </div>
            </div>
            
            <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
               <div style="padding: 15px 20px; display: flex; justify-content: space-between; align-items: center;">
                  <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('image_list')}</h3>
                  <span id="ws-img-count-badge" class="neu-box" style="padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; box-shadow: var(--neu-inset);">0</span>
               </div>
               <div id="image-list-container" style="flex: 1; overflow-y: auto; padding: 10px 15px;">
                  <div style="text-align:center; padding: 40px; color: var(--neu-text-light);">${i18n.t('loading_images')}</div>
               </div>
               <div style="padding: 15px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(0,0,0,0.05);">
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;" id="btn-img-prev">‹</button>
                  <span id="ws-page-info" style="font-size: 12px; font-weight: 600;">1 / 1</span>
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;" id="btn-img-next">›</button>
               </div>
            </div>
          </div>
          
          <!-- Middle Column: Canvas & Hover Tools -->
          <div style="flex: 1; position: relative; display: flex; flex-direction: column; overflow: hidden; background: #eaeff2;">
             <!-- Canvas Area -->
             <div id="canvas-container" style="flex: 1; position: relative;">
                <div id="canvas-placeholder" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; pointer-events: none;">
                   <div style="font-size: 64px; opacity: 0.1; margin-bottom: 20px;">🖼️</div>
                   <div style="font-size: 18px; font-weight: 600; color: var(--neu-text-light);">${i18n.t('select_image_prompt')}</div>
                </div>

                <!-- Hovering Toolbar -->
                <div class="neu-box" style="position: absolute; top: 20px; left: 50%; transform: translateX(-50%); height: 50px; border-radius: 25px; display: flex; align-items: center; padding: 0 10px; z-index: 100; gap: 5px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
                   <button class="neu-button active" id="btn-tool-point" title="Point Prompt" style="width: 40px; height: 40px; border-radius: 50%;">📍</button>
                   <button class="neu-button" id="btn-tool-box" title="Box Prompt" style="width: 40px; height: 40px; border-radius: 50%;">🏁</button>
                   <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                   <button class="neu-button" id="btn-vtool-clear" title="${i18n.t('clear_prompts')}" style="width: 40px; height: 40px; border-radius: 50%;">🧹</button>
                   <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                   <button class="neu-button" id="btn-vtool-filter" title="${i18n.t('filter_settings')}" style="width: 40px; height: 40px; border-radius: 50%;">🔍</button>
                </div>
             </div>

             <!-- Display Toggles & Information -->
             <div class="neu-box" style="height: 40px; border-radius: 0; display: flex; align-items: center; padding: 0 20px; gap: 20px; background: var(--neu-bg); z-index: 40; font-size: 11px; border-top: 1px solid rgba(0,0,0,0.03);">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-show-masks" checked /> 显示遮罩
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-auto-infer" /> 提示后自动分割
                </label>
                <div style="flex: 1;"></div>
                <div id="ws-image-status" style="font-weight: 700; color: var(--neu-text-light);">--</div>
             </div>

             <!-- Bottom Action Bar (Context Sensitive) -->
             <div id="ws-action-bar" style="position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); z-index: 100; display: none;">
                <button class="neu-button" id="btn-submit-preview" style="padding: 12px 32px; border-radius: 30px; font-weight: 800; font-size: 16px; color: var(--neu-text-active); background: var(--neu-bg); box-shadow: var(--neu-outset);">
                   ${i18n.t('submit_all')}
                </button>
             </div>
          </div>
          
          <!-- Right Column: Classes & Annotations -->
          <div class="neu-box" id="right-panel" style="width: 320px; border-radius: 0; box-shadow: -4px 0 12px var(--neu-shadow-dark); z-index: 50; display: flex; flex-direction: column; background: var(--neu-bg);">
             <!-- Classes Management -->
             <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); background: var(--neu-bg);">
                <h3 style="margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('annotations_summary')}</h3>
                <div id="classes-list" style="display: flex; flex-direction: column; gap: 8px;">
                   <!-- Class items -->
                </div>
                <button class="neu-button" id="btn-add-class-ws" style="width: 100%; margin-top: 15px; font-size: 12px; font-weight: 600; color: var(--neu-text-active); padding: 10px;">${i18n.t('create_class')}</button>
             </div>

             <!-- Annotations List -->
             <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                <div style="padding: 15px 20px; border-bottom: 1px solid rgba(0,0,0,0.03);">
                   <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">标注列表</h3>
                </div>
                <div id="annotation-list-container" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px;">
                   <!-- Annotation items -->
                   <div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">无标注数据</div>
                </div>
                <div style="padding: 20px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 10px;">
                   <button id="btn-save-anns" class="neu-button" style="width: 100%; height: 44px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('save_anns')}</button>
                   <button id="btn-clear-anns" class="neu-button" style="width: 100%; height: 44px; font-weight: 600; color: #ef4444;">${i18n.t('clear_anns')}</button>
                </div>
             </div>

             <!-- Hidden Previews Section (becomes a modal or overlay later) -->
             <div id="preview-floating-panel" style="display: none;"></div>
          </div>
        </div>
      </div>

      <!-- Modals -->
      <div id="modal-filter-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-export-full" class="modal-overlay" style="display: none;"></div>
    `;
    
    this.viewer = new CanvasViewer('canvas-container');
    this.viewer.onPromptAdded = (type, data) => this.addPrompt(type, data);
    
    this.bindEvents();
    window.currentWorkspace = this;
    
    await this.loadProjectInfo();
    await this.loadImages();
    this.startHealthCheck();
  },

  unmount() {
    this.isUnmounted = true;
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.container = null;
    window.currentWorkspace = null;
  },

  startHealthCheck() {
    const check = async () => {
      const el = document.getElementById('backend-health');
      const headerStatus = document.getElementById('health-status-header-ws');
      if (!el) return;
      try {
        const res = await api.getHealth();
        const dot = el.querySelector('.dot');
        if (res.status === 'ok') {
          dot.style.background = '#10b981';
          const txt = i18n.t('backend_online');
          el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; margin-right: 6px;"></span> ${txt}`;
          if (headerStatus) headerStatus.innerText = txt;
        } else {
          dot.style.background = '#ef4444';
          const txt = i18n.t('backend_error');
          el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 6px;"></span> ${txt}`;
          if (headerStatus) headerStatus.innerText = txt;
        }
      } catch (e) {
        const txt = i18n.t('backend_offline');
        el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 6px;"></span> ${txt}`;
        if (headerStatus) headerStatus.innerText = txt;
      }
    };
    check();
    this.healthInterval = setInterval(check, 10000);
  },

  bindEvents() {
    // Top Operation Bar
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    sam3UrlInp.onchange = (e) => store.setConfig('sam3ApiUrl', e.target.value);
    
    const thresholdInp = document.getElementById('inp-threshold');
    thresholdInp.onchange = (e) => store.setConfig('threshold', parseFloat(e.target.value));
    
    const batchSizeInp = document.getElementById('inp-batch-size');
    batchSizeInp.onchange = (e) => store.setConfig('batchSize', parseInt(e.target.value));

    document.getElementById('btn-test-api').onclick = async () => {
      const btn = document.getElementById('btn-test-api');
      try {
        btn.disabled = true;
        btn.innerText = 'Testing...';
        await api.testSam3(store.state.config.sam3ApiUrl);
        showToast("SAM3 API is Online", "success");
      } catch(e) {
        showToast("SAM3 API Connection Failed: " + e.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerText = i18n.t('test_api');
      }
    };

    document.getElementById('btn-infer-current').onclick = () => this.runSingleInfer();
    document.getElementById('btn-batch-infer').onclick = () => this.startBatchTask('text');
    document.getElementById('btn-example-segment').onclick = () => this.runExamplePreview();
    document.getElementById('btn-example-prop').onclick = () => this.startBatchTask('example');
    
    document.getElementById('btn-open-filter').onclick = () => this.openSmartFilter();
    document.getElementById('btn-open-export').onclick = () => this.openExport();

    // Task Bar
    document.getElementById('btn-task-stop').onclick = () => this.stopActiveTask();
    document.getElementById('btn-task-resume').onclick = () => this.resumeActiveTask();

    // Left Column
    document.getElementById('btn-img-prev').onclick = () => {
      if (this.offset >= this.limit) {
        this.offset -= this.limit;
        this.loadImages();
      }
    };
    
    document.getElementById('btn-img-next').onclick = () => {
      if (this.offset + this.limit < this.totalImages) {
        this.offset += this.limit;
        this.loadImages();
      }
    };
    
    document.getElementById('btn-add-class-ws').onclick = async () => {
      const name = prompt("New class name:");
      if (name) {
        try {
          await api.addClass(this.projectId, name);
          await this.loadProjectInfo();
        } catch(e) { showToast(e.message, "error"); }
      }
    };

    // Canvas Tools
    const btnPoint = document.getElementById('btn-tool-point');
    const btnBox = document.getElementById('btn-tool-box');
    const btnClear = document.getElementById('btn-vtool-clear');

    if (btnPoint) btnPoint.onclick = () => this.setPromptMode('point');
    if (btnBox) btnBox.onclick = () => this.setPromptMode('box');
    if (btnClear) btnClear.onclick = () => {
      this.currentPrompts = [];
      this.previews = [];
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.renderPreviews();
      this.updateActionBar();
      showToast(i18n.t('prompts_cleared'));
    };

    document.getElementById('chk-show-masks').onchange = (e) => {
      if (this.viewer) this.viewer.setOptions({ showMasks: e.target.checked });
    };

    // Right Column
    document.getElementById('btn-save-anns').onclick = () => this.saveCurrentAnns();
    document.getElementById('btn-clear-anns').onclick = () => this.clearCurrentAnns();
    document.getElementById('btn-submit-preview').onclick = () => this.keepAllPreviews();

    // Theme Toggle
    const btnTheme = document.getElementById('btn-toggle-theme');
    btnTheme.onclick = () => {
      const next = store.state.config.theme === 'dark' ? 'light' : 'dark';
      store.setConfig('theme', next);
      document.getElementById('theme-icon').innerText = next === 'dark' ? '☀️' : '🌓';
    };
  },

  selectAllPreviews() {
    // In current implementation, "Submit" already keeps all. 
    // This button could be used to toggle visual selection if we had selective submission.
    // For now, let's make it a quick way to trigger keepAllPreviews.
    this.keepAllPreviews();
  },

  updateActionBar() {
    const bar = document.getElementById('ws-action-bar');
    const btn = document.getElementById('btn-submit-preview');
    const btnAll = document.getElementById('btn-select-all-previews');
    
    if (this.previews.length > 0) {
      bar.style.display = 'block';
      btnAll.style.display = 'block';
      const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
      btn.textContent = `Submit ${this.previews.length} Previews to [${className}]`;
    } else {
      bar.style.display = 'none';
      btnAll.style.display = 'none';
    }
  },

  async keepAllPreviews() {
    if (this.previews.length === 0) return;
    const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
    
    try {
      const existing = await api.getAnnotations(this.projectId, this.selectedImageId);
      const newAnns = [...(existing.annotations || []), ...this.previews.map(p => ({
        ...p,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }))];
      
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      
      // Clear previews and refresh
      this.previews = [];
      this.currentPrompts = [];
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.renderPreviews();
      this.updateActionBar();
      
      await this.loadProjectInfo(); // Refresh counts
      await this.selectImage(this.selectedImageId, this.selectedImagePath); // Refresh annotations list
      
    } catch(e) {
      alert("Failed to save: " + e.message);
    }
  },

  renderClasses() {
    const list = document.getElementById('classes-list');
    const classes = this.projectMeta?.classes || [];
    
    if (classes.length === 0) {
      list.innerHTML = `<div style="color:var(--neu-text-light); font-size:12px; text-align:center;">${i18n.t('no_classes')}</div>`;
      return;
    }
    
    if (!this.selectedClass) this.selectedClass = classes[0];

    // Calculate current image class counts
    const annCounts = {};
    (this.annotations || []).forEach(ann => {
      annCounts[ann.class_name] = (annCounts[ann.class_name] || 0) + 1;
    });

    list.innerHTML = classes.map(cls => `
      <div class="neu-button class-item ${this.selectedClass === cls ? 'active' : ''}" 
           style="justify-content: space-between; padding: 10px 15px; font-size: 13px; border-radius: 12px; ${this.selectedClass === cls ? 'box-shadow: var(--neu-inset);' : ''}">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1;" onclick="window.currentWorkspace.selectClass('${cls}')">
           <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${this.getClassColor(cls)}; box-shadow: 0 2px 5px rgba(0,0,0,0.1);"></span>
           <span style="font-weight: 600;">${cls}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
           <span style="font-size: 11px; opacity: 0.6; font-family: monospace;">(${annCounts[cls] || 0})</span>
           <input type="checkbox" class="cls-chk-infer" data-cls="${cls}" title="Include in text inference" checked style="width: 14px; height: 14px; cursor: pointer;" />
        </div>
      </div>
    `).join('');
    
    this.updateActionBar();
  },

  selectClass(cls) {
    this.selectedClass = cls;
    this.renderClasses();
  },

  getClassColor(className) {
    let hash = 0;
    const str = String(className || 'unknown');
    for (let i = 0; i < str.length; i++) {
       hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  },

  setPromptMode(mode) {
    this.promptMode = mode;
    document.querySelectorAll('[id^="btn-tool-"]').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`btn-tool-${mode}`);
    if (btn) btn.classList.add('active');
    
    if (this.viewer) {
      this.viewer.setPromptMode(mode);
    }
  },

  addPrompt(type, data) {
    this.currentPrompts.push({type, data, timestamp: new Date().getTime()});
    if (this.viewer) this.viewer.setPrompts(this.currentPrompts);
  },

  renderPreviews() {
    const list = document.getElementById('preview-list');
    if (this.previews.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
           <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">✨</div>
           <div style="font-size: 13px;">${i18n.t('preview_results_desc')}</div>
        </div>
      `;
      return;
    }

    list.innerHTML = this.previews.map((p, idx) => `
      <div class="neu-box" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--neu-bg); box-shadow: var(--neu-outset-sm);">
         <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; font-weight: 700; color: var(--neu-text-active); text-transform: uppercase;">Preview Result #${idx+1}</span>
            <button class="neu-button" style="width: 24px; height: 24px; border-radius: 50%; padding: 0; font-size: 10px; color: #ef4444;" onclick="window.currentWorkspace.removePreview('${p.id}')">×</button>
         </div>
         <div style="font-size: 12px; color: var(--neu-text-light);">
            Confidence: <span style="font-weight: 600; color: var(--neu-text);">${(p.score || 0.98).toFixed(3)}</span>
         </div>
         <div style="display: flex; gap: 8px;">
            <button class="neu-button" style="flex: 1; font-size: 11px; padding: 6px;" onclick="window.currentWorkspace.keepSinglePreview('${p.id}')">Apply to Image</button>
         </div>
      </div>
    `).join('');
  },

  removePreview(id) {
    this.previews = this.previews.filter(p => p.id !== id);
    this.viewer.setPreviews(this.previews);
    this.renderPreviews();
    this.updateActionBar();
  },

  async keepSinglePreview(id) {
    const pre = this.previews.find(p => p.id === id);
    if (!pre) return;
    
    const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
    try {
      const existing = await api.getAnnotations(this.projectId, this.selectedImageId);
      const newAnns = [...(existing.annotations || []), {
        ...pre,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }];
      
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      this.removePreview(id);
      await this.loadProjectInfo();
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
    } catch(e) { alert(e.message); }
  },

  async loadProjectInfo() {
    try {
      const res = await api.getProject(this.projectId, false);
      this.projectMeta = res.project;
      if (this.isUnmounted) return;
      
      const projectNameEl = document.getElementById('ws-pj-name');
      const projectNameCardEl = document.getElementById('ws-pj-card-name');
      const projectIdEl = document.getElementById('ws-pj-id');
      const projectIdCardEl = document.getElementById('ws-pj-card-id');
      
      const name = this.projectMeta.name || this.projectId;
      if (projectNameEl) projectNameEl.innerText = name;
      if (projectNameCardEl) projectNameCardEl.innerText = name;
      if (projectIdEl) projectIdEl.innerText = this.projectId;
      if (projectIdCardEl) projectIdCardEl.innerText = this.projectId;
      
      const total = this.projectMeta.num_images || 0;
      const labeled = this.projectMeta.labeled_images || 0;
      const progress = total > 0 ? (labeled / total) * 100 : 0;
      
      document.getElementById('ws-progress-bar').style.width = `${progress}%`;
      document.getElementById('ws-progress-text').innerText = `${labeled} / ${total}`;
      document.getElementById('ws-img-count-badge').innerText = total;
      
      document.getElementById('ws-meta-total').innerText = total;
      document.getElementById('ws-meta-labeled').innerText = labeled;
      
      this.totalImages = total;
      this.renderClasses();
      
      // Check for active job
      const activeJob = await api.getInferActiveJob(this.projectId);
      if (activeJob && activeJob.job_id) {
        this.activeJobId = activeJob.job_id;
        this.pollTaskStatus();
      }
    } catch(err) { console.error(err); }
  },
  
  async loadImages() {
    const listCont = document.getElementById('image-list-container');
    try {
      const data = await api.getImages(this.projectId, this.offset, this.limit);
      if (this.isUnmounted) return;
      
      this.images = data.items || [];
      this.totalImages = data.total || 0;
      
      const totalPages = Math.ceil(this.totalImages / this.limit) || 1;
      const currPage = Math.floor(this.offset / this.limit) + 1;
      document.getElementById('ws-page-info').innerText = `${currPage} / ${totalPages}`;
      
      if (this.images.length === 0) {
         listCont.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--neu-text-light);">${i18n.t('no_images')}</div>`;
         return;
      }
      
      let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
      for(const img of this.images) {
        const isSel = this.selectedImageId === img.id;
        const bgState = isSel ? 'var(--neu-bg)' : 'transparent';
        const shadowState = isSel ? 'var(--neu-inset)' : 'none';
        const weight = isSel ? '700' : '500';
        
        const isLabeled = (img.status === 'labeled' || img.labeled);
        const dotColor = isLabeled ? '#10b981' : '#e2e8f0';
        
        html += `
          <div class="neu-button" style="justify-content: flex-start; text-align: left; padding: 12px; background: ${bgState}; box-shadow: ${shadowState}; font-weight: ${weight}; border-radius: 12px; font-size: 13px; overflow: hidden;" onclick="window.currentWorkspace.selectImage('${img.id}', '${img.rel_path}')">
             <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; margin-right: 12px; flex-shrink: 0;"></span>
             <span style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${img.rel_path}</span>
          </div>
        `;
      }
      html += '</div>';
      listCont.innerHTML = html;
      
    } catch(e) {
      listCont.innerHTML = `<div style="color: #ef4444; padding: 10px; font-size: 12px;">${e.message}</div>`;
    }
  },
  async selectImage(id, relPath) {
    this.selectedImageId = id;
    this.selectedImagePath = relPath;
    this.currentPrompts = [];
    this.previews = [];
    
    if (this.viewer) {
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
    }
    
    this.renderPreviews();
    this.updateActionBar();
    await this.loadImages();
    this.renderAnnotations();
    
    const placeholder = document.getElementById('canvas-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    
    try {
      const imgUrl = `/api/projects/${this.projectId}/images/${id}/file`;
      await this.viewer.loadImage(imgUrl);
      
      const annsRes = await api.getAnnotations(this.projectId, id);
      this.annotations = annsRes.annotations || [];
      this.viewer.setAnnotations(this.annotations);
      this.renderClasses();
      this.renderAnnotations();
      
    } catch(e) {
      console.error("Failed to load image/annotations:", e);
    }
  },

  async runSingleInfer() {
    if (!this.selectedImageId) return showToast("Select an image first", "error");
    
    const btn = document.getElementById('btn-infer-current');
    try {
      btn.disabled = true;
      btn.innerText = i18n.t('inferring');
      
      const payload = {
        project_id: this.projectId,
        image_id: this.selectedImageId,
        mode: 'text',
        classes: this.getSelectedClassesForInference(),
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };
      
      const res = await api.infer(payload);
      showToast(i18n.t('save_success'), "success");
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerText = i18n.t('infer_current');
    }
  },

  async runExamplePreview() {
    if (!this.selectedImageId) return showToast("Select an image first", "error");
    if (!this.selectedClass) return showToast("Select a class first", "error");
    
    const boxes = this.currentPrompts
      .filter(p => p.type === 'box')
      .map(p => p.data);
      
    if (boxes.length === 0) return showToast("Draw at least one box as an example", "error");

    const btn = document.getElementById('btn-example-segment');
    try {
      btn.disabled = true;
      btn.innerText = 'Segmenting...';
      
      const payload = {
        project_id: this.projectId,
        image_id: this.selectedImageId,
        active_class: this.selectedClass,
        boxes: boxes,
        pure_visual: false,
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };
      
      const res = await api.inferExample(payload);
      const detections = res.detections || [];
      this.previews = detections.map(d => ({
        ...d,
        id: 'preview_' + Math.random().toString(36).substr(2, 9),
        class_name: this.selectedClass
      }));
      
      this.viewer.setPreviews(this.previews);
      this.renderPreviews(); // Although this panel is hidden, we use it for keeping
      this.updateActionBar();
      showToast(`Found ${this.previews.length} matches`, "info");
    } catch(e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerText = i18n.t('example_segment');
    }
  },

  async startBatchTask(type) {
    const classes = this.getSelectedClassesForInference();
    if (type === 'text' && classes.length === 0) return showToast("Select at least one class for text inference", "error");
    
    let payload = {
      project_id: this.projectId,
      threshold: store.state.config.threshold,
      batch_size: store.state.config.batchSize,
      api_base_url: store.state.config.sam3ApiUrl
    };

    if (type === 'text') {
      payload.classes = classes;
    } else {
      const boxes = this.currentPrompts.filter(p => p.type === 'box').map(p => p.data);
      if (boxes.length === 0) return showToast("Draw an example box first", "error");
      if (!this.selectedClass) return showToast("Select a target class", "error");
      payload.active_class = this.selectedClass;
      payload.boxes = boxes;
      payload.pure_visual = false;
    }

    try {
      const res = type === 'text' 
        ? await api.startBatchInfer(payload)
        : await api.startBatchExample(payload);
        
      this.activeJobId = res.job_id;
      this.pollTaskStatus();
      showToast("Batch task started", "success");
    } catch(e) {
       showToast(e.message, "error");
    }
  },

  async pollTaskStatus() {
    if (this.isPolling) return;
    this.isPolling = true;
    
    const bar = document.getElementById('ws-task-bar');
    const nameEl = document.getElementById('task-name');
    const fillEl = document.getElementById('task-progress-fill');
    const statusEl = document.getElementById('task-status-text');
    
    bar.style.display = 'flex';
    
    const poll = async () => {
      if (this.isUnmounted || !this.activeJobId) {
        this.isPolling = false;
        return;
      }
      
      try {
        const job = await api.getInferJob(this.activeJobId);
        nameEl.innerText = i18n.t(job.job_type === 'example_batch' ? 'example_propagate' : 'batch_infer');
        fillEl.style.width = `${job.progress_pct * 100}%`;
        statusEl.innerText = `${job.message}`;
        
        if (job.status === 'completed' || job.status === 'failed') {
          setTimeout(() => bar.style.display = 'none', 3000);
          this.activeJobId = null;
          this.isPolling = false;
          this.loadProjectInfo();
          return;
        } else if (job.status === 'paused') {
          document.getElementById('btn-task-resume').style.display = 'block';
          document.getElementById('btn-task-stop').style.display = 'none';
        } else {
          document.getElementById('btn-task-resume').style.display = 'none';
          document.getElementById('btn-task-stop').style.display = 'block';
        }
        
        setTimeout(poll, 1000);
      } catch(e) {
        console.error("Poll error", e);
        this.isPolling = false;
      }
    };
    
    poll();
  },

  async stopActiveTask() {
    try {
      await api.stopInferJob(this.projectId);
      showToast("Stopping task...");
    } catch(e) { showToast(e.message, "error"); }
  },

  async resumeActiveTask() {
    try {
      const payload = {
        project_id: this.projectId,
        threshold: store.state.config.threshold,
        batch_size: store.state.config.batchSize,
        api_base_url: store.state.config.sam3ApiUrl
      };
      await api.resumeInferJob(payload);
      showToast("Resuming task...");
    } catch(e) { showToast(e.message, "error"); }
  },

  renderAnnotations() {
    const list = document.getElementById('annotation-list-container');
    const anns = this.annotations || [];
    
    if (anns.length === 0) {
      list.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">无标注数据</div>`;
      return;
    }

    list.innerHTML = anns.map(ann => `
      <div class="neu-box" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--neu-bg); box-shadow: var(--neu-inset-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="width: 10px; height: 10px; border-radius: 50%; background: ${this.getClassColor(ann.class_name)};"></span>
            <span style="font-size: 13px; font-weight: 700;">${ann.class_name}</span>
          </div>
          <div style="display: flex; gap: 5px;">
            <button class="neu-button" style="width: 24px; height: 24px; padding: 0; font-size: 10px;" onclick="window.currentWorkspace.locateAnnotation('${ann.id}')">🎯</button>
            <button class="neu-button" style="width: 24px; height: 24px; padding: 0; font-size: 12px; color: #ef4444;" onclick="window.currentWorkspace.deleteAnnotation('${ann.id}')">×</button>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--neu-text-light); display: flex; justify-content: space-between;">
          <span>Conf: <b>${(ann.score || 0.98).toFixed(3)}</b></span>
          <span>${ann.polygon ? 'Polygon' : 'BBox'}</span>
        </div>
      </div>
    `).join('');
  },

  locateAnnotation(annId) {
    const ann = this.annotations.find(a => a.id === annId);
    if (ann && this.viewer) {
      this.viewer.centerOn(ann.bbox);
    }
  },

  getSelectedClassesForInference() {
    const checked = [];
    document.querySelectorAll('.cls-chk-infer[type="checkbox"]:checked').forEach(chk => {
       checked.push(chk.dataset.cls);
    });
    return checked;
  },

  async saveCurrentAnns() {
    if (!this.selectedImageId) return;
    try {
      await api.saveAnnotations(this.projectId, this.selectedImageId, this.annotations);
      showToast(i18n.t('save_success'), "success");
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },

  async clearCurrentAnns() {
    if (!this.selectedImageId) return;
    if (!confirm("Clear all annotations on this image?")) return;
    try {
      await api.saveAnnotations(this.projectId, this.selectedImageId, []);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },
  
  async deleteAnnotation(annId) {
    if (!this.selectedImageId) return;
    try {
      const newAnns = this.annotations.filter(a => a.id !== annId);
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },

  openSmartFilter() {
    const modal = document.getElementById('modal-filter-full');
    modal.innerHTML = `
      <div class="neu-card" style="width: 500px; padding: 30px; position: relative;">
        <h2 style="margin-top: 0;">${i18n.t('smart_filter')}</h2>
        <div style="display: flex; flex-direction: column; gap: 20px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">过滤方式</label>
            <select id="filter-mode-sel" class="neu-input" style="width: 100%;">
              <option value="same_class">主从类别合并</option>
            </select>
          </div>
          <div>
             <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">覆盖率阈值</label>
             <input type="range" id="filter-cov" min="0.5" max="1" step="0.01" value="0.98" style="width: 100%;" />
             <div style="text-align: right; font-size: 11px; font-family: monospace;" id="filter-cov-val">0.98</div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
            <button class="neu-button" onclick="document.getElementById('modal-filter-full').style.display='none'">${i18n.t('cancel')}</button>
            <button id="btn-start-filter-preview" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">分析预览</button>
          </div>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    
    const cov = document.getElementById('filter-cov');
    const val = document.getElementById('filter-cov-val');
    cov.oninput = (e) => val.innerText = e.target.value;
    
    document.getElementById('btn-start-filter-preview').onclick = async () => {
       try {
         await api.startFilterPreview({
           project_id: this.projectId,
           merge_mode: document.getElementById('filter-mode-sel').value,
           coverage_threshold: parseFloat(cov.value)
         });
         showToast("Smart filter analysis started", "success");
         modal.style.display = 'none';
         this.pollFilterStatus();
       } catch(e) { showToast(e.message, "error"); }
    };
  },

  async pollFilterStatus() {
     // Implement polling for filter job if needed, or reuse pollTaskStatus
     // For brevity, we'll assume the same UI channel for all jobs
     const active = await api.getFilterActiveJob(this.projectId);
     if (active && active.job_id) {
        this.activeJobId = active.job_id;
        this.pollTaskStatus(); 
     }
  },

  openExport() {
    const modal = document.getElementById('modal-export-full');
    modal.innerHTML = `
      <div class="neu-card" style="width: 400px; padding: 300px; padding: 30px;">
        <h2 style="margin-top: 0;">${i18n.t('export')}</h2>
        <div style="display: flex; flex-direction: column; gap: 20px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出格式</label>
            <select id="exp-format" class="neu-input" style="width: 100%;">
              <option value="coco">COCO</option>
              <option value="yolo">YOLO</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <div>
             <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">保存内容</label>
             <div style="display: flex; gap: 20px; font-size: 12px;">
                <label><input type="checkbox" id="exp-bbox" checked /> BBox</label>
                <label><input type="checkbox" id="exp-mask" /> Mask</label>
             </div>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出目录</label>
            <input type="text" id="exp-dir" class="neu-input" style="width: 100%;" placeholder="e.g. D:/export" />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
            <button class="neu-button" onclick="document.getElementById('modal-export-full').style.display='none'">${i18n.t('cancel')}</button>
            <button id="btn-do-export" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">确认导出</button>
          </div>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    
    document.getElementById('btn-do-export').onclick = async () => {
       const dir = document.getElementById('exp-dir').value;
       if (!dir) return showToast("Please specify export directory", "error");
       try {
         await api.exportProject({
           project_id: this.projectId,
           format: document.getElementById('exp-format').value,
           include_bbox: document.getElementById('exp-bbox').checked,
           include_mask: document.getElementById('exp-mask').checked,
           output_dir: dir
         });
         showToast("Export successful", "success");
         modal.style.display = 'none';
       } catch(e) { showToast(e.message, "error"); }
    };
  }
};
