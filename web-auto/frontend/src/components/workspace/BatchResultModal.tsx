import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useInferenceStore } from '../../stores/workspace/inferenceStore';
import { useInference } from '../../hooks/useInference';

function statValue(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      return String(candidate);
    }
  }
  return '0';
}

/**
 * Batch inference result modal — 1:1 port of the legacy
 * InferenceController.showBatchResultModal: 6-stat grid (requested /
 * processed / succeeded / failed / skipped / new annotations), class
 * addition stats, trailing message, and a retry button that restarts the
 * job for result.retry_image_ids only.
 */
export function BatchResultModal() {
  const { t } = useTranslation();
  const job = useInferenceStore((s) => s.batchResultJob);
  const closeBatchResult = useInferenceStore((s) => s.closeBatchResult);
  const { retryBatch } = useInference();

  const result = (job?.result || {}) as Record<string, unknown>;
  const classAdditions = (result.class_additions || {}) as Record<string, unknown>;
  const retryImageIds = Array.isArray(result.retry_image_ids)
    ? (result.retry_image_ids as unknown[]).map((id) => String(id))
    : [];
  const classRows = Object.entries(classAdditions);

  const stats = job
    ? [
        { label: t('batch_requested'), value: statValue(result.requested, job.requested, 0) },
        { label: t('batch_processed'), value: statValue(result.processed_images, job.progress_done, 0) },
        { label: t('batch_succeeded'), value: statValue(result.saved_images, result.succeeded, job.succeeded, 0), color: '#10b981' },
        { label: t('batch_failed'), value: statValue(result.failed_images, result.failed, job.failed, 0), color: '#ef4444' },
        { label: t('batch_skipped'), value: statValue(result.skipped_images, result.skipped, job.skipped, 0) },
        { label: t('batch_new_anns'), value: statValue(result.new_annotations, job.new_annotations, 0) },
      ]
    : [];

  return (
    <Dialog open={job !== null} onClose={closeBatchResult} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 18, fontWeight: 700, pr: 6 }}>
        {t('batch_result_title')}
        <IconButton onClick={closeBatchResult} size="small" sx={{ position: 'absolute', right: 10, top: 10, color: '#ef4444' }} aria-label="close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
          {stats.map((item) => (
            <Box key={item.label} sx={{ p: 1.75, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
              <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{item.label}</Typography>
              <Typography sx={{ mt: 0.75, fontSize: 14, fontWeight: 700, color: item.color || 'text.primary' }}>
                {item.value}
              </Typography>
            </Box>
          ))}
        </Box>

        <Box sx={{ p: 1.75, borderRadius: 3, bgcolor: 'action.hover', mt: 2 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 1 }}>{t('batch_class_additions')}</Typography>
          {classRows.length > 0 ? (
            classRows.map(([cls, count]) => (
              <Box key={cls} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, py: 0.5 }}>
                <Typography sx={{ fontSize: 12 }}>{cls}</Typography>
                <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{String(count)}</Typography>
              </Box>
            ))
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('batch_no_class_stats')}</Typography>
          )}
        </Box>

        <Typography sx={{ mt: 2, fontSize: 12, color: 'text.secondary', lineHeight: 1.7 }}>
          {String(job?.message || result.message || t('batch_done_default'))}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {retryImageIds.length > 0 ? (
          <Button
            variant="contained"
            sx={{ fontWeight: 700 }}
            onClick={() => {
              if (job) void retryBatch(job, retryImageIds);
            }}
          >
            {t('batch_retry')}
          </Button>
        ) : null}
        <Button onClick={closeBatchResult}>{t('close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
