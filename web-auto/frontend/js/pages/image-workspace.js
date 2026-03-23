import { api } from '../api.js';
import { CanvasViewer } from '../components/canvas-viewer.js';
import { FilterUI } from '../components/filter.js';

export const ImageWorkspace = {
  container: null,
  projectId: null,
  projectMeta: null,
  images: [],
  offset: 0,
  limit: 50,
  totalImages: 0,
  selectedImageId: null,
  viewer: null,
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    
    container.innerHTML = `
      <div style="display: flex; height: 100vh; flex-direction: column;">
        <!-- Toolbar -->
        <div class="neu-box" style="height: 60px; display: flex; align-items: center; padding: 0 20px; z-index: 10; border-radius: 0;">
          <h2 style="margin:0; font-size: 18px; margin-right: 20px;">Image Workspace <span id="ws-pj-name" style="font-weight: normal; font-size: 14px; color: var(--neu-text-light);">Loading...</span></h2>
          <div style="flex: 1;"></div>
          <button class="neu-button" onclick="window.location.hash='/'">← Back to List</button>
        </div>
        
        <!-- Main Area -->
        <div style="display: flex; flex: 1; overflow: hidden;">
          <!-- Left Panel: Image List -->
          <div class="neu-box" style="width: 280px; border-radius: 0; box-shadow: 5px 0 10px var(--neu-shadow-dark); display: flex; flex-direction: column; z-index: 5;">
            <div style="padding: 16px; border-bottom: 2px solid var(--neu-bg); box-shadow: var(--neu-inset);">
              <h3 style="margin: 0 0 10px 0; font-size: 16px;">Images (<span id="ws-img-count">0</span>)</h3>
              <div style="display: flex; gap: 8px;">
                 <button class="neu-button" style="padding: 6px 12px; flex: 1;" id="btn-img-refresh">Refresh</button>
              </div>
            </div>
            <div id="image-list-container" style="flex: 1; overflow-y: auto; padding: 8px;">
              <div style="text-align:center; padding: 20px; color: var(--neu-text-light);">Loading images...</div>
            </div>
            <div style="padding: 12px; display: flex; justify-content: space-between; border-top: 2px solid var(--neu-bg); box-shadow: var(--neu-inset); align-items: center;">
              <button class="neu-button" style="padding: 6px 12px;" id="btn-img-prev">Prev</button>
              <span id="ws-page-info" style="font-size: 12px; color: var(--neu-text-light);">1 / 1</span>
              <button class="neu-button" style="padding: 6px 12px;" id="btn-img-next">Next</button>
            </div>
          </div>
          
          <!-- Center Panel: Canvas -->
          <div style="flex: 1; position: relative; overflow: hidden;" id="canvas-container">
             <div id="canvas-placeholder" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: var(--neu-text-light); font-size: 24px; font-weight: bold; pointer-events: none;">Select an image to start</div>
          </div>
          
          <!-- Right Panel: Properties & Tools -->
          <div class="neu-box" id="right-panel" style="width: 320px; border-radius: 0; box-shadow: -5px 0 10px var(--neu-shadow-dark); z-index: 5; display: flex; flex-direction: column; overflow-y: auto;">
             <div style="padding: 0;">
                
                <!-- Annotations Section -->
                <div style="padding: 16px; border-bottom: 2px solid var(--neu-bg);">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <h3 style="margin:0; font-size: 16px;">Annotations</h3>
                    <button class="neu-button" id="btn-clear-anns" style="padding: 4px 8px; font-size: 12px; color: #e53e3e;">Clear</button>
                  </div>
                  <div id="anns-list" style="max-height: 200px; overflow-y: auto; background: var(--neu-bg); box-shadow: var(--neu-inset); border-radius: 8px; padding: 8px;">
                     <div style="color: var(--neu-text-light); font-size: 13px; text-align: center; padding: 10px;">Select an image first</div>
                  </div>
                </div>

                <!-- Tools Section -->
                <div style="padding: 16px;">
                  <h3 style="margin-top:0; font-size: 16px;">Tools</h3>
                  <button class="neu-button" id="btn-infer" style="width: 100%; margin-bottom: 12px; color: var(--neu-text-active);">Auto Infer (Text)</button>
                  <button class="neu-button" id="btn-batch" style="width: 100%;">Batch Infer Dataset</button>
                </div>
                
                <!-- Filter Section -->
                <div id="filter-container"></div>
                
                <!-- Export Section -->
                <div style="padding: 16px; border-top: 2px solid var(--neu-bg);">
                   <h3 style="margin-top:0; font-size: 16px;">Export Dataset</h3>
                   <div style="display: flex; gap: 8px;">
                     <select id="exp-format" class="neu-input" style="padding: 8px; flex: 1;">
                       <option value="coco">COCO</option>
                       <option value="yolo">YOLO</option>
                       <option value="json">JSON</option>
                     </select>
                     <button class="neu-button" id="btn-export" style="color: var(--neu-text-active);">Export</button>
                   </div>
                </div>
             </div>
          </div>
        </div>
      </div>
    `;
    
    this.viewer = new CanvasViewer('canvas-container');
    FilterUI.render('filter-container', this.projectId);
    this.bindEvents();
    
    await this.loadProjectInfo();
    await this.loadImages();
  },

  unmount() {
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    this.container = null;
  },

  bindEvents() {
    document.getElementById('btn-img-refresh').onclick = async () => {
      try {
        await api.refreshImages(this.projectId);
        this.offset = 0;
        await this.loadProjectInfo();
        await this.loadImages();
      } catch(e) {
        alert(e.message);
      }
    };
    
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
    
    document.getElementById('btn-clear-anns').onclick = async () => {
      if (!this.selectedImageId) return;
      if (!confirm("Clear all annotations?")) return;
      try {
        await api.saveAnnotations(this.projectId, this.selectedImageId, []);
        await this.selectImage(this.selectedImageId, this.selectedImagePath);
      } catch(e) { alert(e.message); }
    };
    
    document.getElementById('btn-infer').onclick = async () => {
      if (!this.selectedImageId) return;
      const btn = document.getElementById('btn-infer');
      btn.textContent = 'Inferring...';
      btn.disabled = true;
      try {
        await api.inferSingle({
           project_id: this.projectId,
           image_id: this.selectedImageId,
           mode: 'text',
           classes: this.projectMeta.classes || [],
           threshold: 0.5
        });
        await this.selectImage(this.selectedImageId, this.selectedImagePath);
      } catch(e) {
        alert(e.message);
      } finally {
         btn.textContent = 'Auto Infer (Text)';
         btn.disabled = false;
      }
    };
    
    document.getElementById('btn-batch').onclick = async () => {
      if (!confirm("Start batch inference for all images based on current project classes?")) return;
      try {
        await api.startBatchInfer({
          project_id: this.projectId,
          classes: this.projectMeta.classes || [],
          all_images: true,
          batch_size: 4,
          threshold: 0.5
        });
        alert("Batch task started. See task manager.");
        if (window.taskManager) window.taskManager.pollActiveJobs();
      } catch(e) { alert(e.message); }
    };
    
    document.getElementById('btn-export').onclick = async () => {
      const format = document.getElementById('exp-format').value;
      const btn = document.getElementById('btn-export');
      btn.textContent = '...';
      btn.disabled = true;
      try {
        await api.exportProject({
          project_id: this.projectId,
          format: format,
          include_bbox: true,
          include_mask: true
        });
        alert(`Export to ${format.toUpperCase()} triggered. Check the save directory on the server.`);
      } catch(e) {
        alert("Export failed: " + e.message);
      } finally {
        btn.textContent = 'Export';
        btn.disabled = false;
      }
    };
  },

  async loadProjectInfo() {
    try {
      this.projectMeta = await api.getProject(this.projectId, false);
      document.getElementById('ws-pj-name').innerText = `- ${this.projectMeta.name}`;
      document.getElementById('ws-img-count').innerText = this.projectMeta.num_images;
      this.totalImages = this.projectMeta.num_images || 0;
    } catch(err) {
      console.error(err);
    }
  },
  
  async loadImages() {
    const listCont = document.getElementById('image-list-container');
    listCont.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--neu-text-light);">Loading...</div>';
    try {
      const data = await api.getImages(this.projectId, this.offset, this.limit);
      this.images = data.items || [];
      this.totalImages = data.total || 0;
      
      const totalPages = Math.ceil(this.totalImages / this.limit) || 1;
      const currPage = Math.floor(this.offset / this.limit) + 1;
      document.getElementById('ws-page-info').innerText = `${currPage} / ${totalPages}`;
      
      if (this.images.length === 0) {
         listCont.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--neu-text-light);">No images found</div>';
         return;
      }
      
      let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
      for(const img of this.images) {
        const isSel = this.selectedImageId === img.id;
        const bgState = isSel ? 'var(--neu-inset)' : 'var(--neu-bg)';
        const colorState = isSel ? 'var(--neu-text-active)' : 'var(--neu-text)';
        const shadowState = isSel ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
        
        let statusDot = img.status === 'labeled' ? '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#48bb78; margin-right:6px;"></span>' : '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#e2e8f0; margin-right:6px;"></span>';
        
        // Use inline onclick accessing a global instance variable
        html += `
          <div class="neu-button" style="justify-content: flex-start; text-align: left; padding: 10px; background: ${bgState}; box-shadow: ${shadowState}; color: ${colorState}; font-weight: ${isSel ? 'bold' : 'normal'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" onclick="window.currentWorkspace.selectImage('${img.id}', '${img.rel_path}')">
             ${statusDot} ${img.rel_path}
          </div>
        `;
      }
      html += '</div>';
      listCont.innerHTML = html;
      
    } catch(e) {
      listCont.innerHTML = `<div style="color: #e53e3e; padding: 10px;">${e.message}</div>`;
    }
  },
  
  async selectImage(id, relPath) {
    this.selectedImageId = id;
    this.selectedImagePath = relPath;
    
    // Refresh list to show active state
    await this.loadImages();
    
    document.getElementById('canvas-placeholder').style.display = 'none';
    const annsList = document.getElementById('anns-list');
    annsList.innerHTML = '<div style="text-align:center; padding: 10px; color: var(--neu-text-light);">Loading annotations...</div>';
    
    try {
      // Load Image
      // Ensure we hit the right API endpoint
      const imgUrl = `/api/projects/${this.projectId}/images/${id}/file`;
      await this.viewer.loadImage(imgUrl);
      
      // Load Annotations
      const anns = await api.getAnnotations(this.projectId, id);
      this.viewer.setAnnotations(anns || []);
      
      // Render Annotations sidebar
      if (!anns || anns.length === 0) {
         annsList.innerHTML = '<div style="color: var(--neu-text-light); font-size: 13px; text-align: center; padding: 10px;">No annotations</div>';
      } else {
         let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
         for(const a of anns) {
            html += `
              <div style="background: var(--neu-bg); box-shadow: var(--neu-outset-sm); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
                 <div>
                   <div style="font-weight: 600; font-size: 13px;">${a.class_name}</div>
                   ${a.score ? `<div style="font-size: 11px; color: var(--neu-text-light);">Score: ${a.score.toFixed(3)}</div>` : ''}
                 </div>
                 <button class="neu-button" style="padding: 4px 6px; color: #e53e3e; font-size: 11px;" onclick="window.currentWorkspace.deleteAnnotation('${a.id}')">Del</button>
              </div>
            `;
         }
         html += '</div>';
         annsList.innerHTML = html;
      }
      
    } catch(e) {
      console.error(e);
      annsList.innerHTML = '<div style="color: #e53e3e; font-size: 13px; text-align: center; padding: 10px;">Error loading annotations</div>';
    }
  },
  
  async deleteAnnotation(annId) {
    if (!this.selectedImageId) return;
    try {
      // Since API only has saveAnnotations (overwrite), we fetch current, remove, and save over.
      const anns = await api.getAnnotations(this.projectId, this.selectedImageId);
      const newAnns = anns.filter(a => a.id !== annId);
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
    } catch(e) {
      alert("Failed to delete annotation: " + e.message);
    }
  }
};

window.currentWorkspace = ImageWorkspace;
