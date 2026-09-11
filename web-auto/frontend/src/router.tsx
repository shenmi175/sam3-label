import { createHashRouter, Navigate } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutoImageWorkspacePage } from './pages/AutoImageWorkspacePage';
import { ManualImageWorkspacePage } from './pages/ManualImageWorkspacePage';
import { PoseWorkspacePage } from './pages/PoseWorkspacePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectManagePage } from './pages/ProjectManagePage';

export const router = createHashRouter([
  { path: '/', element: <ProjectsPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/project/:id/manage', element: <ProjectManagePage /> },
  { path: '/project/:id/shortcuts', element: <Navigate to="/settings?tab=shortcuts" replace /> },
  { path: '/project/image/:id', element: <AutoImageWorkspacePage /> },
  { path: '/project/image/:id/auto', element: <AutoImageWorkspacePage /> },
  { path: '/project/image/:id/review', element: <ManualImageWorkspacePage /> },
  {
    path: '/project/image/:id/cleaning',
    lazy: async () => {
      const module = await import('./pages/DataCleaningPage');
      return { Component: module.DataCleaningPage };
    },
  },
  {
    path: '/project/image/:id/analytics',
    lazy: async () => {
      const module = await import('./features/data-analytics/DataAnalyticsPage');
      return { Component: module.DataAnalyticsPage };
    },
  },
  { path: '/project/pose/:id', element: <PoseWorkspacePage /> },
  { path: '*', element: <NotFoundPage /> },
]);

export { Navigate };
