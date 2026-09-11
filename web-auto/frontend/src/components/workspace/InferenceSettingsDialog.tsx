import { useState } from 'react';
import { Box, Button, Dialog, IconButton, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { testSam3, testLocate } from '../../api/system';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { toast } from '../../utils/notify';
import { useImageNavigation } from '../../hooks/useImageNavigation';

interface InferenceSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const captionSx = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0.8,
  color: 'text.secondary',
  whiteSpace: 'nowrap',
} as const;

const stepperSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.25,
  px: 0.5,
  height: 32,
  borderRadius: '10px',
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'background.paper',
} as const;

/**
 * Inference settings dialog — the legacy AutoAnnotatePanel "backend" and
 * "params" groups merged into one two-column dialog:
 *   - left column: backend URL inputs + connection test + backend select
 *   - right column: threshold (±0.05) / batch size (±1)
 * Every control stays bound to settingsStore, so edits apply instantly and
 * the panel summary button refreshes once the dialog closes.
 */
export function InferenceSettingsDialog({ open, onClose }: InferenceSettingsDialogProps) {
  const { t } = useTranslation();
  const sam3ApiUrl = useSettingsStore((s) => s.sam3ApiUrl);
  const locateApiUrl = useSettingsStore((s) => s.locateApiUrl);
  const defaultBackend = useSettingsStore((s) => s.defaultBackend);
  const threshold = useSettingsStore((s) => s.threshold);
  const batchSize = useSettingsStore((s) => s.batchSize);
  const setSetting = useSettingsStore((s) => s.set);
  const { applyFilters } = useImageNavigation();

  const [testing, setTesting] = useState(false);

  const isLocate = defaultBackend === 'locate-anything';

  const handleTest = async () => {
    setTesting(true);
    try {
      if (isLocate) {
        const res = await testLocate(locateApiUrl);
        const result = (res?.result || {}) as Record<string, unknown>;
        const loaded = Boolean(result.model_loaded ?? (res as Record<string, unknown>).model_loaded ?? false);
        toast(`${t('backend_online')}${loaded ? ' (model loaded)' : ''}`, 'success');
      } else {
        await testSam3(sam3ApiUrl);
        toast(t('backend_online'), 'success');
      }
    } catch (err) {
      toast(`${t('backend_offline')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleBackendChange = (value: string) => {
    setSetting('defaultBackend', value);
    // Legacy syncSourceFilter: the annotation source filter follows the backend.
    useAnnotationStore
      .getState()
      .setSourceFilter(value === 'locate-anything' ? 'locate-anything' : 'sam3');
    const project = useProjectStore.getState();
    if (project.imageFilterClass) {
      void applyFilters(project.imageFilterClass, project.imageFilterStatus);
    }
  };

  const adjustThreshold = (delta: number) => {
    setSetting('threshold', Number((Number(threshold || 0.5) + delta).toFixed(2)));
  };

  const adjustBatchSize = (delta: number) => {
    setSetting('batchSize', Number(batchSize || 1) + delta);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <Box sx={{ p: 3, position: 'relative' }}>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t('close')}
          sx={{ position: 'absolute', top: 14, right: 14, color: '#ef4444' }}
        >
          {'\u00D7'}
        </IconButton>
        <Typography sx={{ fontSize: 16, fontWeight: 800, mb: 2 }}>{t('inference_settings')}</Typography>

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 2.5 }}>
          {/* Left column: backend */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
            <Typography sx={captionSx}>{t('group_backend')}</Typography>
            <TextField
              select
              size="small"
              value={defaultBackend || 'sam3'}
              onChange={(e) => handleBackendChange(e.target.value)}
              label={t('group_backend')}
              inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
              fullWidth
            >
              <MenuItem value="sam3" sx={{ fontSize: 12 }}>{t('sam3_backend')}</MenuItem>
              <MenuItem value="locate-anything" sx={{ fontSize: 12 }}>{t('locate_backend')}</MenuItem>
            </TextField>
            {!isLocate ? (
              <TextField
                size="small"
                value={sam3ApiUrl}
                onChange={(e) => setSetting('sam3ApiUrl', e.target.value)}
                label={t('sam3_api')}
                inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
                fullWidth
              />
            ) : (
              <TextField
                size="small"
                value={locateApiUrl}
                onChange={(e) => setSetting('locateApiUrl', e.target.value)}
                label={t('locate_api_url')}
                inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
                fullWidth
              />
            )}
            <Button
              size="small"
              variant="outlined"
              disabled={testing}
              onClick={() => void handleTest()}
              sx={{ height: 32, fontSize: 11, whiteSpace: 'nowrap', alignSelf: 'flex-start' }}
            >
              {t('test_api')}
            </Button>
          </Box>

          {/* Right column: parameters */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
            <Typography sx={captionSx}>{t('group_params')}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                {t('threshold')}
              </Typography>
              <Box sx={stepperSx}>
                <IconButton size="small" onClick={() => adjustThreshold(-0.05)} sx={{ width: 24, height: 24 }} aria-label="threshold -">
                  −
                </IconButton>
                <Typography sx={{ minWidth: 42, textAlign: 'center', fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {Number(threshold).toFixed(2)}
                </Typography>
                <IconButton size="small" onClick={() => adjustThreshold(0.05)} sx={{ width: 24, height: 24 }} aria-label="threshold +">
                  +
                </IconButton>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                {t('batch_size')}
              </Typography>
              <Box sx={stepperSx}>
                <IconButton size="small" onClick={() => adjustBatchSize(-1)} sx={{ width: 24, height: 24 }} aria-label="batch -">
                  −
                </IconButton>
                <Typography sx={{ minWidth: 32, textAlign: 'center', fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {batchSize}
                </Typography>
                <IconButton size="small" onClick={() => adjustBatchSize(1)} sx={{ width: 24, height: 24 }} aria-label="batch +">
                  +
                </IconButton>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
