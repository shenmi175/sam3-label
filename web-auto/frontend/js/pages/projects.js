import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';
import { i18n } from '../i18n.js';

export const ProjectsPage = {
  container: null,
  _datasetFiles: [],
  _activeUploadXhr: null,
  _cancelDatasetUpload: false,
  _datasetTargetProjectId: '',
  _uploadConfig: null,
  _discoveryCandidates: [],

  async render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="app-container" style="overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; border-bottom: 1px solid rgba(0,0,0,0.05); gap: 20px;">
           <div style="min-width: 0;">
             <h1 style="margin:0; font-size: 28px; font-weight: 800; display: inline-block;">web-auto</h1>
             <span id="health-status-header" style="margin-left: 12px; color: var(--neu-text-light); font-size: 14px; font-weight: 500;">${i18n.t('backend_checking')}</span>
           </div>
           <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
              <div id="health-indicator" title="Backend Health">
                <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--neu-text-light);">
                  <span id="health-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ccc;"></span>
                  ${i18n.t('dashboard')}: <span id="health-text">${i18n.t('backend_checking')}</span>
                </div>
              </div>
              <button id="btn-dataset-upload" class="neu-button" style="padding: 8px 16px;">${i18n.t('upload_dataset_btn')}</button>
              <button id="btn-restore-project" class="neu-button" style="padding: 8px 16px;">${i18n.t('restore_project_btn')}</button>
              <button id="btn-create-project" class="neu-button" style="padding: 8px 16px; color: var(--neu-text-active); font-weight: 700;">${i18n.t('create_btn')}</button>
              <button id="btn-toggle-theme" class="neu-button" title="${i18n.t('toggle_theme')}" style="padding: 8px 12px;">
                 <span id="theme-icon">🌓</span>
              </button>
              <button id="btn-settings" class="neu-button" style="padding: 8px 16px;">${i18n.t('global_settings')}</button>
              <button id="btn-logout" class="neu-button" style="padding: 8px 16px;">${i18n.t('logout')}</button>
           </div>
        </div>

        <div style="padding: 30px 40px; flex: 1; min-height: 0; overflow-y: auto;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; gap: 16px;">
            <h2 style="margin:0; font-size: 20px;">${i18n.t('project_list')}</h2>
            <div id="pj-count-label" style="font-size: 13px; color: var(--neu-text-light);">${i18n.t('total_projects', {count: '<span id="pj-count">0</span>'})}</div>
          </div>
          <div id="projects-list-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 460px), 1fr)); gap: 20px;">
             <div style="padding: 40px; text-align: center; color: var(--neu-text-light);">${i18n.t('backend_checking')}</div>
          </div>
        </div>
      </div>

      <div id="modal-create-project" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: min(560px, calc(100vw - 32px)); padding: 28px; position: relative;">
          <button id="btn-close-create-project" class="neu-button" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">×</button>
          <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('new_project')}</h2>
          <div style="display: grid; gap: 16px;">
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('project_name')}</label>
              <input type="text" id="inp-pj-name" class="neu-input" placeholder="${i18n.t('project_name')}" />
            </div>
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('project_type')}</label>
              <select id="inp-pj-type" class="neu-input">
                <option value="image">${i18n.t('image_project')}</option>
                <option value="video">${i18n.t('video_project')}</option>
              </select>
            </div>
            <div id="dir-image-wrapper">
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('image_dir')}</label>
              <input type="text" id="inp-pj-imgdir" class="neu-input" placeholder="/absolute/path/to/images" />
            </div>
            <div id="dir-video-wrapper" style="display: none;">
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('video_path')}</label>
              <input type="text" id="inp-pj-vidpath" class="neu-input" placeholder="/absolute/path/to/video.mp4" />
            </div>
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('initial_classes')}</label>
              <textarea id="inp-pj-classes" class="neu-input" style="height: 88px; resize: vertical;" placeholder="cat&#10;dog&#10;person face"></textarea>
            </div>
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('save_dir')}</label>
              <input type="text" id="inp-pj-savedir" class="neu-input" placeholder="..." />
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button id="btn-cancel-create-project" class="neu-button">${i18n.t('cancel')}</button>
            <button id="btn-submit-new" class="neu-button" style="color: var(--neu-text-active); font-weight: 700; min-width: 120px;">${i18n.t('create_btn')}</button>
          </div>
        </div>
      </div>

      <div id="modal-restore-project" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: min(820px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto; padding: 28px; position: relative;">
          <button id="btn-close-restore-project" class="neu-button" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">×</button>
          <h2 style="margin: 0 0 8px; font-size: 20px;">${i18n.t('restore_project_title')}</h2>
          <div style="font-size: 13px; color: var(--neu-text-light); margin-bottom: 20px; line-height: 1.5;">${i18n.t('restore_project_desc')}</div>
          <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px;">
            <div style="display: grid; gap: 14px;">
              <button id="btn-scan-existing-projects" class="neu-button" style="justify-self: start; color: var(--neu-text-active); font-weight: 700;">${i18n.t('scan_existing_projects')}</button>
              <div id="existing-projects-list" style="display: grid; gap: 12px; max-height: 360px; overflow-y: auto; padding-right: 4px;">
                <div style="padding: 18px; color: var(--neu-text-light);">${i18n.t('no_existing_projects')}</div>
              </div>
            </div>
            <div style="display: grid; gap: 14px; align-content: start;">
              <div>
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('existing_project_output_dir')}</label>
                <input type="text" id="inp-restore-output-dir" class="neu-input" placeholder="/path/to/prj_xxxxx" />
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('image_dir')}</label>
                <input type="text" id="inp-restore-image-dir" class="neu-input" placeholder="/path/to/images" />
                <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;">${i18n.t('existing_project_image_dir_hint')}</div>
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('project_name')}</label>
                <input type="text" id="inp-restore-name" class="neu-input" placeholder="${i18n.t('project_name')}" />
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('initial_classes')}</label>
                <textarea id="inp-restore-classes" class="neu-input" style="height: 82px; resize: vertical;" placeholder="cat&#10;dog&#10;person face"></textarea>
              </div>
              <input type="hidden" id="inp-restore-manifest-path" />
              <input type="hidden" id="inp-restore-project-type" />
              <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button id="btn-cancel-restore-project" class="neu-button">${i18n.t('cancel')}</button>
                <button id="btn-submit-restore-project" class="neu-button" style="color: var(--neu-text-active); font-weight: 700; min-width: 120px;">${i18n.t('import_existing_project')}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="modal-dataset-upload" class="modal-overlay" style="display: none;">
        <div class="neu-card modal-content" style="width: min(680px, calc(100vw - 32px)); padding: 28px; position: relative;">
          <button id="btn-close-dataset-upload" class="neu-button" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">×</button>
          <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('upload_dataset_title')}</h2>
          <div style="display: grid; gap: 16px;">
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('upload_target_dir')}</label>
              <input type="text" id="inp-dataset-target-dir" class="neu-input" placeholder="/home/enabot/datasets/my-dataset" />
              <div id="dataset-root-hint" style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;"></div>
            </div>
            <div>
              <label style="display:block; margin-bottom: 8px; font-size: 13px; font-weight: 600;">${i18n.t('upload_source')}</label>
              <div id="dataset-drop-zone" class="neu-box" style="min-height: 134px; border: 2px dashed rgba(0,0,0,0.1); box-shadow: var(--neu-inset); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 20px;">
                <div style="font-size: 13px; color: var(--neu-text-light);" id="dataset-selected-summary">${i18n.t('upload_no_files')}</div>
                <div style="display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;">
                  <button id="btn-select-dataset-folder" class="neu-button" type="button">${i18n.t('select_folder')}</button>
                  <button id="btn-select-dataset-files" class="neu-button" type="button">${i18n.t('select_files')}</button>
                  <button id="btn-clear-dataset-files" class="neu-button" type="button">${i18n.t('clear')}</button>
                </div>
                <input type="file" id="inp-dataset-folder" webkitdirectory directory multiple style="display:none;" />
                <input type="file" id="inp-dataset-files" multiple style="display:none;" />
              </div>
            </div>
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600;">
              <input type="checkbox" id="inp-dataset-overwrite" />
              ${i18n.t('overwrite_existing')}
            </label>
            <div>
              <div style="display:flex; justify-content:space-between; gap: 12px; font-size: 12px; color: var(--neu-text-light); margin-bottom: 8px;">
                <span id="dataset-upload-status">${i18n.t('upload_idle')}</span>
                <span id="dataset-upload-percent">0%</span>
              </div>
              <div style="width: 100%; height: 10px; border-radius: 999px; overflow: hidden; background: rgba(0,0,0,0.08); box-shadow: var(--neu-inset);">
                <div id="dataset-progress-bar" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.15s ease;"></div>
              </div>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; gap: 12px; margin-top: 24px; flex-wrap: wrap;">
            <button id="btn-create-from-upload" class="neu-button" style="display:none;">${i18n.t('create_from_uploaded')}</button>
            <div style="margin-left: auto; display: flex; gap: 12px;">
              <button id="btn-cancel-dataset-upload" class="neu-button">${i18n.t('cancel')}</button>
              <button id="btn-start-dataset-upload" class="neu-button" style="color: var(--neu-text-active); font-weight: 700; min-width: 120px;">${i18n.t('start_upload')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.loadProjects();
    this.checkHealth();
    this.loadUploadConfig();
  },

  unmount() {
    this.container = null;
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = null;
    if (this._activeUploadXhr) this._activeUploadXhr.abort();
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
    const btnLogout = document.getElementById('btn-logout');
    const btnCreate = document.getElementById('btn-create-project');
    const btnRestore = document.getElementById('btn-restore-project');
    const btnDatasetUpload = document.getElementById('btn-dataset-upload');
    const btnSubmitNew = document.getElementById('btn-submit-new');
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

    btnLogout.onclick = async () => {
      try {
        await api.logout();
      } catch(e) {}
      window.location.href = '/login';
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

    btnCreate.onclick = () => this.openCreateModal();
    btnRestore.onclick = () => this.openRestoreModal();
    document.getElementById('btn-close-create-project').onclick = () => this.closeCreateModal();
    document.getElementById('btn-cancel-create-project').onclick = () => this.closeCreateModal();
    btnSubmitNew.onclick = () => this.submitProject();
    btnSet.onclick = () => router.navigate('/settings');
    btnDatasetUpload.onclick = () => this.showDatasetUpload();
    document.getElementById('btn-close-restore-project').onclick = () => this.closeRestoreModal();
    document.getElementById('btn-cancel-restore-project').onclick = () => this.closeRestoreModal();
    document.getElementById('btn-scan-existing-projects').onclick = () => this.scanExistingProjects();
    document.getElementById('btn-submit-restore-project').onclick = () => this.importExistingProject();

    const folderInput = document.getElementById('inp-dataset-folder');
    const filesInput = document.getElementById('inp-dataset-files');
    const dropZone = document.getElementById('dataset-drop-zone');
    document.getElementById('btn-select-dataset-folder').onclick = () => folderInput.click();
    document.getElementById('btn-select-dataset-files').onclick = () => filesInput.click();
    document.getElementById('btn-clear-dataset-files').onclick = () => this.clearDatasetFiles();
    folderInput.onchange = (e) => this.setDatasetFiles(e.target.files);
    filesInput.onchange = (e) => this.setDatasetFiles(e.target.files);
    document.getElementById('btn-start-dataset-upload').onclick = () => this.startDatasetUpload();
    document.getElementById('btn-cancel-dataset-upload').onclick = () => this.cancelOrCloseDatasetUpload();
    document.getElementById('btn-close-dataset-upload').onclick = () => this.cancelOrCloseDatasetUpload();
    document.getElementById('btn-create-from-upload').onclick = () => {
      const imageDir = this.getUploadedImageDir();
      document.getElementById('modal-dataset-upload').style.display = 'none';
      this.openCreateModal({ project_type: 'image', image_dir: imageDir });
    };
    dropZone.ondragover = (e) => {
      e.preventDefault();
      dropZone.style.background = 'rgba(0,0,0,0.03)';
    };
    dropZone.ondragleave = () => {
      dropZone.style.background = 'transparent';
    };
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.style.background = 'transparent';
      this.setDatasetFiles(e.dataTransfer.files);
    };
  },

  async submitProject() {
    const btnSubmitNew = document.getElementById('btn-submit-new');
    const typeSelect = document.getElementById('inp-pj-type');
    try {
      const payload = {
        name: document.getElementById('inp-pj-name').value,
        project_type: typeSelect.value,
        classes_text: document.getElementById('inp-pj-classes').value.replace(/\r\n?/g, '\n'),
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
      await this.loadProjects();
      this.closeCreateModal();
      this.clearCreateForm();
      showToast(i18n.t('save_success'));
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btnSubmitNew.textContent = i18n.t('create_btn');
      btnSubmitNew.disabled = false;
    }
  },

  clearCreateForm() {
    document.getElementById('inp-pj-name').value = '';
    document.getElementById('inp-pj-imgdir').value = '';
    document.getElementById('inp-pj-vidpath').value = '';
    document.getElementById('inp-pj-classes').value = '';
    document.getElementById('inp-pj-savedir').value = '';
    document.getElementById('inp-pj-type').value = 'image';
    document.getElementById('dir-image-wrapper').style.display = 'block';
    document.getElementById('dir-video-wrapper').style.display = 'none';
  },

  openCreateModal(prefill = {}) {
    const modal = document.getElementById('modal-create-project');
    if (!modal) return;
    const type = prefill.project_type || 'image';
    document.getElementById('inp-pj-type').value = type;
    document.getElementById('dir-image-wrapper').style.display = type === 'image' ? 'block' : 'none';
    document.getElementById('dir-video-wrapper').style.display = type === 'video' ? 'block' : 'none';
    if (prefill.name) document.getElementById('inp-pj-name').value = prefill.name;
    if (prefill.image_dir) document.getElementById('inp-pj-imgdir').value = prefill.image_dir;
    if (prefill.video_path) document.getElementById('inp-pj-vidpath').value = prefill.video_path;
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('inp-pj-name')?.focus(), 0);
  },

  closeCreateModal() {
    const modal = document.getElementById('modal-create-project');
    if (modal) modal.style.display = 'none';
  },

  openRestoreModal() {
    const modal = document.getElementById('modal-restore-project');
    if (!modal) return;
    document.getElementById('inp-restore-output-dir').value = '';
    document.getElementById('inp-restore-image-dir').value = '';
    document.getElementById('inp-restore-name').value = '';
    document.getElementById('inp-restore-classes').value = '';
    document.getElementById('inp-restore-manifest-path').value = '';
    document.getElementById('inp-restore-project-type').value = '';
    this._discoveryCandidates = [];
    this.renderDiscoveryCandidates();
    modal.style.display = 'flex';
    this.scanExistingProjects();
  },

  closeRestoreModal() {
    const modal = document.getElementById('modal-restore-project');
    if (modal) modal.style.display = 'none';
  },

  async scanExistingProjects() {
    const btn = document.getElementById('btn-scan-existing-projects');
    if (btn) {
      btn.disabled = true;
      btn.textContent = i18n.t('scanning_existing_projects');
    }
    try {
      const data = await api.discoverProjects();
      this._discoveryCandidates = data.candidates || [];
      this.renderDiscoveryCandidates();
    } catch(e) {
      showToast(e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = i18n.t('scan_existing_projects');
      }
    }
  },

  renderDiscoveryCandidates() {
    const list = document.getElementById('existing-projects-list');
    if (!list) return;
    if (!this._discoveryCandidates.length) {
      list.innerHTML = `<div style="padding: 18px; color: var(--neu-text-light);">${i18n.t('no_existing_projects')}</div>`;
      return;
    }
    list.innerHTML = this._discoveryCandidates.map((item, index) => {
      const kind = item.kind === 'manifest' ? i18n.t('existing_project_kind_manifest') : i18n.t('existing_project_kind_legacy');
      const status = item.imported ? i18n.t('existing_project_imported') : (item.requires_image_dir ? i18n.t('existing_project_requires_image_dir') : '');
      const name = this.escapeHtml(item.name || item.project_id || '');
      const outputDir = this.escapeHtml(item.output_dir || '');
      const annCount = Number(item.annotation_count || 0);
      const disabled = item.imported ? 'disabled' : '';
      return `
        <div class="neu-box" style="padding: 14px; display: grid; gap: 10px; box-shadow: var(--neu-inset);">
          <div style="display: flex; justify-content: space-between; gap: 12px; align-items: start;">
            <div style="min-width: 0;">
              <div style="font-weight: 800; overflow-wrap: anywhere;">${name}</div>
              <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 4px;">${this.escapeHtml(kind)} · ${annCount} JSON</div>
            </div>
            <button class="neu-button" ${disabled} onclick="window.projectsPage.selectDiscoveredProject(${index})" style="padding: 6px 10px;">${i18n.t('import_existing_project')}</button>
          </div>
          <div style="font-size: 12px; color: var(--neu-text-light); overflow-wrap: anywhere;">${outputDir}</div>
          ${status ? `<div style="font-size: 12px; color: ${item.imported ? '#48bb78' : 'var(--neu-text-active)'};">${this.escapeHtml(status)}</div>` : ''}
        </div>
      `;
    }).join('');
  },

  selectDiscoveredProject(index) {
    const item = this._discoveryCandidates[Number(index)] || null;
    if (!item || item.imported) return;
    document.getElementById('inp-restore-output-dir').value = item.output_dir || '';
    document.getElementById('inp-restore-image-dir').value = item.image_dir || '';
    document.getElementById('inp-restore-name').value = item.name || '';
    document.getElementById('inp-restore-manifest-path').value = item.manifest_path || '';
    document.getElementById('inp-restore-project-type').value = item.project_type || '';
    document.getElementById('inp-restore-image-dir')?.focus();
    if (!item.requires_image_dir && item.manifest_path) this.importExistingProject();
  },

  async importExistingProject() {
    const btn = document.getElementById('btn-submit-restore-project');
    const payload = {
      output_dir: document.getElementById('inp-restore-output-dir').value.trim(),
      manifest_path: document.getElementById('inp-restore-manifest-path').value.trim(),
      image_dir: document.getElementById('inp-restore-image-dir').value.trim(),
      name: document.getElementById('inp-restore-name').value.trim(),
      classes_text: document.getElementById('inp-restore-classes').value.replace(/\r\n?/g, '\n'),
      project_type: document.getElementById('inp-restore-project-type').value.trim(),
    };
    if (!payload.output_dir && !payload.manifest_path) {
      showToast(i18n.t('existing_project_output_dir'), 'error');
      return;
    }
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = i18n.t('importing_existing_project');
      }
      await api.importExistingProject(payload);
      await this.loadProjects();
      this.closeRestoreModal();
      showToast(i18n.t('restore_success'));
    } catch(e) {
      showToast(e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = i18n.t('import_existing_project');
      }
    }
  },

  async loadUploadConfig() {
    try {
      this._uploadConfig = await api.getUploadConfig();
      const hint = document.getElementById('dataset-root-hint');
      if (hint) hint.textContent = i18n.t('upload_root_hint', {root: this._uploadConfig.host_data_root || ''});
      const targetInput = document.getElementById('inp-dataset-target-dir');
      if (targetInput && !targetInput.value) targetInput.value = this._uploadConfig.default_target_dir || '';
    } catch(e) {
      const hint = document.getElementById('dataset-root-hint');
      if (hint) hint.textContent = e.message;
    }
  },

  showDatasetUpload(targetDir = '', projectId = '') {
    this._datasetTargetProjectId = projectId || '';
    this._cancelDatasetUpload = false;
    this._activeUploadXhr = null;
    const modal = document.getElementById('modal-dataset-upload');
    const targetInput = document.getElementById('inp-dataset-target-dir');
    if (targetInput) targetInput.value = targetDir || this._uploadConfig?.default_target_dir || targetInput.value || '';
    document.getElementById('btn-create-from-upload').style.display = 'none';
    document.getElementById('btn-start-dataset-upload').disabled = false;
    document.getElementById('btn-start-dataset-upload').textContent = i18n.t('start_upload');
    this.updateDatasetProgress(0, i18n.t('upload_idle'));
    modal.style.display = 'flex';
  },

  cancelOrCloseDatasetUpload() {
    if (this._activeUploadXhr) {
      this._cancelDatasetUpload = true;
      this._activeUploadXhr.abort();
      return;
    }
    const modal = document.getElementById('modal-dataset-upload');
    if (modal) modal.style.display = 'none';
  },

  setDatasetFiles(fileList) {
    this._datasetFiles = Array.from(fileList || []);
    const summary = document.getElementById('dataset-selected-summary');
    if (!summary) return;
    if (!this._datasetFiles.length) {
      summary.textContent = i18n.t('upload_no_files');
      return;
    }
    const totalBytes = this._datasetFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    summary.textContent = i18n.t('upload_selected', {
      count: this._datasetFiles.length,
      size: this.formatBytes(totalBytes),
    });
    this.updateDatasetProgress(0, i18n.t('upload_ready'));
  },

  clearDatasetFiles() {
    this._datasetFiles = [];
    const folderInput = document.getElementById('inp-dataset-folder');
    const filesInput = document.getElementById('inp-dataset-files');
    if (folderInput) folderInput.value = '';
    if (filesInput) filesInput.value = '';
    const summary = document.getElementById('dataset-selected-summary');
    if (summary) summary.textContent = i18n.t('upload_no_files');
    this.updateDatasetProgress(0, i18n.t('upload_idle'));
  },

  async startDatasetUpload() {
    const targetDir = document.getElementById('inp-dataset-target-dir').value.trim();
    const overwrite = document.getElementById('inp-dataset-overwrite').checked;
    const files = this._datasetFiles;
    if (!targetDir) {
      showToast(i18n.t('upload_target_required'), 'error');
      return;
    }
    if (!files.length) {
      showToast(i18n.t('upload_files_required'), 'error');
      return;
    }

    const btnStart = document.getElementById('btn-start-dataset-upload');
    const btnCreateFromUpload = document.getElementById('btn-create-from-upload');
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    let completedBytes = 0;
    this._cancelDatasetUpload = false;
    btnStart.disabled = true;
    btnStart.textContent = i18n.t('uploading_short');
    btnCreateFromUpload.style.display = 'none';

    try {
      for (let idx = 0; idx < files.length; idx += 1) {
        if (this._cancelDatasetUpload) throw new Error(i18n.t('upload_canceled'));
        const file = files[idx];
        const relativePath = file.webkitRelativePath || file.name;
        await api.uploadDatasetFile({
          file,
          targetDir,
          relativePath,
          overwrite,
          onXhr: (xhr) => { this._activeUploadXhr = xhr; },
          onProgress: (loaded) => {
            const percent = totalBytes > 0 ? ((completedBytes + loaded) / totalBytes) * 100 : ((idx + 1) / files.length) * 100;
            this.updateDatasetProgress(percent, i18n.t('uploading_file', {
              index: idx + 1,
              count: files.length,
              name: file.name,
            }));
          },
        });
        completedBytes += file.size || 0;
        this._activeUploadXhr = null;
      }

      this.updateDatasetProgress(100, i18n.t('upload_done', {count: files.length}));
      btnCreateFromUpload.style.display = 'inline-flex';
      if (this._datasetTargetProjectId) {
        try {
          await api.refreshImages(this._datasetTargetProjectId);
          await this.loadProjects();
        } catch(e) {
          showToast(e.message, 'error');
        }
      }
      showToast(i18n.t('upload_done', {count: files.length}));
    } catch(e) {
      this.updateDatasetProgress(0, i18n.t('upload_failed', {error: e.message}));
      showToast(i18n.t('upload_failed', {error: e.message}), 'error');
    } finally {
      this._activeUploadXhr = null;
      btnStart.disabled = false;
      btnStart.textContent = i18n.t('start_upload');
    }
  },

  updateDatasetProgress(percent, statusText) {
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const bar = document.getElementById('dataset-progress-bar');
    const status = document.getElementById('dataset-upload-status');
    const percentEl = document.getElementById('dataset-upload-percent');
    if (bar) bar.style.width = `${safePercent}%`;
    if (status) status.textContent = statusText || '';
    if (percentEl) percentEl.textContent = `${safePercent}%`;
  },

  getUploadedImageDir() {
    const targetDir = document.getElementById('inp-dataset-target-dir')?.value.trim() || '';
    const prefixes = new Set();
    for (const file of this._datasetFiles) {
      const rel = String(file.webkitRelativePath || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      if (parts.length > 1) prefixes.add(parts[0]);
    }
    if (prefixes.size === 1 && !this._datasetTargetProjectId) {
      return this.joinServerPath(targetDir, Array.from(prefixes)[0]);
    }
    return targetDir;
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
        listCont.innerHTML = `<div style="grid-column: 1 / -1; padding: 48px; text-align: center; color: var(--neu-text-light);">${i18n.t('no_projects')}</div>`;
        return;
      }

      listCont.innerHTML = projects.map(p => {
        const isVideo = p.project_type === 'video';
        const typeLabel = isVideo ? i18n.t('video_project') : i18n.t('image_project');
        const total = isVideo ? p.num_frames : p.num_images;
        const labeled = p.labeled_images || 0;
        const progress = total > 0 ? Math.round((labeled / total) * 100) : 0;
        const sourcePath = String(p.image_dir || p.video_path || '');
        const projectName = this.escapeHtml(p.name || '');
        const projectId = this.escapeHtml(p.id || '');
        const projectType = this.escapeHtml(p.project_type || '');
        const sourcePathHtml = this.escapeHtml(sourcePath);
        const jsId = this.escapeHtml(this.jsString(p.id || ''));
        const jsType = this.escapeHtml(this.jsString(p.project_type || ''));
        const jsPath = this.escapeHtml(this.jsString(sourcePath));

        return `
          <div class="neu-card" style="padding: 22px; display: flex; flex-direction: column; gap: 16px; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;">
              <div style="display: flex; gap: 16px; align-items: center; min-width: 0;">
                <div class="neu-box" style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: var(--neu-inset); flex: 0 0 auto;">
                  ${isVideo ? '🎬' : '🖼️'}
                </div>
                <div style="min-width: 0;">
                  <h3 style="margin: 0; font-size: 18px; overflow-wrap: anywhere;">${projectName}</h3>
                  <div style="font-size: 11px; color: var(--neu-text-light); margin-top: 4px; overflow-wrap: anywhere;">ID: ${projectId}</div>
                </div>
              </div>
              <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end;">
                <button class="neu-button" onclick="window.projectsPage.openProject('${jsId}', '${jsType}')" style="color: var(--neu-text-active); font-weight:600;">${i18n.t('open_btn')}</button>
                ${!isVideo ? `<button class="neu-button" onclick="window.projectsPage.showDatasetUpload('${jsPath}', '${jsId}')">${i18n.t('add_data_btn')}</button>` : ''}
                <button class="neu-button" onclick="window.projectsPage.deleteProject('${jsId}')" style="color: #e53e3e;">${i18n.t('delete_btn')}</button>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; padding: 14px; background: rgba(0,0,0,0.02); border-radius: 8px; font-size: 13px;">
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('type')}</div>
                <div style="font-weight: 700;">${this.escapeHtml(typeLabel.toUpperCase())}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('total')}</div>
                <div style="font-weight: 700;">${Number(total || 0)}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('labeled')}</div>
                <div style="font-weight: 700; color: #48bb78;">${Number(labeled || 0)}</div>
              </div>
              <div>
                <div style="color: var(--neu-text-light); font-size: 11px; margin-bottom: 2px;">${i18n.t('unlabeled')}</div>
                <div style="font-weight: 700; color: var(--neu-text-active);">${Math.max(0, Number(total || 0) - Number(labeled || 0))}</div>
              </div>
            </div>

            <div style="font-size: 12px; color: var(--neu-text-light); display: flex; gap: 20px; min-width: 0;">
               <span style="overflow-wrap: anywhere;"><strong style="color:var(--neu-text);">${i18n.t('path')}:</strong> ${sourcePathHtml}</span>
               <span style="margin-left:auto; white-space: nowrap;">${i18n.t('created')}: ${this.safeFormatDate(p.created_at)}</span>
            </div>

            <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.08); border-radius: 3px; overflow: hidden; margin-top: 4px;">
              <div style="width: ${progress}%; height: 100%; background: var(--neu-text-active);"></div>
            </div>
          </div>
        `;
      }).join('');

    } catch (err) {
      listCont.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #e53e3e;">Failed to load projects: ${this.escapeHtml(err.message)}</div>`;
    }
  },

  safeFormatDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '--';
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ts = numeric > 1e12 ? numeric : numeric * 1000;
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString();
    }
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
  },

  openProject(id, type) {
    if (type === 'image') router.navigate(`/project/image/${id}`);
    else router.navigate(`/project/video/${id}`);
  },

  async deleteProject(id) {
    if(!confirm("Are you sure you want to delete this project? Data goes away, files stay.")) return;
    try {
      await api.deleteProject(id);
      showToast(i18n.t('project_deleted'));
      this.loadProjects();
    } catch(err) {
      showToast(i18n.t('delete_failed', {error: err.message}), 'error');
    }
  },

  formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
  },

  joinServerPath(root, child) {
    const cleanRoot = String(root || '').replace(/\/+$/, '');
    const cleanChild = String(child || '').replace(/^\/+/, '');
    return cleanRoot ? `${cleanRoot}/${cleanChild}` : cleanChild;
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
    return String(value ?? '')
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "\\'")
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '');
  },
};

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

const style = document.createElement('style');
style.innerHTML = `
  @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes slideOut { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-20px); opacity: 0; } }
`;
document.head.appendChild(style);

window.projectsPage = ProjectsPage;
