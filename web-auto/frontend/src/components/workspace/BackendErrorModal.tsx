import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { unloadLocate } from '../../api/system';
import { useSettingsStore } from '../../stores/settingsStore';
import { useInferenceStore } from '../../stores/workspace/inferenceStore';
import { toast } from '../../utils/notify';

/**
 * Backend conflict modal — 1:1 port of the legacy
 * InferenceController.showBothLoadedModal / showSam3NotReadyModal:
 * BOTH_LOADED and SAM3_NOT_READY error codes surface a warning with three
 * actions: unload the LocateAnything model, jump to the settings page, or
 * close.
 */
export function BackendErrorModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const errorModal = useInferenceStore((s) => s.backendErrorModal);
  const closeBackendError = useInferenceStore((s) => s.closeBackendError);
  const locateApiUrl = useSettingsStore((s) => s.locateApiUrl);
  const sam3ApiUrl = useSettingsStore((s) => s.sam3ApiUrl);
  const [unloading, setUnloading] = useState(false);

  const isSam3NotReady = errorModal?.type === 'sam3-not-ready';
  const detail = errorModal?.detail || {};
  const locateUrl = String(detail.locate_api_base_url || locateApiUrl || '');
  const sam3Url = String(detail.sam3_api_base_url || sam3ApiUrl || '');

  const handleUnload = async () => {
    setUnloading(true);
    try {
      await unloadLocate(locateUrl);
      toast(t('locate_unloaded'), 'success');
      closeBackendError();
    } catch (err) {
      toast(t('unload_failed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setUnloading(false);
    }
  };

  const goToSettings = () => {
    closeBackendError();
    navigate('/settings');
  };

  return (
    <Dialog open={errorModal !== null} onClose={closeBackendError} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 18, fontWeight: 700, color: '#d97706', pr: 6 }}>
        {isSam3NotReady ? t('sam3_not_ready_title') : t('both_loaded_title')}
        <IconButton onClick={closeBackendError} size="small" sx={{ position: 'absolute', right: 10, top: 10, color: '#ef4444' }} aria-label="close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Box
          sx={{
            p: 1.75,
            borderRadius: 3,
            bgcolor: 'rgba(217,119,6,0.08)',
            border: '1px solid rgba(217,119,6,0.24)',
          }}
        >
          <Typography sx={{ fontSize: 13, lineHeight: 1.7 }}>
            {isSam3NotReady ? t('sam3_not_ready_hint') : t('both_loaded_warning')}
          </Typography>
          {isSam3NotReady ? (
            <Typography sx={{ mt: 1.25, fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
              sam3-api: {sam3Url}
              <br />
              locate-anything-api: {locateUrl}
            </Typography>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="error" disabled={unloading} onClick={() => void handleUnload()} sx={{ fontWeight: 700 }}>
          {t('unload_locate')}
        </Button>
        <Button onClick={goToSettings}>{t('both_loaded_resolve')}</Button>
        <Button onClick={closeBackendError}>{t('close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
