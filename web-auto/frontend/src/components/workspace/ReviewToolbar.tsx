import { Box, Button, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useLayoutStore } from '../../stores/workspace/layoutStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { useReviewFlow } from '../../hooks/useReviewFlow';

/**
 * Review toolbar — 1:1 port of the legacy review-toolbar.js (ws-review-only
 * block), mounted into the WorkspaceToolbar review slot only in review mode:
 * current manual class display, continuous-drawing toggle, recolor the
 * focused annotation to the current class, delete focused annotation,
 * save-and-next (accept → auto next) and next-unlabeled jump.
 */
export function ReviewToolbar() {
  const { t } = useTranslation();
  const reviewContinuousMode = useLayoutStore((s) => s.reviewContinuousMode);
  const selectedClass = useProjectStore((s) => s.selectedClass);
  const classes = useProjectStore((s) => s.classes);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);

  const {
    toggleContinuousMode,
    applyClassToFocused,
    deleteFocusedAnnotation,
    saveAndNavigate,
    nextUnlabeled,
  } = useReviewFlow();

  const currentClass = selectedClass || classes[0] || '';

  const btnSx = { height: 32, px: 1.25, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Tooltip title={t('review_current_class_title')}>
        <Box
          sx={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.25,
            borderRadius: '10px',
            minWidth: 0,
            boxShadow: 'inset 2px 2px 5px rgba(0,0,0,0.06)',
          }}
        >
          <Typography sx={{ fontSize: 11, fontWeight: 800, color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {t('review_current_class')}
          </Typography>
          <Typography
            title={currentClass || t('review_no_class')}
            sx={{ fontSize: 12, fontWeight: 800, color: 'primary.main', maxWidth: 120 }}
            noWrap
          >
            {currentClass || '--'}
          </Typography>
        </Box>
      </Tooltip>

      <Tooltip title={t('review_continuous_title')}>
        <Button
          size="small"
          variant={reviewContinuousMode ? 'contained' : 'outlined'}
          onClick={toggleContinuousMode}
          sx={btnSx}
        >
          {reviewContinuousMode ? t('review_continuous_on') : t('review_continuous_off')}
        </Button>
      </Tooltip>

      <Tooltip title={t('review_apply_class_title')}>
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={!focusedAnnotationId}
            onClick={() => void applyClassToFocused()}
            sx={btnSx}
          >
            {t('review_apply_class')}
          </Button>
        </span>
      </Tooltip>

      <Tooltip title={t('review_delete_ann_title')}>
        <span>
          <Button
            size="small"
            variant="outlined"
            color="error"
            disabled={!focusedAnnotationId}
            onClick={deleteFocusedAnnotation}
            sx={btnSx}
          >
            {t('review_delete_ann')}
          </Button>
        </span>
      </Tooltip>

      <Tooltip title={t('review_save_next_title')}>
        <Button
          size="small"
          variant="contained"
          onClick={() => void saveAndNavigate(1)}
          sx={{ ...btnSx, fontWeight: 800, px: 1.5 }}
        >
          {t('review_save_next')}
        </Button>
      </Tooltip>

      <Tooltip title={t('review_next_unlabeled_title')}>
        <Button size="small" variant="outlined" onClick={() => void nextUnlabeled()} sx={{ ...btnSx, px: 1.5 }}>
          {t('review_next_unlabeled')}
        </Button>
      </Tooltip>
    </Box>
  );
}
