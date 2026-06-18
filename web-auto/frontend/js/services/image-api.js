import { request, uploadDatasetFile } from './api-client.js';

export const imageApi = {
  getImages(projectId, offset = 0, limit = 200, filters = {}) {
    const params = new URLSearchParams();
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    if (filters.imageId) params.set('image_id', filters.imageId);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    if (filters.className) params.set('class_name', filters.className);
    return request('GET', `/projects/${projectId}/images?${params.toString()}`);
  },

  getUnlabeledImage(projectId, afterImageId = '', direction = 'next') {
    const params = new URLSearchParams();
    if (afterImageId) params.set('after_image_id', afterImageId);
    if (direction) params.set('direction', direction);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/projects/${projectId}/images/unlabeled${suffix}`);
  },

  refreshImages(projectId) {
    return request('POST', `/projects/${projectId}/images/refresh`);
  },

  uploadImage(projectId, file) {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', `/projects/${projectId}/images/upload`, fd, true);
  },

  importImages(projectId, sourceDir) {
    return request('POST', `/projects/${projectId}/images/import`, { source_dir: sourceDir });
  },

  deleteImage(projectId, imageId) {
    return request('DELETE', `/projects/${projectId}/images/${imageId}`);
  },

  getImageTilesInfo(projectId, imageId, requestOptions = {}) {
    return request('GET', `/projects/${projectId}/images/${imageId}/tiles/info`, null, false, requestOptions);
  },

  getUploadConfig() {
    return request('GET', '/uploads/config');
  },

  uploadDatasetFile,
};
