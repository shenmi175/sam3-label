import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useInferenceStore } from '../../stores/workspace/inferenceStore';
import { useInference } from '../../hooks/useInference';

/**
 * Task progress shadow row — 1:1 port of the legacy #ws-task-bar: shows the
 * active batch job name, progress fill and status text, plus state-dependent
 * Stop / Resume / Cancel buttons (running → Stop; pausing → disabled Stop;
 * paused → Resume + Cancel). Visibility and text are driven by
 * inferenceStore via useJobPolling.
 */
export function TaskProgressBar() {
  const { t } = useTranslation();
  const visible = useInferenceStore((s) => s.taskBarVisible);
  const text = useInferenceStore((s) => s.taskBarText);
  const job = useInferenceStore((s) => s.job);
  const { stopActiveTask, resumeActiveTask, cancelActiveTask } = useInference();

  if (!visible) return null;

  const status = String(job?.status || 'running');
  const pausing = status === 'pausing';
  const paused = status === 'paused';
  const pct = Math.max(0, Math.min(100, Number(job?.progress_pct || 0)));

  return (
    <Box
      sx={{
        height: 50,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        px: 3,
        gap: 2.5,
        zIndex: 80,
        bgcolor: 'background.paper',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 200 }}>
        <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary' }}>{t('task_header')}:</Typography>
        <Typography sx={{ fontSize: 11, fontWeight: 800 }}>{t('batch_infer')}</Typography>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2 }}>
        <LinearProgress variant="determinate" value={pct} sx={{ flex: 1, height: 4, borderRadius: 2 }} />
        <Typography sx={{ fontSize: 10, fontWeight: 600, minWidth: 100, textAlign: 'right', color: 'text.secondary' }} noWrap>
          {text || '--'}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        {!paused ? (
          <Button
            size="small"
            color="error"
            disabled={pausing}
            onClick={() => void stopActiveTask()}
            sx={{ height: 28, px: 1.5, fontSize: 10, fontWeight: 700 }}
          >
            {pausing ? t('task_stopping') : t('stop')}
          </Button>
        ) : null}
        {paused ? (
          <>
            <Button
              size="small"
              color="success"
              onClick={() => void resumeActiveTask()}
              sx={{ height: 28, px: 1.5, fontSize: 10, fontWeight: 700 }}
            >
              {t('resume')}
            </Button>
            <Button
              size="small"
              color="error"
              onClick={() => void cancelActiveTask()}
              sx={{ height: 28, px: 1.5, fontSize: 10, fontWeight: 700 }}
            >
              {t('cancel_task')}
            </Button>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
