import { createTheme, type Theme } from '@mui/material/styles';

export function buildTheme(mode: 'light' | 'dark'): Theme {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#7aa2ff' : '#3b6cf6' },
      success: { main: '#10b981' },
      error: { main: '#ef4444' },
      background: mode === 'dark'
        ? { default: '#12141a', paper: '#1a1d26' }
        : { default: '#eef1f6', paper: '#ffffff' },
    },
    typography: {
      fontSize: 13,
      button: { textTransform: 'none', fontWeight: 600 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiButton: { defaultProps: { size: 'small' } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiDialog: { defaultProps: { maxWidth: 'md' } },
    },
  });
}
