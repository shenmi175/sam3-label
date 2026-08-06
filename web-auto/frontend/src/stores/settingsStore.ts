import { create } from 'zustand';
import { get } from '../api/client';
import i18n from '../i18n';

function clamp01(value: unknown, fallback = 0.5): number {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function clampBatchSize(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(32, parsed)) : 1;
}

function normalizeContourMode(value: unknown): 'split' | 'merged' {
  return String(value || '').trim().toLowerCase() === 'merged' ? 'merged' : 'split';
}

export type ThemeMode = 'light' | 'dark';

interface SettingsState {
  sam3ApiUrl: string;
  locateApiUrl: string;
  defaultBackend: string;
  scoreDefault: number;
  contourMode: 'split' | 'merged';
  themeMode: ThemeMode;
  language: string;
  threshold: number;
  batchSize: number;
  initialized: boolean;
  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  init: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, getState) => ({
  sam3ApiUrl: localStorage.getItem('sam3ApiUrl') || 'http://127.0.0.1:8001',
  locateApiUrl: localStorage.getItem('locateApiUrl') || 'http://127.0.0.1:8004',
  defaultBackend: localStorage.getItem('defaultBackend') || 'sam3',
  scoreDefault: clamp01(localStorage.getItem('scoreDefault')),
  contourMode: normalizeContourMode(localStorage.getItem('contourMode')),
  themeMode: (localStorage.getItem('theme') as ThemeMode) || 'light',
  language: localStorage.getItem('language') || 'zh',
  threshold: clamp01(localStorage.getItem('threshold')),
  batchSize: clampBatchSize(localStorage.getItem('batchSize')),
  initialized: false,

  set: (key, value) => {
    let v = value;
    if (key === 'threshold' || key === 'scoreDefault') v = clamp01(value) as never;
    else if (key === 'batchSize') v = clampBatchSize(value) as never;
    else if (key === 'contourMode') v = normalizeContourMode(value) as never;

    const lsKey = key === 'themeMode' ? 'theme' : key;
    localStorage.setItem(lsKey, String(v));
    if (key === 'language') i18n.changeLanguage(String(v));
    set({ [key]: v } as Pick<SettingsState, typeof key>);
  },

  init: async () => {
    if (getState().initialized) return;
    set({ initialized: true });
    i18n.changeLanguage(getState().language);
    try {
      const defaults = await get<Record<string, unknown>>('/config/defaults');
      const apiUrl = String(defaults?.sam3_api_base_url || '').trim();
      const allowed = Array.isArray(defaults?.allowed_sam3_api_base_urls)
        ? (defaults.allowed_sam3_api_base_urls as string[]).map((i) => String(i || '').replace(/\/+$/, '')).filter(Boolean)
        : [];
      const current = (localStorage.getItem('sam3ApiUrl') || '').replace(/\/+$/, '');
      if (apiUrl && (!current || (allowed.length && !allowed.includes(current)))) {
        localStorage.setItem('sam3ApiUrl', apiUrl);
        set({ sam3ApiUrl: apiUrl });
      }
      const locateUrl = String(defaults?.locate_api_base_url || '').trim();
      const locateAllowed = Array.isArray(defaults?.allowed_locate_api_base_urls)
        ? (defaults.allowed_locate_api_base_urls as string[]).map((i) => String(i || '').replace(/\/+$/, '')).filter(Boolean)
        : [];
      const locateCurrent = (localStorage.getItem('locateApiUrl') || '').replace(/\/+$/, '');
      if (locateUrl && (!locateCurrent || (locateAllowed.length && !locateAllowed.includes(locateCurrent)))) {
        localStorage.setItem('locateApiUrl', locateUrl);
        set({ locateApiUrl: locateUrl });
      }
    } catch (err) {
      console.warn('load default config failed', err);
    }
  },
}));
