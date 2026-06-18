import { request } from './api-client.js';

export const filterApi = {
  smartFilterPreview(data) {
    return request('POST', '/filter/intelligent/jobs/start_preview', data);
  },

  smartFilterApply(data) {
    return request('POST', '/filter/intelligent/jobs/start_apply', data);
  },

  getFilterActiveJob(projectId) {
    return request('GET', `/filter/intelligent/jobs/active?project_id=${projectId}`);
  },

  getFilterJob(jobId) {
    return request('GET', `/filter/intelligent/jobs/${jobId}`);
  },

  getLatestFilterRun(projectId) {
    return request('GET', `/filter/intelligent/runs/latest?project_id=${encodeURIComponent(projectId)}`);
  },

  rollbackFilterRun(projectId, runId) {
    return request('POST', `/filter/intelligent/runs/${encodeURIComponent(runId)}/rollback?project_id=${encodeURIComponent(projectId)}`);
  },
};
