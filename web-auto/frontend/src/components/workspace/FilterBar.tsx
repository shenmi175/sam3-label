import { Box, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore, type ImageFilterStatus } from '../../stores/workspace/projectStore';
import { useImageNavigation } from '../../hooks/useImageNavigation';

/**
 * Image list filter bar — 1:1 port of the legacy sel-image-filter-class /
 * sel-image-filter-status pair above the image list. Any change resets to
 * page 1 and reloads the list through useImageNavigation.applyFilters.
 */
export function FilterBar() {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const imageFilterClass = useProjectStore((s) => s.imageFilterClass);
  const imageFilterStatus = useProjectStore((s) => s.imageFilterStatus);
  const { applyFilters } = useImageNavigation();

  return (
    <Box sx={{ px: 2.5, pb: 1.25, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
      <TextField
        select
        size="small"
        value={imageFilterClass}
        onChange={(e) => void applyFilters(e.target.value, imageFilterStatus)}
        inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
      >
        <MenuItem value="" sx={{ fontSize: 12 }}>{t('filter_all_classes')}</MenuItem>
        {classes.map((cls) => (
          <MenuItem key={cls} value={cls} sx={{ fontSize: 12 }}>
            {cls}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        value={imageFilterStatus}
        onChange={(e) => void applyFilters(imageFilterClass, e.target.value as ImageFilterStatus)}
        inputProps={{ style: { fontSize: 11, padding: '6px 8px' } }}
      >
        <MenuItem value="all" sx={{ fontSize: 12 }}>{t('filter_all_status')}</MenuItem>
        <MenuItem value="labeled" sx={{ fontSize: 12 }}>{t('labeled')}</MenuItem>
        <MenuItem value="unlabeled" sx={{ fontSize: 12 }}>{t('unlabeled')}</MenuItem>
      </TextField>
    </Box>
  );
}
