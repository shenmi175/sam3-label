import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';
import { i18n } from '../i18n.js';

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
             <span id="health-status-header" style="margin-left: 12px; color: var(--neu-text-light); font-size: 14px; font-weight: 500;">${i18n.t('backend_checking')}</span>
           </div>
           <div style="display: flex; gap: 16px; align-items: center;">
              <div id="health-indicator" title="Backend Health">
                <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--neu-text-light);">
                  <span id="health-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ccc;"></span>
                  ${i18n.t('dashboard')}: <span id="health-text">${i18n.t('backend_checking')}</span>
                </div>
              </div>
              <button id="btn-toggle-theme" class="neu-button" title="${i18n.t('toggle_theme')}" style="padding: 8px 12px;">
                 <span id="theme-icon">🌓</span>
              </button>
              <button id="btn-settings" class="neu-button" style="padding: 8px 16px;">${i18n.t('global_settings')}</button>
           </div>
        </div>

        <div style="display: flex; flex: 1; min-height: 0;">
          <!-- Left Panel: Create Project (35%) -->
          <div style="width: 35%; padding: 30px; border-right: 1px solid rgba(0,0,0,0.05); overflow-y: auto;">
            <div class="neu-card" style="padding: 24px;">
              <h2 style="margin-top:0; margin-bottom: 24px; font-size: 20px;">${i18n.t('new_project')}</h2>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('project_name')}</label>
                <input type="text" id="inp-pj-name" class="neu-input" placeholder="${i18n.t('project_name')}" />
              </div>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('project_type')}</label>
                <select id="inp-pj-type" class="neu-input">
                  <option value="image">${i18n.t('image_project')}</option>
                  <option value="video">${i18n.t('video_project')}</option>
                </select>
              </div>
              <div style="margin-bottom: 16px;" id="dir-image-wrapper">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('image_dir')}</label>
                <input type="text" id="inp-pj-imgdir" class="neu-input" placeholder="/absolute/path/to/images" />
              </div>
              <div style="margin-bottom: 16px; display: none;" id="dir-video-wrapper">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('video_path')}</label>
                <input type="text" id="inp-pj-vidpath" class="neu-input" placeholder="/absolute/path/to/video.mp4" />
              </div>
              <div style="margin-bottom: 16px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('initial_classes')}</label>
                <textarea id="inp-pj-classes" class="neu-input" style="height: 80px; resize: none;" placeholder="cat, dog, person"></textarea>
              </div>
              <div style="margin-bottom: 24px;">
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('save_dir')}</label>
                <input type="text" id="inp-pj-savedir" class="neu-input" placeholder="..." />
              </div>
              <button id="btn-submit-new" class="neu-button" style="width: 100%; color: var(--neu-text-active); font-weight: bold; padding: 14px;">${i18n.t('create_btn')}</button>
            </div>
          </div>

          <!-- Right Panel: Project List (65%) -->
          <div style="width: 65%; padding: 30px; overflow-y: auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
              <h2 style="margin:0; font-size: 20px;">${i18n.t('project_list')}</h2>
              <div id="pj-count-label" style="font-size: 13px; color: var(--neu-text-light);">${i18n.t('total_projects', {count: '<span id="pj-count">0</span>'})}</div>
            </div>
            <div id="projects-list-container" style="display: flex; flex-direction: column; gap: 20px;">
               <!-- Projects will load here -->
            </div>
          </div>
        </div>
      </div>
      
      <div id="modal-upload" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 450px; padding: 30px;">
          <h2 style="margin-top:0;">${i18n.t('add_data_title')}</h2>
          <p style="font-size:13px; color:var(--neu-text-light); margin-bottom: 20px;">${i18n.t('add_data_desc')}</p>
          <div id="drop-zone" class="neu-box" style="height: 180px; border: 2px dashed rgba(0,0,0,0.1); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s;">
            <span style="font-size: 40px; margin-bottom: 10px;">⁺</span>
            <span style="font-size: 14px; font-weight: 500;">${i18n.t('drop_zone')}</span>
            <input type="file" id="inp-upload-files" multiple accept="image/*" style="display:none;" />
          </div>
          <div id="upload-status" style="margin-top: 16px; font-size: 12px; height: 20px; color: var(--neu-text-active);"></div>
          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px;">
            <button id="btn-close-upload" class="neu-button">${i18n.t('cancel')}</button>
          </div>
        </div>
      </div>

      <!-- Modal for Settings -->
      <div id="modal-settings" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 400px; padding: 30px;">
          <h2 style="margin-top:0;">${i18n.t('global_settings')}</h2>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('sam_api_url')}</label>
            <input type="text" id="inp-set-samurl" class="neu-input" />
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('cache_dir')}</label>
            <input type="text" id="inp-set-cachedir" class="neu-input" placeholder="/absolute/path/to/data" />
          </div>
          <div style="margin-bottom: 24px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('language')}</label>
            <select id="inp-set-lang" class="neu-input">
               <option value="zh">简体中文</option>
               <option value="en">English</option>
            </select>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="btn-save-settings" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('save')}</button>
            <button id="btn-close-settings" class="neu-button">${i18n.t('close')}</button>
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
    const headerStatus = document.getElementById('health-status-header');
    if (!dot || !text) return;
    try {
      const res = await api.getHealth();
      if (res.status === 'ok') {
        dot.style.background = '#10b981';
        text.innerText = i18n.t('backend_online');
        if (headerStatus) headerStatus.innerText = i18n.t('backend_online');
      } else {
        dot.style.background = '#fbbf24';
        text.innerText = i18n.t('backend_error');
        if (headerStatus) headerStatus.innerText = i18n.t('backend_error');
      }
    } catch(e) {
      dot.style.background = '#ef4444';
      text.innerText = i18n.t('backend_offline');
      if (headerStatus) headerStatus.innerText = i18n.t('backend_offline');
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
        
        btnSubmitNew.textContent = i18n.t('creating');
        btnSubmitNew.disabled = true;
        await api.createProject(payload);
        this.loadProjects(); 
        // Clear form
        document.getElementById('inp-pj-name').value = '';
        document.getElementById('inp-pj-classes').value = '';
        showToast(i18n.t('save_success'));
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnSubmitNew.textContent = i18n.t('create_btn');
        btnSubmitNew.disabled = false;
      }
    };

    btnSet.onclick = async () => {
      inpSamUrl.value = store.state.config.sam3ApiUrl;
      document.getElementById('inp-set-lang').value = store.state.config.language;
      modalSet.style.display = 'flex';
      try {
        const res = await api.getCacheDir();
        if (res && res.cache_dir) document.getElementById('inp-set-cachedir').value = res.cache_dir;
      } catch(e) {}
    };
    
    document.getElementById('btn-save-settings').onclick = async () => {
      const newLang = document.getElementById('inp-set-lang').value;
      const langChanged = newLang !== store.state.config.language;
      
      store.setConfig('sam3ApiUrl', inpSamUrl.value);
      store.setConfig('language', newLang);
      
      const newCacheDir = document.getElementById('inp-set-cachedir').value;
      if (newCacheDir) {
        try { await api.setCacheDir(newCacheDir); } catch(e) { showToast(e.message, 'error'); }
      }
      modalSet.style.display = 'none';
      
      if (langChanged) {
        showToast(i18n.t('switch_lang'));
        this.render(this.container); // Hard refresh UI
      }
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

    status.textContent = i18n.t('uploading', {count: files.length});
    try {
      for (let i = 0; i < files.length; i++) {
        await api.uploadImage(projectId, files[i]);
      }
      this.loadProjects();
      setTimeout(() => {
        document.getElementById('modal-upload').style.display = 'none';
      }, 1000);
    } catch(e) {
      status.textContent = i18n.t('upload_failed', {error: e.message});
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
        listCont.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--neu-text-light);">${i18n.t('no_projects')}</div>`;
        return;
      }
      
      listCont.innerHTML = projects.map(p => {
        const isVideo = p.project_type === 'video';
        const typeLabel = isVideo ? i18n.t('video_project') : i18n.t('image_project');
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
                <button class="neu-button" onclick="window.projectsPage.openProject('${p.id}', '${p.project_type}')" style="color: var(--neu-text-active); font-weight:600;">${i18n.t('open_btn')}</button>
                ${!isVideo ? `<button class="neu-button" onclick="window.projectsPage.showUpload('${p.id}')">${i18n.t('add_data_btn')}</button>` : ''}
                <button class="neu-button" onclick="window.projectsPage.deleteProject('${p.id}')" style="color: #e53e3e;">${i18n.t('delete_btn')}</button>
              </div>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 16px; background: rgba(0,0,0,0.02); border-radius: 8px; font-size: 13px;">
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('type')}</div>
                <div style="font-weight: 700;">${typeLabel.toUpperCase()}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('total')}</div>
                <div style="font-weight: 700;">${total}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('labeled')}</div>
                <div style="font-weight: 700; color: #48bb78;">${labeled}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('unlabeled')}</div>
                <div style="font-weight: 700; color: var(--neu-text-active);">${total - labeled}</div>
              </div>
            </div>

            <div style="font-size: 12px; color: var(--neu-text-light); display: flex; gap: 20px;">
               <span><strong style="color:var(--neu-text);">${i18n.t('path')}:</strong> ${p.image_dir || p.video_path}</span>
               <span style="margin-left:auto;">${i18n.t('created')}: ${new Date(p.created_at * 1000).toLocaleDateString()}</span>
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
