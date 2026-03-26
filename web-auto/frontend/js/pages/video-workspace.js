import { api } from '../api.js';
import { CanvasViewer } from '../components/canvas-viewer.js';
import { store } from '../store.js';
import { i18n } from '../i18n.js';

export const VideoWorkspace = {
  container: null,
  projectId: null,
  project: null,
  currentFrame: 0,
  isPlaying: false,
  isPropagating: false,
  annotations: [],
  classes: [],
  selectedClass: null,
  canvasViewer: null,
  videoElement: null,
  isUnmounted: false,
  abortController: null,

  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    this.isUnmounted = false;
    this.abortController = new AbortController();
    this.currentPrompts = [];
    this.previews = [];
    this.promptMode = 'point';
    window.currentWorkspace = this;

    try {
      const data = await api.getProject(this.projectId, false);
      if (this.isUnmounted) return;
      this.project = data.project;
      this.classes = this.project.classes || [];
      if (this.classes.length > 0) this.selectedClass = this.classes[0];
      
      await this.renderLayout();
    } catch (err) {
      console.error('Failed to load project:', err);
      if (!this.isUnmounted) {
        container.innerHTML = `<div class="neu-card" style="margin:20px; padding:20px; color:var(--neu-accent);">Error loading video project: ${err.message}</div>`;
      }
    }
  },

  async renderLayout() {
    this.container.innerHTML = `
      <div class="workspace-layout v-workspace" style="display: flex; height: 100%; flex-direction: column; background: var(--neu-bg); overflow: hidden; min-height: 0; min-width: 0; box-sizing: border-box;">
        <!-- Top Navigation / Task Progress -->
        <div class="neu-box" style="height: 64px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px; box-sizing: border-box;">
            <div style="display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.location.hash='/'">
              <span style="font-size: 20px;">🎬</span>
              <div style="display: flex; flex-direction: column;">
                <span id="ws-pj-name" style="font-weight: 700; font-size: 15px; color: var(--neu-text);">${this.project?.name || i18n.t('backend_checking')}</span>
                <span id="health-status-header-ws" style="font-size: 10px; color: var(--neu-text-light); font-family: monospace;">${i18n.t('backend_checking')}</span>
              </div>
            </div>
          
          <!-- Task Progress Area -->
          <div style="flex: 1; display: flex; justify-content: center;">
             <div class="neu-box" style="width: 50%; height: 40px; border-radius: 20px; display: flex; align-items: center; padding: 0 15px; background: var(--neu-bg); box-shadow: var(--neu-inset); gap: 10px;">
                <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.05); border-radius: 3px; overflow: hidden;">
                   <div id="v-progress-bar" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.3s ease;"></div>
                </div>
                <span id="v-progress-text" style="font-size: 12px; font-weight: 600; min-width: 80px; text-align: right; color: var(--neu-text-light);">0 / 0</span>
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
        <div style="display: flex; flex: 1; overflow: hidden; min-height: 0;">
          
          <!-- Left Column: Classes & Propagation -->
          <div class="neu-box" style="width: 300px; border-radius: 0; box-shadow: 4px 0 12px var(--neu-shadow-dark); display: flex; flex-direction: column; z-index: 50; padding: 0; min-height: 0;">
            <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); display: flex; flex-direction: column; min-height: 0; max-height: 50%;">
               <h3 style="margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('annotations_summary')}</h3>
               <div id="video-classes-list" style="display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; min-height: 0;">
                  <!-- Class items -->
               </div>
               <button class="neu-button" id="btn-add-class-v" style="width: 100%; margin-top: 15px; font-size: 12px; font-weight: 600; color: var(--neu-text-active); padding: 10px; flex-shrink: 0;">${i18n.t('create_class')}</button>
            </div>
            
            <div style="flex: 1; overflow-y: auto; padding: 20px;">
               <h3 style="margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('propagation')}</h3>
               <div class="neu-box" style="padding: 15px; border-radius: 12px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--neu-outset-sm);">
                  <div>
                    <label style="display: block; font-size: 11px; margin-bottom: 6px; font-weight: 700;">${i18n.t('frame_range')}</label>
                    <input type="text" class="neu-input" id="propagate-range" value="0-100" />
                  </div>
                  <div>
                    <label style="display: block; font-size: 11px; margin-bottom: 6px; font-weight: 700;">${i18n.t('imgsz')} / ${i18n.t('segment_size')}</label>
                    <div style="display: flex; gap: 6px;">
                       <select id="v-imgsz" class="neu-input" style="padding: 8px; font-size:12px;">
                          <option value="640">640</option>
                          <option value="1024" selected>1024</option>
                       </select>
                       <input type="number" id="v-segment" class="neu-input" value="16" style="padding: 8px; font-size:12px; width: 60px;" />
                    </div>
                  </div>
                  <button class="neu-button" id="btn-propagate" style="width: 100%; height: 46px; font-weight: bold; color: var(--neu-text-active);">${i18n.t('propagate')}</button>
                  <p style="font-size: 11px; margin: 0; color: var(--neu-text-light); text-align: center;">${i18n.t('propagate_desc')}</p>
               </div>
            </div>
            
            <div style="padding: 20px; border-top: 1px solid rgba(0,0,0,0.05);">
               <button class="neu-button" id="btn-save-video" style="width: 100%; height: 46px; font-weight: bold; color: var(--neu-text-active);">${i18n.t('save_all')}</button>
               <button class="neu-button" id="btn-export-video" style="width: 100%; margin-top: 12px;">${i18n.t('export_dataset')}</button>
            </div>
          </div>
          
          <!-- Middle Column: Canvas & Timeline -->
          <div style="flex: 1; position: relative; display: flex; flex-direction: column; overflow: hidden; background: var(--canvas-bg); min-width: 0; min-height: 0;">
             <!-- Canvas Area -->
             <div id="video-canvas-container" style="flex: 1; position: relative;">
                <!-- CanvasViewer will be here -->
                
                <!-- Hovering Toolbar -->
                <div class="neu-box" style="position: absolute; top: 20px; left: 50%; transform: translateX(-50%); height: 50px; border-radius: 25px; display: flex; align-items: center; padding: 0 10px; z-index: 100; gap: 5px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); background: var(--canvas-toolbar-bg); border: 1px solid rgba(255,255,255,0.1);">
                   <button class="neu-button active" id="btn-vtool-point" title="Point" style="width: 40px; height: 40px; border-radius: 50%;">📍</button>
                   <button class="neu-button" id="btn-vtool-box" title="Box" style="width: 40px; height: 40px; border-radius: 50%;">🏁</button>
                   <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1); margin: 0 5px;"></div>
                   <button class="neu-button" id="btn-vtool-clear" title="Clear" style="width: 40px; height: 40px; border-radius: 50%;">🧹</button>
                </div>
             </div>

             <!-- Timeline Area -->
             <div class="neu-box" style="height: 140px; border-radius: 0; background: var(--neu-bg); z-index: 100; display: flex; flex-direction: column; padding: 15px 25px; gap: 15px; box-shadow: 0 -4px 20px rgba(0,0,0,0.1);">
                <div style="display: flex; align-items: center; gap: 20px;">
                   <div style="display: flex; gap: 10px;">
                      <button class="neu-button" id="btn-v-prev" style="width: 44px; height: 44px; border-radius: 50%;">⏪</button>
                      <button class="neu-button" id="btn-v-play" style="width: 54px; height: 44px; border-radius: 22px;">▶️</button>
                      <button class="neu-button" id="btn-v-next" style="width: 44px; height: 44px; border-radius: 50%;">⏩</button>
                   </div>
                   
                   <div style="flex: 1; position: relative; padding: 0 10px;">
                      <input type="range" class="neu-range" id="video-scrubber" min="0" max="100" value="0" style="width: 100%; height: 6px;" />
                      <div id="timeline-keyframes" style="position: absolute; top: 0; left: 10px; right: 10px; height: 6px; pointer-events: none;"></div>
                   </div>

                   <div style="display: flex; flex-direction: column; align-items: flex-end; min-width: 80px;">
                      <span id="v-time-current" style="font-weight: 700; font-size: 16px; font-family: monospace;">0:00</span>
                      <span id="v-frame-info" style="font-size: 11px; opacity: 0.6;">FRAME 0</span>
                   </div>
                </div>

                <div style="display: flex; justify-content: center; gap: 12px; align-items: center;">
                   <button class="neu-button" id="btn-infer-frame" style="padding: 10px 24px; font-weight: 700; color: var(--neu-text-active);">INFER CURRENT FRAME</button>
                   <div id="v-action-bar" style="display: none;">
                      <button class="neu-button" id="btn-vsubmit" style="padding: 10px 24px; font-weight: 800; border: 2px solid var(--neu-text-active);">SUBMIT PREVIEW</button>
                   </div>
                </div>
             </div>
          </div>
          
          <!-- Right Column: Previews & Keyframes -->
          <div class="neu-box" id="v-right-panel" style="width: 320px; border-radius: 0; box-shadow: -4px 0 12px var(--neu-shadow-dark); z-index: 50; display: flex; flex-direction: column; background: var(--neu-bg); min-height: 0;">
            <div style="padding: 20px; border-bottom: 1px solid rgba(0,0,0,0.05); display: flex; justify-content: space-between; align-items: center;">
               <div style="display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('keyframes')}</h3>
                    <span id="v-keyframe-count" class="neu-box" style="padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; box-shadow: var(--neu-inset);">0</span>
                  </div>
                  <p style="font-size: 11px; margin: 2px 0 0 0; color: var(--neu-text-light);">${i18n.t('preview_results')}</p>
               </div>
            </div>
             
             <div id="v-preview-list" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px;">
                <!-- Frame Previews -->
                <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
                   <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">🖼️</div>
                   <div style="font-size: 13px;">Annotated frames (keyframes) will appear here. Press 'Propagate' to fill the gaps.</div>
                </div>
             </div>
          </div>
        </div>

        <!-- Hidden Video for Frame Extraction -->
        <video id="main-video" style="display:none;"></video>
      </div>
    `;

    this.videoElement = document.getElementById('main-video');
    this.canvasContainer = document.getElementById('video-canvas-container');
    
    this.bindEvents();
    this.initCanvas();
    this.startHealthCheck();
    
    await this.loadAnnotations();
    this.renderClasses();
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

  initCanvas() {
    this.canvasViewer = new CanvasViewer('video-canvas-container');
    this.canvasViewer.onPromptAdded = (type, data) => this.addPrompt(type, data);
    this.updateFrameInCanvas();
  },

  async loadAnnotations() {
    try {
      const data = await api.getVideoAnnotations(this.projectId);
      if (this.isUnmounted) return;
      this.annotations = Array.isArray(data?.annotations?.frames)
        ? data.annotations.frames.map((frame) => ({
            ...frame,
            annotations: Array.isArray(frame?.annotations) ? frame.annotations : [],
          }))
        : [];
      this.updateFrameInCanvas();
      this.renderKeyframes();
      this.updateTaskProgress();
    } catch (err) {
      console.error('Failed to load annotations:', err);
    }
  },

  updateTaskProgress() {
    const total = this.project?.num_images || 0; // num_images is used for frames in video projects
    const labeled = (this.annotations || []).length;
    const progress = total > 0 ? (labeled / total) * 100 : 0;
    
    const bar = document.getElementById('v-progress-bar');
    const text = document.getElementById('v-progress-text');
    if (bar) bar.style.width = `${progress}%`;
    if (text) text.innerText = `${labeled} / ${total}`;
  },

  bindEvents() {
    // Classes
    document.getElementById('btn-add-class-v').onclick = async () => {
      const name = prompt('New class name:');
      if (name) {
        try {
          await api.addClass(this.projectId, name);
          if (!this.classes.includes(name)) this.classes.push(name);
          this.renderClasses();
        } catch (err) { alert(err.message); }
      }
    };

    // Playback
    document.getElementById('btn-v-play').onclick = () => this.togglePlay();
    document.getElementById('btn-v-prev').onclick = () => this.seekFrame(this.currentFrame - 1);
    document.getElementById('btn-v-next').onclick = () => this.seekFrame(this.currentFrame + 1);

    // Scrubber
    const scrubber = document.getElementById('video-scrubber');
    scrubber.oninput = () => {
      this.seekFrame(parseInt(scrubber.value));
    };

    // Tools
    document.getElementById('btn-vtool-point').onclick = () => this.setPromptMode('point');
    document.getElementById('btn-vtool-box').onclick = () => this.setPromptMode('box');
    document.getElementById('btn-vtool-clear').onclick = () => {
      this.currentPrompts = [];
      this.previews = [];
      this.canvasViewer.setPrompts([]);
      this.canvasViewer.setPreviews([]);
      this.updateActionBar();
    };

    // Action
    document.getElementById('btn-infer-frame').onclick = () => this.inferFrame();
    document.getElementById('btn-vsubmit').onclick = () => this.submitPreview();
    document.getElementById('btn-propagate').onclick = () => this.startPropagation();
    document.getElementById('btn-save-video').onclick = () => this.saveAll();
    
    // Theme
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

    // Video Metadata
    this.videoElement.onloadedmetadata = () => {
      const dur = this.videoElement.duration;
      const fps = 25; // Default assumption
      const totalFrames = Math.floor(dur * fps);
      document.getElementById('video-scrubber').max = totalFrames;
      this.updateTaskProgress();
    };
  },

  togglePlay() {
    this.isPlaying = !this.isPlaying;
    const btn = document.getElementById('btn-v-play');
    btn.innerText = this.isPlaying ? '⏸️' : '▶️';
    if (this.isPlaying) {
      this.playInterval = setInterval(() => {
        this.seekFrame(this.currentFrame + 1);
      }, 1000 / 25);
    } else {
      clearInterval(this.playInterval);
    }
  },

  seekFrame(index) {
    if (index < 0) index = 0;
    const max = parseInt(document.getElementById('video-scrubber').max || 0);
    if (index > max) index = max;
    
    this.currentFrame = index;
    document.getElementById('video-scrubber').value = index;
    document.getElementById('v-frame-info').innerText = `FRAME ${index}`;
    
    const sec = index / 25;
    document.getElementById('v-time-current').innerText = this.formatTime(sec);
    
    this.updateFrameInCanvas();
  },

  async updateFrameInCanvas() {
    if (!this.canvasViewer) return;
    const frameUrl = `/api/projects/${this.projectId}/video/frame/${this.currentFrame}`;
    await this.canvasViewer.loadImage(frameUrl);
    this.canvasViewer.fitToScreen();
    
    const frameData = this.annotations.find(f => f.frame_index === this.currentFrame);
    const frameAnnotations = Array.isArray(frameData?.annotations) ? frameData.annotations : [];
    if (frameAnnotations.length > 0) {
       this.canvasViewer.setAnnotations(frameAnnotations.map(obj => ({
          ...obj,
          color: this.getClassColor(obj.class_name)
       })));
    } else {
       this.canvasViewer.setAnnotations([]);
    }
  },

  setPromptMode(mode) {
    this.promptMode = mode;
    document.querySelectorAll('[id^="btn-vtool-"]').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-vtool-${mode}`).classList.add('active');
    if (this.canvasViewer) this.canvasViewer.setPromptMode(mode);
  },

  addPrompt(type, data) {
    if (!this.currentPrompts) this.currentPrompts = [];
    this.currentPrompts.push({type, data, timestamp: new Date().getTime()});
    if (this.canvasViewer) this.canvasViewer.setPrompts(this.currentPrompts);
  },

  async inferFrame() {
    alert('Current frame preview infer is not exposed by the current video backend yet. Use prompts plus Propagate, or save keyframes directly.');
  },

  updateActionBar() {
    const bar = document.getElementById('v-action-bar');
    bar.style.display = (this.previews?.length > 0) ? 'block' : 'none';
  },

  async submitPreview() {
    if (!this.previews || this.previews.length === 0) return;
    const className = this.selectedClass || (this.classes[0] || 'Object');
    
    let frameData = this.annotations.find(f => f.frame_index === this.currentFrame);
    if (!frameData) {
      frameData = { frame_index: this.currentFrame, annotations: [] };
      this.annotations.push(frameData);
    }
    
    this.previews.forEach(p => {
       frameData.annotations.push({
         ...p,
         id: 'obj_' + Math.random().toString(36).substr(2, 9),
         class_name: className
       });
    });
    
    this.previews = [];
    this.currentPrompts = [];
    this.canvasViewer.setPrompts([]);
    this.canvasViewer.setPreviews([]);
    this.updateActionBar();
    this.renderKeyframes();
    this.updateFrameInCanvas();
  },

  renderClasses() {
    const list = document.getElementById('video-classes-list');
    if (!list) return;
    list.innerHTML = this.classes.map(cls => `
      <div class="neu-button class-item ${this.selectedClass === cls ? 'active' : ''}" 
           style="justify-content: flex-start; padding: 10px 15px; border-radius: 12px;"
           onclick="window.currentWorkspace.selectClass('${cls}')">
        <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${this.getClassColor(cls)}; margin-right:10px;"></span>
        <span style="font-weight: 600;">${cls}</span>
      </div>
    `).join('');
  },

  selectClass(cls) {
    this.selectedClass = cls;
    this.renderClasses();
  },

  renderKeyframes() {
    const list = document.getElementById('v-preview-list');
    const sortedAnns = [...this.annotations].sort((a, b) => a.frame_index - b.frame_index);
    document.getElementById('v-keyframe-count').innerText = sortedAnns.length;

    if (sortedAnns.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
           <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">🖼️</div>
           <div style="font-size: 13px;">Annotated frames (keyframes) will appear here. Press 'Propagate' to fill the gaps.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = sortedAnns.map(ann => `
      <div class="neu-box" style="padding: 12px; border-radius: 12px; background: var(--neu-bg); box-shadow: var(--neu-outset-sm); cursor: pointer;" onclick="window.currentWorkspace.seekFrame(${ann.frame_index})">
         <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
            <span style="font-weight: 700; font-size: 12px;">FRAME ${ann.frame_index}</span>
            <button class="neu-button" style="width: 20px; height: 20px; padding: 0; font-size: 10px; color: #ef4444;" onclick="event.stopPropagation(); window.currentWorkspace.deleteKeyframe(${ann.frame_index})">×</button>
         </div>
         <div style="font-size: 11px; color: var(--neu-text-light);">
            Objects: ${(ann.annotations || []).length}
         </div>
      </div>
    `).join('');
  },

  deleteKeyframe(frameIndex) {
    this.annotations = this.annotations.filter(a => a.frame_index !== frameIndex);
    this.renderKeyframes();
    this.updateFrameInCanvas();
    this.updateTaskProgress();
  },

  async startPropagation() {
    const range = String(document.getElementById('propagate-range').value || '').trim();
    const imgsz = document.getElementById('v-imgsz').value;
    const segment = document.getElementById('v-segment').value;
    const match = range.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    const startFrame = match ? parseInt(match[1], 10) : 0;
    const endFrame = match ? parseInt(match[2], 10) : null;
    const promptBoxes = (this.currentPrompts || []).filter((item) => item.type === 'box').map((item) => item.data);
    const useBoxPrompt = promptBoxes.length > 0 && !!this.selectedClass;
    
    try {
      await api.startVideoJob({
        project_id: this.projectId,
        mode: 'keyframe',
        classes: useBoxPrompt ? [this.selectedClass] : (this.selectedClass ? [this.selectedClass] : this.classes),
        start_frame_index: startFrame,
        end_frame_index: endFrame,
        imgsz: parseInt(imgsz),
        segment_size_frames: parseInt(segment),
        threshold: Number(store.state.config.threshold || 0.5),
        prompt_mode: useBoxPrompt ? 'boxes' : 'text',
        prompt_frame_index: this.currentFrame,
        active_class: useBoxPrompt ? this.selectedClass : '',
        boxes: useBoxPrompt ? promptBoxes : [],
        api_base_url: store.state.config.sam3ApiUrl
      });
      alert("Propagation job started! Track it in Dashboard.");
    } catch(e) { alert(e.message); }
  },

  async saveAll() {
    try {
      await api.saveVideoAnnotations(this.projectId, this.annotations);
      alert("All changes saved!");
    } catch(e) { alert(e.message); }
  },

  formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
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

  unmount() {
    this.isUnmounted = true;
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.playInterval) clearInterval(this.playInterval);
    if (this.canvasViewer) this.canvasViewer.destroy();
    this.container = null;
    window.currentWorkspace = null;
  }
};
