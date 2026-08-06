import { get, post } from './client';

/** Shape of GET/POST /api/config/global `config` payload (backend: global_config_info). */
export interface GlobalConfig {
  cache_dir?: string;
  default_dir?: string;
  upload_root?: string;
  allowed_data_roots?: string[];
  default_upload_target_dir?: string;
  upload_target_dir?: string;
  sam3_api_base_url?: string;
  allowed_sam3_api_base_urls?: string[];
  locate_api_base_url?: string;
  allowed_locate_api_base_urls?: string[];
  sapiens_api_base_url?: string;
  ops_api_configured?: boolean;
  sam3_max_batch_files?: number;
  max_tile_workers?: number;
  preview_max_edge?: number;
  thumbnail_max_edge?: number;
  auth_enabled?: boolean;
  session_ttl_seconds?: number;
  restart_supported?: boolean;
  restart_note?: string;
  [key: string]: unknown;
}

export interface GlobalConfigUpdate {
  cache_dir?: string;
  upload_target_dir?: string;
  sam3_api_base_url?: string;
  locate_api_base_url?: string;
}

export interface ConfigDefaults {
  sam3_api_base_url?: string;
  allowed_sam3_api_base_urls?: string[];
  locate_api_base_url?: string;
  allowed_locate_api_base_urls?: string[];
  sapiens_api_base_url?: string;
  ops_api_configured?: boolean;
  data_dir?: string;
  sam3_max_batch_files?: number;
  [key: string]: unknown;
}

/** GET /api/config/global */
export function getGlobalConfig() {
  return get<{ config: GlobalConfig }>('/config/global');
}

/** POST /api/config/global */
export function setGlobalConfig(data: GlobalConfigUpdate) {
  return post<{ ok: boolean; config: GlobalConfig }>('/config/global', data);
}

/** GET /api/config/defaults */
export function getConfigDefaults() {
  return get<ConfigDefaults>('/config/defaults');
}

/** GET /api/config/cache_dir */
export function getCacheDir() {
  return get<{ cache_dir: string; default_dir: string }>('/config/cache_dir');
}

/** POST /api/config/cache_dir */
export function setCacheDir(path: string) {
  return post<{ ok: boolean; cache_dir: string; message: string }>('/config/cache_dir', {
    cache_dir: path,
  });
}

/** GET /api/ui_state */
export function getUIState(projectId = '') {
  const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return get<{ project_id?: string | null; state?: Record<string, unknown> }>(`/ui_state${suffix}`);
}

/** POST /api/ui_state */
export function setUIState(projectId: string, state: Record<string, unknown>) {
  return post<{ ok: boolean }>('/ui_state', {
    project_id: projectId || null,
    state: state || {},
  });
}

/** GET /api/info */
export function getApiInfo() {
  return get<Record<string, unknown>>('/info');
}
