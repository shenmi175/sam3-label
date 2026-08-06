import { Box, Button, IconButton, LinearProgress, Paper, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useTasksStore } from '../../stores/workspace/tasksStore';

/**
 * Global floating task widget — 1:1 port of the legacy TaskManager
 * (components/tasks.js): bottom-right 350 px panel listing active inference /
 * smart-filter jobs with progress + Stop/Resume controls. Polling is driven
 * by tasksStore (2 s interval, per-project active-job endpoints).
 */
export function TaskWidget() {
  const { t } = useTranslation();
  const jobs = useTasksStore((s) => s.jobs);
  const dismissed = useTasksStore((s) => s.dismissed);
  const projectName = useTasksStore((s) => s.projectName);
  const actionBusy = useTasksStore((s) => s.actionBusy);
  const dismissJob = useTasksStore((s) => s.dismissJob);
  const stopJob = useTasksStore((s) => s.stopJob);
  const resumeJob = useTasksStore((s) => s.resumeJob);

  const visible = jobs.filter((job) => !dismissed.includes(job.job_id));
  if (!visible.length) return null;

  return (
    <Box sx={{ position: 'fixed', right: 20, bottom: 20, width: 350, zIndex: 1400, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {visible.map((job) => {
        const running = job.status === 'running' || job.status === 'queued';
        const pausing = job.status === 'pausing';
        const paused = job.status === 'paused';
        const pct = Number(job.progress_pct || 0);
        return (
          <Paper key={job.job_id} elevation={4} sx={{ p: 1.5, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 800, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.job_type || 'task'}
                {projectName ? ` · ${projectName}` : ''}
              </Typography>
              <Typography sx={{ fontSize: 10, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase' }}>
                {job.status}
              </Typography>
              <IconButton size="small" onClick={() => dismissJob(job.job_id)} aria-label="dismiss">
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
            {job.message ? (
              <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }} noWrap>
                {job.message}
              </Typography>
            ) : null}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
              <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, pct))} sx={{ flex: 1, height: 6, borderRadius: 3 }} />
              <Typography sx={{ fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{Math.round(pct)}%</Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1, justifyContent: 'flex-end' }}>
              {running ? (
                <Button
                  size="small"
                  color="error"
                  disabled={actionBusy === job.job_id}
                  onClick={() => void stopJob(String(job.project_id || ''), job.job_id, job.taskKind)}
                >
                  {pausing || actionBusy === job.job_id ? t('task_stopping') : t('stop')}
                </Button>
              ) : null}
              {paused ? (
                <Button
                  size="small"
                  color="success"
                  disabled={actionBusy === job.job_id}
                  onClick={() => void resumeJob(String(job.project_id || ''), job)}
                >
                  {actionBusy === job.job_id ? t('task_resuming') : t('resume')}
                </Button>
              ) : null}
            </Box>
          </Paper>
        );
      })}
    </Box>
  );
}
