import { useEffect, useRef, useState } from 'react';
import { getLocateStatus, getSam3Status } from '../api/system';
import { useSettingsStore } from '../stores/settingsStore';

const GPU_POLL_INTERVAL_MS = 1000;
const GPU_FAILURE_THRESHOLD = 3;

export interface GpuItemInfo {
  index: number;
  name: string;
  utilizationText: string;
  memoryText: string;
}

export interface GpuStatusSummary {
  available: boolean;
  stale: boolean;
  ageSeconds: number;
  /** 0-100 or null when unknown. */
  gpuUtilization: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number;
  /** 0-100. */
  memoryPct: number;
  gpus: GpuItemInfo[];
  statusMessage: string;
}

const UNAVAILABLE: GpuStatusSummary = {
  available: false,
  stale: false,
  ageSeconds: 0,
  gpuUtilization: null,
  memoryUsedMb: 0,
  memoryTotalMb: 0,
  memoryPct: 0,
  gpus: [],
  statusMessage: '',
};

/** Legacy formatMemory: ≥1024 MB → G (1 decimal, none past 10G), else M. */
export function formatGpuMemory(mb: unknown): string {
  const value = Number(mb || 0);
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 0 : 1)}G`;
  return `${Math.round(value)}M`;
}

function summarize(status: unknown): GpuStatusSummary {
  const resp = status as { result?: { gpu?: Record<string, unknown> }; gpu?: Record<string, unknown> };
  const gpu = (resp?.result?.gpu || resp?.gpu || {}) as Record<string, unknown>;
  const summary = (gpu.summary || {}) as Record<string, unknown>;
  const gpus = Array.isArray(gpu.gpus) ? (gpu.gpus as Record<string, unknown>[]) : [];
  if (!gpu.available || gpus.length === 0) {
    return { ...UNAVAILABLE, statusMessage: 'sam3-api GPU status unavailable' };
  }
  const gpuUtilRaw = Number(summary.gpu_utilization_percent);
  const gpuUtilization = Number.isFinite(gpuUtilRaw) ? Math.max(0, Math.min(100, gpuUtilRaw)) : null;
  const memoryUsedMb = Number(summary.memory_used_mb || 0);
  const memoryTotalMb = Number(summary.memory_total_mb || 0);
  const memPctRaw = Number(summary.memory_utilization_percent);
  const memoryPct = Number.isFinite(memPctRaw) ? Math.max(0, Math.min(100, memPctRaw)) : 0;
  const items: GpuItemInfo[] = gpus.map((item) => {
    const util =
      item.gpu_utilization_percent === null || item.gpu_utilization_percent === undefined
        ? '--'
        : `${Number(item.gpu_utilization_percent).toFixed(0)}%`;
    return {
      index: Number(item.index ?? 0),
      name: String(item.name ?? ''),
      utilizationText: util,
      memoryText: `${formatGpuMemory(item.memory_used_mb)}/${formatGpuMemory(item.memory_total_mb)}`,
    };
  });
  return {
    available: true,
    stale: Boolean(gpu.stale),
    ageSeconds: Number(gpu.age_seconds || 0),
    gpuUtilization,
    memoryUsedMb,
    memoryTotalMb,
    memoryPct,
    gpus: items,
    statusMessage: '',
  };
}

function summarizeLocateStatus(status: unknown): GpuStatusSummary {
  const resp = status as { result?: { gpu?: Record<string, unknown> } };
  const gpu = (resp?.result?.gpu || {}) as Record<string, unknown>;
  const usedMb = Number(gpu.used_mb || 0);
  const totalMb = Number(gpu.total_mb || 0);
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
    return { ...UNAVAILABLE, statusMessage: 'locate-anything-api GPU status unavailable' };
  }
  return {
    available: true,
    stale: false,
    ageSeconds: 0,
    gpuUtilization: null,
    memoryUsedMb: usedMb,
    memoryTotalMb: totalMb,
    memoryPct: Math.max(0, Math.min(100, (usedMb / totalMb) * 100)),
    gpus: [
      {
        index: Number(gpu.device_index ?? 0),
        name: String(gpu.name ?? ''),
        utilizationText: '--',
        memoryText: `${formatGpuMemory(usedMb)}/${formatGpuMemory(totalMb)}`,
      },
    ],
    statusMessage: '',
  };
}

/**
 * GPU status polling — 1:1 port of the legacy GpuStatusController: poll
 * /api/sam3/status every second; after 3 consecutive failures mark the GPU
 * unavailable, fewer failures mark it stale.
 */
export function useGpuStatus(active: boolean): GpuStatusSummary {
  const [summary, setSummary] = useState<GpuStatusSummary>(UNAVAILABLE);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      let summary: GpuStatusSummary | null = null;
      try {
        const status = await getSam3Status(useSettingsStore.getState().sam3ApiUrl);
        if (cancelled) return;
        const sam3Summary = summarize(status);
        if (sam3Summary.available) summary = sam3Summary;
      } catch {
        // sam3-api offline: fall back to locate-anything-api GPU stats
      }
      if (!summary) {
        try {
          const status = await getLocateStatus();
          if (cancelled) return;
          const locateSummary = summarizeLocateStatus(status);
          if (locateSummary.available) summary = locateSummary;
        } catch {
          // both sources unavailable
        }
      }
      if (cancelled) return;
      if (summary) {
        failuresRef.current = 0;
        setSummary(summary);
        return;
      }
      failuresRef.current += 1;
      const message = 'GPU status unavailable';
      if (failuresRef.current >= GPU_FAILURE_THRESHOLD) {
        setSummary({ ...UNAVAILABLE, statusMessage: message });
      } else {
        setSummary((prev) => ({ ...prev, stale: true, statusMessage: message }));
      }
    };

    void poll();
    const interval = setInterval(poll, GPU_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  return summary;
}
