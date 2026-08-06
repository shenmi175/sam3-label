import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { registerToast } from '../../utils/notify';

type ToastType = 'info' | 'success' | 'error' | 'warning';

interface ToastItem {
  key: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    seq.current += 1;
    const key = seq.current;
    setToasts((prev) => [...prev, { key, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), 4000);
  }, []);

  useEffect(() => {
    registerToast(showToast);
  }, [showToast]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.map((t, idx) => (
        <Snackbar
          key={t.key}
          open
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          sx={{ bottom: `${30 + idx * 64}px !important` }}
        >
          <Alert
            severity={t.type === 'error' ? 'error' : t.type === 'success' ? 'success' : t.type === 'warning' ? 'warning' : 'info'}
            variant="filled"
            onClose={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))}
            sx={{ minWidth: 220, maxWidth: 420, fontWeight: 600 }}
          >
            {t.message}
          </Alert>
        </Snackbar>
      ))}
    </ToastContext.Provider>
  );
}
