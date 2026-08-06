import { createHashRouter, Navigate } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ImageWorkspacePage } from './pages/ImageWorkspacePage';
import { PoseWorkspacePage } from './pages/PoseWorkspacePage';
import { NotFoundPage } from './pages/NotFoundPage';

export const router = createHashRouter([
  { path: '/', element: <ProjectsPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/project/image/:id', element: <ImageWorkspacePage /> },
  { path: '/project/image/:id/auto', element: <ImageWorkspacePage /> },
  { path: '/project/image/:id/review', element: <ImageWorkspacePage /> },
  { path: '/project/pose/:id', element: <PoseWorkspacePage /> },
  { path: '*', element: <NotFoundPage /> },
]);

export { Navigate };
