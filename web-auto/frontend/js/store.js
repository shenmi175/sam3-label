function clampThreshold(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.5;
}

function clampBatchSize(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(32, parsed)) : 10;
}

export const store = {
  state: {
    config: {
      sam3ApiUrl: localStorage.getItem('sam3ApiUrl') || 'http://127.0.0.1:8001',
      theme: localStorage.getItem('theme') || 'light',
      language: localStorage.getItem('language') || 'zh',
      threshold: clampThreshold(localStorage.getItem('threshold')),
      batchSize: clampBatchSize(localStorage.getItem('batchSize'))
    }
  },
  listeners: [],
  
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    }
  },
  
  setConfig(key, value) {
    if (key === 'threshold') {
      value = clampThreshold(value);
    } else if (key === 'batchSize') {
      value = clampBatchSize(value);
    }
    this.state.config[key] = value;
    if (key === 'sam3ApiUrl') {
      localStorage.setItem('sam3ApiUrl', value);
    } else if (key === 'theme') {
      localStorage.setItem('theme', value);
      this.applyTheme(value);
    } else if (key === 'language') {
      localStorage.setItem('language', value);
    } else if (key === 'threshold') {
      localStorage.setItem('threshold', value);
    } else if (key === 'batchSize') {
      localStorage.setItem('batchSize', value);
    }
    this.notify();
  },
  
  applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark-mode');
    } else {
      document.documentElement.classList.remove('dark-mode');
    }
  },
  
  async init() {
    this.applyTheme(this.state.config.theme);
    try {
      const response = await fetch('/api/config/defaults');
      if (!response.ok) return;
      const defaults = await response.json();
      const apiUrl = String(defaults?.sam3_api_base_url || '').trim();
      const allowed = Array.isArray(defaults?.allowed_sam3_api_base_urls)
        ? defaults.allowed_sam3_api_base_urls.map((item) => String(item || '').replace(/\/+$/, '')).filter(Boolean)
        : [];
      const current = String(localStorage.getItem('sam3ApiUrl') || '').replace(/\/+$/, '');
      if (apiUrl && (!current || (allowed.length && !allowed.includes(current)))) {
        this.state.config.sam3ApiUrl = apiUrl;
        localStorage.setItem('sam3ApiUrl', apiUrl);
        this.notify();
      }
    } catch (err) {
      console.warn('load default config failed', err);
    }
  },
  
  notify() {
    for (let listener of this.listeners) {
      listener(this.state);
    }
  }
};
