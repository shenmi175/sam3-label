import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material';
import { getHealth, restartWebAuto } from '../../api/system';
import type { GlobalConfig } from '../../api/config';
import { useToast } from '../common/ToastProvider';

interface RuntimeTabProps {
  config: GlobalConfig;
  onReload: () => void;
  onStatusChange: (text: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function RuntimeTab({ config, onReload, onStatusChange }: RuntimeTabProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const rows: [string, string][] = [
    [t('cache_dir'), config.cache_dir || '--'],
    [t('upload_root'), config.upload_root || '--'],
    [t('allowed_data_roots'), (config.allowed_data_roots || []).join('\n') || '--'],
    [t('default_upload_target_dir'), config.default_upload_target_dir || '--'],
    [t('upload_target_dir'), config.upload_target_dir || '--'],
    [t('sam_api_url'), config.sam3_api_base_url || '--'],
    [t('settings_auth_enabled'), config.auth_enabled ? t('yes') : t('no')],
    [t('settings_session_ttl'), `${config.session_ttl_seconds || '--'}s`],
    [t('settings_max_batch'), String(config.sam3_max_batch_files ?? '--')],
  ];

  const waitForRestart = async () => {
    onStatusChange(t('restarting'));
    await sleep(1200);
    for (let i = 0; i < 60; i += 1) {
      if (!mountedRef.current) return;
      try {
        const res = await getHealth();
        if (res && res.status === 'ok') {
          onStatusChange(t('restart_done'));
          showToast(t('restart_done'), 'success');
          onReload();
          setRestarting(false);
          return;
        }
      } catch {
        // server not up yet
      }
      await sleep(1000);
    }
    if (mountedRef.current) {
      onStatusChange(t('restart_pending'));
      showToast(t('restart_pending'), 'error');
      setRestarting(false);
    }
  };

  const restartWebAutoFlow = async () => {
    setConfirmOpen(false);
    setRestarting(true);
    try {
      await restartWebAuto();
    } catch {
      // The request can be interrupted because the server exits immediately.
    }
    await waitForRestart();
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        {t('settings_runtime')}
      </Typography>
      <Box sx={{ display: 'grid', gap: '12px', mb: 3 }}>
        {rows.map(([label, value]) => (
          <Box
            key={label}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)',
              gap: '14px',
              alignItems: 'start',
              py: 1.5,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 700 }}>
              {label}
            </Typography>
            <Typography sx={{ fontSize: 13, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5 }}>
        <Button variant="outlined" onClick={onReload}>
          {t('reload_settings')}
        </Button>
        <Button
          variant="outlined"
          color="warning"
          disabled={restarting}
          onClick={() => setConfirmOpen(true)}
          sx={{ fontWeight: 700 }}
        >
          {restarting ? t('restarting') : t('restart_web_auto')}
        </Button>
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{t('restart_web_auto')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('confirm_restart_web_auto')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t('cancel')}</Button>
          <Button color="warning" variant="contained" onClick={restartWebAutoFlow}>
            {t('restart_web_auto')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
