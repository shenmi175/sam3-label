import { useMemo } from 'react';
import { Box, Button, Dialog, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';
import { useSmartFilterJob } from '../../hooks/useSmartFilterJob';
import { buildRuleText, num } from './shared';
import { ModeSelectCards } from './ModeSelectCards';
import { MergeModeConfig } from './MergeModeConfig';
import { RuleFilterConfig } from './RuleFilterConfig';
import { JobStatusSection } from './JobStatusSection';

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

  const config = useSmartFilterStore((s) => s.config);
  const jobRunning = useSmartFilterStore((s) => s.jobRunning);
  const previewToken = useSmartFilterStore((s) => s.previewToken);
  const applyResult = useSmartFilterStore((s) => s.applyResult);
  const latestRun = useSmartFilterStore((s) => s.latestRun);
  const rollbackBusy = useSmartFilterStore((s) => s.rollbackBusy);

  // Runs/latest restore + post-apply/rollback workspace refresh.
  useSmartFilterJob(projectId);

  const ruleText = useMemo(() => buildRuleText(config, t), [config, t]);

  const isMerge = config.operationMode === 'merge';

  const handleApplyClick = () => {
    const confirmText =
      config.operationMode === 'merge'
        ? t('sf_confirm_merge')
        : config.operationMode === 'delete_unlabeled'
          ? t('sf_confirm_delete_unlabeled')
          : t('sf_confirm_rule');
    if (!window.confirm(confirmText)) return;
    void useSmartFilterStore.getState().startApply();
  };

  const handleRollbackClick = () => {
    if (!window.confirm(t('sf_rollback_confirm'))) return;
    void useSmartFilterStore.getState().rollbackLatestRun();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
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
            gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)',
            gap: 2.5,
            alignItems: 'start',
          }}
        >
          {/* Left column: mode selection + mode config + execution summary */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
            <ModeSelectCards />
            {isMerge && <MergeModeConfig />}
            {config.operationMode === 'rule' && <RuleFilterConfig />}

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
          disabled={jobRunning}
          onClick={() => void useSmartFilterStore.getState().startPreview()}
          sx={{ fontSize: 12, fontWeight: 700, color: 'primary.main' }}
        >
          {t('sf_start_preview')}
        </Button>
        {previewToken && !applyResult && (
          <Button
            size="small"
            variant="contained"
            color={isMerge ? 'success' : 'error'}
            disabled={jobRunning}
            onClick={handleApplyClick}
            sx={{ fontSize: 12, fontWeight: 700 }}
          >
            {isMerge ? t('sf_apply_merge') : config.operationMode === 'delete_unlabeled' ? t('sf_apply_delete_images') : t('sf_apply_delete_anns')}
          </Button>
        )}
      </Box>
    </Dialog>
  );
}
