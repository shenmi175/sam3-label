import { useState } from 'react';
import { Box, Button, IconButton, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { testSam3, testLocate } from '../../api/system';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useInference } from '../../hooks/useInference';
import { toast } from '../../utils/notify';

/**
 * Auto-annotate toolbar panel — 1:1 port of the legacy auto-annotate-panel.js
 * + auto-config-controller.js wiring:
 *   - sam3 / locate-anything URL inputs + connection test
 *   - backend select (switching syncs the annotation source filter, legacy
 *     syncSourceFilter)
 *   - threshold (±0.05) and batch size (±1) steppers
 *   - contour mode select (disabled for locate-anything)
 *   - infer-current / batch-infer / la-boxes-batch / example-segment buttons
 */
export function AutoAnnotatePanel() {
  const { t } = useTranslation();
  const sam3ApiUrl = useSettingsStore((s) => s.sam3ApiUrl);
  const locateApiUrl = useSettingsStore((s) => s.locateApiUrl);
  const defaultBackend = useSettingsStore((s) => s.defaultBackend);
  const threshold = useSettingsStore((s) => s.threshold);
  const batchSize = useSettingsStore((s) => s.batchSize);
  const contourMode = useSettingsStore((s) => s.contourMode);
  const setSetting = useSettingsStore((s) => s.set);

  const { runSingle, startBatchTask, startLaBoxesBatchTask, runExamplePreview } = useInference();

  const [testing, setTesting] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [findingSimilar, setFindingSimilar] = useState(false);

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
  };

  const adjustThreshold = (delta: number) => {
    setSetting('threshold', Number((Number(threshold || 0.5) + delta).toFixed(2)));
  };

  const adjustBatchSize = (delta: number) => {
    setSetting('batchSize', Number(batchSize || 1) + delta);
  };

  const handleInfer = async () => {
    setInferring(true);
    try {
      await runSingle();
    } finally {
      setInferring(false);
    }
  };

  const handleExample = async () => {
    setFindingSimilar(true);
    try {
      await runExamplePreview();
    } finally {
      setFindingSimilar(false);
    }
  };

  const stepperSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 0.25,
    px: 0.5,
    height: 32,
    borderRadius: '10px',
    boxShadow: 'inset 2px 2px 5px rgba(0,0,0,0.06), inset -2px -2px 5px rgba(255,255,255,0.6)',
  } as const;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
      {/* Backend URLs + test */}
      {!isLocate ? (
        <TextField
          size="small"
          value={sam3ApiUrl}
          onChange={(e) => setSetting('sam3ApiUrl', e.target.value)}
          label={t('sam3_api')}
          inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
          sx={{ width: 190 }}
        />
      ) : null}
      <Button
        size="small"
        variant="outlined"
        disabled={testing}
        onClick={() => void handleTest()}
        sx={{ height: 32, fontSize: 11, whiteSpace: 'nowrap' }}
      >
        {t('test_api')}
      </Button>
      <TextField
        select
        size="small"
        value={defaultBackend || 'sam3'}
        onChange={(e) => handleBackendChange(e.target.value)}
        inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
        sx={{ width: 150 }}
      >
        <MenuItem value="sam3" sx={{ fontSize: 12 }}>{t('sam3_backend')}</MenuItem>
        <MenuItem value="locate-anything" sx={{ fontSize: 12 }}>{t('locate_backend')}</MenuItem>
      </TextField>
      {isLocate ? (
        <TextField
          size="small"
          value={locateApiUrl}
          onChange={(e) => setSetting('locateApiUrl', e.target.value)}
          placeholder={t('locate_api_url')}
          inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
          sx={{ width: 190 }}
        />
      ) : null}

      <Box sx={{ width: 1, height: 24, bgcolor: 'divider' }} />

      {/* Threshold stepper */}
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

      {/* Batch size stepper */}
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

      {/* Contour mode */}
      <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>
        {t('contour_mode')}
      </Typography>
      <TextField
        select
        size="small"
        value={contourMode || 'split'}
        disabled={isLocate}
        onChange={(e) => setSetting('contourMode', e.target.value as 'split' | 'merged')}
        inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
        sx={{ width: 150, opacity: isLocate ? 0.45 : 1 }}
      >
        <MenuItem value="split" sx={{ fontSize: 12 }}>{t('contour_split')}</MenuItem>
        <MenuItem value="merged" sx={{ fontSize: 12 }}>{t('contour_merged')}</MenuItem>
      </TextField>

      <Box sx={{ width: 1, height: 24, bgcolor: 'divider' }} />

      {/* Action buttons */}
      <Button
        size="small"
        variant="contained"
        disabled={inferring}
        onClick={() => void handleInfer()}
        sx={{ height: 32, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
      >
        {inferring ? t('inferring') : t('infer_current')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={() => void startBatchTask()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}
      >
        {t('batch_infer')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={() => void startLaBoxesBatchTask()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}
      >
        {t('la_boxes_batch')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        disabled={isLocate || findingSimilar}
        onClick={() => void handleExample()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', opacity: isLocate ? 0.45 : 1 }}
      >
        {findingSimilar ? t('finding_similar') : t('example_segment')}
      </Button>
    </Box>
  );
}
