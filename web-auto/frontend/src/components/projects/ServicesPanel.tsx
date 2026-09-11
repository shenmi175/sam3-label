import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, LinearProgress, Paper, Typography } from '@mui/material';
import type {
  SapiensStatusResponse,
  ModelLoadJob,
  ServiceInfo,
  ServiceOperation,
  ServicesStatusResponse,
} from '../../api/system';
import { formatBytes } from './utils';
import { useToast } from '../common/ToastProvider';
import {
  downloadLogs,
  getLatestModelLoadJob,
  getModelLoadJob,
  startModelLoadJob,
} from '../../api/system';

const SERVICE_NAMES = ['sam3-api', 'locate-anything-api', 'sapiens-api'];

interface ServicesPanelProps {
  servicesStatus: ServicesStatusResponse | null;
  sapiensStatus: SapiensStatusResponse | null;
  onRefresh: () => void;
  onControlService: (service: string, action: string) => void;
  onStartSapiensDownload: () => void;
}

export function ServicesPanel({
  servicesStatus,
  sapiensStatus,
  onRefresh,
  onControlService,
  onStartSapiensDownload,
}: ServicesPanelProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [preparingLogs, setPreparingLogs] = useState(false);
  const [modelLoadJobs, setModelLoadJobs] = useState<Record<string, ModelLoadJob | null>>({});
  const reportedJobsRef = useRef(new Set<string>());

  const loaded = servicesStatus !== null || sapiensStatus !== null;
  const activeModelLoadJobIds = useMemo(
    () => Object.values(modelLoadJobs)
      .filter((job): job is ModelLoadJob => Boolean(
        job && ['queued', 'running'].includes(String(job.status || '')),
      ))
      .map((job) => job.job_id)
      .sort()
      .join(','),
    [modelLoadJobs],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled(SERVICE_NAMES.map(async (service) => {
      const response = await getLatestModelLoadJob(service);
      if (!cancelled) {
        setModelLoadJobs((prev) => {
          const current = prev[service];
          const incoming = response.job || null;
          const currentActive = current && ['queued', 'running'].includes(String(current.status || ''));
          if (currentActive && incoming?.job_id !== current.job_id) {
            return prev;
          }
          return { ...prev, [service]: incoming };
        });
      }
    }));
    return () => {
      cancelled = true;
    };
  }, [servicesStatus]);

  useEffect(() => {
    const jobIds = activeModelLoadJobIds.split(',').filter(Boolean);
    if (jobIds.length === 0) return undefined;
    let cancelled = false;
    const poll = async () => {
      const settled = await Promise.allSettled(
        jobIds.map((jobId) => getModelLoadJob(jobId)),
      );
      if (cancelled) return;
      let shouldRefresh = false;
      settled.forEach((result) => {
        if (result.status !== 'fulfilled' || !result.value.job) return;
        const job = result.value.job;
        setModelLoadJobs((prev) => ({ ...prev, [job.service]: job }));
        if (!['completed', 'failed'].includes(String(job.status || ''))) return;
        if (reportedJobsRef.current.has(job.job_id)) return;
        reportedJobsRef.current.add(job.job_id);
        shouldRefresh = true;
        if (job.status === 'completed') {
          showToast(t('model_load_success'), 'success');
        } else {
          showToast(job.error?.message || t('model_load_failed'), 'error');
        }
      });
      if (shouldRefresh) onRefresh();
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeModelLoadJobIds, onRefresh, showToast, t]);

  const handleModelLoad = async (service: string) => {
    try {
      const response = await startModelLoadJob(service);
      if (response.job) {
        setModelLoadJobs((prev) => ({ ...prev, [service]: response.job }));
      }
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  };

  const handleDownloadLogs = async () => {
    setPreparingLogs(true);
    try {
      await downloadLogs();
      showToast(t('logs_download_started'));
    } catch (error) {
      showToast(t('logs_download_failed', { error: (error as Error).message }), 'error');
    } finally {
      setPreparingLogs(false);
    }
  };

  const serviceByName = (name: string): ServiceInfo => {
    const services = servicesStatus?.services || [];
    return services.find((item) => item.service === name) || { service: name, status: 'unknown', containers: [] };
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('command_copied'));
    } catch {
      showToast(t('copy_failed'), 'error');
    }
  };

  const renderOperation = (operation: ServiceOperation) => {
    const status = String(operation.status || '');
    const phase = String(operation.phase || '');
    const logs = Array.isArray(operation.logs) ? operation.logs.slice(-4).join('\n') : '';
    const color = status === 'failed' ? '#ef4444' : status === 'completed' ? '#10b981' : 'primary.main';
    return (
      <Box sx={{ display: 'grid', gap: 0.75, fontSize: 12 }}>
        <Typography sx={{ color, fontWeight: 700, fontSize: 12 }}>
          {status || 'operation'} {phase ? `· ${phase}` : ''}
        </Typography>
        {logs && (
          <Box
            component="pre"
            sx={{
              m: 0,
              whiteSpace: 'pre-wrap',
              maxHeight: 92,
              overflow: 'auto',
              fontSize: 11,
              color: 'text.secondary',
              bgcolor: 'action.hover',
              p: 1,
              borderRadius: 1.5,
            }}
          >
            {logs}
          </Box>
        )}
      </Box>
    );
  };

  const renderSapiensCheckpointBlock = (isRunning: boolean) => {
    const status = sapiensStatus || {};
    if (!isRunning) {
      return (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('sapiens_enable_first')}</Typography>
      );
    }
    if (!status.ok) {
      return (
        <Typography sx={{ fontSize: 12, color: '#ef4444', overflowWrap: 'anywhere' }}>
          {status.error || t('backend_offline')}
        </Typography>
      );
    }
    const checkpoint = status.checkpoint || {};
    const exists = Boolean(checkpoint.checkpoint_exists) && Boolean(checkpoint.detector_exists);
    const job = checkpoint.download_job || null;
    if (exists) {
      return (
        <Typography sx={{ fontSize: 12, color: '#10b981', overflowWrap: 'anywhere' }}>
          {t('sapiens_checkpoint_ready')}: {checkpoint.checkpoint_path || ''}
        </Typography>
      );
    }
    const percent = Number(job?.percent || 0);
    const jobStatus = String(job?.status || '');
    const downloaded = formatBytes(job?.downloaded_bytes || checkpoint.partial_size_bytes || 0);
    const total = Number(job?.total_bytes || 0) > 0 ? formatBytes(job?.total_bytes) : '--';
    return (
      <Box sx={{ display: 'grid', gap: 1 }}>
        <Typography sx={{ fontSize: 12, color: '#f59e0b', overflowWrap: 'anywhere' }}>
          {t('sapiens_checkpoint_missing')}: {checkpoint.checkpoint_path || ''}
          <br />
          {checkpoint.detector_path || ''}
        </Typography>
        <LinearProgress
          variant="determinate"
          value={Math.max(0, Math.min(100, percent))}
          sx={{ height: 8, borderRadius: 999 }}
        />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, fontSize: 11, color: 'text.secondary' }}>
          <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>
            {jobStatus || t('waiting_download')}
          </Typography>
          <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>
            {percent.toFixed(percent > 0 ? 1 : 0)}% · {downloaded} / {total}
          </Typography>
        </Box>
        <Box>
          <Button variant="outlined" onClick={onStartSapiensDownload} sx={{ justifySelf: 'start' }}>
            {t('download_sapiens_model')}
          </Button>
        </Box>
      </Box>
    );
  };

  const renderServiceCard = (name: string) => {
    const service = serviceByName(name);
    const status = String(service.status || 'unknown');
    const isRunning = status === 'running';
    const isMissing = status === 'not_created';
    const operation = service.operation || null;
    const opRunning = Boolean(operation && ['queued', 'running'].includes(String(operation.status || '')));
    const modelLoadJob = modelLoadJobs[name] || null;
    const modelLoading = Boolean(modelLoadJob && ['queued', 'running'].includes(String(modelLoadJob.status || '')));
    const color = isRunning ? '#10b981' : isMissing || status === 'creating' ? '#f59e0b' : '#ef4444';
    const command =
      service.manage_command || (name === 'sapiens-api' ? './deploy.sh sapiens enable' : `./deploy.sh services start ${name}`);
    const title = name === 'sapiens-api' ? 'sapiens-api (Sapiens2-5B Pose)' : name;

    return (
      <Box
        key={name}
        sx={{
          p: 1.75,
          display: 'grid',
          gap: 1.5,
          minWidth: 0,
          borderRadius: 2,
          bgcolor: 'action.hover',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{title}</Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>{status}</Typography>
          </Box>
          <Box
            component="span"
            sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color, mt: 0.5, flex: '0 0 auto' }}
          />
        </Box>
        {isMissing && (
          <Typography sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>{command}</Typography>
        )}
        {operation && renderOperation(operation)}
        {name === 'sapiens-api' && renderSapiensCheckpointBlock(isRunning)}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {opRunning ? (
            <Button variant="outlined" disabled>
              {t('creating_service')}
            </Button>
          ) : isMissing ? (
            <>
              <Button variant="outlined" onClick={() => onControlService(name, 'start')} sx={{ fontWeight: 700 }}>
                {name === 'sapiens-api' ? t('enable_service') : t('start')}
              </Button>
              <Button variant="outlined" onClick={() => copyText(command)}>
                {t('copy_command')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outlined" onClick={() => onControlService(name, isRunning ? 'stop' : 'start')}>
                {isRunning ? t('stop') : t('start')}
              </Button>
              <Button variant="outlined" onClick={() => onControlService(name, 'restart')}>
                {t('restart')}
              </Button>
            </>
          )}
          <Button
            variant="contained"
            disabled={!isRunning || opRunning || modelLoading}
            onClick={() => void handleModelLoad(name)}
          >
            {modelLoading ? t('model_loading') : t('load_model')}
          </Button>
        </Box>
      </Box>
    );
  };

  return (
    <Paper sx={{ p: 2.25, mb: 3, display: 'grid', gap: 1.75 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 700 }}>
            {t('model_services')}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
            {t('model_services_hint')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" disabled={preparingLogs} onClick={() => void handleDownloadLogs()}>
            {preparingLogs ? t('logs_preparing') : t('download_logs')}
          </Button>
          <Button variant="outlined" onClick={onRefresh}>
            {t('refresh')}
          </Button>
        </Box>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
          gap: 1.75,
        }}
      >
        {loaded ? (
          SERVICE_NAMES.map((name) => renderServiceCard(name))
        ) : (
          <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('loading_services')}</Typography>
        )}
      </Box>
    </Paper>
  );
}
