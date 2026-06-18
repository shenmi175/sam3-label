import { request } from './api-client.js';

export const annotationApi = {
  getAnnotationDashboard(projectId) {
    return request('GET', `/projects/${projectId}/annotation_dashboard`);
  },

  rebuildAnnotationIndex(projectId) {
    return request('POST', `/projects/${projectId}/annotation_index/rebuild`);
  },

  getAnnotations(projectId, imageId, requestOptions = {}) {
    return request('GET', `/projects/${projectId}/images/${imageId}/annotations`, null, false, requestOptions);
  },

  saveAnnotations(projectId, imageId, annotations) {
    return request('POST', '/annotations/save', { project_id: projectId, image_id: imageId, annotations });
  },

  appendAnnotations(projectId, imageId, annotations) {
    return request('POST', '/annotations/append', { project_id: projectId, image_id: imageId, annotations });
  },
};
