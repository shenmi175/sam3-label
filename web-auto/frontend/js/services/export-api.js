import { request } from './api-client.js';

export const exportApi = {
  exportProject(data) {
    return request('POST', '/export', data);
  },
  previewExport(data) {
    return request('POST', '/export/preview', data);
  },
};
