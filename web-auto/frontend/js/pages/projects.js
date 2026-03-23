import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';

export const ProjectsPage = {
  container: null,

  async render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="app-container" style="overflow-y: auto;">
        <!-- Top Title Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; border-bottom: 1px solid rgba(0,0,0,0.05);">
           <div>
             <h1 style="margin:0; font-size: 28px; font-weight: 800; letter-spacing: -1.5px; display: inline-block;">web-auto</h1>
             <span style="margin-left: 12px; color: var(--neu-text-light); font-size: 14px; font-weight: 500;">SAM3 标注工作台</span>
           </div>
           <div style="display: flex; gap: 16px; align-items: center;">
              <div id="health-indicator" title="Backend Health">
                <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--neu-text-light);">
                  <span id="health-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ccc;"></span>
                  Backend: <span id="health-text">Checking...</span>
                </div>
              </div>
              <button id="btn-toggle-theme" class="neu-button" title="Toggle Mode" style="padding: 8px 12px;">
                 <span id="theme-icon">🌓</span>
              </button>
              <button id="btn-settings" class="neu-button" style="padding: 8px 16px;">Settings</button>
           </div>
        </div>

        <div style="display: flex; flex: 1; min-height: 0;">
          <!-- Left Panel: Create Project (35%) -->
          <div style="width: 35%; padding: 30px; border-right: 1px solid rgba(0,0,0,0.05); overflow-y: auto;">
            <div class="neu-card" style="padding: 24px;">
              <h2 style="margin-top:0; margin-bottom: 24px; font-size: 20px;">创建新项目</h2>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">项目名称</label>
                <input type="text" id="inp-pj-name" class="neu-input" placeholder="项目名称" />
              </div>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">项目类型</label>
                <select id="inp-pj-type" class="neu-input">
                  <option value="image">图片项目 (Images)</option>
                  <option value="video">视频项目 (Video)</option>
                </select>
              </div>
              <div style="margin-bottom: 16px;" id="dir-image-wrapper">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">图片目录</label>
                <input type="text" id="inp-pj-imgdir" class="neu-input" placeholder="/absolute/path/to/images" />
              </div>
              <div style="margin-bottom: 16px; display: none;" id="dir-video-wrapper">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">视频文件路径</label>
                <input type="text" id="inp-pj-vidpath" class="neu-input" placeholder="/absolute/path/to/video.mp4" />
              </div>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">初始类别 (支持逗号/换行)</label>
                <textarea id="inp-pj-classes" class="neu-input" style="height: 80px; resize: none;" placeholder="cat, dog, person"></textarea>
              </div>
              <div style="margin-bottom: 24px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">输出目录 (选填)</label>
                <input type="text" id="inp-pj-savedir" class="neu-input" placeholder="留空则使用默认路径" />
              </div>
              <button id="btn-submit-new" class="neu-button" style="width: 100%; color: var(--neu-text-active); font-weight: bold; padding: 14px;">创建项目</button>
            </div>
          </div>

          <!-- Right Panel: Project List (65%) -->
          <div style="width: 65%; padding: 30px; overflow-y: auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
              <h2 style="margin:0; font-size: 20px;">项目列表</h2>
              <div style="font-size: 13px; color: var(--neu-text-light);">共 <span id="pj-count">0</span> 个项目</div>
            </div>
            <div id="projects-list-container" style="display: flex; flex-direction: column; gap: 20px;">
               <!-- Projects will load here -->
            </div>
          </div>
        </div>
      </div>
      
      <!-- Modal for Upload/Add Data -->
      <div id="modal-upload" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 450px; padding: 30px;">
          <h2 style="margin-top:0;">新增数据</h2>
          <p style="font-size:13px; color:var(--neu-text-light); margin-bottom: 20px;">上传图片到项目目录。同名文件将自动重命名。</p>
          <div id="drop-zone" class="neu-box" style="height: 180px; border: 2px dashed rgba(0,0,0,0.1); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s;">
            <span style="font-size: 40px; margin-bottom: 10px;">⁺</span>
            <span style="font-size: 14px; font-weight: 500;">拖拽图片到此处 或 点击选择</span>
            <input type="file" id="inp-upload-files" multiple accept="image/*" style="display:none;" />
          </div>
          <div id="upload-status" style="margin-top: 16px; font-size: 12px; height: 20px; color: var(--neu-text-active);"></div>
          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px;">
            <button id="btn-close-upload" class="neu-button">取消</button>
          </div>
        </div>
      </div>

      <!-- Modal for Settings (Kept from before) -->
      <div id="modal-settings" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 400px;">
          <h2 style="margin-top:0;">Global Settings</h2>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">sam3-api URL (Local)</label>
            <input type="text" id="inp-set-samurl" class="neu-input" />
          </div>
          <div style="margin-bottom: 24px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Global Cache Directory (Server)</label>
            <input type="text" id="inp-set-cachedir" class="neu-input" placeholder="/absolute/path/to/data" />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="btn-save-settings" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">Save</button>
            <button id="btn-close-settings" class="neu-button">Close</button>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.loadProjects();
    this.checkHealth();
  },

  unmount() {
    this.container = null;
    if (this._healthTimer) clearInterval(this._healthTimer);
  },

  async checkHealth() {
    const dot = document.getElementById('health-dot');
    const text = document.getElementById('health-text');
    try {
      const start = Date.now();
      await api.getProjects(); // Simple ping
      const ms = Date.now() - start;
      dot.style.background = '#48bb78'; // Green
      text.textContent = `Online (${ms}ms)`;
    } catch(e) {
      dot.style.background = '#f56565'; // Red
      text.textContent = 'Offline';
    }
    if (!this._healthTimer) {
      this._healthTimer = setInterval(() => this.checkHealth(), 10000);
    }
  },

  bindEvents() {
    const btnSet = document.getElementById('btn-settings');
    const btnTheme = document.getElementById('btn-toggle-theme');
    const modalSet = document.getElementById('modal-settings');
    const btnSubmitNew = document.getElementById('btn-submit-new');
    const btnCloseSet = document.getElementById('btn-close-settings');
    const inpSamUrl = document.getElementById('inp-set-samurl');
    const typeSelect = document.getElementById('inp-pj-type');
    const imgWrapper = document.getElementById('dir-image-wrapper');
    const vidWrapper = document.getElementById('dir-video-wrapper');

    const updateThemeIcon = () => {
       const icon = document.getElementById('theme-icon');
       if (icon) icon.innerText = store.state.config.theme === 'dark' ? '☀️' : '🌓';
    };
    updateThemeIcon();

    btnTheme.onclick = () => {
      const current = store.state.config.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      store.setConfig('theme', next);
      updateThemeIcon();
      showToast(`Switched to ${next} mode`);
    };

    typeSelect.onchange = (e) => {
      if(e.target.value === 'image') {
        imgWrapper.style.display = 'block';
        vidWrapper.style.display = 'none';
      } else {
        imgWrapper.style.display = 'none';
        vidWrapper.style.display = 'block';
      }
    };

    btnSubmitNew.onclick = async () => {
      try {
        const payload = {
          name: document.getElementById('inp-pj-name').value,
          project_type: typeSelect.value,
          classes_text: document.getElementById('inp-pj-classes').value,
        };
        const saveDir = document.getElementById('inp-pj-savedir').value.trim();
        if (saveDir) payload.save_dir = saveDir;
        
        if (payload.project_type === 'image') {
          payload.image_dir = document.getElementById('inp-pj-imgdir').value;
        } else {
          payload.video_path = document.getElementById('inp-pj-vidpath').value;
        }
        
        btnSubmitNew.textContent = 'Creating...';
        btnSubmitNew.disabled = true;
        await api.createProject(payload);
        this.loadProjects(); 
        // Clear form
        document.getElementById('inp-pj-name').value = '';
        document.getElementById('inp-pj-classes').value = '';
      } catch (err) {
        alert(err.message);
      } finally {
        btnSubmitNew.textContent = '创建项目';
        btnSubmitNew.disabled = false;
      }
    };

    btnSet.onclick = async () => {
      inpSamUrl.value = store.state.config.sam3ApiUrl;
      modalSet.style.display = 'flex';
      try {
        const res = await api.getCacheDir();
        if (res && res.cache_dir) document.getElementById('inp-set-cachedir').value = res.cache_dir;
      } catch(e) {}
    };
    
    document.getElementById('btn-save-settings').onclick = async () => {
      store.setConfig('sam3ApiUrl', inpSamUrl.value);
      const newCacheDir = document.getElementById('inp-set-cachedir').value;
      if (newCacheDir) {
        try { await api.setCacheDir(newCacheDir); } catch(e) { alert(e.message); }
      }
      modalSet.style.display = 'none';
    };

    btnCloseSet.onclick = () => modalSet.style.display = 'none';

    // Upload / Add Data Modal
    const modalUpload = document.getElementById('modal-upload');
    const dropZone = document.getElementById('drop-zone');
    const inpFile = document.getElementById('inp-upload-files');
    const btnCloseUpload = document.getElementById('btn-close-upload');

    btnCloseUpload.onclick = () => modalUpload.style.display = 'none';
    dropZone.onclick = () => inpFile.click();
    
    inpFile.onchange = (e) => this.handleUpload(e.target.files);
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.background = 'rgba(0,0,0,0.02)'; };
    dropZone.ondragleave = () => { dropZone.style.background = 'transparent'; };
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.style.background = 'transparent';
      this.handleUpload(e.dataTransfer.files);
    };
  },

  async handleUpload(files) {
    if (!files || files.length === 0) return;
    const status = document.getElementById('upload-status');
    const projectId = this._uploadingProjectId;
    if (!projectId) return;

    status.textContent = `Uploading ${files.length} items...`;
    try {
      for (const file of files) {
        await api.uploadImage(projectId, file);
      }
      status.textContent = 'Upload complete! Refreshing...';
      setTimeout(() => {
        document.getElementById('modal-upload').style.display = 'none';
        this.loadProjects();
      }, 1000);
    } catch(e) {
      status.textContent = 'Upload failed: ' + e.message;
    }
  },

  async loadProjects() {
    if (!this.container) return;
    const listCont = document.getElementById('projects-list-container');
    const countSpan = document.getElementById('pj-count');
    try {
      const data = await api.getProjects();
      const projects = data.projects || [];
      countSpan.textContent = projects.length;

      if (projects.length === 0) {
        listCont.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--neu-text-light);">No projects found. Create one to start.</div>';
        return;
      }
      
      listCont.innerHTML = projects.map(p => {
        const isVideo = p.project_type === 'video';
        const typeLabel = isVideo ? 'Video' : 'Image';
        const total = isVideo ? p.num_frames : p.num_images;
        const labeled = p.labeled_images || 0;
        const progress = total > 0 ? Math.round((labeled / total) * 100) : 0;
        
        return `
          <div class="neu-card" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div style="display: flex; gap: 20px; align-items: center;">
                <div class="neu-box" style="width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: var(--neu-inset);">
                  ${isVideo ? '🎬' : '🖼️'}
                </div>
                <div>
                  <h3 style="margin: 0; font-size: 18px;">${p.name}</h3>
                  <div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px;">ID: ${p.id}</div>
                </div>
              </div>
              <div style="display: flex; gap: 10px;">
                <button class="neu-button" onclick="window.projectsPage.openProject('${p.id}', '${p.project_type}')" style="color: var(--neu-text-active); font-weight:600;">Open</button>
                ${!isVideo ? `<button class="neu-button" onclick="window.projectsPage.showUpload('${p.id}')">新增数据</button>` : ''}
                <button class="neu-button" onclick="window.projectsPage.deleteProject('${p.id}')" style="color: #e53e3e;">Delete</button>
              </div>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 16px; background: rgba(0,0,0,0.02); border-radius: 8px; font-size: 13px;">
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">TYPE</div>
                <div style="font-weight: 700;">${typeLabel.toUpperCase()}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">TOTAL</div>
                <div style="font-weight: 700;">${total}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">LABELED</div>
                <div style="font-weight: 700; color: #48bb78;">${labeled}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">UNLABELED</div>
                <div style="font-weight: 700; color: var(--neu-text-active);">${total - labeled}</div>
              </div>
            </div>

            <div style="font-size: 12px; color: var(--neu-text-light); display: flex; gap: 20px;">
               <span><strong style="color:var(--neu-text);">Path:</strong> ${p.image_dir || p.video_path}</span>
               <span style="margin-left:auto;">Created: ${new Date(p.created_at * 1000).toLocaleDateString()}</span>
            </div>

            <div style="width: 100%; height: 6px; background: var(--neu-inset); border-radius: 3px; overflow: hidden; margin-top: 4px;">
              <div style="width: ${progress}%; height: 100%; background: var(--neu-text-active);"></div>
            </div>
          </div>
        `;
      }).join('');
      
    } catch (err) {
      listCont.innerHTML = `<div style="padding: 40px; text-align: center; color: #e53e3e;">Failed to load projects: ${err.message}</div>`;
    }
  },

  showUpload(projectId) {
    this._uploadingProjectId = projectId;
    document.getElementById('modal-upload').style.display = 'flex';
    document.getElementById('upload-status').textContent = '';
  },

  openProject(id, type) {
    if (type === 'image') router.navigate(`/project/image/${id}`);
    else router.navigate(`/project/video/${id}`);
  },

  async deleteProject(id) {
    if(!confirm("Are you sure you want to delete this project? Data goes away, files stay.")) return;
    try {
      await api.deleteProject(id);
      showToast("Project deleted");
      this.loadProjects();
    } catch(err) { showToast("Delete failed: " + err.message, "error"); }
  }
};

// Simple Toast System
window.showToast = (message, type = 'info') => {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = 'neu-box toast-item';
  toast.style.cssText = `
    padding: 12px 24px;
    border-radius: 30px;
    background: var(--neu-bg);
    box-shadow: var(--neu-outset-sm);
    color: ${type === 'error' ? '#ef4444' : 'var(--neu-text-active)'};
    font-size: 13px;
    font-weight: 600;
    margin-top: 10px;
    animation: slideIn 0.3s ease-out;
    pointer-events: auto;
  `;
  toast.innerText = message;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
};

function createToastContainer() {
  const c = document.createElement('div');
  c.id = 'toast-container';
  c.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
  `;
  document.body.appendChild(c);
  return c;
}

// Add slide animations to document
const style = document.createElement('style');
style.innerHTML = `
  @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes slideOut { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-20px); opacity: 0; } }
`;
document.head.appendChild(style);

window.projectsPage = ProjectsPage;
