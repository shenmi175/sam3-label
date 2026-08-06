import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Typography,
} from '@mui/material';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import {
  deleteProject,
  getProjects,
  getUploadConfig,
  type ProjectInfo,
  type UploadConfig,
} from '../api/projects';
import {
  controlService,
  downloadSapiensCheckpoint,
  getHealth,
  getSapiensCheckpointDownload,
  getSapiensStatus,
  getServicesStatus,
  logout,
  type SapiensDownloadJob,
  type SapiensStatusResponse,
  type ServicesStatusResponse,
} from '../api/system';
import { useSettingsStore } from '../stores/settingsStore';
import { useToast } from '../components/common/ToastProvider';
import { ProjectCard } from '../components/projects/ProjectCard';
import { ServicesPanel } from '../components/projects/ServicesPanel';
import { CreateProjectDialog, type CreateProjectPrefill } from '../components/projects/CreateProjectDialog';
import { RestoreProjectDialog } from '../components/projects/RestoreProjectDialog';
import { DatasetUploadDialog } from '../components/projects/DatasetUploadDialog';

interface HealthState {
  color: string;
  text: string;
}

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setSetting = useSettingsStore((s) => s.set);

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [health, setHealth] = useState<HealthState | null>(null);
  const [servicesStatus, setServicesStatus] = useState<ServicesStatusResponse | null>(null);
  const [sapiensStatus, setSapiensStatus] = useState<SapiensStatusResponse | null>(null);
  const [uploadConfig, setUploadConfig] = useState<UploadConfig | null>(null);
  const [uploadHint, setUploadHint] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<CreateProjectPrefill>({});
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [uploadDialog, setUploadDialog] = useState<{ open: boolean; targetDir: string; projectId: string }>({
    open: false,
    targetDir: '',
    projectId: '',
  });
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  const hasCacheRef = useRef(false);
  const mountedRef = useRef(true);
  const downloadStartedRef = useRef(false);
  const downloadJobIdRef = useRef('');
  const sapiensTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------- health ----------------

  const checkHealth = useCallback(async () => {
    try {
      const res = await getHealth();
      setHealth(
        res.status === 'ok'
          ? { color: '#10b981', text: t('backend_online') }
          : { color: '#fbbf24', text: t('backend_error') },
      );
    } catch {
      setHealth({ color: '#ef4444', text: t('backend_offline') });
    }
  }, [t]);

  // ---------------- model services + sapiens ----------------

  const stopSapiensPolling = useCallback(() => {
    if (sapiensTimerRef.current) {
      clearInterval(sapiensTimerRef.current);
      sapiensTimerRef.current = null;
    }
  }, []);

  const mergeSapiensJob = useCallback((job: SapiensDownloadJob) => {
    setSapiensStatus((prev) =>
      prev?.checkpoint ? { ...prev, checkpoint: { ...prev.checkpoint, download_job: job } } : prev,
    );
  }, []);

  const loadServicesRef = useRef<() => Promise<void>>(async () => {});

  const pollSapiensDownload = useCallback(async () => {
    const jobId = downloadJobIdRef.current;
    if (!jobId) return;
    try {
      const data = await getSapiensCheckpointDownload(jobId);
      const job = data.job || {};
      mergeSapiensJob(job);
      if (['completed', 'failed'].includes(String(job.status || ''))) {
        stopSapiensPolling();
        if (job.status === 'completed') {
          showToast(t('sapiens_download_done'));
          await loadServicesRef.current();
        } else {
          showToast(job.error || t('sapiens_download_failed'), 'error');
        }
      }
    } catch (e) {
      stopSapiensPolling();
      showToast((e as Error).message, 'error');
    }
  }, [mergeSapiensJob, stopSapiensPolling, showToast, t]);

  const ensureSapiensDownloadPolling = useCallback(() => {
    if (sapiensTimerRef.current || !downloadJobIdRef.current) return;
    sapiensTimerRef.current = setInterval(() => pollSapiensDownload(), 1000);
    pollSapiensDownload();
  }, [pollSapiensDownload]);

  const startSapiensDownload = useCallback(async () => {
    try {
      downloadStartedRef.current = true;
      const data = await downloadSapiensCheckpoint();
      const job = data.job || {};
      downloadJobIdRef.current = job.job_id || '';
      mergeSapiensJob(job);
      ensureSapiensDownloadPolling();
      showToast(t('sapiens_download_started'));
    } catch (e) {
      showToast((e as Error).message, 'error');
    }
  }, [ensureSapiensDownloadPolling, mergeSapiensJob, showToast, t]);

  const loadServices = useCallback(async () => {
    const [servicesResult, sapiensResult] = await Promise.allSettled([getServicesStatus(), getSapiensStatus()]);
    const svc: ServicesStatusResponse =
      servicesResult.status === 'fulfilled'
        ? servicesResult.value
        : { ok: false, error: (servicesResult.reason as Error)?.message || 'service status failed', services: [] };
    const sap: SapiensStatusResponse =
      sapiensResult.status === 'fulfilled'
        ? sapiensResult.value
        : { ok: false, error: (sapiensResult.reason as Error)?.message || 'sapiens status failed' };
    if (!mountedRef.current) return;
    setServicesStatus(svc);
    setSapiensStatus(sap);

    // autoStartSapiensDownload (same logic as old projects.js)
    const checkpoint = sap.checkpoint || {};
    const job = checkpoint.download_job || null;
    if (job?.job_id && ['queued', 'running'].includes(String(job.status || ''))) {
      downloadJobIdRef.current = job.job_id;
      ensureSapiensDownloadPolling();
      return;
    }
    const sapiensRunning = (svc.services || []).find((item) => item.service === 'sapiens-api')?.status === 'running';
    if (
      !sapiensRunning ||
      !sap.ok ||
      (checkpoint.checkpoint_exists && checkpoint.detector_exists) ||
      downloadStartedRef.current
    ) {
      return;
    }
    startSapiensDownload();
  }, [ensureSapiensDownloadPolling, startSapiensDownload]);

  useEffect(() => {
    loadServicesRef.current = loadServices;
  }, [loadServices]);

  const controlServiceAction = useCallback(
    async (service: string, action: string) => {
      try {
        await controlService(service, action);
        showToast(t('service_action_sent'));
        await loadServicesRef.current();
      } catch (e) {
        showToast((e as Error).message, 'error');
      }
    },
    [showToast, t],
  );

  // ---------------- projects ----------------

  const loadProjects = useCallback(
    async (options: { showLoading?: boolean } = {}) => {
      if (options.showLoading) {
        setLoadingProjects(true);
        setProjectsError('');
      }
      try {
        const data = await getProjects();
        if (!mountedRef.current) return;
        setProjects(data.projects || []);
        hasCacheRef.current = true;
        setProjectsError('');
      } catch (err) {
        if (!mountedRef.current) return;
        if (hasCacheRef.current) {
          showToast(t('failed_refresh_projects', { error: (err as Error).message }), 'error');
          return;
        }
        setProjectsError((err as Error).message);
      } finally {
        if (mountedRef.current) setLoadingProjects(false);
      }
    },
    [showToast, t],
  );

  const loadUploadConfig = useCallback(async () => {
    try {
      const cfg = await getUploadConfig();
      if (!mountedRef.current) return;
      setUploadConfig(cfg);
      setUploadHint(t('upload_root_hint', { root: cfg.host_data_root || '' }));
    } catch (e) {
      if (mountedRef.current) setUploadHint((e as Error).message);
    }
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    loadProjects({ showLoading: true });
    checkHealth();
    loadUploadConfig();
    loadServices();

    const healthTimer = setInterval(() => checkHealth(), 10000);
    const serviceTimer = setInterval(() => loadServicesRef.current(), 5000);
    return () => {
      mountedRef.current = false;
      clearInterval(healthTimer);
      clearInterval(serviceTimer);
      stopSapiensPolling();
    };
  }, [checkHealth, loadProjects, loadServices, loadUploadConfig, stopSapiensPolling]);

  // ---------------- actions ----------------

  const toggleTheme = () => {
    const next = themeMode === 'dark' ? 'light' : 'dark';
    setSetting('themeMode', next);
    showToast(t('theme_switched', { mode: next }));
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore, redirect anyway
    }
    window.location.href = '/login';
  };

  const openProject = (id: string, projectType = 'image') => {
    const type = String(projectType || 'image');
    navigate(type === 'pose' ? `/project/pose/${id}` : `/project/image/${id}`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteProject(deleteTarget.id);
      showToast(t('project_deleted'));
      setDeleteTarget(null);
      loadProjects();
    } catch (err) {
      showToast(t('delete_failed', { error: (err as Error).message }), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const showDatasetUpload = (targetDir = '', projectId = '') => {
    setUploadDialog({ open: true, targetDir, projectId });
  };

  const handleCreateFromUpload = (imageDir: string) => {
    setUploadDialog((prev) => ({ ...prev, open: false }));
    setCreatePrefill({ project_type: 'image', image_dir: imageDir });
    setCreateOpen(true);
  };

  const visibleProjects = projects.filter((p) => ['image', 'pose'].includes(String(p.project_type || 'image')));

  return (
    <Box sx={{ height: '100vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: 5,
          py: 2.5,
          gap: 2.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h1" variant="h4" sx={{ display: 'inline-block', fontWeight: 800 }}>
            web-auto
          </Typography>
          <Typography component="span" sx={{ ml: 1.5, color: 'text.secondary', fontSize: 14, fontWeight: 500 }}>
            {health ? health.text : t('backend_checking')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Box title="Backend Health" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontSize: 11, color: 'text.secondary' }}>
            <Box
              component="span"
              sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: health ? health.color : '#ccc' }}
            />
            <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>
              {t('dashboard')}: {health ? health.text : t('backend_checking')}
            </Typography>
          </Box>
          <Button variant="outlined" onClick={() => showDatasetUpload()}>
            {t('upload_dataset_btn')}
          </Button>
          <Button variant="outlined" onClick={() => setRestoreOpen(true)}>
            {t('restore_project_btn')}
          </Button>
          <Button variant="contained" onClick={() => { setCreatePrefill({}); setCreateOpen(true); }} sx={{ fontWeight: 700 }}>
            {t('create_btn')}
          </Button>
          <IconButton onClick={toggleTheme} title={t('toggle_theme')} size="small">
            {themeMode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
          </IconButton>
          <Button variant="outlined" onClick={() => navigate('/settings')}>
            {t('global_settings')}
          </Button>
          <Button variant="outlined" onClick={handleLogout}>
            {t('logout')}
          </Button>
        </Box>
      </Box>

      {/* Content */}
      <Box sx={{ px: 5, py: 3.75, flex: 1, minHeight: 0 }}>
        <ServicesPanel
          servicesStatus={servicesStatus}
          sapiensStatus={sapiensStatus}
          onRefresh={() => loadServicesRef.current()}
          onControlService={controlServiceAction}
          onStartSapiensDownload={startSapiensDownload}
        />

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, gap: 2 }}>
          <Typography variant="h6" sx={{ fontSize: 20, fontWeight: 700 }}>
            {t('project_list')}
          </Typography>
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            {t('total_projects', { count: visibleProjects.length })}
          </Typography>
        </Box>

        {loadingProjects && !hasCacheRef.current ? (
          <Typography sx={{ py: 5, textAlign: 'center', color: 'text.secondary' }}>{t('loading_projects')}</Typography>
        ) : projectsError ? (
          <Typography sx={{ py: 5, textAlign: 'center', color: 'error.main' }}>
            {t('failed_load_projects', { error: projectsError })}
          </Typography>
        ) : visibleProjects.length === 0 ? (
          <Typography sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>{t('no_projects')}</Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 460px), 1fr))',
              gap: 2.5,
            }}
          >
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={openProject}
                onAddData={showDatasetUpload}
                onDelete={setDeleteTarget}
              />
            ))}
          </Box>
        )}
      </Box>

      {/* Dialogs */}
      <CreateProjectDialog
        open={createOpen}
        prefill={createPrefill}
        onClose={() => setCreateOpen(false)}
        onCreated={() => loadProjects()}
      />
      <RestoreProjectDialog
        open={restoreOpen}
        defaultScanRoot={uploadConfig?.host_data_root || ''}
        onClose={() => setRestoreOpen(false)}
        onImported={() => loadProjects()}
      />
      <DatasetUploadDialog
        open={uploadDialog.open}
        initialTargetDir={uploadDialog.targetDir || uploadConfig?.default_target_dir || ''}
        targetProjectId={uploadDialog.projectId}
        hintText={uploadHint}
        onClose={() => setUploadDialog((prev) => ({ ...prev, open: false }))}
        onProjectsMaybeChanged={() => loadProjects()}
        onCreateProjectFromUpload={handleCreateFromUpload}
      />
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>{t('delete_btn')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('confirm_delete_project')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button>
          <Button color="error" variant="contained" disabled={deleting} onClick={confirmDelete}>
            {t('delete_btn')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
