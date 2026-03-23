import { ProjectsPage } from './pages/projects.js';
import { ImageWorkspace } from './pages/image-workspace.js';
import { VideoWorkspace } from './pages/video-workspace.js';
import { router } from './router.js';
import { TaskManager } from './components/tasks.js';
import { store } from './store.js';

export function bootstrap() {
  console.log('web-auto App initialized');
  store.init();
  
  // UI Helpers
  window.showToast = (message, type = 'info') => {
    const toast = document.createElement('div');
    toast.className = `neu-box toast toast-${type}`;
    toast.style = `position: fixed; bottom: 30px; right: 30px; padding: 12px 24px; border-radius: 12px; z-index: 10000; font-size: 13px; font-weight: 700; background: var(--neu-bg); box-shadow: var(--neu-outset); color: ${type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : 'var(--neu-text-active)')}; animation: slideIn 0.3s ease;`;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  };

  router.addRoute('/', ProjectsPage);
  router.addRoute('/project/image/:id', ImageWorkspace);
  router.addRoute('/project/video/:id', VideoWorkspace);
  router.init();
  TaskManager.init();
}

bootstrap();
