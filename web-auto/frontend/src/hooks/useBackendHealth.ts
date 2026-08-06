import { useEffect, useState } from 'react';
import { getHealth } from '../api/system';

export type BackendHealth = 'checking' | 'online' | 'error' | 'offline';

export const HEALTH_POLL_INTERVAL_MS = 10000;

/**
 * Backend health indicator polling — port of the legacy startHealthCheck:
 * GET /api/health every 10 s; `status === 'ok'` → online (green), non-ok
 * response → error (red), network failure → offline (red).
 */
export function useBackendHealth(intervalMs = HEALTH_POLL_INTERVAL_MS): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await getHealth();
        if (!cancelled) setHealth(res?.status === 'ok' ? 'online' : 'error');
      } catch {
        if (!cancelled) setHealth('offline');
      }
    };
    void check();
    const timer = setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return health;
}
