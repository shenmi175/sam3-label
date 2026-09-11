import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { addClass, deleteClass } from '../api/classes';
import { deleteAiFeatures, getAiFeatureStatus } from '../api/ai';
import {
  cancelInferJob,
  getFilterActiveJob,
  getInferActiveJob,
  stopInferJob,
  type InferJob,
} from '../api/inference';
import {
  deleteProject,
  getProject,
  getUploadConfig,
  refreshImages,
  updateProject,
  type ProjectInfo,
} from '../api/projects';
import { useSettingsStore } from '../stores/settingsStore';
import { useToast } from '../components/common/ToastProvider';
import { DatasetUploadDialog } from '../components/projects/DatasetUploadDialog';
import { formatBytes } from '../components/projects/utils';

interface FeatureStatus {
  count?: number;
  bytes?: number;
  indexed_count?: number;
}

type ProjectManageTab = 'overview' | 'paths' | 'classes' | 'data' | 'tasks' | 'features' | 'danger';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, display: 'grid', gap: 2 }}>
      <Typography variant="h6" sx={{ fontSize: 17, fontWeight: 800 }}>{title}</Typography>
      {children}
    </Paper>
  );
}

export function ProjectManagePage() {
  const { id = '' } = useParams();
  const projectId = id;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const theme = useTheme();
  const compactLayout = useMediaQuery(theme.breakpoints.down('md'));
  const { showToast } = useToast();
  const sam3ApiUrl = useSettingsStore((state) => state.sam3ApiUrl);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [name, setName] = useState('');
  const [newClass, setNewClass] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadHint, setUploadHint] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFeaturesOpen, setDeleteFeaturesOpen] = useState(false);
  const [featureStatus, setFeatureStatus] = useState<FeatureStatus | null>(null);
  const [jobs, setJobs] = useState<Array<InferJob & { kind: 'infer' | 'filter' }>>([]);
  const [activeTab, setActiveTab] = useState<ProjectManageTab>('overview');

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await getProject(projectId, false);
      setProject(response.project);
      setName(String(response.project.name || ''));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadFeatureStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      setFeatureStatus(await getAiFeatureStatus(projectId) as FeatureStatus);
    } catch {
      setFeatureStatus(null);
    }
  }, [projectId]);

  const loadJobs = useCallback(async () => {
    if (!projectId) return;
    const [infer, filter] = await Promise.allSettled([
      getInferActiveJob(projectId),
      getFilterActiveJob(projectId),
    ]);
    const next: Array<InferJob & { kind: 'infer' | 'filter' }> = [];
    if (infer.status === 'fulfilled' && infer.value.job) next.push({ ...infer.value.job, kind: 'infer' });
    if (filter.status === 'fulfilled' && filter.value.job) next.push({ ...filter.value.job, kind: 'filter' });
    setJobs(next);
  }, [projectId]);

  useEffect(() => {
    void Promise.all([loadProject(), loadFeatureStatus(), loadJobs(), getUploadConfig().then((cfg) => {
      setUploadHint(t('upload_root_hint', { root: cfg.host_data_root || '' }));
    }).catch(() => undefined)]);
  }, [loadFeatureStatus, loadJobs, loadProject, t]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadJobs(), 2500);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  const projectType = String(project?.project_type || 'image');
  const projectWorkspacePath = projectType === 'pose' ? `/project/pose/${projectId}` : `/project/image/${projectId}`;
  const classes = useMemo(
    () => Array.isArray(project?.classes) ? (project.classes as unknown[]).map(String) : [],
    [project],
  );
  const paths = [
    [t('project_source_path'), project?.image_dir],
    [t('project_save_path'), project?.project_save_dir || project?.save_dir],
    [t('project_annotation_path'), project?.annotation_dir],
    [t('project_export_path'), project?.export_dir],
  ].filter((item) => item[1]);

  const saveName = async () => {
    const clean = name.trim();
    if (!clean || clean === String(project?.name || '')) return;
    setBusy('name');
    try {
      const response = await updateProject(projectId, { name: clean });
      setProject(response.project);
      setName(String(response.project.name || ''));
      showToast(t('project_name_saved'));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const addProjectClass = async () => {
    const clean = newClass.trim();
    if (!clean) return;
    setBusy('class');
    try {
      await addClass(projectId, clean);
      setNewClass('');
      await loadProject();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const removeProjectClass = async (className: string) => {
    if (!window.confirm(t('project_class_delete_confirm', { name: className }))) return;
    setBusy(`class:${className}`);
    try {
      await deleteClass(projectId, className);
      await loadProject();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const rescanImages = async () => {
    setBusy('refresh');
    try {
      await refreshImages(projectId);
      await loadProject();
      showToast(t('project_data_refreshed'));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const removeFeatures = async () => {
    setBusy('features');
    try {
      await deleteAiFeatures({ project_id: projectId, api_base_url: sam3ApiUrl, confirmed: true });
      setDeleteFeaturesOpen(false);
      await loadFeatureStatus();
      showToast(t('ai_features_deleted'));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const removeProject = async () => {
    setBusy('delete');
    try {
      await deleteProject(projectId);
      showToast(t('project_deleted'));
      navigate('/');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress /></Box>;
  if (!project || error) return <Box sx={{ p: 4 }}><Alert severity="error">{error || t('project_not_found')}</Alert></Box>;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ height: 64, px: { xs: 2, md: 5 }, display: 'flex', alignItems: 'center', gap: 1.5, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
        <IconButton onClick={() => navigate(projectWorkspacePath)} aria-label={t('back_to_project_workspace')}><ArrowBackIcon /></IconButton>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800 }} noWrap>{project.name}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 11 }}>{t('project_manage')}</Typography>
        </Box>
      </Box>

      <Box sx={{ maxWidth: 1200, mx: 'auto', p: { xs: 2, md: 4 }, display: 'grid', gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : '220px minmax(0, 1fr)', gap: 3, alignItems: 'start' }}>
        <Paper sx={{ p: 1.25, position: compactLayout ? 'static' : 'sticky', top: 24, minWidth: 0 }}>
          <Tabs
            value={activeTab}
            onChange={(_, value: ProjectManageTab) => setActiveTab(value)}
            orientation={compactLayout ? 'horizontal' : 'vertical'}
            variant="scrollable"
            sx={{
              '& .MuiTab-root': {
                minHeight: 44,
                minWidth: compactLayout ? 120 : 0,
                alignItems: compactLayout ? 'center' : 'flex-start',
                textAlign: 'left',
              },
            }}
          >
            <Tab value="overview" label={t('project_overview')} />
            <Tab value="paths" label={t('project_paths')} />
            <Tab value="classes" label={t('project_classes')} />
            <Tab value="data" label={t('project_data')} />
            <Tab value="tasks" label={t('project_tasks')} />
            {projectType === 'image' && <Tab value="features" label={t('project_ai_features')} />}
            <Tab value="danger" label={t('danger_zone')} sx={{ color: 'error.main', '&.Mui-selected': { color: 'error.main' } }} />
          </Tabs>
        </Paper>

        <Box sx={{ minWidth: 0 }}>
          {activeTab === 'overview' && (
            <Section title={t('project_overview')}>
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <TextField size="small" label={t('project_name')} value={name} onChange={(event) => setName(event.target.value)} sx={{ minWidth: 280, flex: 1 }} inputProps={{ maxLength: 128 }} />
                <Button variant="contained" disabled={busy === 'name' || !name.trim() || name.trim() === String(project.name || '')} onClick={() => void saveName()}>{t('save')}</Button>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Chip label={projectType === 'pose' ? t('pose_project') : t('image_project')} />
                <Chip label={`${t('total')}: ${Number(project.num_images || 0)}`} />
                <Chip color="success" variant="outlined" label={`${t('labeled')}: ${Number(project.labeled_images || 0)}`} />
                <Chip label={`ID: ${project.id}`} />
              </Box>
            </Section>
          )}

          {activeTab === 'paths' && (
            <Section title={t('project_paths')}>
              {paths.map(([label, value]) => (
                <TextField key={String(label)} size="small" label={String(label)} value={String(value || '')} fullWidth InputProps={{ readOnly: true }} />
              ))}
              <Alert severity="info">{t('project_paths_readonly_hint')}</Alert>
            </Section>
          )}

          {activeTab === 'classes' && (
            <Section title={t('project_classes')}>
              <Box sx={{ display: 'flex', gap: 1.5 }}>
                <TextField size="small" label={t('add_class')} value={newClass} onChange={(event) => setNewClass(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addProjectClass(); }} sx={{ flex: 1 }} />
                <Button variant="outlined" disabled={!newClass.trim() || busy === 'class'} onClick={() => void addProjectClass()}>{t('add')}</Button>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {classes.map((className) => (
                  <Chip key={className} label={className} onDelete={() => void removeProjectClass(className)} disabled={busy === `class:${className}`} />
                ))}
                {!classes.length && <Typography color="text.secondary">{t('no_classes')}</Typography>}
              </Box>
            </Section>
          )}

          {activeTab === 'data' && (
            <Section title={t('project_data')}>
              <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('project_data_hint')}</Typography>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                <Button startIcon={<UploadFileIcon />} variant="contained" onClick={() => setUploadOpen(true)}>{t('add_data_btn')}</Button>
                <Button startIcon={<RefreshIcon />} variant="outlined" disabled={busy === 'refresh'} onClick={() => void rescanImages()}>{t('refresh_images')}</Button>
              </Box>
            </Section>
          )}

          {activeTab === 'tasks' && (
            <Section title={t('project_tasks')}>
              {!jobs.length ? <Typography color="text.secondary">{t('project_no_active_tasks')}</Typography> : jobs.map((job) => (
                <Box key={job.job_id} sx={{ display: 'grid', gap: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Typography sx={{ fontWeight: 700 }}>{job.kind === 'infer' ? t('batch_inference') : t('smart_filter')}</Typography>
                    <Chip size="small" label={job.status} />
                    <Box sx={{ flex: 1 }} />
                    {job.kind === 'infer' && <Button size="small" onClick={() => void stopInferJob(projectId).then(loadJobs)}>{t('stop')}</Button>}
                    {job.kind === 'infer' && <Button size="small" color="error" onClick={() => void cancelInferJob(projectId).then(loadJobs)}>{t('cancel')}</Button>}
                  </Box>
                  <LinearProgress variant="determinate" value={Number(job.progress_pct || 0)} />
                  <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{job.message || job.job_id}</Typography>
                </Box>
              ))}
            </Section>
          )}

          {activeTab === 'features' && projectType === 'image' && (
            <Section title={t('project_ai_features')}>
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography>{t('project_ai_feature_summary', { count: Number(featureStatus?.count || 0), size: formatBytes(Number(featureStatus?.bytes || 0)) })}</Typography>
                <Tooltip title={t('refresh')}><IconButton size="small" onClick={() => void loadFeatureStatus()}><RefreshIcon fontSize="small" /></IconButton></Tooltip>
              </Box>
              <Alert severity="info">{t('project_ai_feature_hint')}</Alert>
              <Box><Button color="error" variant="outlined" disabled={!Number(featureStatus?.count || 0)} onClick={() => setDeleteFeaturesOpen(true)}>{t('ai_delete_features')}</Button></Box>
            </Section>
          )}

          {activeTab === 'danger' && (
            <Section title={t('danger_zone')}>
              <Alert severity="warning">{t('project_delete_scope_warning')}</Alert>
              <Divider />
              <Box><Button color="error" variant="contained" startIcon={<DeleteForeverIcon />} onClick={() => setDeleteOpen(true)}>{t('delete_project')}</Button></Box>
            </Section>
          )}
        </Box>
      </Box>

      <DatasetUploadDialog
        open={uploadOpen}
        initialTargetDir={String(project.image_dir || '')}
        targetProjectId={projectId}
        lockTargetDir
        hintText={uploadHint}
        onClose={() => setUploadOpen(false)}
        onProjectsMaybeChanged={() => void loadProject()}
        onCreateProjectFromUpload={() => undefined}
      />

      <Dialog open={deleteFeaturesOpen} onClose={() => setDeleteFeaturesOpen(false)}>
        <DialogTitle>{t('ai_delete_features')}</DialogTitle>
        <DialogContent><DialogContentText>{t('ai_delete_confirm', { count: Number(featureStatus?.count || 0), size: (Number(featureStatus?.bytes || 0) / 1024 / 1024).toFixed(1) })}</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setDeleteFeaturesOpen(false)}>{t('cancel')}</Button><Button color="error" variant="contained" disabled={busy === 'features'} onClick={() => void removeFeatures()}>{t('delete_btn')}</Button></DialogActions>
      </Dialog>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)}>
        <DialogTitle>{t('delete_project')}</DialogTitle>
        <DialogContent><DialogContentText>{t('project_delete_scope_warning')}</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setDeleteOpen(false)}>{t('cancel')}</Button><Button color="error" variant="contained" disabled={busy === 'delete'} onClick={() => void removeProject()}>{t('delete_project')}</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
