import { useEffect, useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { buildTheme } from './theme';
import { router } from './router';
import { ToastProvider } from './components/common/ToastProvider';
import { useSettingsStore } from './stores/settingsStore';
import './i18n';

export function App() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const theme = useMemo(() => buildTheme(themeMode), [themeMode]);

  useEffect(() => {
    useSettingsStore.getState().init();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ThemeProvider>
  );
}
