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
    
    container.innerHTML = `
      <div class="workspace-layout" style="display: flex; height: 100vh; flex-direction: column; background: var(--neu-bg); overflow: hidden;">
        <!-- Top Navigation / Task Progress -->
        <div class="neu-box" style="height: 64px; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px;">
          <div style="display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.location.hash='/'">
            <span style="font-size: 20px;">🖼️</span>
            <div style="display: flex; flex-direction: column;">
              <span id="ws-pj-name" style="font-weight: 700; font-size: 15px; color: var(--neu-text);">${i18n.t('backend_checking')}</span>
              <span id="health-status-header-ws" style="font-size: 10px; color: var(--neu-text-light); font-family: monospace;">${i18n.t('backend_checking')}</span>
            </div>
          </div>
          
          <!-- Task Progress Area -->
          <div style="flex: 1; display: flex; justify-content: center;">
             <div class="neu-box" style="width: 50%; height: 40px; border-radius: 20px; display: flex; align-items: center; padding: 0 15px; background: var(--neu-bg); box-shadow: var(--neu-inset); gap: 10px;">
                <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.05); border-radius: 3px; overflow: hidden;">
                   <div id="ws-progress-bar" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.3s ease;"></div>
                </div>
                <span id="ws-progress-text" style="font-size: 12px; font-weight: 600; min-width: 80px; text-align: right; color: var(--neu-text-light);">0 / 0</span>
             </div>
          </div>

          <div style="display: flex; gap: 12px; align-items: center;">
             <div id="backend-health" class="health-indicator" style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--neu-text-light);">
                <span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #fbbf24;"></span> ${i18n.t('backend_checking')}
             </div>
             <button id="btn-toggle-theme" class="neu-button" title="${i18n.t('toggle_theme')}" style="padding: 8px 12px;">
                <span id="theme-icon">🌓</span>
             </button>
             <button class="neu-button" onclick="window.location.hash='/'" style="padding: 8px 16px;">${i18n.t('dashboard')}</button>
          </div>
        </div>
        
        <!-- Main Workspace Area -->
        <div style="display: flex; flex: 1; overflow: hidden;">
          
          <!-- Left Column: Metadata & Classes -->
          <div class="neu-box" style="width: 300px; border-radius: 0; box-shadow: 4px 0 12px var(--neu-shadow-dark); display: flex; flex-direction: column; z-index: 50; padding: 0;">
            <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); background: var(--neu-bg);">
               <h3 style="margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('annotations_summary')}</h3>
               <div id="classes-list" style="display: flex; flex-direction: column; gap: 10px;">
                  <!-- Class items with counts -->
                  <div style="text-align: center; padding: 20px; color: var(--neu-text-light); font-size: 13px;">${i18n.t('no_classes')}</div>
               </div>
               <button class="neu-button" id="btn-add-class-ws" style="width: 100%; margin-top: 15px; font-size: 13px; font-weight: 600; color: var(--neu-text-active);">${i18n.t('create_class')}</button>
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
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; items-center; justify-content: center;" id="btn-img-prev">‹</button>
                  <span id="ws-page-info" style="font-size: 12px; font-weight: 600;">1 / 1</span>
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; items-center; justify-content: center;" id="btn-img-next">›</button>
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
                   <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1); margin: 0 5px;"></div>
                   <button class="neu-button" id="btn-vtool-filter" title="${i18n.t('filter_settings')}" style="width: 40px; height: 40px; border-radius: 50%;">🔍</button>
                </div>
             </div>

             <!-- Filter Modal (Overlay) -->
             <div id="modal-filter" class="modal-overlay" style="display: none;">
                <div class="neu-card" style="width: 320px; padding: 25px;">
                   <h3 style="margin-top: 0; font-size: 16px;">${i18n.t('smart_filter')}</h3>
                   <div style="margin-bottom: 20px;">
                      <label style="display: block; font-size: 11px; margin-bottom: 8px; font-weight: 700;">${i18n.t('confidence_threshold')}</label>
                      <input type="range" id="filter-threshold" min="0" max="1" step="0.05" value="0.5" style="width: 100%;" />
                      <div style="text-align: right; font-size: 11px; font-family: monospace;" id="val-threshold">0.50</div>
                   </div>
                   <div style="display: flex; justify-content: flex-end; gap: 10px;">
                      <button class="neu-button" id="btn-close-filter">${i18n.t('close')}</button>
                   </div>
                </div>
             </div>

             <!-- Bottom Action Bar (Context Sensitive) -->
             <div id="ws-action-bar" style="position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 100; display: none;">
                <button class="neu-button" id="btn-submit-preview" style="padding: 12px 32px; border-radius: 30px; font-weight: 800; font-size: 16px; color: var(--neu-text-active); background: var(--neu-bg); box-shadow: var(--neu-outset);">
                   ${i18n.t('submit_all')}
                </button>
             </div>
          </div>
          
          <!-- Right Column: Pure Vision Previews -->
          <div class="neu-box" id="right-panel" style="width: 320px; border-radius: 0; box-shadow: -4px 0 12px var(--neu-shadow-dark); z-index: 50; display: flex; flex-direction: column; background: var(--neu-bg);">
             <div style="padding: 20px; border-bottom: 1px solid rgba(0,0,0,0.05); display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column;">
                   <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('pure_vision')}</h3>
                   <p style="font-size: 11px; margin: 2px 0 0 0; color: var(--neu-text-light);">${i18n.t('preview_results')}</p>
                </div>
                <button class="neu-button" id="btn-select-all-previews" style="padding: 6px 10px; font-size: 11px; font-weight: 700; display: none;">${i18n.t('select_all')}</button>
             </div>
             
             <div id="preview-list" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px;">
                <!-- Previews will appear here -->
                <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
                   <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">✨</div>
                   <div style="font-size: 13px;">${i18n.t('preview_results_desc')}</div>
                </div>
             </div>

             <div style="padding: 20px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 10px;">
                <button class="neu-button" id="btn-infer" style="width: 100%; height: 50px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('run_inference')}</button>
             </div>
          </div>
        </div>
      </div>
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
    
    document.getElementById('btn-tool-point').onclick = () => this.setPromptMode('point');
    document.getElementById('btn-tool-box').onclick = () => this.setPromptMode('box');
    document.getElementById('btn-tool-clear').onclick = () => {
      this.currentPrompts = [];
      this.previews = [];
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.renderPreviews();
      this.updateActionBar();
    };

    document.getElementById('btn-add-class-ws').onclick = async () => {
      const name = prompt("New class name:");
      if (name) {
        try {
          await api.addClass(this.projectId, name);
          await this.loadProjectInfo();
        } catch(e) { alert(e.message); }
      }
    };
    
    document.getElementById('btn-infer').onclick = async () => {
      if (!this.selectedImageId) return alert("Select an image first");
      if (this.currentPrompts.length === 0) return alert("Add at least one point or box on the image first");

      const btn = document.getElementById('btn-infer');
      try {
        btn.textContent = i18n.t('inferring');
        btn.disabled = true;
        
        const payload = {
           project_id: this.projectId,
           image_id: this.selectedImageId,
           class_name: this.selectedClass || (this.projectMeta.classes?.[0] || 'Object'),
           prompts: this.currentPrompts.map(p => ({
              type: p.type,
              data: p.data
           }))
        };
        
        const res = await api.infer(payload);
        if (res.job_id) {
           alert("Batch job started: " + res.job_id);
        } else if (res.annotations) {
           // Pure Vision: Add to previews
           this.previews = res.annotations.map(a => ({
             ...a,
             id: 'preview_' + Math.random().toString(36).substr(2, 9),
             timestamp: new Date().getTime()
           }));
           this.viewer.setPreviews(this.previews);
           this.renderPreviews();
           this.updateActionBar();
           showToast(`Found ${this.previews.length} possible matching results`);
        }
      } catch(err) {
        alert("Inference failed: " + err.message);
      } finally {
        btn.textContent = i18n.t('run_inference');
        btn.disabled = false;
      }
    };

    document.getElementById('btn-select-all-previews').onclick = () => this.selectAllPreviews();

    // Filter Modal
    const btnFilter = document.getElementById('btn-vtool-filter');
    const modalFilter = document.getElementById('modal-filter');
    const btnCloseFilter = document.getElementById('btn-close-filter');
    const rangeFilter = document.getElementById('filter-threshold');
    const valFilter = document.getElementById('val-threshold');

    if (btnFilter) {
      btnFilter.onclick = () => modalFilter.style.display = 'flex';
      btnCloseFilter.onclick = () => modalFilter.style.display = 'none';
      rangeFilter.oninput = (e) => {
        valFilter.innerText = parseFloat(e.target.value).toFixed(2);
      };
    }
    
    // Override Point/Box tool IDs if they were renamed in template
    const btnPoint = document.getElementById('btn-tool-point') || document.getElementById('btn-vtool-point');
    const btnBox = document.getElementById('btn-tool-box') || document.getElementById('btn-vtool-box');
    const btnClear = document.getElementById('btn-tool-clear') || document.getElementById('btn-vtool-clear');

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

    const btnTheme = document.getElementById('btn-toggle-theme');
    const updateThemeIcon = () => {
       const icon = document.getElementById('theme-icon');
       if (icon) icon.innerText = store.state.config.theme === 'dark' ? '☀️' : '🌓';
    };
    updateThemeIcon();

    btnTheme.onclick = () => {
      const next = store.state.config.theme === 'dark' ? 'light' : 'dark';
      store.setConfig('theme', next);
      updateThemeIcon();
      if (window.showToast) window.showToast(`Switched to ${next} mode`);
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
           style="justify-content: space-between; padding: 10px 15px; font-size: 13px; border-radius: 12px; ${this.selectedClass === cls ? 'box-shadow: var(--neu-inset);' : ''}"
           onclick="window.currentWorkspace.selectClass('${cls}')">
        <div style="display: flex; align-items: center; gap: 10px;">
           <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${this.getClassColor(cls)}; box-shadow: 0 2px 5px rgba(0,0,0,0.1);"></span>
           <span style="font-weight: 600;">${cls}</span>
        </div>
        <span style="font-size: 11px; opacity: 0.6; font-family: monospace;">(${annCounts[cls] || 0})</span>
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
      
      document.getElementById('ws-pj-name').innerText = this.projectMeta.name;
      document.getElementById('ws-pj-id').innerText = this.projectId;
      
      const total = this.projectMeta.num_images || 0;
      const labeled = this.projectMeta.labeled_images || 0;
      const progress = total > 0 ? (labeled / total) * 100 : 0;
      
      document.getElementById('ws-progress-bar').style.width = `${progress}%`;
      document.getElementById('ws-progress-text').innerText = `${labeled} / ${total}`;
      document.getElementById('ws-img-count-badge').innerText = total;
      
      this.totalImages = total;
      this.renderClasses();
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
    
    document.getElementById('canvas-placeholder').style.display = 'none';
    
    try {
      const imgUrl = `/api/projects/${this.projectId}/images/${id}/file`;
      await this.viewer.loadImage(imgUrl);
      
      const annsRes = await api.getAnnotations(this.projectId, id);
      this.annotations = annsRes.annotations || [];
      this.viewer.setAnnotations(this.annotations);
      this.renderClasses();
      
    } catch(e) {
      console.error("Failed to load image/annotations:", e);
    }
  },
  
  async deleteAnnotation(annId) {
    if (!this.selectedImageId) return;
    try {
      const newAnns = this.annotations.filter(a => a.id !== annId);
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) { alert("Failed to delete: " + e.message); }
  }
};
