import { useState } from 'react';
import { Box, Button } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { useInference } from '../../hooks/useInference';
import { InferenceSettingsDialog } from './InferenceSettingsDialog';

/**
 * Auto-annotate toolbar panel — compact single-row variant of the legacy
 * auto-annotate-panel.js + auto-config-controller.js wiring:
 *   - the legacy "backend" and "params" groups are merged into one
 *     "inference settings" button (Settings icon + live summary text, e.g.
 *     `SAM3 · Threshold 0.50 · Batch Size 1`) that opens
 *     InferenceSettingsDialog; edits there apply instantly via settingsStore
 *     and the summary refreshes on close.
 *   - the execution buttons stay inline: infer-current / batch-infer /
 *     la-boxes-batch / example-segment.
 */
export function AutoAnnotatePanel() {
  const { t } = useTranslation();
  const defaultBackend = useSettingsStore((s) => s.defaultBackend);
  const threshold = useSettingsStore((s) => s.threshold);
  const batchSize = useSettingsStore((s) => s.batchSize);

  const { runSingle, startBatchTask, startLaBoxesBatchTask, runBoxPromptInference } = useInference();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [findingSimilar, setFindingSimilar] = useState(false);

  const isLocate = defaultBackend === 'locate-anything';

  const settingsSummary = `${isLocate ? t('locate_backend') : t('sam3_backend')} · ${t('threshold')} ${Number(
    threshold,
  ).toFixed(2)} · ${t('batch_size')} ${batchSize}`;

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
      await runBoxPromptInference();
    } finally {
      setFindingSimilar(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', minWidth: 0, overflowX: 'auto' }}>
      {/* Merged backend+params entry point (opens InferenceSettingsDialog) */}
      <Button
        size="small"
        variant="outlined"
        startIcon={<SettingsIcon sx={{ fontSize: 16 }} />}
        onClick={() => setSettingsOpen(true)}
        sx={{ height: 32, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}
        title={t('inference_settings')}
        aria-label={t('inference_settings')}
      >
        {settingsSummary}
      </Button>

      {/* Execution actions (legacy group 3, kept inline) */}
      <Button
        size="small"
        variant="contained"
        disabled={inferring}
        onClick={() => void handleInfer()}
        sx={{ height: 32, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {inferring ? t('inferring') : t('infer_current')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={() => void startBatchTask()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {t('batch_infer')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        onClick={() => void startLaBoxesBatchTask()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {t('la_boxes_batch')}
      </Button>
      <Button
        size="small"
        variant="outlined"
        disabled={isLocate || findingSimilar}
        onClick={() => void handleExample()}
        sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, opacity: isLocate ? 0.45 : 1 }}
      >
        {findingSimilar ? t('finding_similar') : t('example_segment')}
      </Button>

      <InferenceSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}
