export const store = {
  state: {
    config: {
      sam3ApiUrl: localStorage.getItem('sam3ApiUrl') || 'http://127.0.0.1:8001'
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
    }
    this.notify();
  },
  
  notify() {
    for (let listener of this.listeners) {
      listener(this.state);
    }
  }
};
