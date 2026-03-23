import { api } from '../api.js';
import { CanvasViewer } from '../components/canvas-viewer.js';
import { store } from '../store.js';

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

    try {
      const data = await api.request(`/api/projects/${this.projectId}`);
      if (this.isUnmounted) return;
      this.project = data.project;
      this.classes = this.project.classes || [];
      if (this.classes.length > 0) this.selectedClass = this.classes[0];
      
      this.renderLayout();
      this.initCanvas();
      this.loadAnnotations();
    } catch (err) {
      console.error('Failed to load project:', err);
      if (!this.isUnmounted) {
        container.innerHTML = `<div class="neu-card" style="margin:20px; padding:20px; color:var(--neu-accent);">Error loading video project: ${err.message}</div>`;
      }
    }
  },

  renderLayout() {
    this.container.innerHTML = `
      <div class="app-container" style="display: flex; height: 100vh; flex-direction: column;">
        <!-- Header -->
        <div class="neu-box" style="height: 60px; display: flex; align-items: center; padding: 0 20px; z-index: 10; border-radius: 0;">
          <h2 style="margin:0; font-size: 18px; margin-right: 20px; display: flex; align-items: center; gap: 10px;">
            <span>🎬</span> 
            <span>Video Workspace</span>
            <span style="font-weight: normal; font-size: 14px; color: var(--neu-text-light);">(${this.project.name})</span>
          </h2>
          <div style="flex: 1;"></div>
          <div id="video-job-status" style="margin-right: 20px;"></div>
          <button class="neu-button" onclick="window.location.hash='/'">← Dashboard</button>
        </div>

        <div style="flex:1; display:flex; overflow:hidden;">
          <!-- Sidebar Left -->
          <div class="neu-box" style="width: 280px; display:flex; flex-direction:column; border-radius:0; border-right: 1px solid var(--neu-shadow-dark);">
            <div style="padding:15px; flex:1; overflow-y:auto;">
              <h3 style="margin-top:0; font-size:14px; color:var(--neu-text-light); text-transform:uppercase;">Classes</h3>
              <div id="video-classes-list" style="display:flex; flex-direction:column; gap:8px; margin-bottom:20px;">
                ${this.classes.map(cls => `
                  <button class="neu-button class-item ${this.selectedClass === cls ? 'active' : ''}" 
                          data-class="${cls}" style="justify-content:flex-start; text-align:left;">
                    <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${this.getClassColor(cls)}; margin-right:8px;"></span>
                    ${cls}
                  </button>
                `).join('')}
              </div>
              <button class="neu-button" id="btn-add-class-video" style="width:100%; font-size:12px;">+ Add Class</button>

              <hr style="border:0; border-top:1px solid var(--neu-shadow-dark); margin:20px 0;">

              <h3 style="font-size:14px; color:var(--neu-text-light); text-transform:uppercase;">SAM Propagation</h3>
              <div class="neu-card" style="padding:15px; margin-bottom:15px; font-size:13px;">
                <p style="margin-top:0;">Annotate current frame, then propagate masks to others.</p>
                <div style="display:flex; flex-direction:column; gap:10px;">
                   <div>
                     <label style="display:block; margin-bottom:4px; font-size:11px;">Target Frames</label>
                     <input type="text" class="neu-input" id="propagate-range" value="0-100" style="width:100%;">
                   </div>
                   <button class="neu-button-primary" id="btn-propagate" style="width:100%;">🚀 Propagate</button>
                </div>
              </div>
            </div>
            
            <div style="padding:15px; border-top: 1px solid var(--neu-shadow-dark);">
              <button class="neu-button" id="btn-save-video" style="width:100%; margin-bottom:10px;">Save Annotations</button>
              <button class="neu-button" id="btn-export-video" style="width:100%;">Export Results</button>
            </div>
          </div>

          <!-- Main Workspace -->
          <div style="flex:1; display:flex; flex-direction:column; background: var(--neu-bg); position:relative;">
             <div id="video-canvas-container" style="flex:1; position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden;">
               <!-- CanvasViewer will be here -->
               <div id="video-player-container" style="display:none; width:100%; height:100%;">
                 <video id="main-video" controls style="width:100%; height:100%; object-fit:contain;">
                    <source src="/api/projects/${this.projectId}/video/stream" type="video/mp4">
                 </video>
               </div>
             </div>

             <!-- Bottom Controls -->
             <div class="neu-box" style="height:120px; border-radius:0; border-top:1px solid var(--neu-shadow-dark); padding:15px; display:flex; flex-direction:column; gap:10px;">
               <div style="display:flex; align-items:center; gap:15px;">
                 <button class="neu-button" id="btn-toggle-mode" style="min-width:120px;">🖼️ Edit Frame</button>
                 <div style="flex:1; display:flex; align-items:center; gap:10px;">
                    <span id="video-time-current" style="font-family:monospace; min-width:60px;">0:00</span>
                    <input type="range" class="neu-range" id="video-scrubber" min="0" max="100" value="0" style="flex:1;">
                    <span id="video-time-total" style="font-family:monospace; min-width:60px;">0:00</span>
                 </div>
                 <div style="display:flex; gap:5px;">
                   <button class="neu-button" id="btn-prev-frame">前一帧</button>
                   <button class="neu-button" id="btn-next-frame">后一帧</button>
                 </div>
               </div>
               
               <div style="display:flex; justify-content:center; gap:10px;">
                  <div class="prompt-tool-group neu-box" style="display:flex; padding:5px; border-radius:12px;">
                    <button class="neu-button prompt-btn active" data-tool="point">🎯 Point</button>
                    <button class="neu-button prompt-btn" data-tool="box">📦 Box</button>
                  </div>
                  <button class="neu-button-accent" id="btn-infer-frame">SAM Infer</button>
                  <button class="neu-button" id="btn-clear-frame">Clear Frame</button>
               </div>
             </div>
          </div>
        </div>
      </div>
    `;

    this.videoElement = document.getElementById('main-video');
    this.bindEvents();
  },

  initCanvas() {
    const container = document.getElementById('video-canvas-container');
    this.canvasViewer = new CanvasViewer(container);
    this.updateFrameInCanvas();
  },

  updateFrameInCanvas() {
    const frameUrl = `/api/projects/${this.projectId}/video/frame/${this.currentFrame}?t=${Date.now()}`;
    this.canvasViewer.setImage(frameUrl);
    // TODO: Apply existing annotations for this frame
    const frameData = this.annotations.find(f => f.frame_index === this.currentFrame);
    if (frameData && frameData.objects) {
       this.canvasViewer.setMasks(frameData.objects.map(obj => ({
         id: obj.id,
         label: obj.class_name,
         color: this.getClassColor(obj.class_name),
         points: obj.mask_rle || [] // Simplification
       })));
    } else {
       this.canvasViewer.setMasks([]);
    }
  },

  async loadAnnotations() {
    try {
      const data = await api.getVideoAnnotations(this.projectId);
      if (this.isUnmounted) return;
      this.annotations = data.frames || [];
      this.updateFrameInCanvas();
    } catch (err) {
      console.error('Failed to load annotations:', err);
    }
  },

  bindEvents() {
    // Classes
    this.container.querySelectorAll('.class-item').forEach(btn => {
      btn.onclick = () => {
        this.selectedClass = btn.dataset.class;
        this.container.querySelectorAll('.class-item').forEach(b => b.classList.toggle('active', b === btn));
      };
    });

    // Add Class
    const btnAddClass = document.getElementById('btn-add-class-video');
    if (btnAddClass) {
      btnAddClass.onclick = async () => {
        const name = prompt('Enter new class name:');
        if (name) {
          try {
            await api.addClass(this.projectId, name);
            this.classes.push(name);
            this.renderLayout(); // Re-render to update list
          } catch (err) {
            alert('Failed to add class: ' + err.message);
          }
        }
      };
    }

    // Toggle Mode (Edit vs Play)
    const btnToggle = document.getElementById('btn-toggle-mode');
    const playerContainer = document.getElementById('video-player-container');
    btnToggle.onclick = () => {
       const isEdit = playerContainer.style.display === 'none';
       if (isEdit) {
         // Switch to Play
         playerContainer.style.display = 'block';
         btnToggle.innerText = '🖼️ Edit Frame';
         this.canvasViewer.container.style.display = 'none';
       } else {
         // Switch to Edit
         playerContainer.style.display = 'none';
         btnToggle.innerText = '🎥 Play Video';
         this.canvasViewer.container.style.display = 'flex';
         this.currentFrame = Math.floor(this.videoElement.currentTime * 25); // Assume 25fps for now
         this.updateFrameInCanvas();
       }
    };

    // Scrubber
    const scrubber = document.getElementById('video-scrubber');
    scrubber.oninput = () => {
      this.currentFrame = parseInt(scrubber.value);
      this.updateFrameInCanvas();
    };

    // Save
    document.getElementById('btn-save-video').onclick = async () => {
      try {
        await api.saveVideoAnnotations(this.projectId, this.annotations);
        alert('Annotations saved successfully!');
      } catch (err) {
        alert('Failed to save: ' + err.message);
      }
    };

    // Export
    document.getElementById('btn-export-video').onclick = async () => {
      try {
        const res = await api.request('/api/export', {
          method: 'POST',
          body: JSON.stringify({ project_id: this.projectId, format: 'json' })
        });
        alert('Export started! Check: ' + res.filepath);
      } catch (err) {
        alert('Export failed: ' + err.message);
      }
    };

    // Frame Nav
    document.getElementById('btn-prev-frame').onclick = () => {
      if (this.currentFrame > 0) {
        this.currentFrame--;
        this.updateScrubber();
        this.updateFrameInCanvas();
      }
    };
    document.getElementById('btn-next-frame').onclick = () => {
      if (this.currentFrame < 1000) { // Assume max for now or get from metadata
        this.currentFrame++;
        this.updateScrubber();
        this.updateFrameInCanvas();
      }
    };

    // Video events
    this.videoElement.onloadedmetadata = () => {
      const dur = this.videoElement.duration;
      document.getElementById('video-time-total').innerText = this.formatTime(dur);
      const fps = 25; // Default assumption
      const totalFrames = Math.floor(dur * fps);
      const scrubber = document.getElementById('video-scrubber');
      if (scrubber) scrubber.max = totalFrames;
    };

    this.videoElement.ontimeupdate = () => {
      document.getElementById('video-time-current').innerText = this.formatTime(this.videoElement.currentTime);
      if (this.videoElement.style.display !== 'none') {
         // Auto update frame index in Play mode
         this.currentFrame = Math.floor(this.videoElement.currentTime * 25);
         this.updateScrubber();
      }
    };
  },

  updateScrubber() {
    const scrubber = document.getElementById('video-scrubber');
    if (scrubber) scrubber.value = this.currentFrame;
  },

  formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  },

  async startPropagation() {
    const rangeStr = document.getElementById('propagate-range').value;
    const prompts = this.canvasViewer.getPrompts();
    if (prompts.length === 0) return alert('No prompts to propagate.');

    try {
      // Start video job (tracker + SAM)
      const payload = {
        project_id: this.projectId,
        classes: this.classes,
        prompt_added: true,
        prompt_frame_index: this.currentFrame,
        prompt_boxes: prompts.filter(p => p.type === 'box').map((p, i) => ({
            id: 'obj_' + i,
            class_name: this.selectedClass,
            box: [p.x1, p.y1, p.x2, p.y2]
        })),
        prompt_points: prompts.filter(p => p.type === 'point').map((p, i) => ({
            id: 'obj_' + i, // In unified tracking, multiple points might mean one object
            class_name: this.selectedClass,
            points: [p.x, p.y, p.label === null ? 1 : p.label]
        }))
      };
      await api.startVideoJob(payload);
      alert('Propagation job started! Check Task Manager.');
    } catch (err) {
      alert('Failed to start propagation: ' + err.message);
    }
  },

  getClassColor(className) {
    const idx = this.classes.indexOf(className);
    return `hsl(${ (idx * 137.5) % 360 }, 70%, 50%)`;
  },

  unmount() {
    this.isUnmounted = true;
    if (this.abortController) this.abortController.abort();
    if (this.canvasViewer) this.canvasViewer.destroy();
    this.container = null;
  }
};
