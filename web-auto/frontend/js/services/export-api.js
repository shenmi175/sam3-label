import { request } from './api-client.js';

export const exportApi = {
  exportProject(data) {
    return request('POST', '/export', data);
  },
};
