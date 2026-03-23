const API_BASE = '/api';

export const api = {
  async request(method, endpoint, data = null, isFormData = false) {
    const options = {
      method,
      headers: {},
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
      try {
        const d = await response.json();
        if (d && d.detail) errorMsg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
      } catch(e) {}
      throw new Error(`API Error ${response.status}: ${errorMsg}`);
    }
    return response.json();
  },

  getProjects() { return this.request('GET', '/projects'); },
  getProject(id, includeImages=false) { return this.request('GET', `/projects/${id}?include_images=${includeImages}`); },
  getHealth() { return this.request('GET', '/health'); },
  createProject(data) { return this.request('POST', '/projects/open', data); },
  deleteProject(id) { return this.request('DELETE', `/projects/${id}`); },
  
  getImages(projectId, offset=0, limit=200) { return this.request('GET', `/projects/${projectId}/images?offset=${offset}&limit=${limit}`); },
  refreshImages(projectId) { return this.request('POST', `/projects/${projectId}/images/refresh`); },
  uploadImage(projectId, file) {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', `/projects/${projectId}/images/upload`, fd, true);
  },
  importImages(projectId, sourceDir) { return this.request('POST', `/projects/${projectId}/images/import`, {source_dir: sourceDir}); },
  deleteImage(projectId, imageId) { return this.request('DELETE', `/projects/${projectId}/images/${imageId}`); },
  
  getAnnotations(projectId, imageId) { return this.request('GET', `/projects/${projectId}/images/${imageId}/annotations`); },
  saveAnnotations(projectId, imageId, annotations) { return this.request('POST', '/annotations/save', { project_id: projectId, image_id: imageId, annotations}); },
  appendAnnotations(projectId, imageId, annotations) { return this.request('POST', '/annotations/append', { project_id: projectId, image_id: imageId, annotations}); },
  
  addClass(projectId, classes_text) { return this.request('POST', `/projects/${projectId}/classes/add`, {classes_text}); },
  deleteClass(projectId, class_name) { return this.request('DELETE', `/projects/${projectId}/classes/${encodeURIComponent(class_name)}`); },
  
  // Samplers & Inference
  testSam3(apiUrl) { return this.request('POST', '/sam3/health', { api_base_url: apiUrl }); },
  
  infer(data) { return this.request('POST', '/infer', data); },
  inferPreview(data) { return this.request('POST', '/infer/preview', data); },
  inferExample(data) { return this.request('POST', '/infer/example_preview', data); },
  
  // Batch Jobs
  startBatchInfer(data) { return this.request('POST', '/infer/jobs/start_batch', data); },
  startBatchExample(data) { return this.request('POST', '/infer/jobs/start_batch_example', data); },
  getInferActiveJob(projectId) { return this.request('GET', `/infer/jobs/active?project_id=${projectId}`); },
  getInferJob(jobId) { return this.request('GET', `/infer/jobs/${jobId}`); },
  stopInferJob(projectId) { return this.request('POST', '/infer/jobs/stop', {project_id: projectId}); },
  resumeInferJob(data) { return this.request('POST', '/infer/jobs/resume', data); },

  smartFilterPreview(data) { return this.request('POST', '/filter/intelligent/jobs/start_preview', data); },
  smartFilterApply(data) { return this.request('POST', '/filter/intelligent/jobs/start_apply', data); },
  getFilterActiveJob(projectId) { return this.request('GET', `/filter/intelligent/jobs/active?project_id=${projectId}`); },
  getFilterJob(jobId) { return this.request('GET', `/filter/intelligent/jobs/${jobId}`); },

  exportProject(data) { return this.request('POST', '/export', data); },
  
  startVideoJob(data) { return this.request('POST', '/video/jobs/start', data); },
  getVideoJob(projectId) { return this.request('GET', `/video/jobs/${projectId}`); },
  stopVideoJob(projectId) { return this.request('POST', '/video/jobs/stop', {project_id: projectId}); },
  resumeVideoJob(data) { return this.request('POST', '/video/jobs/resume', data); },
  getVideoAnnotations(projectId) { return this.request('GET', `/projects/${projectId}/video/annotations`); },
  saveVideoAnnotations(projectId, frames, replaceAll = true) {
    return this.request('POST', `/projects/${projectId}/video/annotations/save`, {
      project_id: projectId,
      frames,
      replace_all: replaceAll
    });
  },

  // Configuration
  getCacheDir() { return this.request('GET', '/config/cache_dir'); },
  setCacheDir(path) { return this.request('POST', '/config/cache_dir', {cache_dir: path}); }
};
