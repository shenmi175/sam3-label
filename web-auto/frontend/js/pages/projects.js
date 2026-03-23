import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';

export const ProjectsPage = {
  container: null,

  async render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="page-layout" style="padding: 40px; max-width: 1200px; margin: 0 auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
          <h1 style="margin:0; font-size: 28px;">web-auto Dashboard</h1>
          <div>
            <button id="btn-settings" class="neu-button" style="margin-right: 12px;">Settings</button>
            <button id="btn-new-project" class="neu-button">New Project</button>
          </div>
        </div>
        
        <div class="neu-card">
          <div id="projects-list-container">
             <div style="padding: 40px; text-align: center; color: var(--neu-text-light);">Loading projects...</div>
          </div>
        </div>
      </div>
      
      <!-- Modal for New Project -->
      <div id="modal-new-project" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 500px;">
          <h2 style="margin-top:0;">Create Project</h2>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Project Name</label>
            <input type="text" id="inp-pj-name" class="neu-input" placeholder="e.g. Cat Dataset" />
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Type</label>
            <select id="inp-pj-type" class="neu-input">
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </div>
          <div style="margin-bottom: 16px;" id="dir-image-wrapper">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Image Directory</label>
            <input type="text" id="inp-pj-imgdir" class="neu-input" placeholder="/absolute/path/to/images" />
          </div>
          <div style="margin-bottom: 16px; display: none;" id="dir-video-wrapper">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Video Path</label>
            <input type="text" id="inp-pj-vidpath" class="neu-input" placeholder="/absolute/path/to/video.mp4" />
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Classes (comma separated)</label>
            <input type="text" id="inp-pj-classes" class="neu-input" placeholder="cat, dog, person" />
          </div>
          <div style="margin-bottom: 24px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">Save Directory (Optional)</label>
            <input type="text" id="inp-pj-savedir" class="neu-input" placeholder="Leave empty for default" />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="btn-cancel-new" class="neu-button">Cancel</button>
            <button id="btn-submit-new" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">Create</button>
          </div>
        </div>
      </div>
      
      <!-- Modal for Settings -->
      <div id="modal-settings" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: 400px;">
          <h2 style="margin-top:0;">Global Settings</h2>
          <div style="margin-bottom: 24px;">
            <label style="display:block; margin-bottom: 8px; font-weight: 500;">sam3-api URL</label>
            <input type="text" id="inp-set-samurl" class="neu-input" />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="btn-close-settings" class="neu-button">Close</button>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.loadProjects();
  },

  unmount() {
    this.container = null;
  },

  bindEvents() {
    // New Project Modal
    const btnNew = document.getElementById('btn-new-project');
    const modalNew = document.getElementById('modal-new-project');
    const btnCancelNew = document.getElementById('btn-cancel-new');
    const btnSubmitNew = document.getElementById('btn-submit-new');
    const typeSelect = document.getElementById('inp-pj-type');
    const imgWrapper = document.getElementById('dir-image-wrapper');
    const vidWrapper = document.getElementById('dir-video-wrapper');

    btnNew.onclick = () => { modalNew.style.display = 'flex'; };
    btnCancelNew.onclick = () => { modalNew.style.display = 'none'; };
    
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
        modalNew.style.display = 'none';
        this.loadProjects(); // refresh
      } catch (err) {
        alert(err.message);
      } finally {
        btnSubmitNew.textContent = 'Create';
        btnSubmitNew.disabled = false;
      }
    };

    // Settings Modal
    const btnSet = document.getElementById('btn-settings');
    const modalSet = document.getElementById('modal-settings');
    const btnCloseSet = document.getElementById('btn-close-settings');
    const inpSamUrl = document.getElementById('inp-set-samurl');

    btnSet.onclick = () => {
      inpSamUrl.value = store.state.config.sam3ApiUrl;
      modalSet.style.display = 'flex';
    };
    btnCloseSet.onclick = () => {
      modalSet.style.display = 'none';
    };
    inpSamUrl.onchange = (e) => {
      store.setConfig('sam3ApiUrl', e.target.value);
    };
  },

  async loadProjects() {
    if (!this.container) return;
    const listCont = document.getElementById('projects-list-container');
    try {
      const data = await api.getProjects();
      const projects = data.items || [];
      if (projects.length === 0) {
        listCont.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--neu-text-light);">No projects found. Create one to start.</div>';
        return;
      }
      
      let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 24px;">';
      projects.forEach(p => {
        const prog = p.num_images ? ((p.labeled_images || 0) / p.num_images * 100).toFixed(1) : 0;
        html += `
          <div class="neu-box" style="padding: 20px; display: flex; flex-direction: column;">
            <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">${p.name}</div>
            <div style="font-size: 13px; color: var(--neu-text-light); margin-bottom: 16px;">
              <span style="display:inline-block; padding: 2px 8px; border-radius: 4px; background: rgba(0,0,0,0.05); margin-right: 8px;">${p.project_type.toUpperCase()}</span>
              ID: ${p.id.substring(0,8)}...
            </div>
            
            <div style="margin-bottom: 8px; font-size: 13px;">
              <div>Total: <b>${p.num_images || 0}</b></div>
              <div>Labeled: <b style="color: var(--neu-text-active);">${p.labeled_images || 0}</b></div>
            </div>
            
            <div style="width: 100%; height: 6px; background: var(--neu-inset); border-radius: 3px; overflow: hidden; margin-bottom: 20px;">
              <div style="height: 100%; width: ${prog}%; background: var(--neu-text-active); transition: width 0.3s;"></div>
            </div>
            
            <div style="margin-top: auto; display: flex; gap: 8px;">
               <button class="neu-button" style="flex: 1; color: var(--neu-text-active);" onclick="window.projectsPage.openProject('${p.id}', '${p.project_type}')">Open</button>
               <button class="neu-button" style="color: #e53e3e;" onclick="window.projectsPage.deleteProject('${p.id}')">Delete</button>
            </div>
          </div>
        `;
      });
      html += '</div>';
      listCont.innerHTML = html;
      
    } catch (err) {
      listCont.innerHTML = `<div style="padding: 40px; text-align: center; color: #e53e3e;">Failed to load projects: ${err.message}</div>`;
    }
  },

  openProject(id, type) {
    if (type === 'image') {
      router.navigate(`/project/image/${id}`);
    } else {
      router.navigate(`/project/video/${id}`);
    }
  },

  async deleteProject(id) {
    if(!confirm("Are you sure you want to delete this project? Data goes away, files stay.")) return;
    try {
      await api.deleteProject(id);
      this.loadProjects();
    } catch(err) {
      alert("Delete failed: " + err.message);
    }
  }
};

// Make it global so inline onclick can find it
window.projectsPage = ProjectsPage;
