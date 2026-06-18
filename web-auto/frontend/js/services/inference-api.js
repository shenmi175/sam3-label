import { request } from './api-client.js';

export const inferenceApi = {
  testSam3(apiUrl) {
    return request('POST', '/sam3/health', { api_base_url: apiUrl });
  },

  getSam3Status(apiUrl = '') {
    const suffix = apiUrl ? `?api_base_url=${encodeURIComponent(apiUrl)}` : '';
    return request('GET', `/sam3/status${suffix}`);
  },

  getServicesStatus() {
    return request('GET', '/services/status');
  },

  controlService(service, action) {
    return request('POST', `/services/${encodeURIComponent(service)}/${encodeURIComponent(action)}`);
  },

  getServiceLogs(service, tail = 120) {
    return request('GET', `/services/${encodeURIComponent(service)}/logs?tail=${tail}`);
  },

  getSapiensStatus() {
    return request('GET', '/sapiens/status');
  },

  downloadSapiensCheckpoint() {
    return request('POST', '/sapiens/checkpoint/download');
  },

  getSapiensCheckpointDownload(jobId) {
    return request('GET', `/sapiens/checkpoint/download/${encodeURIComponent(jobId)}`);
  },

  inferPose(data) {
    return request('POST', '/pose/infer', data);
  },

  infer(data) {
    return request('POST', '/infer', data);
  },

  inferExample(data) {
    return request('POST', '/infer/example_preview', data);
  },

  startBatchInfer(data) {
    return request('POST', '/infer/jobs/start_batch', data);
  },

  getInferActiveJob(projectId) {
    return request('GET', `/infer/jobs/active?project_id=${projectId}`);
  },

  getInferJob(jobId) {
    return request('GET', `/infer/jobs/${jobId}`);
  },

  stopInferJob(projectId) {
    return request('POST', '/infer/jobs/stop', { project_id: projectId });
  },

  resumeInferJob(data) {
    return request('POST', '/infer/jobs/resume', data);
  },
};
