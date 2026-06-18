import { request } from './api-client.js';

export const systemApi = {
  getHealth() {
    return request('GET', '/health');
  },

  getAuthStatus() {
    return request('GET', '/auth/status');
  },

  logout() {
    return request('POST', '/auth/logout');
  },

  changePassword(currentPassword, newPassword) {
    return request('POST', '/auth/password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },

  getUIState(projectId = '') {
    const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return request('GET', `/ui_state${suffix}`);
  },

  setUIState(projectId, state) {
    return request('POST', '/ui_state', {
      project_id: projectId || null,
      state: state || {},
    });
  },

  getGlobalConfig() {
    return request('GET', '/config/global');
  },

  setGlobalConfig(data) {
    return request('POST', '/config/global', data);
  },

  restartWebAuto() {
    return request('POST', '/system/restart');
  },

  getCacheDir() {
    return request('GET', '/config/cache_dir');
  },

  setCacheDir(path) {
    return request('POST', '/config/cache_dir', { cache_dir: path });
  },
};
