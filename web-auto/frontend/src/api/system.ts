import { get, post } from './client';

export interface HealthResponse {
  status: string;
  service?: string;
  mode?: string;
  timestamp?: number;
  task_queue?: Record<string, unknown>;
  [key: string]: unknown;
}

/** GET /api/health */
export function getHealth() {
  return get<HealthResponse>('/health');
}

/** POST /api/system/restart — the server exits right after responding, the request may be interrupted. */
export function restartWebAuto() {
  return post<{ ok: boolean; message: string }>('/system/restart');
}

/** GET /api/auth/status */
export function getAuthStatus() {
  return get<Record<string, unknown>>('/auth/status');
}

/** POST /api/auth/logout */
export function logout() {
  return post<Record<string, unknown>>('/auth/logout');
}

/** POST /api/auth/password */
export function changePassword(currentPassword: string, newPassword: string) {
  return post<Record<string, unknown>>('/auth/password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export interface ServiceOperation {
  status?: string;
  phase?: string;
  logs?: string[];
  [key: string]: unknown;
}

export interface ServiceInfo {
  service: string;
  status: string;
  containers?: unknown[];
  operation?: ServiceOperation | null;
  manage_command?: string;
  [key: string]: unknown;
}

export interface ServicesStatusResponse {
  ok?: boolean;
  ops_available?: boolean;
  services?: ServiceInfo[];
  error?: string;
  [key: string]: unknown;
}

/** GET /api/services/status */
export function getServicesStatus() {
  return get<ServicesStatusResponse>('/services/status');
}

/** POST /api/services/{service}/{action} (start | stop | restart ...) */
export function controlService(service: string, action: string) {
  return post<Record<string, unknown>>(
    `/services/${encodeURIComponent(service)}/${encodeURIComponent(action)}`,
  );
}

/** GET /api/services/{service}/logs */
export function getServiceLogs(service: string, tail = 120) {
  return get<Record<string, unknown>>(
    `/services/${encodeURIComponent(service)}/logs?tail=${tail}`,
  );
}

/** POST /api/sam3/health */
export function testSam3(apiUrl: string) {
  return post<{ ok: boolean; result?: unknown }>('/sam3/health', { api_base_url: apiUrl });
}

/** GET /api/sam3/status */
export function getSam3Status(apiUrl = '') {
  const suffix = apiUrl ? `?api_base_url=${encodeURIComponent(apiUrl)}` : '';
  return get<{ ok?: boolean; api_base_url?: string; result?: unknown }>(`/sam3/status${suffix}`);
}

/** POST /api/locate/health */
export function testLocate(apiUrl: string) {
  return post<{ ok: boolean; result?: unknown }>('/locate/health', { api_base_url: apiUrl });
}

/** GET /api/locate/status */
export function getLocateStatus(apiUrl = '') {
  const suffix = apiUrl ? `?api_base_url=${encodeURIComponent(apiUrl)}` : '';
  return get<{ ok?: boolean; api_base_url?: string; result?: unknown }>(`/locate/status${suffix}`);
}

/** POST /api/locate/unload */
export function unloadLocate(apiUrl: string) {
  return post<Record<string, unknown>>('/locate/unload', { api_base_url: apiUrl });
}

export interface SapiensDownloadJob {
  job_id?: string;
  status?: string;
  percent?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  [key: string]: unknown;
}

export interface SapiensCheckpointInfo {
  checkpoint_exists?: boolean;
  detector_exists?: boolean;
  checkpoint_path?: string;
  detector_path?: string;
  partial_size_bytes?: number;
  download_job?: SapiensDownloadJob | null;
  [key: string]: unknown;
}

export interface SapiensStatusResponse {
  ok?: boolean;
  error?: string;
  api_base_url?: string;
  checkpoint?: SapiensCheckpointInfo;
  [key: string]: unknown;
}

/** GET /api/sapiens/status */
export function getSapiensStatus() {
  return get<SapiensStatusResponse>('/sapiens/status');
}

/** POST /api/sapiens/checkpoint/download */
export function downloadSapiensCheckpoint() {
  return post<{ ok?: boolean; job?: SapiensDownloadJob }>('/sapiens/checkpoint/download');
}

/** GET /api/sapiens/checkpoint/download/{job_id} */
export function getSapiensCheckpointDownload(jobId: string) {
  return get<{ ok?: boolean; job?: SapiensDownloadJob }>(
    `/sapiens/checkpoint/download/${encodeURIComponent(jobId)}`,
  );
}
