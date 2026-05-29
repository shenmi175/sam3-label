const API_BASE = '/api';

export const api = {
  async request(method, endpoint, data = null, isFormData = false, requestOptions = {}) {
    const options = {
      method,
      ...requestOptions,
      headers: { ...(requestOptions.headers || {}) },
    };
    if (data && !isFormData) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    } else if (data && isFormData) {
      options.body = data; // FormData for uploads
    }
    
    const response = await fetch(`${API_BASE}${endpoint}`, options);
    if (!response.ok) {
      let errorMsg = response.statusText;
      let errorCode = '';
      try {
        const d = await response.json();
        if (d && d.code) errorCode = String(d.code);
        if (d && d.detail) errorMsg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
      } catch(e) {}
      if (response.status === 401 || errorCode === 'login_required') {
        window.location.href = '/login';
        throw new Error('Login required');
      }
      if (response.status === 403 && errorCode === 'setup_required') {
        window.location.href = '/setup';
        throw new Error('Setup required');
      }
      if (response.status === 503 && errorCode === 'admin_not_configured') {
        window.location.href = '/login';
        throw new Error('Admin credentials are not configured');
      }
      throw new Error(`API Error ${response.status}: ${errorMsg}`);
    }
    return response.json();
  },

  getProjects(options = {}) {
    const params = new URLSearchParams();
    if (options.autoDiscover) params.set('auto_discover', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/projects${suffix}`);
  },
  getProject(id, includeImages=false) { return this.request('GET', `/projects/${id}?include_images=${includeImages}`); },
  getHealth() { return this.request('GET', '/health'); },
  getAuthStatus() { return this.request('GET', '/auth/status'); },
  logout() { return this.request('POST', '/auth/logout'); },
  changePassword(currentPassword, newPassword) {
    return this.request('POST', '/auth/password', {
      current_password: currentPassword,
      new_password: newPassword
    });
  },
  createProject(data) { return this.request('POST', '/projects/open', data); },
  discoverProjects(scanRoot = '', maxDepth = 8) {
    const params = new URLSearchParams();
    if (scanRoot) params.set('scan_root', scanRoot);
    if (maxDepth) params.set('max_depth', String(maxDepth));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/projects/discover${suffix}`);
  },
  importExistingProject(data) { return this.request('POST', '/projects/import_existing', data); },
  deleteProject(id) { return this.request('DELETE', `/projects/${id}`); },
  
  getImages(projectId, offset=0, limit=200, filters = {}) {
    const params = new URLSearchParams();
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    if (filters.imageId) params.set('image_id', filters.imageId);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    if (filters.className) params.set('class_name', filters.className);
    return this.request('GET', `/projects/${projectId}/images?${params.toString()}`);
  },
  getAnnotationDashboard(projectId) { return this.request('GET', `/projects/${projectId}/annotation_dashboard`); },
  rebuildAnnotationIndex(projectId) { return this.request('POST', `/projects/${projectId}/annotation_index/rebuild`); },
  getUnlabeledImage(projectId, afterImageId='', direction='next') {
    const params = new URLSearchParams();
    if (afterImageId) params.set('after_image_id', afterImageId);
    if (direction) params.set('direction', direction);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/projects/${projectId}/images/unlabeled${suffix}`);
  },
  refreshImages(projectId) { return this.request('POST', `/projects/${projectId}/images/refresh`); },
  uploadImage(projectId, file) {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', `/projects/${projectId}/images/upload`, fd, true);
  },
  importImages(projectId, sourceDir) { return this.request('POST', `/projects/${projectId}/images/import`, {source_dir: sourceDir}); },
  deleteImage(projectId, imageId) { return this.request('DELETE', `/projects/${projectId}/images/${imageId}`); },
  getUploadConfig() { return this.request('GET', '/uploads/config'); },
  uploadDatasetFile({ file, targetDir, relativePath = '', overwrite = false, onProgress = null, onXhr = null }) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('target_dir', targetDir);
      fd.append('relative_path', relativePath || file.webkitRelativePath || file.name);
      fd.append('overwrite', overwrite ? 'true' : 'false');

      const xhr = new XMLHttpRequest();
      if (onXhr) onXhr(xhr);
      xhr.open('POST', `${API_BASE}/uploads/dataset`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch(e) {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
          return;
        }
        const errorCode = data && data.code ? String(data.code) : '';
        if (xhr.status === 401 || errorCode === 'login_required') {
          window.location.href = '/login';
          reject(new Error('Login required'));
          return;
        }
        const detail = data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : xhr.statusText;
        reject(new Error(`API Error ${xhr.status}: ${detail}`));
      };
      xhr.onerror = () => reject(new Error('network error during upload'));
      xhr.onabort = () => reject(new Error('upload canceled'));
      xhr.send(fd);
    });
  },
  
  getAnnotations(projectId, imageId, requestOptions = {}) {
    return this.request('GET', `/projects/${projectId}/images/${imageId}/annotations`, null, false, requestOptions);
  },
  saveAnnotations(projectId, imageId, annotations) { return this.request('POST', '/annotations/save', { project_id: projectId, image_id: imageId, annotations}); },
  appendAnnotations(projectId, imageId, annotations) { return this.request('POST', '/annotations/append', { project_id: projectId, image_id: imageId, annotations}); },
  
  addClass(projectId, classes_text) { return this.request('POST', `/projects/${projectId}/classes/add`, {classes_text}); },
  deleteClass(projectId, class_name) { return this.request('DELETE', `/projects/${projectId}/classes/${encodeURIComponent(class_name)}`); },
  
  // Samplers & Inference
  testSam3(apiUrl) { return this.request('POST', '/sam3/health', { api_base_url: apiUrl }); },
  getSam3Status(apiUrl = '') {
    const suffix = apiUrl ? `?api_base_url=${encodeURIComponent(apiUrl)}` : '';
    return this.request('GET', `/sam3/status${suffix}`);
  },
  getServicesStatus() { return this.request('GET', '/services/status'); },
  controlService(service, action) { return this.request('POST', `/services/${encodeURIComponent(service)}/${encodeURIComponent(action)}`); },
  getServiceLogs(service, tail = 120) { return this.request('GET', `/services/${encodeURIComponent(service)}/logs?tail=${tail}`); },
  getSapiensStatus() { return this.request('GET', '/sapiens/status'); },
  downloadSapiensCheckpoint() { return this.request('POST', '/sapiens/checkpoint/download'); },
  getSapiensCheckpointDownload(jobId) { return this.request('GET', `/sapiens/checkpoint/download/${encodeURIComponent(jobId)}`); },
  
  infer(data) { return this.request('POST', '/infer', data); },
  inferExample(data) { return this.request('POST', '/infer/example_preview', data); },
  
  // Batch Jobs
  startBatchInfer(data) { return this.request('POST', '/infer/jobs/start_batch', data); },
  getInferActiveJob(projectId) { return this.request('GET', `/infer/jobs/active?project_id=${projectId}`); },
  getInferJob(jobId) { return this.request('GET', `/infer/jobs/${jobId}`); },
  stopInferJob(projectId) { return this.request('POST', '/infer/jobs/stop', {project_id: projectId}); },
  resumeInferJob(data) { return this.request('POST', '/infer/jobs/resume', data); },

  smartFilterPreview(data) { return this.request('POST', '/filter/intelligent/jobs/start_preview', data); },
  smartFilterApply(data) { return this.request('POST', '/filter/intelligent/jobs/start_apply', data); },
  getFilterActiveJob(projectId) { return this.request('GET', `/filter/intelligent/jobs/active?project_id=${projectId}`); },
  getFilterJob(jobId) { return this.request('GET', `/filter/intelligent/jobs/${jobId}`); },
  getLatestFilterRun(projectId) { return this.request('GET', `/filter/intelligent/runs/latest?project_id=${encodeURIComponent(projectId)}`); },
  rollbackFilterRun(projectId, runId) { return this.request('POST', `/filter/intelligent/runs/${encodeURIComponent(runId)}/rollback?project_id=${encodeURIComponent(projectId)}`); },

  exportProject(data) { return this.request('POST', '/export', data); },

  getUIState(projectId = '') {
    const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/ui_state${suffix}`);
  },
  setUIState(projectId, state) {
    return this.request('POST', '/ui_state', {
      project_id: projectId || null,
      state: state || {}
    });
  },

  // Configuration
  getGlobalConfig() { return this.request('GET', '/config/global'); },
  setGlobalConfig(data) { return this.request('POST', '/config/global', data); },
  restartWebAuto() { return this.request('POST', '/system/restart'); },
  getCacheDir() { return this.request('GET', '/config/cache_dir'); },
  setCacheDir(path) { return this.request('POST', '/config/cache_dir', {cache_dir: path}); }
};
