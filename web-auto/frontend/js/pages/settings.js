import { api } from '../api.js';
import { router } from '../router.js';
import { store } from '../store.js';
import { i18n } from '../i18n.js';

export const SettingsPage = {
  container: null,
  activeTab: 'basic',

  async render(container) {
    this.container = container;
    container.innerHTML = `
      <style>
        @media (max-width: 760px) {
          .settings-layout { grid-template-columns: 1fr !important; padding: 20px !important; }
          .settings-tabs { flex-direction: row !important; overflow-x: auto; }
          .settings-tab { white-space: nowrap; flex: 0 0 auto; }
        }
      </style>
      <div class="app-container" style="overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; border-bottom: 1px solid rgba(0,0,0,0.05);">
          <div>
            <h1 style="margin:0; font-size: 28px; font-weight: 800; display: inline-block;">${i18n.t('global_settings')}</h1>
            <span style="margin-left: 12px; color: var(--neu-text-light); font-size: 14px; font-weight: 500;">web-auto</span>
          </div>
          <div style="display: flex; gap: 12px; align-items: center;">
            <button id="btn-settings-back" class="neu-button" style="padding: 8px 16px;">${i18n.t('back_to_projects')}</button>
            <button id="btn-logout" class="neu-button" style="padding: 8px 16px;">${i18n.t('logout')}</button>
          </div>
        </div>

        <div class="settings-layout" style="display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 720px); gap: 28px; padding: 30px 40px; align-items: start;">
          <div class="neu-card settings-tabs" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
            <button class="neu-button settings-tab" data-settings-tab="basic" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_basic')}</button>
            <button class="neu-button settings-tab" data-settings-tab="proxy" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_proxy')}</button>
            <button class="neu-button settings-tab" data-settings-tab="account" style="justify-content: flex-start; padding: 12px 14px; text-align: left;">${i18n.t('settings_account')}</button>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="basic" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('settings_basic')}</h2>
            <div style="margin-bottom: 18px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('sam_api_url')}</label>
              <input type="text" id="inp-set-samurl" class="neu-input" />
            </div>
            <div style="margin-bottom: 18px;">
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
            <div style="display: flex; justify-content: flex-end;">
              <button id="btn-save-settings-basic" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('save')}</button>
            </div>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="proxy" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('reverse_proxy')}</h2>
            <div style="margin-bottom: 18px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('proxy_domains')}</label>
              <input type="text" id="inp-proxy-domains" class="neu-input" placeholder="label.example.com" />
            </div>
            <div style="margin-bottom: 18px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('proxy_email')}</label>
              <input type="email" id="inp-proxy-email" class="neu-input" placeholder="admin@example.com" />
            </div>
            <label style="display:flex; align-items:center; gap: 8px; margin-bottom: 12px; font-weight: 600; font-size: 13px;">
              <input type="checkbox" id="inp-proxy-ssl" checked />
              ${i18n.t('proxy_request_ssl')}
            </label>
            <label style="display:flex; align-items:center; gap: 8px; margin-bottom: 18px; font-weight: 600; font-size: 13px;">
              <input type="checkbox" id="inp-proxy-force-ssl" checked />
              ${i18n.t('proxy_force_ssl')}
            </label>
            <div id="proxy-status" style="min-height: 18px; font-size: 12px; color: var(--neu-text-light); margin-bottom: 18px;"></div>
            <div style="display: flex; justify-content: flex-end;">
              <button id="btn-save-proxy" class="neu-button" style="color: var(--neu-text-active); font-weight: bold;">${i18n.t('proxy_save')}</button>
            </div>
          </div>

          <div class="neu-card settings-panel" data-settings-panel="account" style="padding: 28px;">
            <h2 style="margin: 0 0 22px; font-size: 20px;">${i18n.t('account')}</h2>
            <div style="margin-bottom: 18px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('current_password')}</label>
              <input type="password" id="inp-current-password" class="neu-input" autocomplete="current-password" />
            </div>
            <div style="margin-bottom: 18px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('new_password')}</label>
              <input type="password" id="inp-new-password" class="neu-input" autocomplete="new-password" />
            </div>
            <div style="margin-bottom: 24px;">
              <label style="display:block; margin-bottom: 8px; font-weight: 600; font-size: 13px;">${i18n.t('confirm_password')}</label>
              <input type="password" id="inp-confirm-password" class="neu-input" autocomplete="new-password" />
            </div>
            <div style="display: flex; justify-content: flex-end;">
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

    document.getElementById('btn-save-settings-basic').onclick = async () => {
      const newLang = document.getElementById('inp-set-lang').value;
      const langChanged = newLang !== store.state.config.language;
      store.setConfig('sam3ApiUrl', document.getElementById('inp-set-samurl').value.trim());
      store.setConfig('language', newLang);

      const cacheDir = document.getElementById('inp-set-cachedir').value.trim();
      if (cacheDir) {
        try {
          await api.setCacheDir(cacheDir);
        } catch(e) {
          showToast(e.message, 'error');
          return;
        }
      }
      showToast(i18n.t('settings_saved'), 'success');
      if (langChanged) this.render(this.container);
    };

    document.getElementById('btn-save-proxy').onclick = async () => {
      const btn = document.getElementById('btn-save-proxy');
      const status = document.getElementById('proxy-status');
      const payload = {
        domain_names: document.getElementById('inp-proxy-domains').value,
        letsencrypt_email: document.getElementById('inp-proxy-email').value,
        request_ssl: document.getElementById('inp-proxy-ssl').checked,
        force_ssl: document.getElementById('inp-proxy-force-ssl').checked,
      };
      try {
        btn.disabled = true;
        const res = await api.setProxyConfig(payload);
        const cfg = res?.config || {};
        status.textContent = i18n.t('proxy_configured', {url: cfg.url || payload.domain_names});
        showToast(status.textContent, 'success');
      } catch(e) {
        showToast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    document.getElementById('btn-change-password').onclick = async () => {
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
    };
  },

  async loadConfig() {
    document.getElementById('inp-set-samurl').value = store.state.config.sam3ApiUrl || '';
    document.getElementById('inp-set-lang').value = store.state.config.language || 'zh';

    try {
      const res = await api.getCacheDir();
      if (res && res.cache_dir) document.getElementById('inp-set-cachedir').value = res.cache_dir;
    } catch(e) {}

    try {
      const res = await api.getProxyConfig();
      const cfg = res?.config || {};
      if (Array.isArray(cfg.domain_names)) document.getElementById('inp-proxy-domains').value = cfg.domain_names.join(', ');
      if (cfg.letsencrypt_email) document.getElementById('inp-proxy-email').value = cfg.letsencrypt_email;
      if (typeof cfg.request_ssl === 'boolean') document.getElementById('inp-proxy-ssl').checked = cfg.request_ssl;
      if (typeof cfg.force_ssl === 'boolean') document.getElementById('inp-proxy-force-ssl').checked = cfg.force_ssl;
      if (cfg.url) document.getElementById('proxy-status').textContent = i18n.t('proxy_configured', {url: cfg.url});
    } catch(e) {}
  },
};
