import { request } from './api-client.js';

export const projectApi = {
  getProjects(options = {}) {
    const params = new URLSearchParams();
    if (options.autoDiscover) params.set('auto_discover', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/projects${suffix}`);
  },

  getProject(id, includeImages = false) {
    return request('GET', `/projects/${id}?include_images=${includeImages}`);
  },

  createProject(data) {
    return request('POST', '/projects/open', data);
  },

  discoverProjects(scanRoot = '', maxDepth = 8) {
    const params = new URLSearchParams();
    if (scanRoot) params.set('scan_root', scanRoot);
    if (maxDepth) params.set('max_depth', String(maxDepth));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/projects/discover${suffix}`);
  },

  importExistingProject(data) {
    return request('POST', '/projects/import_existing', data);
  },

  deleteProject(id) {
    return request('DELETE', `/projects/${id}`);
  },

  addClass(projectId, classesText) {
    return request('POST', `/projects/${projectId}/classes/add`, { classes_text: classesText });
  },

  deleteClass(projectId, className) {
    return request('DELETE', `/projects/${projectId}/classes/${encodeURIComponent(className)}`);
  },

  migrateSources(projectId) {
    return request('POST', `/projects/${projectId}/migrate-sources`);
  },
};
