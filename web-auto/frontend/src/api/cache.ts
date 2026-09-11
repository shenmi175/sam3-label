import { get, post } from './client';

export type CacheScope = 'previews' | 'tiles' | 'composites';

export interface CacheUsage {
  file_count: number;
  directory_count: number;
  logical_bytes: number;
  disk_bytes: number;
}

export interface CacheStatus {
  data_dir: string;
  scopes: Record<CacheScope, CacheUsage>;
  total: CacheUsage;
}

export interface CacheCleanupResult {
  ok: boolean;
  scopes: Partial<Record<CacheScope, CacheUsage>>;
  released: CacheUsage;
  status: CacheStatus;
}

export function getCacheStatus() {
  return get<CacheStatus>('/cache/status');
}

export function cleanupCache(scopes: CacheScope[]) {
  return post<CacheCleanupResult>('/cache/cleanup', { scopes, confirm: true });
}
