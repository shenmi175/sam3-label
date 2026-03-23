export const store = {
  state: {
    config: {
      sam3ApiUrl: localStorage.getItem('sam3ApiUrl') || 'http://127.0.0.1:8001',
      theme: localStorage.getItem('theme') || 'light',
      language: localStorage.getItem('language') || 'zh'
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
    this.state.config[key] = value;
    if (key === 'sam3ApiUrl') {
      localStorage.setItem('sam3ApiUrl', value);
    } else if (key === 'theme') {
      localStorage.setItem('theme', value);
      this.applyTheme(value);
    } else if (key === 'language') {
      localStorage.setItem('language', value);
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
  
  init() {
    this.applyTheme(this.state.config.theme);
  },
  
  notify() {
    for (let listener of this.listeners) {
      listener(this.state);
    }
  }
};
