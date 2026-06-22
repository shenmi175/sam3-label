import { api } from '../../api.js';
import { store } from '../../store.js';

export class GpuStatusController {
  constructor(workspace) {
    this.workspace = workspace;
    this.interval = null;
    this.failures = 0;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  formatMemory(mb) {
    const value = Number(mb || 0);
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 0 : 1)}G`;
    return `${Math.round(value)}M`;
  }

  setUnavailable(message = 'GPU unavailable') {
    const dot = document.getElementById('gpu-status-dot');
    const utilFill = document.getElementById('gpu-util-fill');
    const memFill = document.getElementById('gpu-mem-fill');
    const utilText = document.getElementById('gpu-util-text');
    const memText = document.getElementById('gpu-mem-text');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = '#94a3b8';
    if (utilFill) utilFill.style.width = '0%';
    if (memFill) memFill.style.width = '0%';
    if (utilText) utilText.textContent = '--';
    if (memText) memText.textContent = '--';
    if (widget) widget.title = message;
  }

  markStale(message = 'GPU status refresh delayed') {
    const dot = document.getElementById('gpu-status-dot');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = '#f59e0b';
    if (widget) widget.title = message;
  }

  render(status) {
    const gpu = status?.result?.gpu || status?.gpu || {};
    const summary = gpu.summary || {};
    const gpus = Array.isArray(gpu.gpus) ? gpu.gpus : [];
    if (!gpu.available || gpus.length === 0) {
      this.setUnavailable('sam3-api GPU status unavailable');
      return;
    }

    const gpuUtilRaw = summary.gpu_utilization_percent;
    const gpuUtil = Number.isFinite(Number(gpuUtilRaw)) ? Math.max(0, Math.min(100, Number(gpuUtilRaw))) : null;
    const memUsed = Number(summary.memory_used_mb || 0);
    const memTotal = Number(summary.memory_total_mb || 0);
    const memPctRaw = Number(summary.memory_utilization_percent);
    const memPct = Number.isFinite(memPctRaw) ? Math.max(0, Math.min(100, memPctRaw)) : 0;
    const stale = Boolean(gpu.stale);
    const age = Number(gpu.age_seconds || 0);
    const dot = document.getElementById('gpu-status-dot');
    const utilFill = document.getElementById('gpu-util-fill');
    const memFill = document.getElementById('gpu-mem-fill');
    const utilText = document.getElementById('gpu-util-text');
    const memText = document.getElementById('gpu-mem-text');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = stale ? '#f59e0b' : (memPct >= 90 ? '#ef4444' : (memPct >= 75 ? '#f59e0b' : '#10b981'));
    if (utilFill) utilFill.style.width = gpuUtil === null ? '0%' : `${gpuUtil.toFixed(0)}%`;
    if (memFill) memFill.style.width = `${memPct.toFixed(0)}%`;
    if (utilText) utilText.textContent = gpuUtil === null ? '--' : `${gpuUtil.toFixed(0)}%`;
    if (memText) memText.textContent = `${this.formatMemory(memUsed)}/${this.formatMemory(memTotal)}`;
    if (widget) {
      const lines = gpus.map((item) => {
        const util = item.gpu_utilization_percent === null || item.gpu_utilization_percent === undefined
          ? '--'
          : `${Number(item.gpu_utilization_percent).toFixed(0)}%`;
        return `GPU${item.index} ${item.name}: ${util}, ${this.formatMemory(item.memory_used_mb)}/${this.formatMemory(item.memory_total_mb)}`;
      });
      widget.title = `${stale ? `GPU status is stale (${age.toFixed(0)}s old)\n` : ''}${lines.join('\n')}`;
    }
  }

  start() {
    this.stop();
    const poll = async () => {
      try {
        const status = await api.getSam3Status(store.state.config.sam3ApiUrl);
        if (this.workspace.isUnmounted) return;
        this.failures = 0;
        this.render(status);
      } catch (err) {
        if (this.workspace.isUnmounted) return;
        this.failures += 1;
        const message = String(err?.message || err || 'GPU status unavailable');
        if (this.failures >= 3) {
          this.setUnavailable(message);
        } else {
          this.markStale(message);
        }
      }
    };
    poll();
    this.interval = setInterval(poll, 1000);
  }
}
