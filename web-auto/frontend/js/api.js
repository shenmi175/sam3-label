import { request } from './services/api-client.js';
import { annotationApi } from './services/annotation-api.js';
import { exportApi } from './services/export-api.js';
import { filterApi } from './services/filter-api.js';
import { imageApi } from './services/image-api.js';
import { inferenceApi } from './services/inference-api.js';
import { projectApi } from './services/project-api.js';
import { systemApi } from './services/system-api.js';

export const api = {
  request,
  ...systemApi,
  ...projectApi,
  ...imageApi,
  ...annotationApi,
  ...inferenceApi,
  ...filterApi,
  ...exportApi,
};
