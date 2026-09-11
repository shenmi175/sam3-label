import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';
import { useSmartFilterJob } from '../../hooks/useSmartFilterJob';
import { buildRuleText, num, previewArtworkIssue } from './shared';
import { ModeSelectCards } from './ModeSelectCards';
import { JobStatusSection } from './JobStatusSection';
import { SingleTaskConfig } from './SingleTaskConfig';
import { ConfigImportExport } from './ConfigImportExport';
import { unavailableConfiguredClasses } from './configFile';
import { logFeatureEvent } from '../../api/audit';

export interface DataCleaningDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Data-cleaning workbench dialog (formerly the right-column SmartFilterPanel)
 * — 1:1 port of the legacy modal-filter-full panel (smart-filter-panel.js +
 * SmartFilterController), re-laid out as a large two-column dialog:
 * left column = presets/mode selection + mode config + execution summary,
 * right column = rollback panel + task status/results.
 *
 * Preview → apply job flow, polling and rollback logic are unchanged
 * (smartFilterStore + useSmartFilterJob).
 */
export function DataCleaningDialog({ open, onClose }: DataCleaningDialogProps) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.projectId);
  const projectClasses = useProjectStore((s) => s.classes);

  const config = useSmartFilterStore((s) => s.config);
  const jobRunning = useSmartFilterStore((s) => s.jobRunning);
  const previewToken = useSmartFilterStore((s) => s.previewToken);
  const previewResult = useSmartFilterStore((s) => s.previewResult);
  const applyResult = useSmartFilterStore((s) => s.applyResult);
  const latestRun = useSmartFilterStore((s) => s.latestRun);
  const rollbackBusy = useSmartFilterStore((s) => s.rollbackBusy);
  const [confirmation, setConfirmation] = useState<'apply' | 'rollback' | null>(null);
  const loggedOpenRef = useRef(false);

  // Runs/latest restore + post-apply/rollback workspace refresh.
  useSmartFilterJob(projectId);

  // The workspace aggregate reset can run after child effects in React
  // StrictMode and clear smartFilterStore.projectId. Re-sync on every open so
  // preview/apply buttons never silently no-op with an empty project context.
  useEffect(() => {
    if (!open) {
      loggedOpenRef.current = false;
      return;
    }
    if (open && projectId) {
      if (!loggedOpenRef.current) {
        logFeatureEvent('open_data_cleaning', projectId);
        loggedOpenRef.current = true;
      }
      useSmartFilterStore.getState().setProjectId(projectId);
    }
  }, [open, projectId]);

  const ruleText = useMemo(() => buildRuleText(config, t), [config, t]);

  const isMerge = config.operationMode === 'merge';
  const artworkIssue = previewArtworkIssue(previewResult);
  const unavailableClasses = useMemo(
    () => unavailableConfiguredClasses(config, projectClasses),
    [config, projectClasses],
  );

  const handleApplyClick = () => {
    setConfirmation('apply');
  };

  const handleRollbackClick = () => {
    setConfirmation('rollback');
  };

  const confirmText = confirmation === 'rollback'
    ? t('sf_rollback_confirm')
    : config.taskType === 'delete_unlabeled_images'
      ? t('sf_confirm_delete_unlabeled')
      : config.operationMode === 'component_noise'
      ? t('sf_confirm_component')
      : t('sf_confirm_single_task', { task: t(`sf_task_${config.taskType}`) });

  const confirmAction = () => {
    const action = confirmation;
    setConfirmation(null);
    if (action === 'rollback') void useSmartFilterStore.getState().rollbackLatestRun();
    if (action === 'apply') void useSmartFilterStore.getState().startApply();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xl"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            height: '92vh',
            maxHeight: '92vh',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', px: 3, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        <Box>
          <Typography sx={{ fontSize: 16, fontWeight: 800 }}>{t('sf_title')}</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{t('sf_subtitle')}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label={t('close')} sx={{ color: '#ef4444' }}>
          {'\u00D7'}
        </IconButton>
      </Box>

      {/* Scrollable body */}
      <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              md: config.operationMode === 'component_noise'
                ? 'minmax(0, 5fr) minmax(0, 7fr)'
                : 'minmax(0, 7fr) minmax(0, 5fr)',
            },
            gap: 2.5,
            alignItems: 'start',
          }}
        >
          {/* Left column: mode selection + mode config + execution summary */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
            <ModeSelectCards />
            <ConfigImportExport />
            {unavailableClasses.length > 0 && (
              <Alert severity="warning">{t('sf_config_missing_classes', { classes: unavailableClasses.join(', ') })}</Alert>
            )}
            <SingleTaskConfig />

            {/* Execution summary text (legacy filter-rule-text) */}
            <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
              <Typography sx={{ fontSize: 10, fontWeight: 700, color: 'text.secondary', mb: 0.5 }}>
                {t('sf_exec_summary')}
              </Typography>
              <Typography sx={{ fontSize: 11, lineHeight: 1.6 }}>{ruleText}</Typography>
            </Box>
          </Box>

          {/* Right column: rollback panel + task status/results */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
            {/* Rollback panel (legacy filter-rollback-panel) */}
            {latestRun?.run_id && (
              <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
                <Typography sx={{ fontSize: 12, fontWeight: 800 }}>{t('sf_rollback_title')}</Typography>
                <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
                  {t('sf_rollback_desc', {
                    changed: num(latestRun.summary?.changed_images ?? latestRun.snapshot_count),
                    removed: num(latestRun.summary?.removed_annotations),
                    relabeled: num(latestRun.summary?.relabeled_annotations),
                  })}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  disabled={rollbackBusy}
                  onClick={handleRollbackClick}
                  sx={{ mt: 1, fontSize: 11, fontWeight: 700 }}
                >
                  {rollbackBusy ? t('sf_rollback_running') : t('sf_rollback_btn')}
                </Button>
              </Box>
            )}

            <JobStatusSection />
          </Box>
        </Box>
      </Box>

      {/* Actions */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        <Button size="small" onClick={onClose} sx={{ fontSize: 12 }}>{t('cancel')}</Button>
        <Button
          size="small"
          variant="outlined"
          disabled={jobRunning || unavailableClasses.length > 0}
          onClick={() => void useSmartFilterStore.getState().startPreview()}
          sx={{ fontSize: 12, fontWeight: 700, color: 'primary.main' }}
        >
          {t('sf_start_preview')}
        </Button>
        {previewToken && !applyResult && (
          <Button
            size="small"
            variant="contained"
            color={isMerge || config.operationMode === 'component_noise' ? 'success' : 'error'}
            disabled={jobRunning}
            onClick={handleApplyClick}
            sx={{ fontSize: 12, fontWeight: 700 }}
          >
            {t('sf_apply_task', { task: t(`sf_task_${config.taskType}`) })}
          </Button>
        )}
      </Box>
      <Dialog open={confirmation !== null} onClose={() => setConfirmation(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{confirmation === 'rollback' ? t('sf_rollback_title') : t('sf_confirm_title')}</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13 }}>{confirmText}</Typography>
          {confirmation === 'apply' && artworkIssue && (
            <Alert severity="warning" sx={{ mt: 2, fontSize: 12 }}>
              {t(`sf_preview_artwork_${artworkIssue}`)} {t('sf_preview_artwork_confirm')}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmation(null)}>{t('cancel')}</Button>
          <Button color={config.operationMode === 'delete_unlabeled' || confirmation === 'rollback' ? 'error' : 'primary'} variant="contained" onClick={confirmAction}>{t('confirm')}</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
