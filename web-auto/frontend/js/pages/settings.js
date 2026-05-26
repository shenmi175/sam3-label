import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';
import { i18n } from '../i18n.js';

export const SettingsPage = {
  container: null,
  activeTab: 'basic',
  config: null,

  async render(container) {
    this.container = container;
    container.innerHTML = `
      <style>
        @media (max-width: 840px) {
          .settings-layout { grid-template-columns: 1fr !important; padding: 20px !important; }
          .settings-tabs { flex-direction: row !important; overflow-x: auto; }
          .settings-tab { white-space: nowrap; flex: 0 0 auto; }
        }
      </style>
      <div class="app-container" style="overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; border-bottom: 1px solid rgba(0,0,0,0.05); gap: 16px;">
          <div style="min-width: 0;">
            <h1 style="margin:0; font-size: 28px; font-weight: 800; display: inline-block;">${i18n.t('global_settings')}</h1>
            <span id="settings-status-line" style="margin-left: 12px; color: var(--neu-text-light); font-size: 14px; font-weight: 500;">web-auto</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
            <button id="btn-settings-back" class="neu-button" style="padding: 8px 16px;">${i18n.t('back_to_projects')}</button>
            <button id="btn-logout" class="neu-button" style="padding: 8px 16px;">${i18n.t('logout')}</button>
          </div>
        </div>

        <div class="settings-layout" style="display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 780px); gap: 28px; padding: 30px 40px; align-items: start;">
          <div class="neu-card settings-tabs" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
            <button class="neu-button settings-tab" data-settings-tab="basic" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_basic')}</button>
            <button class="neu-button settings-tab" data-settings-tab="paths" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_paths')}</button>
            <button class="neu-button settings-tab" data-settings-tab="runtime" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_runtime')}</button>
            <button class="neu-button settings-tab" data-settings-tab="account" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_account')}</button>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="basic" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('settings_basic')}</h2>
            <div style="display: grid; gap: 18px;">
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('sam_api_url')}</label>
                <input type="text" id="inp-set-samurl" class="neu-input" />
                <div id="sam-url-hint" style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;"></div>
              </div>
              <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
                <div>
                  <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('language')}</label>
                  <select id="inp-set-lang" class="neu-input">
                    <option value="zh">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </div>
                <div>
                  <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('theme')}</label>
                  <select id="inp-set-theme" class="neu-input">
                    <option value="light">${i18n.t('theme_light')}</option>
                    <option value="dark">${i18n.t('theme_dark')}</option>
                  </select>
                </div>
              </div>
              <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
                <div>
                  <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('threshold')}</label>
                  <input type="number" id="inp-set-threshold" class="neu-input" min="0" max="1" step="0.01" />
                </div>
                <div>
                  <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('batch_size')}</label>
                  <input type="number" id="inp-set-batch" class="neu-input" min="1" max="32" step="1" />
                </div>
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
              <button id="btn-save-settings-basic" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('save')}</button>
            </div>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="paths" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('settings_paths')}</h2>
            <div style="display: grid; gap: 18px;">
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('cache_dir')}</label>
                <input type="text" id="inp-set-cachedir" class="neu-input" placeholder="/absolute/path/to/data" />
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('upload_root')}</label>
                <input type="text" id="inp-set-upload-root" class="neu-input" readonly />
                <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;">${i18n.t('upload_root_readonly_hint')}</div>
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('allowed_data_roots')}</label>
                <textarea id="inp-set-allowed-roots" class="neu-input" readonly style="height: 96px; resize: vertical;"></textarea>
                <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;">${i18n.t('allowed_data_roots_hint')}</div>
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('upload_target_dir')}</label>
                <input type="text" id="inp-set-upload-target" class="neu-input" placeholder="/home/enabot/datasets" />
                <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;">${i18n.t('upload_target_hint')}</div>
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('new_data_root')}</label>
                <input type="text" id="inp-set-new-data-root" class="neu-input" placeholder="/media/enabot/disk/zmb_datas" />
                <div style="font-size: 12px; color: var(--neu-text-light); margin-top: 8px;">${i18n.t('new_data_root_hint')}</div>
              </div>
              <div id="mount-command-panel" style="display: none; padding: 16px; border-radius: 8px; background: rgba(217,119,6,0.08); border: 1px solid rgba(217,119,6,0.24);">
                <div id="mount-command-title" style="font-size: 13px; font-weight: 800; color: #d97706; margin-bottom: 8px;"></div>
                <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.5; margin-bottom: 10px;">${i18n.t('mount_command_hint')}</div>
                <textarea id="mount-command-text" class="neu-input" readonly style="height: 132px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;"></textarea>
                <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px;">
                  <button id="btn-copy-mount-command" class="neu-button" type="button">${i18n.t('copy_command')}</button>
                </div>
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
              <button id="btn-save-settings-paths" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('save')}</button>
            </div>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="runtime" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('settings_runtime')}</h2>
            <div id="runtime-info" style="display: grid; gap: 12px; margin-bottom: 24px;"></div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
              <button id="btn-reload-settings" class="neu-button">${i18n.t('reload_settings')}</button>
              <button id="btn-restart-web-auto" class="neu-button" style="color: #d97706; font-weight: bold;">${i18n.t('restart_web_auto')}</button>
            </div>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="account" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('account')}</h2>
            <div style="display: grid; gap: 18px;">
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('current_password')}</label>
                <input type="password" id="inp-current-password" class="neu-input" autocomplete="current-password" />
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('new_password')}</label>
                <input type="password" id="inp-new-password" class="neu-input" autocomplete="new-password" />
              </div>
              <div>
                <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('confirm_password')}</label>
                <input type="password" id="inp-confirm-password" class="neu-input" autocomplete="new-password" />
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
              <button id="btn-change-password" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('change_password')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.updateTabs();
    await this.loadConfig();
  },

  unmount() {
    this.container = null;
  },

  updateTabs() {
    document.querySelectorAll('.settings-tab').forEach((button) => {
      const active = button.dataset.settingsTab === this.activeTab;
      button.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text)';
      button.style.fontWeight = active ? '800' : '600';
      button.style.boxShadow = active ? 'var(--neu-inset)' : 'var(--neu-outset)';
    });
    document.querySelectorAll('.settings-panel').forEach((panel) => {
      panel.style.display = panel.dataset.settingsPanel === this.activeTab ? 'block' : 'none';
    });
  },

  bindEvents() {
    document.querySelectorAll('.settings-tab').forEach((button) => {
      button.onclick = () => {
        this.activeTab = button.dataset.settingsTab;
        this.updateTabs();
      };
    });

    document.getElementById('btn-settings-back').onclick = () => router.navigate('/');
    document.getElementById('btn-logout').onclick = async () => {
      try {
        await api.logout();
      } catch(e) {}
      window.location.href = '/login';
    };

    document.getElementById('btn-save-settings-basic').onclick = () => this.saveBasicSettings();
    document.getElementById('btn-save-settings-paths').onclick = () => this.savePathSettings();
    document.getElementById('btn-reload-settings').onclick = () => this.loadConfig();
    document.getElementById('btn-restart-web-auto').onclick = () => this.restartWebAuto();
    document.getElementById('btn-change-password').onclick = () => this.changePassword();
    document.getElementById('inp-set-upload-target').oninput = () => this.updateMountCommandPanel();
    document.getElementById('inp-set-new-data-root').oninput = () => this.updateMountCommandPanel();
    document.getElementById('btn-copy-mount-command').onclick = () => this.copyMountCommand();
  },

  async loadConfig() {
    try {
      const res = await api.getGlobalConfig();
      this.config = res.config || {};
    } catch(e) {
      this.config = {};
      showToast(e.message, 'error');
    }

    const allowed = this.config.allowed_sam3_api_base_urls || [];
    let samUrl = store.state.config.sam3ApiUrl || this.config.sam3_api_base_url || '';
    if (allowed.length && !allowed.map((item) => String(item).replace(/\/+$/, '')).includes(String(samUrl).replace(/\/+$/, ''))) {
      samUrl = this.config.sam3_api_base_url || allowed[0] || samUrl;
      store.setConfig('sam3ApiUrl', samUrl);
    }
    document.getElementById('inp-set-samurl').value = samUrl;
    document.getElementById('inp-set-lang').value = store.state.config.language || 'zh';
    document.getElementById('inp-set-theme').value = store.state.config.theme || 'light';
    document.getElementById('inp-set-threshold').value = store.state.config.threshold ?? 0.5;
    document.getElementById('inp-set-batch').value = store.state.config.batchSize ?? 10;
    document.getElementById('inp-set-cachedir').value = this.config.cache_dir || '';
    document.getElementById('inp-set-upload-root').value = this.config.upload_root || '';
    document.getElementById('inp-set-allowed-roots').value = (this.config.allowed_data_roots || []).join('\n');
    document.getElementById('inp-set-upload-target').value = this.config.upload_target_dir || this.config.upload_root || '';
    const newRootInput = document.getElementById('inp-set-new-data-root');
    if (newRootInput && !newRootInput.value.trim()) newRootInput.value = '';

    document.getElementById('sam-url-hint').textContent = allowed.length
      ? i18n.t('allowed_sam_urls', {urls: allowed.join(', ')})
      : '';
    this.renderRuntimeInfo();
    this.updateMountCommandPanel();
    document.getElementById('settings-status-line').textContent = i18n.t('settings_loaded');
  },

  renderRuntimeInfo() {
    const target = document.getElementById('runtime-info');
    if (!target) return;
    const rows = [
      [i18n.t('cache_dir'), this.config?.cache_dir || '--'],
      [i18n.t('upload_root'), this.config?.upload_root || '--'],
      [i18n.t('allowed_data_roots'), (this.config?.allowed_data_roots || []).join('\n') || '--'],
      [i18n.t('default_upload_target_dir'), this.config?.default_upload_target_dir || '--'],
      [i18n.t('upload_target_dir'), this.config?.upload_target_dir || '--'],
      [i18n.t('sam_api_url'), this.config?.sam3_api_base_url || '--'],
      [i18n.t('settings_auth_enabled'), this.config?.auth_enabled ? i18n.t('yes') : i18n.t('no')],
      [i18n.t('settings_session_ttl'), `${this.config?.session_ttl_seconds || '--'}s`],
      [i18n.t('settings_max_batch'), String(this.config?.sam3_max_batch_files || '--')],
    ];
    target.innerHTML = rows.map(([label, value]) => `
      <div style="display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); gap: 14px; align-items: start; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.05);">
        <div style="font-size: 12px; color: var(--neu-text-light); font-weight: 700;">${this.escapeHtml(label)}</div>
        <div style="font-size: 13px; overflow-wrap: anywhere;">${this.escapeHtml(value)}</div>
      </div>
    `).join('');
  },

  async saveBasicSettings() {
    const newLang = document.getElementById('inp-set-lang').value;
    const langChanged = newLang !== store.state.config.language;
    const newTheme = document.getElementById('inp-set-theme').value;
    const samUrl = document.getElementById('inp-set-samurl').value.trim();

    try {
      const res = await api.setGlobalConfig({ sam3_api_base_url: samUrl });
      this.config = res.config || this.config || {};
      store.setConfig('sam3ApiUrl', this.config.sam3_api_base_url || samUrl);
      document.getElementById('inp-set-samurl').value = store.state.config.sam3ApiUrl || '';
      store.setConfig('language', newLang);
      store.setConfig('theme', newTheme);
      store.setConfig('threshold', document.getElementById('inp-set-threshold').value);
      store.setConfig('batchSize', document.getElementById('inp-set-batch').value);
      showToast(i18n.t('settings_saved'), 'success');
      if (langChanged) this.render(this.container);
      else this.renderRuntimeInfo();
    } catch(e) {
      showToast(e.message, 'error');
    }
  },

  async savePathSettings() {
    const cacheDir = document.getElementById('inp-set-cachedir').value.trim();
    const uploadTargetDir = document.getElementById('inp-set-upload-target').value.trim();
    if (uploadTargetDir && !this.pathInsideAllowedRoots(uploadTargetDir)) {
      this.updateMountCommandPanel();
      showToast(i18n.t('upload_target_not_mounted', {path: uploadTargetDir}), 'error');
      return;
    }
    try {
      const res = await api.setGlobalConfig({
        cache_dir: cacheDir,
        upload_target_dir: uploadTargetDir,
      });
      this.config = res.config || this.config || {};
      document.getElementById('inp-set-cachedir').value = this.config.cache_dir || cacheDir;
      document.getElementById('inp-set-upload-target').value = this.config.upload_target_dir || uploadTargetDir;
      this.renderRuntimeInfo();
      showToast(i18n.t('settings_saved_restart_optional'), 'success');
    } catch(e) {
      showToast(e.message, 'error');
    }
  },

  async restartWebAuto() {
    if (!confirm(i18n.t('confirm_restart_web_auto'))) return;
    const btn = document.getElementById('btn-restart-web-auto');
    btn.disabled = true;
    btn.textContent = i18n.t('restarting');
    try {
      await api.restartWebAuto();
    } catch(e) {
      // The request can be interrupted because the server exits immediately.
    }
    await this.waitForRestart();
    btn.disabled = false;
    btn.textContent = i18n.t('restart_web_auto');
  },

  async waitForRestart() {
    const status = document.getElementById('settings-status-line');
    if (status) status.textContent = i18n.t('restarting');
    await this.sleep(1200);
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await api.getHealth();
        if (res && res.status === 'ok') {
          if (status) status.textContent = i18n.t('restart_done');
          showToast(i18n.t('restart_done'), 'success');
          await this.loadConfig();
          return;
        }
      } catch(e) {}
      await this.sleep(1000);
    }
    if (status) status.textContent = i18n.t('restart_pending');
    showToast(i18n.t('restart_pending'), 'error');
  },

  async changePassword() {
    const currentPassword = document.getElementById('inp-current-password').value;
    const newPassword = document.getElementById('inp-new-password').value;
    const confirmPassword = document.getElementById('inp-confirm-password').value;
    if (newPassword !== confirmPassword) {
      showToast(i18n.t('password_confirm_mismatch'), 'error');
      return;
    }
    try {
      await api.changePassword(currentPassword, newPassword);
      showToast(i18n.t('password_changed_login_again'), 'success');
      setTimeout(() => { window.location.href = '/login'; }, 800);
    } catch(e) {
      showToast(e.message, 'error');
    }
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  pathInsideAllowedRoots(path) {
    const cleanPath = String(path || '').replace(/\/+$/, '');
    const roots = this.config?.allowed_data_roots || [];
    return roots.some((root) => {
      const cleanRoot = String(root || '').replace(/\/+$/, '');
      return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
    });
  },

  updateMountCommandPanel() {
    const panel = document.getElementById('mount-command-panel');
    const title = document.getElementById('mount-command-title');
    const text = document.getElementById('mount-command-text');
    if (!panel || !title || !text) return;

    const uploadTarget = this.normalizeHostPathInput(document.getElementById('inp-set-upload-target')?.value.trim() || '');
    const explicitRoot = this.normalizeHostPathInput(document.getElementById('inp-set-new-data-root')?.value.trim() || '');
    const uploadTargetNeedsMount = Boolean(uploadTarget && !this.pathInsideAllowedRoots(uploadTarget));
    const dataRoot = explicitRoot || (uploadTargetNeedsMount ? this.suggestDataRootForUploadTarget(uploadTarget) : '');
    if (!dataRoot) {
      panel.style.display = 'none';
      text.value = '';
      return;
    }

    const uploadTargetInsideDataRoot = uploadTarget && this.pathInsideRoot(uploadTarget, dataRoot);
    const addArgs = uploadTargetInsideDataRoot
      ? `--upload-target ${this.shellQuote(uploadTarget)}`
      : '--default';
    const doctorTarget = uploadTargetInsideDataRoot ? uploadTarget : dataRoot;
    const command = [
      'cd ~/zmb_work/sam3',
      `./deploy.sh data-root add ${this.shellQuote(dataRoot)} ${addArgs}`,
      `./deploy.sh data-root doctor ${this.shellQuote(doctorTarget)}`,
    ].join('\n');
    title.textContent = uploadTargetNeedsMount && !explicitRoot
      ? i18n.t('mount_command_title')
      : i18n.t('mount_command_generated_title');
    text.value = command;
    panel.style.display = 'block';
  },

  suggestDataRootForUploadTarget(path) {
    const clean = String(path || '').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    const uploadsIndex = parts.lastIndexOf('uploads');
    if (uploadsIndex > 0) {
      return `/${parts.slice(0, uploadsIndex).join('/')}`;
    }
    return clean;
  },

  normalizeHostPathInput(path) {
    const clean = String(path || '').trim().replace(/\/+$/, '');
    if (clean.startsWith('media/')) return `/${clean}`;
    return clean;
  },

  pathInsideRoot(path, root) {
    const cleanPath = String(path || '').replace(/\/+$/, '');
    const cleanRoot = String(root || '').replace(/\/+$/, '');
    return Boolean(cleanPath && cleanRoot && (cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`)));
  },

  shellQuote(value) {
    return `'${String(value || '').replaceAll("'", "'\\''")}'`;
  },

  async copyMountCommand() {
    const text = document.getElementById('mount-command-text');
    const command = text?.value || '';
    if (!command) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else {
        text.focus();
        text.select();
        document.execCommand('copy');
      }
      showToast(i18n.t('command_copied'), 'success');
    } catch(e) {
      showToast(i18n.t('copy_failed'), 'error');
    }
  },

  escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  },
};
