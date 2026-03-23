import { ProjectsPage } from './pages/projects.js';
import { ImageWorkspace } from './pages/image-workspace.js';
import { VideoWorkspace } from './pages/video-workspace.js';
import { router } from './router.js';
import { TaskManager } from './components/tasks.js';

export function bootstrap() {
  console.log('web-auto App initialized');
  router.addRoute('/', ProjectsPage);
  router.addRoute('/project/image/:id', ImageWorkspace);
  router.addRoute('/project/video/:id', VideoWorkspace);
  router.init();
  TaskManager.init();
}

bootstrap();
