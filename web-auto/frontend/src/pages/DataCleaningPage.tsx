import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTranslation } from 'react-i18next';
import { logFeatureEvent } from '../api/audit';
import { ConfigImportExport } from '../components/data-cleaning/ConfigImportExport';
import { JobStatusSection } from '../components/data-cleaning/JobStatusSection';
import { DATA_CLEANING_TASK_TABS, ModeSelectCards } from '../components/data-cleaning/ModeSelectCards';
import { SingleTaskConfig } from '../components/data-cleaning/SingleTaskConfig';
import { unavailableConfiguredClasses } from '../components/data-cleaning/configFile';
import { buildRuleText, num, previewArtworkIssue } from '../components/data-cleaning/shared';
import { useSmartFilterJob } from '../hooks/useSmartFilterJob';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useSmartFilterStore } from '../stores/workspace/smartFilterStore';
import type { FilterTaskType } from '../api/filters';

type CleaningTab = keyof typeof DATA_CLEANING_TASK_TABS;
const CLEANING_TABS = new Set<CleaningTab>(['noise', 'instances', 'merge', 'unlabeled']);

function cleaningTab(value: string | null): CleaningTab {
  return CLEANING_TABS.has(value as CleaningTab) ? value as CleaningTab : 'noise';
}

function tabForTask(taskType: FilterTaskType): CleaningTab {
  return (Object.keys(DATA_CLEANING_TASK_TABS) as CleaningTab[])
    .find((tab) => DATA_CLEANING_TASK_TABS[tab].includes(taskType)) || 'noise';
}

export function DataCleaningPage() {
  const { id = '' } = useParams();
  const projectId = id;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<CleaningTab>(() => cleaningTab(searchParams.get('tab')));
  const [confirmation, setConfirmation] = useState<'apply' | 'rollback' | null>(null);
  const initializedProjectRef = useRef('');

  const project = useProjectStore((state) => state.projectMeta);
  const projectClasses = useProjectStore((state) => state.classes);
  const config = useSmartFilterStore((state) => state.config);
  const jobId = useSmartFilterStore((state) => state.jobId);
  const jobKind = useSmartFilterStore((state) => state.jobKind);
  const jobStatus = useSmartFilterStore((state) => state.jobStatus);
  const jobRunning = useSmartFilterStore((state) => state.jobRunning);
  const previewToken = useSmartFilterStore((state) => state.previewToken);
  const previewResult = useSmartFilterStore((state) => state.previewResult);
  const applyResult = useSmartFilterStore((state) => state.applyResult);
  const latestRun = useSmartFilterStore((state) => state.latestRun);
  const rollbackBusy = useSmartFilterStore((state) => state.rollbackBusy);
  const artworkIssue = previewArtworkIssue(previewResult);
  const unavailableClasses = useMemo(
    () => unavailableConfiguredClasses(config, projectClasses),
    [config, projectClasses],
  );
  const ruleText = useMemo(() => buildRuleText(config, t), [config, t]);
  const jobCanBeInterrupted = !(jobKind === 'apply' && config.operationMode === 'delete_unlabeled');

  useEffect(() => {
    setActiveTab(cleaningTab(searchParams.get('tab')));
  }, [searchParams]);

  useEffect(() => {
    const tasks = DATA_CLEANING_TASK_TABS[activeTab];
    if (!tasks.includes(config.taskType)) useSmartFilterStore.getState().selectTask(tasks[0]);
  }, [activeTab, config.taskType]);

  useEffect(() => {
    if (!projectId || initializedProjectRef.current === projectId) return;
    initializedProjectRef.current = projectId;
    useProjectStore.getState().reset();
    useSmartFilterStore.getState().reset();
    useProjectStore.getState().setProjectId(projectId);
    useSmartFilterStore.getState().setProjectId(projectId);
    void useProjectStore.getState().loadProjectInfo();
    logFeatureEvent('open_data_cleaning', projectId, { entry: 'page' });
  }, [projectId]);

  // Refresh project counts after apply, but do not load/select workspace images
  // while this standalone page is active.
  useSmartFilterJob(projectId, false);

  const selectTab = (value: CleaningTab) => {
    const tasks = DATA_CLEANING_TASK_TABS[value];
    if (!tasks.includes(useSmartFilterStore.getState().config.taskType)) {
      useSmartFilterStore.getState().selectTask(tasks[0]);
    }
    setActiveTab(value);
    setSearchParams(value === 'noise' ? {} : { tab: value }, { replace: true });
  };

  const showImportedTask = (taskType: FilterTaskType) => {
    const value = tabForTask(taskType);
    setActiveTab(value);
    setSearchParams(value === 'noise' ? {} : { tab: value }, { replace: true });
  };

  const startPreview = () => {
    void useSmartFilterStore.getState().startPreview();
  };

  const back = () => {
    const state = location.state as { from?: string } | null;
    const from = String(state?.from || '');
    const safePrefix = `/project/image/${encodeURIComponent(projectId)}`;
    navigate(from.startsWith(safePrefix) ? from : `${safePrefix}/auto`);
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
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Paper
        square
        elevation={0}
        sx={{
          px: { xs: 2, md: 3 },
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          gap: 1.5,
          alignItems: 'center',
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={back}>
          {t('back_to_project_workspace')}
        </Button>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography component="h1" sx={{ fontSize: 22, fontWeight: 900 }}>{t('sf_title')}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
            {project?.name || projectId} · {t('sf_subtitle')}
          </Typography>
        </Box>
        <Chip
          size="small"
          color={jobRunning ? 'warning' : previewToken ? 'success' : 'default'}
          label={jobRunning
            ? jobStatus === 'paused'
              ? t('sf_paused_short')
              : jobStatus === 'stopping'
                ? t('sf_stopping_short')
                : t('sf_processing')
            : previewToken ? t('sf_preview_ready') : t('sf_idle')}
        />
      </Paper>

      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1560, mx: 'auto' }}>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('sf_preview_reuse_explanation')}
        </Alert>

        <Paper variant="outlined">
          <Tabs
            value={activeTab}
            onChange={(_event, value: CleaningTab) => selectTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label={t('sf_page_tabs')}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab disabled={jobRunning} value="noise" label={t('sf_category_common')} />
            <Tab disabled={jobRunning} value="instances" label={t('sf_category_filter')} />
            <Tab disabled={jobRunning} value="merge" label={t('sf_category_advanced')} />
            <Tab disabled={jobRunning} value="unlabeled" label={t('sf_category_dataset')} />
          </Tabs>

          <Box
            sx={{
              p: { xs: 2, md: 3 },
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 5fr) minmax(420px, 7fr)' },
              gap: 3,
              alignItems: 'start',
            }}
          >
            <Box component="fieldset" disabled={jobRunning} sx={{ border: 0, m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, opacity: jobRunning ? 0.65 : 1 }}>
              {activeTab !== 'noise' && <Alert severity="info">{t(`sf_category_hint_${activeTab}`)}</Alert>}
              <ModeSelectCards tasks={DATA_CLEANING_TASK_TABS[activeTab]} />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}><ConfigImportExport onImported={showImportedTask} /></Box>
              {unavailableClasses.length > 0 && (
                <Alert severity="warning">{t('sf_config_missing_classes', { classes: unavailableClasses.join(', ') })}</Alert>
              )}
              <SingleTaskConfig />
              <Paper variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
                <Typography sx={{ fontSize: 11, fontWeight: 800, color: 'text.secondary', mb: 0.75 }}>
                  {t('sf_exec_summary')}
                </Typography>
                <Typography sx={{ fontSize: 13, lineHeight: 1.7 }}>{ruleText}</Typography>
              </Paper>
              <Button
                variant="contained"
                disabled={jobRunning || unavailableClasses.length > 0}
                onClick={startPreview}
              >
                {previewToken ? t('sf_preview_again') : t('sf_start_preview')}
              </Button>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              {!previewResult && !applyResult && !jobRunning && (
                <Alert severity="info">{t('sf_preview_tab_empty')}</Alert>
              )}
              <JobStatusSection />
              {jobRunning && !jobCanBeInterrupted && (
                <Alert severity="warning">{t('sf_uninterruptible_delete')}</Alert>
              )}
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
                {jobRunning && jobCanBeInterrupted && jobId && jobStatus === 'paused' && (
                  <Button color="success" variant="outlined" onClick={() => void useSmartFilterStore.getState().resumeJob()}>
                    {t('resume')}
                  </Button>
                )}
                {jobRunning && jobCanBeInterrupted && jobId && ['queued', 'running'].includes(jobStatus) && (
                  <Button color="warning" variant="outlined" onClick={() => void useSmartFilterStore.getState().pauseJob()}>
                    {t('sf_pause_job')}
                  </Button>
                )}
                {jobRunning && jobCanBeInterrupted && jobId && ['queued', 'running', 'pausing', 'paused'].includes(jobStatus) && (
                  <Button color="error" variant="outlined" onClick={() => void useSmartFilterStore.getState().cancelJob()}>
                    {t('sf_stop_job')}
                  </Button>
                )}
                {previewToken && !applyResult && !jobRunning && (
                  <Button
                    variant="contained"
                    color={config.operationMode === 'delete_unlabeled' ? 'error' : 'primary'}
                    onClick={() => setConfirmation('apply')}
                  >
                    {t('sf_apply_task', { task: t(`sf_task_${config.taskType}`) })}
                  </Button>
                )}
              </Box>

              {latestRun?.run_id ? (
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 800 }}>{t('sf_rollback_title')}</Typography>
                  <Typography sx={{ mt: 0.75, fontSize: 12, color: 'text.secondary', lineHeight: 1.7 }}>
                    {t('sf_rollback_desc', {
                      changed: num(latestRun.summary?.changed_images ?? latestRun.snapshot_count),
                      removed: num(latestRun.summary?.removed_annotations),
                      relabeled: num(latestRun.summary?.relabeled_annotations),
                    })}
                  </Typography>
                  <Button sx={{ mt: 1.5 }} size="small" variant="outlined" color="error" disabled={rollbackBusy || jobRunning} onClick={() => setConfirmation('rollback')}>
                    {rollbackBusy ? t('sf_rollback_running') : t('sf_rollback_btn')}
                  </Button>
                </Paper>
              ) : null}
            </Box>
          </Box>
        </Paper>
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
          <Button
            color={config.operationMode === 'delete_unlabeled' || confirmation === 'rollback' ? 'error' : 'primary'}
            variant="contained"
            onClick={confirmAction}
          >
            {t('confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
