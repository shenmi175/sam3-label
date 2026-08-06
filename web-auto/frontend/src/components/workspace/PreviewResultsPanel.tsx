import { Box, Button, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { usePreviewInference } from '../../hooks/usePreviewInference';

/**
 * SAM example-preview results card — 1:1 port of the legacy
 * preview-results-card + PreviewController.render: one card per dashed
 * preview with confidence, "Apply to Image" (keepSingle) and remove buttons;
 * empty state shows the usage hint. Adoption flows through
 * usePreviewInference which re-fetches, saves and reloads the image.
 */
export function PreviewResultsPanel() {
  const { t } = useTranslation();
  const previews = useViewerStore((s) => s.previews);
  const { keepSingle, removePreview } = usePreviewInference();

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 3,
        bgcolor: 'action.hover',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 800, color: 'text.secondary' }}>{t('preview_results')}</Typography>
        <Typography sx={{ fontSize: 10, color: 'text.secondary', textAlign: 'right' }}>{t('preview_results_desc')}</Typography>
      </Box>
      {previews.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 5, color: 'text.secondary' }}>
          <Typography sx={{ fontSize: 13 }}>{t('preview_results_desc')}</Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, maxHeight: 220, overflowY: 'auto' }}>
          {previews.map((preview, index) => {
            const rawScore = Number(preview.score ?? 0.98);
            const confidence = Number.isFinite(rawScore) ? rawScore : 0.98;
            return (
              <Box
                key={String(preview.id)}
                sx={{
                  p: 1.5,
                  borderRadius: 3,
                  bgcolor: 'background.paper',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.25,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'primary.main', textTransform: 'uppercase' }}>
                    {t('preview_result_index', { index: index + 1 })}
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={() => removePreview(String(preview.id))}
                    sx={{ width: 24, height: 24, color: '#ef4444', fontSize: 12, fontWeight: 800 }}
                    aria-label={t('delete_ann')}
                  >
                    ×
                  </IconButton>
                </Box>
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                  {t('preview_confidence')}:{' '}
                  <Typography component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                    {confidence.toFixed(3)}
                  </Typography>
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  fullWidth
                  sx={{ fontSize: 11 }}
                  onClick={() => void keepSingle(String(preview.id))}
                >
                  {t('preview_apply')}
                </Button>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
